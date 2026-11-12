import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { newRepo, cleanup } from "./helpers.ts";
import { splitTarget } from "../src/target.ts";

after(cleanup);
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

function why(args: string[], cwd: string): { out: string; code: number } {
  try {
    return { out: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd, env: { ...process.env, NO_COLOR: "1", WHYLINE_MODEL: "off" } }), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: (err.stdout ?? "") + (err.stderr ?? ""), code: err.status ?? -1 };
  }
}

test("a file and line are split apart correctly", () => {
  assert.deepEqual(splitTarget("src/a.ts:12"), { file: "src/a.ts", start: 12, end: 12 });
  assert.deepEqual(splitTarget("src/a.ts:12-18"), { file: "src/a.ts", start: 12, end: 18 });
  assert.deepEqual(splitTarget("src/a.ts"), { file: "src/a.ts", start: null, end: null });
  assert.deepEqual(splitTarget("C:/work/a.ts"), { file: "C:/work/a.ts", start: null, end: null }, "a drive letter is not a line number");
});

test("asking about one line prints the line, the history and what git shows", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "const timeout = 1000;\n" }, message: "initial" })
    .commit({ files: { "a.ts": "const timeout = 30000;\n" }, message: "Raise the timeout because slow clients were being cut off" });
  const r = why(["a.ts:1"], repo.root);
  assert.match(r.out, /a\.ts:1/);
  assert.match(r.out, /const timeout = 30000;/);
  assert.match(r.out, /Raise the timeout/);
  assert.match(r.out, /No model was asked/);
  assert.equal(r.code, 1, "with no answer the exit code says so");
});

test("a line that was never changed says exactly that", () => {
  const repo = newRepo().commit({ files: { "a.ts": "const x = 1;\n" }, message: "initial" });
  assert.match(why(["a.ts:1"], repo.root).out, /only ever been written once/);
});

test("a thin history is reported as not explaining anything", () => {
  const repo = newRepo().commit({ files: { "a.ts": "x\n" }, message: "wip" }).commit({ files: { "a.ts": "y\n" }, message: "fix" });
  const r = why(["a.ts:1"], repo.root);
  assert.match(r.out, /does not explain this/);
  assert.match(r.out, /generic/);
});

test("--match finds the line by its text so a number is not needed", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "const a = 1;\nconst retries = 3;\nconst b = 2;\n" }, message: "initial" })
    .commit({ files: { "a.ts": "const a = 1;\nconst retries = 5;\nconst b = 2;\n" }, message: "More retries because the upstream is flaky at peak" });
  const r = why(["a.ts", "--match", "retries"], repo.root);
  assert.match(r.out, /a\.ts:2/);
  assert.match(r.out, /More retries/);
});

test("--match with no hit says so instead of guessing a line", () => {
  const repo = newRepo().commit({ files: { "a.ts": "x\n" }, message: "initial" });
  const r = why(["a.ts", "--match", "nothing-like-this"], repo.root);
  assert.equal(r.code, 2);
  assert.match(r.out, /no line in a\.ts contains/);
});

test("asking about a whole file works without a line number", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "one\ntwo\n" }, message: "Add the thing" })
    .commit({ files: { "a.ts": "one\ntwo\nthree\n" }, message: "Extend it because two was not enough" });
  const r = why(["a.ts"], repo.root);
  assert.match(r.out, /Add the thing/);
  assert.match(r.out, /Extend it/);
});

test("a path that is not in the repository is reported clearly", () => {
  const repo = newRepo().commit({ files: { "a.ts": "x\n" }, message: "initial" });
  const r = why(["nope.ts:1"], repo.root);
  assert.equal(r.code, 2);
  assert.match(r.out, /not in this repository/);
});

test("running outside a repository says so rather than crashing", () => {
  const r = why(["a.ts:1"], "/tmp");
  assert.equal(r.code, 2);
  assert.match(r.out, /not inside a git repository/);
});

test("--json gives the whole case, including the signals", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "x\n" }, message: "initial" })
    .commit({ files: { "a.ts": "y\n" }, message: "Change it because of a reason. Fixes #7" });
  const r = why(["a.ts:1", "--json"], repo.root);
  const parsed = JSON.parse(r.out) as { confidence: string; changes: { subject: string; issues: number[] }[]; signals: { kind: string }[] };
  assert.equal(parsed.confidence, "clear");
  assert.equal(parsed.changes.length, 2);
  assert.deepEqual(parsed.changes[1].issues, [7]);
  assert.ok(parsed.signals.some((s) => s.kind === "issue"));
});

test("--show-prompt prints what the model would be asked and stops", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "x\n" }, message: "initial" })
    .commit({ files: { "a.ts": "y\n" }, message: "Change it because of a specific reason" });
  const r = why(["a.ts:1", "--show-prompt"], repo.root);
  assert.equal(r.code, 0);
  assert.match(r.out, /^file: a\.ts lines 1-1/m);
  assert.match(r.out, /Change it because/);
  assert.ok(!r.out.includes("history   "), "only the prompt is printed");
});

test("--limit is honoured and the output says it stopped early", () => {
  let repo = newRepo().commit({ files: { "a.ts": "v0\n" }, message: "Initial version for a specific reason" });
  for (let i = 1; i <= 5; i++) repo = repo.commit({ files: { "a.ts": `v${i}\n` }, message: `Change ${i} because of a reason` });
  const r = why(["a.ts:1", "--limit", "2"], repo.root);
  assert.match(r.out, /stopped at the --limit of 2/);
});

test("help and an unknown option behave sensibly", () => {
  const repo = newRepo().commit({ files: { "a.ts": "x\n" }, message: "initial" });
  assert.match(why(["--help"], repo.root).out, /why is this line of code like this/);
  assert.equal(why(["--nonsense"], repo.root).code, 2);
});

test("-C runs as if in another directory", () => {
  const repo = newRepo().commit({ files: { "a.ts": "x\n" }, message: "initial" });
  assert.match(why(["-C", repo.root, "a.ts:1"], "/tmp").out, /a\.ts:1/);
});

test("a shallow clone is called out, because it changes the answer", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "one\n" }, message: "The original reason this exists" })
    .commit({ files: { "a.ts": "two\n" }, message: "Changed because of something" });
  const shallow = join(repo.root, "..", "shallow");
  execFileSync("git", ["clone", "-q", "--depth", "1", "file://" + repo.root, shallow], { stdio: "ignore" });
  const r = why(["a.ts:1"], shallow);
  assert.match(r.out, /shallow clone/);
  assert.match(r.out, /unshallow/);
});
