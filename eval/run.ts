// Measures the model against histories whose story is known in advance.
//
// Two things matter and both are measured here. First, whether the model finds the reason that is
// genuinely written in the commits. Second, and more important, whether it refuses when the reason
// is not written down anywhere: a confident answer invented from "wip" and "fix" is the one failure
// mode that would make whyline worth less than running git log by hand.
//
//   npm run eval
//   node eval/run.ts --model llama3.2:1b

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { gather, questionFor } from "../src/evidence.ts";
import { ask } from "../src/ask.ts";

interface Case { name: string; commits: { file: string; body: string; message: string }[]; line: number; expect: "answerable" | "refused" | "refused-or-hedged" | "either"; mustMention: string[] }

const args = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const host = flag("host", process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/^(?!http)/, "http://");
const model = flag("model", process.env.WHYLINE_MODEL && process.env.WHYLINE_MODEL !== "off" ? process.env.WHYLINE_MODEL : "llama3.2:1b");
const timeout = Number(flag("timeout", "30000"));
const { cases } = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as { cases: Case[] };

function buildRepo(c: Case): string {
  const root = join(mkdtempSync(join(tmpdir(), "whyline-eval-")), "repo");
  mkdirSync(root, { recursive: true });
  const git = (a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "Eval", GIT_AUTHOR_EMAIL: "e@x.c", GIT_COMMITTER_NAME: "Eval", GIT_COMMITTER_EMAIL: "e@x.c" } });
  git(["init", "-q", "-b", "main", "."]);
  git(["config", "commit.gpgsign", "false"]);
  for (const c2 of c.commits) {
    const p = join(root, c2.file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c2.body);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", c2.message]);
  }
  return root;
}

async function main(): Promise<void> {
  process.stdout.write(`whyline eval\n  host   ${host}\n  model  ${model}\n\n`);
  try {
    const tags = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const installed = ((await tags.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
    process.stdout.write(`  installed: ${installed.join(", ") || "none"}\n\n`);
    if (!installed.some((m) => m === model || m.split(":")[0] === model.split(":")[0])) { process.stdout.write(`  ${model} is not installed. Run: ollama pull ${model}\n`); process.exit(1); }
  } catch (e) {
    process.stdout.write(`  Ollama is not answering at ${host}: ${e instanceof Error ? e.message : String(e)}\n  Start it with "ollama serve".\n`);
    process.exit(1);
  }

  let right = 0, invented = 0, refusedWhenItShould = 0, shouldRefuse = 0, answeredWhenItShould = 0, shouldAnswer = 0;
  const latencies: number[] = [];
  const rows: unknown[] = [];

  for (const c of cases) {
    const root = buildRepo(c);
    const o = { cwd: root, limit: 40 };
    const e = gather(o, questionFor(o, c.commits[0].file, c.line, c.line, null));
    const a = await ask(e, { host, model, timeoutMs: timeout });
    latencies.push(a.ms);

    const answered = a.text !== null;
    const mentioned = c.mustMention.filter((m) => (a.text ?? "").toLowerCase().includes(m.toLowerCase()));
    const mentionedAll = mentioned.length === c.mustMention.length;
    if (a.invented.length) invented++;

    let verdict: string;
    if (c.expect === "answerable") {
      shouldAnswer++;
      if (answered) answeredWhenItShould++;
      verdict = answered ? (mentionedAll ? "ok" : `thin (missed ${c.mustMention.filter((m) => !mentioned.includes(m)).join(", ")})`) : "MISSED the reason";
      if (answered && mentionedAll) right++;
    } else if (c.expect === "refused" || c.expect === "refused-or-hedged") {
      shouldRefuse++;
      if (!answered) { refusedWhenItShould++; right++; verdict = "ok, refused"; }
      else verdict = c.expect === "refused" ? "INVENTED a reason" : "answered where it should hedge";
    } else {
      right++;
      verdict = answered ? "answered" : "refused";
    }

    process.stdout.write(`  ${verdict.padEnd(34)} ${String(a.ms).padStart(6)} ms  ${c.name}\n`);
    if (answered) process.stdout.write(`      ${(a.text ?? "").slice(0, 100)}\n`);
    else if (a.skipped) process.stdout.write(`      (${a.skipped})\n`);
    rows.push({ name: c.name, expect: c.expect, answered, text: a.text, cites: a.cites, invented: a.invented, confidence: e.confidence, ms: a.ms, verdict });
  }

  const q = (p: number) => { const s = [...latencies].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
  process.stdout.write([
    ``,
    `  found the written reason    ${answeredWhenItShould}/${shouldAnswer}`,
    `  refused when nothing said   ${refusedWhenItShould}/${shouldRefuse}`,
    `  invented a commit id        ${invented}/${cases.length}   (dropped by whyline before it was shown)`,
    `  latency p50 / p95           ${q(0.5)} / ${q(0.95)} ms`,
    ``,
    `  The second line is the one that matters. whyline is only worth running if it stays quiet`,
    `  when the history does not explain the code; a plausible answer invented from "wip" and "fix"`,
    `  is worse than no answer, because there is no way for the reader to tell.`,
    ``,
  ].join("\n"));

  writeFileSync(new URL(`./results-${model.replace(/[:/]/g, "-")}.json`, import.meta.url), JSON.stringify({ model, host, when: new Date().toISOString(), foundReason: [answeredWhenItShould, shouldAnswer], refused: [refusedWhenItShould, shouldRefuse], invented, p50: q(0.5), p95: q(0.95), rows }, null, 2));
  process.stdout.write(`written to eval/results-${model.replace(/[:/]/g, "-")}.json\n`);
}

main().catch((e) => { process.stderr.write(`eval failed: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
