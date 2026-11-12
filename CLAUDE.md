# whyline

CLI that answers why a line of code exists: it walks the real git history of that line, proves
reverts from the diffs, and answers citing the commits. A local Ollama model writes the answer and
is never allowed to answer without evidence.

## Commands
- `npm test`: offline test suite (node:test; real git repos built commit by commit in `test/helpers.ts`)
- `npm run typecheck`: `tsc --noEmit`
- `node src/cli.ts <file>:<line>`: ask about a line (Node 22.18+ runs .ts directly)
- `node src/cli.ts <file>:<line> --show-prompt`: print exactly what the model would be asked
- `npm run eval`: build histories with known stories and score the model on them

## Code rules
- TypeScript run by Node's type stripping: no enums, namespaces or constructor parameter properties; use `import type` for types; relative imports end in `.ts`.
- Zero runtime dependencies. Use node: built-ins only; everything about the repository comes from git commands in `src/git.ts`.
- Never claim something the history does not show. Every signal must come from a git command, and reverts are proven by comparing changed lines, never by reading a commit message.
- The model may only answer with commits that exist: verify every cite, drop invented ids, and throw away an answer that cites nothing. Do not ask the model at all when confidence is thin.
- Say what was not searched: shallow clones, the --limit cut-off, and issues that cannot be read.
- Add a test for every new signal or rule, and build the case in a real repository rather than mocking git.

## Git
- Commits are authored as Jay Maurya <maurya67jay@gmail.com>. Do not add co-author or "generated with" lines to commits or pull requests.
