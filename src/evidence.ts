// Building the case. Everything here is derived from git and can be checked by hand; nothing is
// inferred by a model. The model's job comes later, and only if what is gathered here says enough.

import type { Commit, GitOptions, LineHistoryEntry } from "./git.ts";
import { lineHistory, fileHistory, changeFingerprint, tagsContaining, currentLines, commitCount, isShallow, blame } from "./git.ts";

export interface Question {
  file: string;
  start: number;
  end: number;
  /** The lines as they are now, for showing what was asked about. */
  text: string[];
  /** Free-text question, when one was asked. */
  asked: string | null;
}

export interface Change {
  commit: Commit;
  hunk: string;
  /** Lines this commit added inside the range asked about. */
  added: string[];
  removed: string[];
  /** Issue or pull request numbers mentioned in the message. */
  issues: number[];
  /** Release tags that contain this commit. */
  tags: string[];
  isMerge: boolean;
  /** The subject this commit's message claims to revert, if any. */
  claimsRevertOf: string | null;
  /** A commit this one undoes, proven by comparing patch ids rather than by reading the message. */
  reverts: string | null;
  /** A commit that later undid this one. */
  revertedBy: string | null;
  /** 0 = says nothing, 3 = explains itself. */
  informative: number;
}

export type SignalKind = "revert" | "reapplied" | "churn" | "issue" | "release" | "initial" | "merge-only" | "single-author" | "renamed";

export interface Signal { kind: SignalKind; text: string; cites: string[] }

export type Confidence = "clear" | "partial" | "thin";

export interface Evidence {
  question: Question;
  /** Oldest first, which is the order the story happened in. */
  changes: Change[];
  signals: Signal[];
  confidence: Confidence;
  /** Why the confidence is what it is, in words. */
  because: string;
  searched: { commitsInRepo: number; shallow: boolean; limit: number; truncated: boolean };
}

const GENERIC = /^(wip|fix(es|ed)?|update[sd]?|changes?|minor|cleanup|clean ?up|stuff|temp|tmp|misc|refactor|tweak|oops|typo|revert|more|again|final|test|asdf|\.+|[a-f0-9]+)\.?$/i;

/** How much a commit message actually explains, from 0 to 3. */
export function informativeness(c: Commit): number {
  let score = 0;
  const subject = c.subject.trim();
  if (subject.length >= 20 && !GENERIC.test(subject)) score++;
  if (/\b(because|so that|to (avoid|stop|prevent|handle|fix|work ?around)|otherwise|due to|caused by|regression|workaround)\b/i.test(subject + " " + c.body)) score += 2;
  else if (c.body.length > 40) score++;
  if (/#\d+|[A-Z]{2,}-\d+/.test(subject + " " + c.body)) score++;
  return Math.min(3, score);
}

export function issueRefs(c: Commit): number[] {
  const out = new Set<number>();
  for (const m of (c.subject + "\n" + c.body).matchAll(/(?:^|\s|\()#(\d{1,6})\b/g)) out.add(Number(m[1]));
  for (const m of (c.subject + "\n" + c.body).matchAll(/\b(?:fixes|closes|resolves|refs|see)\s+#(\d{1,6})\b/gi)) out.add(Number(m[1]));
  return [...out];
}

/** Lines the hunk adds or removes, with git's +/- markers taken off. */
function hunkLines(hunk: string): { added: string[]; removed: string[] } {
  const added: string[] = [], removed: string[] = [];
  for (const l of hunk.split("\n")) {
    if (/^\+\+\+|^---/.test(l)) continue;
    if (l.startsWith("+")) added.push(l.slice(1));
    else if (l.startsWith("-")) removed.push(l.slice(1));
  }
  return { added, removed };
}

export interface GatherOptions extends GitOptions { limit: number; /** Skip patch-id work, which costs a git call per commit. */ fast?: boolean }

/** Collects the history of the asked-about lines and everything that can be derived from it. */
export function gather(o: GatherOptions, q: Question): Evidence {
  let entries: LineHistoryEntry[] = [];
  let renamed = false;
  try {
    entries = lineHistory(o, q.file, q.start, q.end, o.limit);
  } catch (e) {
    // git log -L refuses on a file it cannot follow that far; fall back to the file's own history.
    const commits = fileHistory(o, q.file, o.limit);
    entries = commits.map((commit) => ({ commit, hunk: "" }));
    renamed = true;
  }

  const changes: Change[] = entries.map((e) => {
    const { added, removed } = hunkLines(e.hunk);
    return {
      commit: e.commit, hunk: e.hunk, added, removed,
      issues: issueRefs(e.commit), tags: [],
      isMerge: e.commit.parents.length > 1,
      claimsRevertOf: /^Revert ["“](.+)["”]\s*$/m.exec(e.commit.subject)?.[1] ?? null,
      reverts: null, revertedBy: null,
      informative: informativeness(e.commit),
    };
  }).reverse(); // oldest first: the order it happened in

  // Reverts, proven by comparing what the commits changed rather than by trusting their messages.
  if (!o.fast && changes.length > 1 && changes.length <= 15) {
    const forward = new Map<string, string>();
    const backward = new Map<string, string>();
    for (const c of changes) {
      const f = changeFingerprint(o, c.commit.sha);
      const r = changeFingerprint(o, c.commit.sha, true);
      if (f) forward.set(c.commit.sha, f);
      if (r) backward.set(c.commit.sha, r);
    }
    // Position in the history decides what came first, not the timestamps: commits made in the
    // same second, or with a rewritten author date, would otherwise be compared the wrong way.
    for (let li = 0; li < changes.length; li++) {
      for (let ei = 0; ei < li; ei++) {
        const later = changes[li], earlier = changes[ei];
        const undoes = backward.get(later.commit.sha) && backward.get(later.commit.sha) === forward.get(earlier.commit.sha);
        if (undoes) { later.reverts = earlier.commit.sha; earlier.revertedBy = later.commit.sha; }
      }
    }
  }

  for (const c of changes.slice(-4)) c.tags = tagsContaining(o, c.commit.sha);

  const signals: Signal[] = [];
  const short = (sha: string) => changes.find((c) => c.commit.sha === sha)?.commit.shortSha ?? sha.slice(0, 7);

  if (renamed) signals.push({ kind: "renamed", text: "git could not follow these particular lines, so this is the whole file's history instead", cites: [] });

  for (const c of changes) {
    if (c.reverts) signals.push({ kind: "revert", text: `${c.commit.shortSha} undoes ${short(c.reverts)}: it adds back exactly the lines ${short(c.reverts)} removed, and removes exactly the ones it added`, cites: [c.commit.sha, c.reverts] });
    else if (c.claimsRevertOf) signals.push({ kind: "revert", text: `${c.commit.shortSha} says it reverts "${c.claimsRevertOf}"`, cites: [c.commit.sha] });
  }

  // A change that was undone and then came back is the strongest signal there is: someone tried the
  // simple thing, it did not work, and they put the complicated thing back.
  for (const undone of changes.filter((c) => c.revertedBy)) {
    const undoneAt = changes.indexOf(undone);
    const after = changes.filter((c, i) => i > undoneAt && c.commit.sha !== undone.revertedBy);
    const sameAgain = after.find((c) => c.added.length && c.added.join("\n") === undone.added.join("\n"));
    if (sameAgain) signals.push({ kind: "reapplied", text: `the change in ${undone.commit.shortSha} was undone by ${short(undone.revertedBy!)} and then put back by ${sameAgain.commit.shortSha}, so the simpler version did not hold`, cites: [undone.commit.sha, undone.revertedBy!, sameAgain.commit.sha] });
  }

  if (changes.length >= 3) {
    const first = new Date(changes[0].commit.date).getTime();
    const last = new Date(changes[changes.length - 1].commit.date).getTime();
    const days = Math.round((last - first) / 86_400_000);
    signals.push({ kind: "churn", text: `${changes.length} commits touched these lines over ${days === 0 ? "the same day" : days === 1 ? "1 day" : `${days} days`}`, cites: changes.map((c) => c.commit.sha) });
  }

  const issues = [...new Set(changes.flatMap((c) => c.issues))];
  if (issues.length) signals.push({ kind: "issue", text: `the commits reference ${issues.map((n) => "#" + n).join(", ")}, which whyline cannot read: that is where the reason usually is`, cites: changes.filter((c) => c.issues.length).map((c) => c.commit.sha) });

  const released = changes.filter((c) => c.tags.length);
  if (released.length) signals.push({ kind: "release", text: `${released[0].commit.shortSha} first shipped in ${released[0].tags[0]}`, cites: [released[0].commit.sha] });

  if (changes.length === 1) signals.push({ kind: "initial", text: `these lines have only ever been written once, in ${changes[0].commit.shortSha}`, cites: [changes[0].commit.sha] });

  const authors = new Set(changes.map((c) => c.commit.authorEmail));
  if (authors.size === 1 && changes.length > 1) signals.push({ kind: "single-author", text: `every change to these lines was made by ${changes[0].commit.author}`, cites: [] });

  if (changes.length && changes.every((c) => c.isMerge)) signals.push({ kind: "merge-only", text: "only merge commits touch these lines, so the real change is on a branch whose commits are not in this history", cites: [] });

  // How much the history actually says.
  const best = Math.max(0, ...changes.map((c) => c.informative));
  let confidence: Confidence, because: string;
  if (!changes.length) { confidence = "thin"; because = "git has no history for these lines"; }
  else if (best >= 2) { confidence = "clear"; because = `${changes.filter((c) => c.informative >= 2).length} of ${changes.length} commit messages explain a reason, not just a change`; }
  else if (best === 1 || issues.length || signals.some((s) => s.kind === "revert" || s.kind === "reapplied")) { confidence = "partial"; because = issues.length ? "the commits point at issues whyline cannot read" : "the commit messages say what changed but not why"; }
  else { confidence = "thin"; because = `every commit message here is generic (${changes.map((c) => `"${c.commit.subject.slice(0, 20)}"`).slice(0, 3).join(", ")})`; }

  return {
    question: q,
    changes,
    signals,
    confidence,
    because,
    searched: { commitsInRepo: commitCount(o), shallow: isShallow(o), limit: o.limit, truncated: changes.length >= o.limit },
  };
}

/** The lines currently at the range, used to show what was asked about. */
export function questionFor(o: GitOptions, file: string, start: number, end: number, asked: string | null): Question {
  return { file, start, end, text: currentLines(o, file, start, end), asked };
}

export { blame };
