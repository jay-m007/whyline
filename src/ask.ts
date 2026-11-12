// The model's only job: read the commits whyline collected and say why the code is the way it is.
//
// It is given nothing but those commits. Its answer is thrown away unless it cites commits that
// really exist in the evidence, because an answer nobody can check is worth less than no answer.
// When the commit messages say nothing, the model is not asked at all: there is nothing to read.

import type { Evidence, Change } from "./evidence.ts";

export interface AskOptions { host: string; model: string; timeoutMs: number }

export interface Answer {
  /** The answer, or null when there is none to give. */
  text: string | null;
  /** Short shas the answer rests on, every one checked against the evidence. */
  cites: string[];
  /** Set when the model said the commits do not explain the code. */
  saidNotEnough: boolean;
  /** Cites the model made up, which were dropped. */
  invented: string[];
  ms: number;
  /** Why there is no answer. */
  skipped: string | null;
}

const SCHEMA = {
  type: "object",
  properties: {
    enough: { type: "boolean" },
    answer: { type: "string" },
    cites: { type: "array", items: { type: "string" } },
  },
  required: ["enough", "answer", "cites"],
} as const;

const SYSTEM = [
  "You are given the commits that changed a particular piece of code, oldest first, with their messages and the lines they changed.",
  "Say why the code is the way it is now, in at most three sentences, using only what those commits say.",
  "Put the commit ids you relied on in cites, copied exactly as they appear under id:.",
  "Never mention a commit id that is not in the list. Never state a cause the commits do not give; if they only say what changed and not why, set enough to false and leave answer empty.",
  "Do not describe what the code does line by line: the reader can read the code. Explain why it is not simpler.",
  "No greeting, no bullet points, no markdown.",
].join("\n");

/** Trims a commit body to something a small model can hold without losing the reason. */
function shortBody(body: string, max = 320): string {
  const text = body.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  // Drop trailing metadata lines, which say nothing about why.
  const useful = text.split("\n").filter((l) => !/^(Signed-off-by|Co-authored-by|Change-Id|Reviewed-by|Acked-by|Tested-by|Cc):/i.test(l.trim())).join("\n").trim();
  return useful.length > max ? useful.slice(0, max).replace(/\s\S*$/, "") + "…" : useful;
}

function changeBlock(c: Change): string {
  const lines = [`id: ${c.commit.shortSha}`, `when: ${c.commit.date.slice(0, 10)}`, `who: ${c.commit.author}`, `message: ${c.commit.subject}`];
  const body = shortBody(c.commit.body);
  if (body) lines.push(`details: ${body}`);
  if (c.reverts) lines.push(`this commit undoes an earlier one in this list`);
  if (c.removed.length) lines.push(`removed: ${c.removed.slice(0, 6).map((l) => l.trim()).filter(Boolean).join(" / ").slice(0, 200)}`);
  if (c.added.length) lines.push(`added: ${c.added.slice(0, 8).map((l) => l.trim()).filter(Boolean).join(" / ").slice(0, 260)}`);
  return lines.join("\n");
}

/** The whole prompt, which is also what gets printed by --show-prompt so it can be checked. */
export function prompt(e: Evidence, maxCommits = 6): string {
  // The most recent commits matter most, but the first one explains why the code exists at all.
  const picked = e.changes.length > maxCommits ? [e.changes[0], ...e.changes.slice(-(maxCommits - 1))] : e.changes;
  const parts = [
    `file: ${e.question.file} lines ${e.question.start}-${e.question.end}`,
    `the code now:\n${e.question.text.map((l) => "  " + l).join("\n")}`,
    ...(e.question.asked ? [`the question: ${e.question.asked}`] : []),
    `commits that changed these lines, oldest first:\n\n${picked.map(changeBlock).join("\n\n")}`,
  ];
  const proven = e.signals.filter((s) => s.kind === "revert" || s.kind === "reapplied").map((s) => "- " + s.text);
  if (proven.length) parts.push(`what git proves about these commits:\n${proven.join("\n")}`);
  if (e.changes.length > picked.length) parts.push(`(${e.changes.length - picked.length} commits in the middle were left out to keep this short)`);
  return parts.join("\n\n");
}

export async function ask(e: Evidence, o: AskOptions): Promise<Answer> {
  const started = performance.now();
  const out: Answer = { text: null, cites: [], saidNotEnough: false, invented: [], ms: 0, skipped: null };
  if (!e.changes.length) { out.skipped = "there is no history to read"; return out; }
  if (e.confidence === "thin") { out.skipped = "the commit messages do not explain anything, so there is nothing for a model to read"; return out; }

  let parsed: { enough?: unknown; answer?: unknown; cites?: unknown };
  try {
    const res = await fetch(`${o.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: o.model,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt(e) }],
        stream: false, format: SCHEMA, options: { temperature: 0, num_predict: 300 },
      }),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    if (!res.ok) { out.skipped = res.status === 404 ? `the model ${o.model} is not installed: run ollama pull ${o.model}` : `Ollama returned ${res.status}`; return out; }
    const body = (await res.json()) as { message?: { content?: string } };
    parsed = JSON.parse(body.message?.content ?? "{}");
  } catch (e2) {
    const err = e2 as Error;
    out.skipped = err.name === "TimeoutError" ? `the model did not answer within ${Math.round(o.timeoutMs / 1000)} s` : `Ollama is not reachable at ${o.host} (${err.message})`;
    out.ms = Math.round(performance.now() - started);
    return out;
  }
  out.ms = Math.round(performance.now() - started);

  if (parsed.enough === false) { out.saidNotEnough = true; out.skipped = "the model was given the commits and said they do not explain why"; return out; }

  const known = new Map(e.changes.map((c) => [c.commit.shortSha, c.commit.shortSha]));
  const resolve = (raw: string): string | null => {
    const id = raw.trim().replace(/^[#(]|[),.]$/g, "").toLowerCase();
    if (!id) return null;
    if (known.has(id)) return id;
    for (const c of e.changes) if (c.commit.sha.startsWith(id) || id.startsWith(c.commit.shortSha)) return c.commit.shortSha;
    return null;
  };

  const raw = Array.isArray(parsed.cites) ? parsed.cites.filter((c): c is string => typeof c === "string") : [];
  for (const r of raw) {
    const hit = resolve(r);
    if (hit) { if (!out.cites.includes(hit)) out.cites.push(hit); }
    else if (!out.invented.includes(r.trim())) out.invented.push(r.trim());
  }

  const text = typeof parsed.answer === "string" ? parsed.answer.replace(/\s+/g, " ").trim() : "";
  if (!text) { out.skipped = "the model returned an empty answer"; return out; }

  // An id inside the prose that is not a real commit means the answer cannot be trusted at all.
  const mentioned = text.match(/\b[0-9a-f]{7,40}\b/g) ?? [];
  const fake = mentioned.filter((m) => !resolve(m));
  if (fake.length) { for (const f of fake) if (!out.invented.includes(f)) out.invented.push(f); out.skipped = `the answer referred to ${fake.join(", ")}, which is not one of these commits`; return out; }

  if (!out.cites.length) { out.skipped = "the answer cited no commit, so there is nothing to check it against"; return out; }

  out.text = text.length > 600 ? text.slice(0, 597).replace(/\s\S*$/, "") + "…" : text;
  return out;
}
