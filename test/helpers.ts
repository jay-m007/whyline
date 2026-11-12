// Test scaffolding: real git repositories built commit by commit, because whyline's whole job is
// reading real history. Nothing here is mocked.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { gather, questionFor } from "../src/evidence.ts";
import type { Evidence } from "../src/evidence.ts";

const made: string[] = [];

export interface CommitSpec {
  /** Files to write before committing, path to contents. */
  files?: Record<string, string>;
  message: string;
  author?: string;
  email?: string;
  /** Tag to put on this commit. */
  tag?: string;
  /** Revert this many commits back, by git revert, instead of writing files. */
  revertHead?: number;
  rename?: [string, string];
}

export class Repo {
  readonly root: string;
  // A constructor parameter property is not allowed under Node's type stripping.
  constructor(root: string) { this.root = root; }

  private run(args: string[], env: Record<string, string> = {}): string {
    return execFileSync("git", args, { cwd: this.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  }

  commit(spec: CommitSpec): this {
    for (const [rel, body] of Object.entries(spec.files ?? {})) {
      const p = join(this.root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    if (spec.rename) this.run(["mv", spec.rename[0], spec.rename[1]]);
    const env = { GIT_AUTHOR_NAME: spec.author ?? "Test Author", GIT_AUTHOR_EMAIL: spec.email ?? "test@example.com", GIT_COMMITTER_NAME: spec.author ?? "Test Author", GIT_COMMITTER_EMAIL: spec.email ?? "test@example.com" };
    if (spec.revertHead !== undefined) this.run(["revert", "--no-edit", `HEAD~${spec.revertHead}`], env);
    else { this.run(["add", "-A"]); this.run(["commit", "-q", "-m", spec.message], env); }
    if (spec.message && spec.revertHead !== undefined) this.run(["commit", "-q", "--amend", "-m", spec.message], env);
    if (spec.tag) this.run(["tag", "-a", spec.tag, "-m", spec.tag], env);
    return this;
  }

  sha(ref = "HEAD"): string { return this.run(["rev-parse", "--short", ref]).trim(); }
  log(): string[] { return this.run(["log", "--format=%h %s"]).trim().split("\n"); }

  /** Gathers evidence for a line range, with no model involved. */
  look(file: string, start: number, end = start, limit = 40): Evidence {
    const o = { cwd: this.root, limit };
    return gather(o, questionFor(o, file, start, end, null));
  }
}

export function newRepo(): Repo {
  const base = mkdtempSync(join(tmpdir(), "whyline-test-"));
  made.push(base);
  const root = join(base, "repo");
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: root, stdio: "ignore" });
  for (const [k, v] of [["user.email", "test@example.com"], ["user.name", "Test Author"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) {
    execFileSync("git", ["config", k, v], { cwd: root, stdio: "ignore" });
  }
  return new Repo(root);
}

export function cleanup(): void {
  for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
}

export const subjects = (e: Evidence): string[] => e.changes.map((c) => c.commit.subject);
export const signalKinds = (e: Evidence): string[] => e.signals.map((s) => s.kind);
export const signalText = (e: Evidence): string => e.signals.map((s) => s.text).join(" | ");
