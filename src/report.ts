// Printing the case. The evidence is always shown, whether or not there is an answer, because the
// commits are the actual product here: the answer is a convenience on top of them.

import type { Evidence } from "./evidence.ts";
import type { Answer } from "./ask.ts";

const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", grey: "\x1b[90m", yellow: "\x1b[33m", green: "\x1b[32m", blue: "\x1b[34m" };

export interface ReportOptions { color: boolean; width: number; verbose: boolean }

export function report(e: Evidence, a: Answer | null, o: ReportOptions): string {
  const c = (code: string, s: string) => (o.color ? code + s + C.reset : s);
  const out: string[] = [""];
  const q = e.question;
  out.push(`  ${c(C.bold, `${q.file}:${q.start}${q.end !== q.start ? `-${q.end}` : ""}`)}`);

  if (q.text.length) {
    out.push("");
    for (const line of q.text.slice(0, 12)) out.push(`  ${c(C.grey, "│")} ${c(C.dim, line.slice(0, o.width - 6))}`);
    if (q.text.length > 12) out.push(`  ${c(C.grey, "│")} ${c(C.dim, `… ${q.text.length - 12} more lines`)}`);
  }

  out.push("");
  if (a?.text) {
    for (const line of wrap(a.text, o.width - 4)) out.push(`  ${line}`);
    out.push(`  ${c(C.grey, "— " + a.cites.join(", "))}`);
  } else if (a) {
    out.push(`  ${c(C.yellow, "no answer:")} ${wrap(a.skipped ?? "the model gave nothing usable", o.width - 14).join("\n              ")}`);
    if (e.confidence === "thin" || a.saidNotEnough) out.push(`  ${c(C.grey, "the commits below are everything whyline found, and the reason is not in them.")}`);
  } else {
    out.push(`  ${c(C.grey, "the commits below are what whyline found. No model was asked.")}`);
  }

  if (a?.invented.length) out.push("", `  ${c(C.yellow, "dropped:")} the model referred to ${a.invented.join(", ")}, which ${a.invented.length === 1 ? "is" : "are"} not in this history`);

  out.push("", `  ${c(C.bold, "history")}   ${e.changes.length === 1 ? "1 commit" : `${e.changes.length} commits`}, oldest first`);
  for (const ch of e.changes) {
    const marks: string[] = [];
    if (ch.reverts) marks.push("undoes " + (e.changes.find((x) => x.commit.sha === ch.reverts)?.commit.shortSha ?? ""));
    if (ch.revertedBy) marks.push("later undone");
    if (ch.isMerge) marks.push("merge");
    if (ch.tags.length) marks.push(ch.tags[0]);
    const cited = a?.cites.includes(ch.commit.shortSha);
    out.push(`    ${cited ? c(C.green, "›") : " "} ${c(C.bold, ch.commit.shortSha)}  ${c(C.grey, ch.commit.date.slice(0, 10))}  ${ch.commit.author.slice(0, 16).padEnd(16)} ${ch.commit.subject.slice(0, Math.max(20, o.width - 52))}${marks.length ? c(C.grey, "  [" + marks.join(", ") + "]") : ""}`);
    if (o.verbose && ch.commit.body) for (const l of ch.commit.body.split("\n").slice(0, 4)) out.push(`        ${c(C.dim, l.slice(0, o.width - 10))}`);
  }

  const proven = e.signals.filter((s) => s.kind !== "single-author");
  if (proven.length) {
    out.push("", `  ${c(C.bold, "what git shows")}`);
    for (const s of proven) for (const [i, line] of wrap(s.text, o.width - 8).entries()) out.push(`    ${i === 0 ? c(C.grey, "·") : " "} ${line}`);
  }

  const notes = [
    `${e.confidence === "clear" ? "the history explains this" : e.confidence === "partial" ? "the history partly explains this" : "the history does not explain this"}: ${e.because}`,
    `searched ${e.changes.length === e.searched.commitsInRepo ? "all" : "back through"} ${e.searched.commitsInRepo} ${e.searched.commitsInRepo === 1 ? "commit" : "commits"} in this repository`,
    ...(e.searched.shallow ? ["this is a shallow clone, so older commits are missing: git fetch --unshallow would change this answer"] : []),
    ...(e.searched.truncated ? [`stopped at the --limit of ${e.searched.limit} commits, so there may be more`] : []),
    ...(a && o.verbose && a.ms ? [`the model took ${a.ms} ms`] : []),
  ];
  out.push("");
  for (const n of notes) for (const [i, line] of wrap(n, o.width - 6).entries()) out.push(`  ${c(C.grey, i === 0 ? n.startsWith("searched") || n.startsWith("the history") ? "" : "" : "  ")}${c(C.grey, line)}`);
  out.push("");
  return out.join("\n");
}

export function wrap(text: string, width: number): string[] {
  if (width < 24) return [text];
  const lines: string[] = [];
  let line = "";
  for (const w of text.split(" ")) {
    if (line && line.length + w.length + 1 > width) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}
