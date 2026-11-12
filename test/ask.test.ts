import { test, after } from "node:test";
import assert from "node:assert/strict";
import { newRepo, cleanup } from "./helpers.ts";
import { startFake, idsInPrompt } from "./fake-ollama.ts";
import { ask, prompt } from "../src/ask.ts";

after(cleanup);

const opts = (host: string, timeoutMs = 5000) => ({ host, model: "test-model", timeoutMs });

/** A repository whose history does explain itself, so the model is actually asked. */
function explained() {
  return newRepo()
    .commit({ files: { "a.ts": "return fetch(URL);\n" }, message: "Add token fetching" })
    .commit({ files: { "a.ts": "return fetch(URL, { retry: true });\n" }, message: "Retry on failure because the endpoint is flaky" })
    .commit({ files: { "a.ts": "return backoff(() => fetch(URL));\n" }, message: "Back off instead of retrying, because retrying made the 429s worse. Fixes #212" });
}

test("an answer that cites real commits is kept", async () => {
  const fake = await startFake();
  const repo = explained();
  const e = repo.look("a.ts", 1);
  fake.replies.push({ enough: true, answer: "It backs off because immediate retries made the 429s worse.", cites: [e.changes[2].commit.shortSha] });
  const a = await ask(e, opts(fake.host));
  assert.match(a.text!, /backs off/);
  assert.deepEqual(a.cites, [e.changes[2].commit.shortSha]);
  assert.deepEqual(a.invented, []);
  await fake.close();
});

test("an answer citing a commit that does not exist is thrown away", async () => {
  const fake = await startFake();
  const e = explained().look("a.ts", 1);
  fake.replies.push({ enough: true, answer: "It was changed for a reason.", cites: ["deadbeef"] });
  const a = await ask(e, opts(fake.host));
  assert.equal(a.text, null);
  assert.deepEqual(a.invented, ["deadbeef"]);
  assert.match(a.skipped!, /cited no commit/);
  await fake.close();
});

test("an answer that mentions a made-up commit id in its prose is thrown away", async () => {
  const fake = await startFake();
  const e = explained().look("a.ts", 1);
  fake.replies.push({ enough: true, answer: "Commit 1234567 introduced this to fix a bug.", cites: [e.changes[2].commit.shortSha] });
  const a = await ask(e, opts(fake.host));
  assert.equal(a.text, null);
  assert.match(a.skipped!, /1234567/);
  await fake.close();
});

test("an answer with no cites at all is thrown away", async () => {
  const fake = await startFake();
  const e = explained().look("a.ts", 1);
  fake.replies.push({ enough: true, answer: "Someone wanted it that way.", cites: [] });
  const a = await ask(e, opts(fake.host));
  assert.equal(a.text, null);
  assert.match(a.skipped!, /nothing to check it against/);
  await fake.close();
});

test("the model saying the commits do not explain it is passed on as that, not as a failure", async () => {
  const fake = await startFake();
  const e = explained().look("a.ts", 1);
  fake.replies.push({ enough: false, answer: "", cites: [] });
  const a = await ask(e, opts(fake.host));
  assert.equal(a.text, null);
  assert.equal(a.saidNotEnough, true);
  assert.match(a.skipped!, /said they do not explain/);
  await fake.close();
});

test("a full-length sha, or one with punctuation around it, still counts as a real cite", async () => {
  const fake = await startFake();
  const repo = explained();
  const e = repo.look("a.ts", 1);
  fake.replies.push({ enough: true, answer: "Backing off replaced the retry.", cites: [e.changes[2].commit.sha, `(${e.changes[1].commit.shortSha})`] });
  const a = await ask(e, opts(fake.host));
  assert.deepEqual(a.cites, [e.changes[2].commit.shortSha, e.changes[1].commit.shortSha]);
  assert.deepEqual(a.invented, []);
  await fake.close();
});

test("the model is never asked when every commit message is generic", async () => {
  const fake = await startFake();
  const repo = newRepo().commit({ files: { "a.ts": "x\n" }, message: "wip" }).commit({ files: { "a.ts": "y\n" }, message: "fix" });
  const a = await ask(repo.look("a.ts", 1), opts(fake.host));
  assert.equal(fake.requests.length, 0, "a model cannot read what is not written down");
  assert.match(a.skipped!, /do not explain anything/);
  await fake.close();
});

test("a timeout is reported and does not throw", async () => {
  const fake = await startFake();
  fake.replies.push(600);
  const a = await ask(explained().look("a.ts", 1), opts(fake.host, 120));
  assert.equal(a.text, null);
  assert.match(a.skipped!, /did not answer within/);
  await fake.close();
});

test("an Ollama that is not running is reported in words a person can act on", async () => {
  const a = await ask(explained().look("a.ts", 1), opts("http://127.0.0.1:1", 500));
  assert.match(a.skipped!, /not reachable/);
});

test("a missing model says which command would install it", async () => {
  const fake = await startFake();
  fake.fail = 404;
  const a = await ask(explained().look("a.ts", 1), opts(fake.host));
  assert.match(a.skipped!, /ollama pull test-model/);
  await fake.close();
});

test("junk instead of json is reported, not thrown", async () => {
  const fake = await startFake();
  for (const junk of ["not json", JSON.stringify({ answer: 7, enough: true, cites: [] }), "{}"]) {
    fake.replies.push(junk);
    const a = await ask(explained().look("a.ts", 1), opts(fake.host));
    assert.equal(a.text, null, `junk accepted: ${junk}`);
  }
  await fake.close();
});

test("the prompt contains the commit ids, messages and changed lines, and nothing else from disk", async () => {
  const fake = await startFake();
  const repo = explained();
  const e = repo.look("a.ts", 1);
  fake.replies.push({ enough: true, answer: "x", cites: [e.changes[2].commit.shortSha] });
  await ask(e, opts(fake.host));
  const ids = idsInPrompt(fake);
  assert.deepEqual(ids, e.changes.map((c) => c.commit.shortSha));
  const user = fake.requests[0].messages[1].content;
  assert.match(user, /Back off instead of retrying/);
  assert.match(user, /backoff/);
  assert.ok(!user.includes(repo.root), "the prompt must not leak absolute paths");
  assert.equal(fake.requests[0].options?.temperature, 0);
  assert.ok(fake.requests[0].format, "a schema must be sent so the answer can be parsed");
  await fake.close();
});

test("a long history is trimmed but keeps the first commit and the most recent ones", () => {
  let repo = newRepo().commit({ files: { "a.ts": "v0\n" }, message: "The first version, written for a reason worth keeping" });
  for (let i = 1; i <= 10; i++) repo = repo.commit({ files: { "a.ts": `v${i}\n` }, message: `Change number ${i}, because of something specific` });
  const e = repo.look("a.ts", 1);
  const p = prompt(e, 4);
  assert.match(p, /The first version/);
  assert.match(p, /Change number 10/);
  assert.match(p, /commits in the middle were left out/);
  assert.ok(!p.includes("Change number 3"), "the middle should be dropped, not the ends");
});

test("commit trailers are kept out of the prompt", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "x\n" }, message: "initial" })
    .commit({ files: { "a.ts": "y\n" }, message: "Guard against an empty list because the API returns null\n\nSigned-off-by: Someone <s@example.com>" });
  const p = prompt(repo.look("a.ts", 1));
  assert.match(p, /Guard against an empty list/);
  assert.ok(!p.includes("Signed-off-by"), "trailers say nothing about why");
});
