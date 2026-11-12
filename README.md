# whyline

Ask why a line of code is the way it is, and get an answer that cites the commits.

```
$ why src/auth.ts:142

  src/auth.ts:142

  │   for (let attempt = 0; attempt < 3; attempt++) {
  │     const res = await fetch(TOKEN_URL);
  │     if (res.status !== 429) return res.json();

  It backs off between attempts because the unconditional retry added earlier looped
  forever when the token endpoint was down, and the provider returns 429 under load.
  — a4e2a90, a45792f

  history   4 commits, oldest first
      b0c52c5  2026-03-02  Alice Dev    Add token fetching
      d3772d6  2026-03-09  Alice Dev    retry on failure            [later undone]
    › a45792f  2026-03-09  Alice Dev    Revert "retry on failure"   [undoes d3772d6]
    › a4e2a90  2026-03-11  Bob Ops      Back off instead of retrying immediately  [v1.4.0]

  what git shows
    · a45792f undoes d3772d6: it adds back exactly the lines d3772d6 removed, and removes
      exactly the ones it added
    · the commits reference #212, which whyline cannot read: that is where the reason usually is

  the history explains this: 2 of 4 commit messages explain a reason, not just a change
  searched all 847 commits in this repository
```

The point is not the paragraph. The point is that the paragraph is pinned to four commits you can
read yourself, and that whyline says **no answer** rather than guessing when those commits do not
explain anything.

## Why a local model

Answering this question properly means reading commit messages, bodies and diffs across a file's
whole history. For one question on a busy file that is a few thousand tokens; for the ten questions
you have while reading unfamiliar code it adds up, and none of it is work you want to pay per token
for or send to anyone. A 1B model on your own machine reads it for free, as many times as you like.

## Install

Needs Node 22.18 or newer, which runs TypeScript directly, and git.

```
git clone https://github.com/jay-m007/whyline
cd whyline && npm install && npm link
ollama pull llama3.2:1b
```

```
why src/auth.ts:142          one line
why src/auth.ts:142-150      a range
why src/auth.ts              the whole file
why src/auth.ts -m "429"     find the line by its text, since line numbers drift
why src/auth.ts:142 --no-model     just the evidence, no model at all
```

## How it works

1. **`git log -L142,142:src/auth.ts`** is the primitive everything rests on: given a file and a line
   range, git works out which commits touched *those lines*, following them as they moved around the
   file and across renames. A commit that changed a different part of the same file never appears.
2. **Reverts are proven, not read.** whyline fingerprints what each commit changed — the added and
   removed lines per file, nothing else — and compares each commit's fingerprint against every
   earlier commit's reversed fingerprint. When they match, one commit undid the other, whatever its
   message claims. A commit saying "tidy up" that silently reverts a fix is caught; a commit saying
   `Revert "x"` whose diff does not match is reported as a claim rather than a fact.
   (`git patch-id` looks like the tool for this and is not: reversing a diff swaps the `a/` and `b/`
   prefixes in the header lines, which patch-id hashes, so a commit and its own revert get different
   ids.)
3. **The strongest signal is a change that came back.** Someone adds a guard, someone else removes it
   as unnecessary, then it goes back in. That pattern means the simple version was tried and failed,
   and whyline calls it out explicitly.
4. **The history is scored before the model sees it.** A message is informative if it says *why* —
   "because", "otherwise", "to avoid", a regression, an issue number — rather than just what changed.
   Messages like `wip`, `fix`, `update` score zero, and trailers like `Signed-off-by` are stripped.
5. **The model is asked only if there is something to read.** If every message is generic, whyline
   does not call the model at all: there is no reason written down, so there is nothing to find, and
   asking would only produce a plausible invention.
6. **Every answer must cite commits.** The model returns its answer plus the commit ids it used.
   whyline checks each one against the real history. An id it made up is dropped; an id in the prose
   that is not a real commit throws the whole answer away; an answer that cites nothing is thrown
   away too. What you read is always backed by commits listed right below it.

`why ... --show-prompt` prints exactly what the model would be asked, so you can see for yourself
that it gets commits and nothing else.

## Honest limits

- **It can only know what is in the history.** If the reason lives in a pull request discussion, a
  Slack thread, an issue tracker or someone's head, whyline cannot reach it. When commits reference
  an issue, it says so and tells you that is where the reason usually is, rather than guessing.
- **It does not read your issue tracker or your forge.** No network calls except to your local
  Ollama. It notices `#431` and admits it cannot open it.
- **A shallow clone gives a shallow answer,** and whyline says so in the output. `git clone --depth`
  is very common in CI; run `git fetch --unshallow` before trusting an answer there.
- **Squash merges destroy exactly what this tool reads.** A repository that squashes every pull
  request into one commit called "Merge PR #42" has no per-change history to walk, and whyline will
  mostly report that the history does not explain anything. That is an accurate description of such
  a repository, not a bug, but it does limit where this is useful.
- **Only merge commits touching the lines** means the real work happened on a branch whose commits
  are not in this history. whyline reports that rather than reading the merge diff as if it were a
  change someone made deliberately.
- **`git log -L` can be slow** on very long histories of very large files, since git has to diff each
  commit. `--limit` bounds it and the output tells you when it stopped early.
- **The answer is still generated text.** Every claim is pinned to commits, and anything unsupported
  is dropped, but a model can still read a commit message and emphasise the wrong part of it. The
  commits are printed underneath so that reading them is always one glance away.
- **Line numbers drift.** `why file:142` asks about line 142 *as it is now*. If you are reading an
  old diff, use `-m "<some text from the line>"` instead.
- **It is not blame.** `git blame` tells you who last touched a line. This tries to answer why the
  line is not simpler, which is a different question and often has several commits as the answer.

## Development

```
npm test          # 48 tests, no network and no model needed
npm run typecheck
npm run eval      # needs Ollama; builds repositories with known stories and scores the model
```

The tests build real git repositories commit by commit — including reverts, renames, misleading
commit messages and shallow clones — because every claim whyline makes comes from a real git command.

The eval is the interesting one: it builds eight histories whose story is known in advance, including
two where the reason is deliberately *not* written down, and scores the model on whether it refuses
those. A confident answer invented from `wip` and `fix` is the one failure that would make this tool
worth less than running `git log` by hand.

MIT licensed.
