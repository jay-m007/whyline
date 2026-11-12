#!/usr/bin/env node
// why — ask why a line of code exists, and get an answer that cites the commits.

import { relative, resolve, isAbsolute } from "node:path";
import { repoRoot, pathExists, findLine, GitError } from "./git.ts";
import { gather, questionFor } from "./evidence.ts";
import { ask, prompt } from "./ask.ts";
import type { Answer } from "./ask.ts";
import { report } from "./report.ts";
import { splitTarget } from "./target.ts";

const VERSION = "0.1.0";

const USAGE = `why ${VERSION} — why is this line of code like this?

  why <file>:<line>              the history of one line
  why <file>:<start>-<end>       the history of a range
  why <file>                     the history of the whole file
  why <file> --match <text>       find the line by its text instead of a number

      --limit N        how many commits to walk back (default 40)
      --no-model       collect the evidence and print it, ask nothing
      --model NAME     model to use (default $WHYLINE_MODEL or llama3.2:1b)
      --host URL       Ollama (default $OLLAMA_HOST or http://127.0.0.1:11434)
      --timeout MS     how long to wait for the model (default 20000)
      --fast           skip revert detection, which costs a git call per commit
      --show-prompt    print exactly what the model would be asked, and stop
      --json           machine-readable output
  -v, --verbose        commit bodies and timings
  -C <dir>             run as if in this directory

Exit codes: 0 answered, 1 no answer could be supported by the commits, 2 bad usage.
`;

interface Options { limit: number; model: boolean; modelName: string; host: string; timeout: number; fast: boolean; showPrompt: boolean; json: boolean; verbose: boolean; cwd: string; match: string | null; color: boolean }

function parseArgv(argv: string[]): { target: string | null; o: Options } {
  const o: Options = {
    limit: 40,
    model: process.env.WHYLINE_MODEL !== "off",
    modelName: process.env.WHYLINE_MODEL && process.env.WHYLINE_MODEL !== "off" ? process.env.WHYLINE_MODEL : "llama3.2:1b",
    host: (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/^(?!http)/, "http://"),
    timeout: Number(process.env.WHYLINE_TIMEOUT_MS || 20_000),
    fast: false, showPrompt: false, json: false, verbose: false,
    cwd: process.cwd(), match: null,
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
  };
  let target: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") { o.limit = Math.max(1, Number(argv[++i] ?? o.limit)); continue; }
    if (a === "--no-model") { o.model = false; continue; }
    if (a === "--model") { o.modelName = argv[++i] ?? o.modelName; continue; }
    if (a === "--host") { o.host = (argv[++i] ?? o.host).replace(/^(?!http)/, "http://"); continue; }
    if (a === "--timeout") { o.timeout = Number(argv[++i] ?? o.timeout); continue; }
    if (a === "--fast") { o.fast = true; continue; }
    if (a === "--show-prompt") { o.showPrompt = true; continue; }
    if (a === "--json") { o.json = true; continue; }
    if (a === "-v" || a === "--verbose") { o.verbose = true; continue; }
    if (a === "--no-color") { o.color = false; continue; }
    if (a === "--match" || a === "-m") { o.match = argv[++i] ?? null; continue; }
    if (a === "-C") { o.cwd = resolve(o.cwd, argv[++i] ?? "."); continue; }
    if (a === "--help" || a === "-h") { target = "--help"; continue; }
    if (a === "--version") { target = "--version"; continue; }
    if (a.startsWith("-")) { process.stderr.write(`why: unknown option ${a}\n`); process.exit(2); }
    target ??= a;
  }
  return { target, o };
}

async function main(): Promise<number> {
  const { target, o } = parseArgv(process.argv.slice(2));
  if (!target || target === "--help") { process.stdout.write(USAGE); return target ? 0 : 2; }
  if (target === "--version") { process.stdout.write(VERSION + "\n"); return 0; }

  let root: string;
  try { root = repoRoot(o.cwd); } catch (e) { process.stderr.write(`why: ${(e as Error).message}\n`); return 2; }

  const parsed = splitTarget(target);
  const abs = isAbsolute(parsed.file) ? parsed.file : resolve(o.cwd, parsed.file);
  const file = relative(root, abs) || parsed.file;
  const git = { cwd: root };

  if (!pathExists(git, file)) {
    process.stderr.write(`why: ${file} is not in this repository at HEAD${parsed.file.includes(":") ? "" : " (use <file>:<line> to ask about one line)"}\n`);
    return 2;
  }

  let start = parsed.start, end = parsed.end;
  if (o.match) {
    const hit = findLine(git, file, o.match);
    if (!hit) { process.stderr.write(`why: no line in ${file} contains ${JSON.stringify(o.match)}\n`); return 2; }
    start = hit.line; end = hit.line;
  }
  if (start === null) {
    // The whole file: ask about every line, which git log -L accepts as a range.
    const lines = (await import("./git.ts")).currentLines(git, file, 1, 1_000_000).length;
    start = 1; end = Math.max(1, lines);
  }

  let evidence;
  try {
    evidence = gather({ ...git, limit: o.limit, fast: o.fast }, questionFor(git, file, start!, end!, null));
  } catch (e) {
    process.stderr.write(`why: ${e instanceof GitError ? e.message : String(e)}\n`);
    return 2;
  }

  if (o.showPrompt) { process.stdout.write(prompt(evidence) + "\n"); return 0; }

  let answer: Answer | null = null;
  if (o.model) answer = await ask(evidence, { host: o.host, model: o.modelName, timeoutMs: o.timeout });

  if (o.json) {
    process.stdout.write(JSON.stringify({
      question: evidence.question, confidence: evidence.confidence, because: evidence.because,
      answer: answer && { text: answer.text, cites: answer.cites, invented: answer.invented, skipped: answer.skipped, ms: answer.ms },
      changes: evidence.changes.map((c) => ({ sha: c.commit.sha, shortSha: c.commit.shortSha, author: c.commit.author, date: c.commit.date, subject: c.commit.subject, body: c.commit.body, issues: c.issues, tags: c.tags, reverts: c.reverts, revertedBy: c.revertedBy, informative: c.informative })),
      signals: evidence.signals, searched: evidence.searched,
    }, null, 2) + "\n");
    return answer?.text ? 0 : 1;
  }

  process.stdout.write(report(evidence, answer, { color: o.color, width: Math.min(process.stdout.columns || 92, 92), verbose: o.verbose }));
  return answer?.text ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { process.stderr.write(`why: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(2); });
