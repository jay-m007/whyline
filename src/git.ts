// Everything whyline knows comes from these calls. Each one is a plain git command, so anything
// whyline claims can be checked by hand with the same command.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export class GitError extends Error {}

export interface GitOptions { cwd: string; timeoutMs?: number }

/** Runs git and returns stdout. Nothing is trimmed, because git's porcelain formats use leading columns. */
export function git(o: GitOptions, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: o.cwd, encoding: "utf8", timeout: o.timeoutMs ?? 20_000, maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stderr?: string; message?: string; code?: string };
    if (err.code === "ETIMEDOUT") throw new GitError(`git ${args[0]} took longer than ${(o.timeoutMs ?? 20_000) / 1000} s`);
    throw new GitError((err.stderr || err.message || "git failed").toString().trim().split("\n")[0]);
  }
}

/** Same, but returns null instead of throwing: for questions git is allowed to answer with "no". */
export function gitOrNull(o: GitOptions, args: string[]): string | null {
  try { return git(o, args); } catch { return null; }
}

export function repoRoot(cwd: string): string {
  const root = gitOrNull({ cwd }, ["rev-parse", "--show-toplevel"])?.trim();
  if (!root) throw new GitError(`${cwd} is not inside a git repository`);
  return root;
}

/** The current clone only has part of the history when it was cloned shallow, which changes every answer. */
export function isShallow(o: GitOptions): boolean {
  return gitOrNull(o, ["rev-parse", "--is-shallow-repository"])?.trim() === "true";
}

export interface Commit {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
  /** Number of parents: 2 or more means a merge. */
  parents: string[];
}

// Each commit record starts with \x01 and its fields end with \x02, so a record can be told apart
// from the diff text that git log -L prints after it. Fields themselves are NUL-separated.
const REC = "\u0001", ENDF = "\u0002";
const FORMAT = "%x01" + ["%H", "%h", "%an", "%ae", "%aI", "%P", "%s", "%b"].join("%x00") + "%x02";

interface Record { commit: Commit; rest: string }

/** Splits git's output into commit records and whatever followed each one. */
function parseRecords(out: string): Record[] {
  const records: Record[] = [];
  for (const piece of out.split(REC)) {
    const cut = piece.indexOf(ENDF);
    if (cut < 0) continue;
    const f = piece.slice(0, cut).split("\u0000");
    if (f.length < 8 || !/^[0-9a-f]{40}$/.test(f[0])) continue;
    records.push({
      commit: { sha: f[0], shortSha: f[1], author: f[2], authorEmail: f[3], date: f[4], parents: f[5].split(" ").filter(Boolean), subject: f[6], body: f.slice(7).join("\u0000").trim() },
      rest: piece.slice(cut + ENDF.length),
    });
  }
  return records;
}

const parseCommits = (out: string): Commit[] => parseRecords(out).map((r) => r.commit);

export function showCommit(o: GitOptions, sha: string): Commit | null {
  const out = gitOrNull(o, ["show", "-s", `--format=${FORMAT}`, sha]);
  return out ? parseCommits(out)[0] ?? null : null;
}

export interface LineHistoryEntry { commit: Commit; /** The diff hunk for the lines asked about, as git printed it. */ hunk: string }

/**
 * The history of one line range, following it through renames and moves.
 * This is git log -L, the one primitive that makes any of this possible: given a file and a line
 * range, git works out which commits touched those particular lines, even as they moved.
 */
export function lineHistory(o: GitOptions, file: string, start: number, end: number, max: number): LineHistoryEntry[] {
  // git log -L prints each commit's header followed by the diff of just those lines, newest first.
  const out = git(o, ["log", `--format=${FORMAT}`, "--no-color", `-L${start},${end}:${file}`, `-n${max}`]);
  return parseRecords(out).map((r) => ({ commit: r.commit, hunk: r.rest.replace(/^\n+/, "").trimEnd() }));
}

/** The history of a whole file, following renames. */
export function fileHistory(o: GitOptions, file: string, max: number): Commit[] {
  return parseCommits(git(o, ["log", `--format=${FORMAT}`, "--follow", `-n${max}`, "--", file]));
}

/** The commit that last changed a line, from blame. */
export interface BlameLine { sha: string; line: number; text: string }

export function blame(o: GitOptions, file: string, start: number, end: number): BlameLine[] {
  const out = gitOrNull(o, ["blame", "--porcelain", `-L${start},${end}`, "HEAD", "--", file]);
  if (!out) return [];
  const lines: BlameLine[] = [];
  let sha = "", lineNo = 0;
  for (const l of out.split("\n")) {
    const header = /^([0-9a-f]{40})\s+\d+\s+(\d+)/.exec(l);
    if (header) { sha = header[1]; lineNo = Number(header[2]); continue; }
    if (l.startsWith("\t")) lines.push({ sha, line: lineNo, text: l.slice(1) });
  }
  return lines;
}

/**
 * A fingerprint of what a commit actually changed: the added and removed lines per file, with
 * nothing else. Comparing a commit's fingerprint with another commit's reversed fingerprint is how
 * whyline can state "this commit undid that one" as a fact instead of trusting a commit message.
 *
 * git patch-id looks like the right tool for this and is not: reversing a diff swaps the a/ and b/
 * prefixes in the header lines, which patch-id hashes, so a commit and its own revert come out with
 * different ids. Only the changed lines are compared here, so that swap does not matter.
 */
export function changeFingerprint(o: GitOptions, sha: string, reverse = false): string | null {
  let show: string;
  try { show = git({ ...o, timeoutMs: 10_000 }, ["show", "--format=", "-U0", "--no-color", sha]); } catch { return null; }
  if (!show.trim()) return null;
  const perFile = new Map<string, string[]>();
  let file = "";
  for (const line of show.split("\n")) {
    const header = /^diff --git [ab]\/(.+?) [ab]\/(.+)$/.exec(line);
    if (header) { file = header[2]; if (!perFile.has(file)) perFile.set(file, []); continue; }
    if (/^(\+\+\+|---|index |similarity |rename |new file|deleted file|old mode|new mode|Binary )/.test(line)) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      let sign = line[0];
      if (reverse) sign = sign === "+" ? "-" : "+";
      perFile.get(file)?.push(sign + line.slice(1).trim());
    }
  }
  const canonical = [...perFile.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([f, lines]) => f + "\n" + [...lines].sort().join("\n")).join("\n--\n");
  if (!canonical.trim()) return null;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** Released tags that contain a commit, oldest first. */
export function tagsContaining(o: GitOptions, sha: string): string[] {
  const out = gitOrNull(o, ["tag", "--contains", sha, "--sort=creatordate"]);
  return out ? out.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 3) : [];
}

/** The lines currently at a range, for showing what is being asked about. */
export function currentLines(o: GitOptions, file: string, start: number, end: number): string[] {
  const out = gitOrNull(o, ["show", `HEAD:${file}`]);
  const text = out ?? "";
  return text.split("\n").slice(start - 1, end);
}

/** Does this path exist in HEAD? */
export function pathExists(o: GitOptions, file: string): boolean {
  return gitOrNull(o, ["cat-file", "-e", `HEAD:${file}`]) !== null;
}

/** How many commits the repository has, to say honestly how much history was searched. */
export function commitCount(o: GitOptions): number {
  return Number(gitOrNull(o, ["rev-list", "--count", "HEAD"])?.trim() ?? "0") || 0;
}

/** Finds the first line matching a pattern in a file at HEAD, so a question can name text instead of a number. */
export function findLine(o: GitOptions, file: string, pattern: string): { line: number; text: string } | null {
  const out = gitOrNull(o, ["grep", "-n", "--fixed-strings", "-e", pattern, "HEAD", "--", file]);
  if (!out) return null;
  const m = /^[^:]*:[^:]*:(\d+):(.*)$/m.exec(out);
  return m ? { line: Number(m[1]), text: m[2] } : null;
}
