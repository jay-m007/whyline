import { test, after } from "node:test";
import assert from "node:assert/strict";
import { newRepo, cleanup, subjects, signalKinds, signalText } from "./helpers.ts";

after(cleanup);

const fn = (body: string) => `export function getToken() {\n${body}\n}\n`;

test("one line's history follows it through the commits that changed it", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": fn("  return fetch(URL);") }, message: "Add token fetching" })
    .commit({ files: { "a.ts": fn("  return fetch(URL, { retry: true });") }, message: "retry on failure" })
    .commit({ files: { "a.ts": fn("  return backoff(() => fetch(URL));") }, message: "Back off instead of retrying immediately, because the endpoint returns 429 under load" });
  const e = repo.look("a.ts", 2);
  assert.equal(e.changes.length, 3);
  assert.deepEqual(subjects(e).map((s) => s.slice(0, 12)), ["Add token fe", "retry on fai", "Back off ins"], "oldest first");
});

test("a commit that changed another part of the file is not in the answer", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "line1\nline2\nline3\n" }, message: "initial" })
    .commit({ files: { "a.ts": "line1\nline2 changed\nline3\n" }, message: "change line 2" })
    .commit({ files: { "a.ts": "line1\nline2 changed\nline3 changed\n" }, message: "change line 3" });
  const e = repo.look("a.ts", 2);
  assert.deepEqual(subjects(e), ["initial", "change line 2"]);
});

test("a revert is proven from the diff, not taken from the commit message", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": fn("  return fetch(URL);") }, message: "initial" })
    .commit({ files: { "a.ts": fn("  return fetch(URL, { retry: true });") }, message: "add retry" })
    // A deliberately misleading message: it does not say "revert" anywhere.
    .commit({ files: { "a.ts": fn("  return fetch(URL);") }, message: "tidy up the token helper" });
  const e = repo.look("a.ts", 2);
  const undoing = e.changes.find((c) => c.reverts);
  assert.ok(undoing, "the third commit undoes the second and should be detected");
  assert.equal(undoing!.commit.subject, "tidy up the token helper");
  assert.match(signalText(e), /adds back exactly the lines/);
});

test("a message that claims to revert is reported even when the diff does not match", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "one\n" }, message: "initial" })
    .commit({ files: { "a.ts": "two\n" }, message: 'Revert "something that is not here"' });
  assert.ok(signalKinds(newRepoFrom(repo)).includes("revert"));
  function newRepoFrom(r: typeof repo) { return r.look("a.ts", 1); }
});

test("a change that was undone and then put back again is called out", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": fn("  return fetch(URL);") }, message: "initial" })
    .commit({ files: { "a.ts": fn("  return backoff(fetch, URL);") }, message: "add backoff" })
    .commit({ files: { "a.ts": fn("  return fetch(URL);") }, message: "simplify" })
    .commit({ files: { "a.ts": fn("  return backoff(fetch, URL);") }, message: "put the backoff back, the simple version hammered the endpoint" });
  const e = repo.look("a.ts", 2);
  assert.ok(signalKinds(e).includes("reapplied"), `signals were ${signalKinds(e).join(", ")}`);
  assert.match(signalText(e), /put back by/);
});

test("issue numbers are picked up and whyline admits it cannot read them", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "x\n" }, message: "initial" })
    .commit({ files: { "a.ts": "y\n" }, message: "handle the empty case\n\nFixes #212. See also #99." });
  const e = repo.look("a.ts", 1);
  assert.deepEqual(e.changes[1].issues.sort((a, b) => a - b), [99, 212]);
  assert.match(signalText(e), /#99, #212|#212, #99/);
  assert.match(signalText(e), /cannot read/);
});

test("a release tag containing the commit is reported", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "x\n" }, message: "initial", tag: "v1.0.0" })
    .commit({ files: { "a.ts": "y\n" }, message: "change it" });
  const e = repo.look("a.ts", 1);
  assert.match(signalText(e), /v1\.0\.0/);
});

test("history is followed through a rename", () => {
  const repo = newRepo()
    .commit({ files: { "old.ts": "const a = 1;\n" }, message: "add old.ts" })
    .commit({ rename: ["old.ts", "new.ts"], message: "rename old.ts to new.ts" })
    .commit({ files: { "new.ts": "const a = 2;\n" }, message: "change the value" });
  const e = repo.look("new.ts", 1);
  assert.ok(e.changes.length >= 2, `only found ${e.changes.length} commits across the rename`);
  assert.ok(subjects(e).some((s) => s.includes("add old.ts")), `subjects were ${subjects(e).join(", ")}`);
});

test("confidence is clear when a message gives a reason", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "x\n" }, message: "initial" })
    .commit({ files: { "a.ts": "y\n" }, message: "Pin the version because 4.2 broke the build on node 20" });
  const e = repo.look("a.ts", 1);
  assert.equal(e.confidence, "clear");
  assert.match(e.because, /explains? a reason/);
});

test("confidence is thin when every message is generic, and it quotes them", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "x\n" }, message: "wip" })
    .commit({ files: { "a.ts": "y\n" }, message: "fix" })
    .commit({ files: { "a.ts": "z\n" }, message: "update" });
  const e = repo.look("a.ts", 1);
  assert.equal(e.confidence, "thin");
  assert.match(e.because, /generic/);
  assert.match(e.because, /"wip"|"fix"|"update"/);
});

test("confidence is partial when the message says what changed but not why", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "x\n" }, message: "initial" })
    .commit({ files: { "a.ts": "y\n" }, message: "change the default timeout to 30 seconds" });
  assert.equal(repo.look("a.ts", 1).confidence, "partial");
});

test("a line written once is reported as never having changed", () => {
  const repo = newRepo().commit({ files: { "a.ts": "x\n" }, message: "initial" });
  const e = repo.look("a.ts", 1);
  assert.ok(signalKinds(e).includes("initial"));
  assert.match(signalText(e), /only ever been written once/);
});

test("the number of commits searched is reported honestly", () => {
  const repo = newRepo().commit({ files: { "a.ts": "x\n" }, message: "one" }).commit({ files: { "b.ts": "y\n" }, message: "two" });
  const e = repo.look("a.ts", 1);
  assert.equal(e.searched.commitsInRepo, 2);
  assert.equal(e.searched.shallow, false);
});

test("the limit is respected and the truncation is admitted", () => {
  let repo = newRepo().commit({ files: { "a.ts": "v0\n" }, message: "initial" });
  for (let i = 1; i <= 6; i++) repo = repo.commit({ files: { "a.ts": `v${i}\n` }, message: `change ${i}` });
  const e = repo.look("a.ts", 1, 1, 3);
  assert.equal(e.changes.length, 3);
  assert.equal(e.searched.truncated, true);
});

test("churn across several commits is counted with the time it spans", () => {
  let repo = newRepo().commit({ files: { "a.ts": "v0\n" }, message: "initial" });
  for (let i = 1; i <= 3; i++) repo = repo.commit({ files: { "a.ts": `v${i}\n` }, message: `change ${i}` });
  assert.match(signalText(repo.look("a.ts", 1)), /4 commits touched these lines/);
});

test("a single author across every change is noted", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "x\n" }, message: "initial", author: "Solo Dev", email: "solo@x.com" })
    .commit({ files: { "a.ts": "y\n" }, message: "again", author: "Solo Dev", email: "solo@x.com" });
  assert.ok(signalKinds(repo.look("a.ts", 1)).includes("single-author"));
});

test("different authors are not reported as one", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "x\n" }, message: "initial", author: "A", email: "a@x.com" })
    .commit({ files: { "a.ts": "y\n" }, message: "again", author: "B", email: "b@x.com" });
  assert.ok(!signalKinds(repo.look("a.ts", 1)).includes("single-author"));
});

test("the lines being asked about are shown as they are now", () => {
  const repo = newRepo().commit({ files: { "a.ts": "one\ntwo\nthree\n" }, message: "initial" });
  assert.deepEqual(repo.look("a.ts", 2, 3).question.text, ["two", "three"]);
});

test("trailers such as Signed-off-by do not count as an explanation", () => {
  const repo = newRepo()
    .commit({ files: { "a.ts": "x\n" }, message: "initial" })
    .commit({ files: { "a.ts": "y\n" }, message: "fix\n\nSigned-off-by: Someone <s@x.com>\nReviewed-by: Other <o@x.com>" });
  const e = repo.look("a.ts", 1);
  assert.notEqual(e.confidence, "clear");
});

test("the confidence sentence is grammatical for one commit and for many", () => {
  const one = newRepo().commit({ files: { "a.ts": "x\n" }, message: "Add the flag because the default breaks on Windows" });
  assert.match(one.look("a.ts", 1).because, /1 of 1 commit message explains a reason/);
  const many = newRepo()
    .commit({ files: { "a.ts": "x\n" }, message: "Add the flag because the default breaks on Windows" })
    .commit({ files: { "a.ts": "y\n" }, message: "Flip it because the Windows bug was fixed upstream" });
  assert.match(many.look("a.ts", 1).because, /2 of 2 commit messages explain a reason/);
});
