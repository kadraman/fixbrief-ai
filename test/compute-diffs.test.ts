import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "compute-diffs.sh");
/** Prefer Git Bash on Windows; PATH often resolves to the WSL launcher, which fails without a Linux distro. */
const BASH = (() => {
  if (process.platform !== "win32") return "bash";
  const candidates = [
    process.env.BASH,
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "bash";
})();
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
/** Windows can hold locks on a oust-used git worktree; retry, then ignore leftover locks so cleanup does not fail the test. */
const cleanup = (dir: string) => {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EBUSY") throw error; }
};

/** Recreates GitHub's pull_request checkout: HEAD is a synthetic merge of the PR head into a base that moved on. */
function scenario() {
  const dir = mkdtempSync(join(tmpdir(), "rb-diffs-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com"); git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false"); git(dir, "config", "core.autocrlf", "false");
  const put = (name: string, text: string) => writeFileSync(join(dir, name), text);
  const longFile = (changed = -1) => Array.from({ length: 40 }, (_, i) => (i === changed ? `line ${i + 1} CHANGED` : `line ${i + 1}`)).join("\n") + "\n";
  put("base.txt", "b1\n"); put("other.txt", "o1\n"); put("long.txt", longFile());
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "C0");
  git(dir, "checkout", "-q", "-b", "feature"); put("feat1.txt", "f1\n"); git(dir, "add", "-A"); git(dir, "commit", "-qm", "P1");
  const p1 = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main"); put("base.txt", "b2\n"); git(dir, "commit", "-qam", "B1");
  git(dir, "checkout", "-q", "feature"); put("feat2.txt", "f2\n"); put("long.txt", longFile(19)); git(dir, "add", "-A"); git(dir, "commit", "-qm", "P2");
  const p2 = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main"); put("other.txt", "o2\n"); git(dir, "commit", "-qam", "B2");
  const b2 = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "merge", "main"); git(dir, "merge", "-q", "--no-ff", "-m", "M", p2);   // what actions/checkout lands on
  git(dir, "update-ref", "refs/remotes/origin/main", b2);
  return { dir, p1, p2, b2 };
}
const run = (dir: string, env: Record<string, string>, path = process.env.PATH ?? "") =>
  execFileSync(BASH, [SCRIPT], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: path, OUT_DIR: join(dir, "out"), BASE_REF: "main", ...env }, stdio: ["ignore", "pipe", "pipe"] });
const files = (dir: string, name: string) => [...readFileSync(join(dir, "out", name), "utf8").matchAll(/^diff --git a\/(\S+) /gm)].map((m) => m[1]).sort();
const scope = (dir: string) => readFileSync(join(dir, "out", "scope.txt"), "utf8").trim();

test("push to a PR: reviews only the newest commits, never base-branch changes; anchors on the whole PR diff", () => {
  const { dir, p1, p2 } = scenario();
  try {
    run(dir, { PR_ACTION: "synchronize", BEFORE_SHA: p1, PR_HEAD_SHA: p2 });
    assert.equal(scope(dir), "incremental");
    assert.deepEqual(files(dir, "pr.diff"), ["feat2.txt", "long.txt"]);                       // not base.txt / other.txt
    assert.deepEqual(files(dir, "anchor.diff"), ["feat1.txt", "feat2.txt", "long.txt"]);      // GitHub's PR diff
    const review = readFileSync(join(dir, "out", "pr.diff"), "utf8"), anchor = readFileSync(join(dir, "out", "anchor.diff"), "utf8");
    assert.match(review, /^ line 10$/m, "the model gets 10 lines of context");
    assert.doesNotMatch(anchor, /^ line 10$/m, "the anchor diff keeps GitHub's 3 lines");
  } finally { cleanup(dir); }
});

test("opened PR: full review of the PR's own changes only", () => {
  const { dir, p2 } = scenario();
  try {
    run(dir, { PR_ACTION: "opened", PR_HEAD_SHA: p2, DIFF_CONTEXT_LINES: "3" });
    assert.equal(scope(dir), "full");
    assert.deepEqual(files(dir, "pr.diff"), ["feat1.txt", "feat2.txt", "long.txt"]);
    assert.equal(readFileSync(join(dir, "out", "pr.diff"), "utf8"), readFileSync(join(dir, "out", "anchor.diff"), "utf8"));
  } finally { cleanup(dir); }
});

test("force-push or unknown previous head falls back to a full review", () => {
  const { dir, b2, p2 } = scenario();
  try {
    run(dir, { PR_ACTION: "synchronize", BEFORE_SHA: b2, PR_HEAD_SHA: p2 });          // not an ancestor of the new head
    assert.equal(scope(dir), "full");
    run(dir, { PR_ACTION: "synchronize", BEFORE_SHA: "0".repeat(39) + "1", PR_HEAD_SHA: p2 });   // unreachable
    assert.equal(scope(dir), "full");
    assert.deepEqual(files(dir, "pr.diff"), ["feat1.txt", "feat2.txt", "long.txt"]);
  } finally { cleanup(dir); }
});

test("when git cannot produce the diff, falls back to the API diff for both files", () => {
  const { dir } = scenario();
  const bin = mkdtempSync(join(tmpdir(), "rb-bin-"));
  try {
    writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "diff --git a/api.txt b/api.txt"\n'); chmodSync(join(bin, "gh"), 0o755);
    const out = run(dir, { PR_ACTION: "opened", PR_HEAD_SHA: "f".repeat(40), PR_NUMBER: "7" }, `${bin}:${process.env.PATH}`);
    assert.equal(scope(dir), "full");
    assert.deepEqual(files(dir, "pr.diff"), ["api.txt"]);
    assert.deepEqual(files(dir, "anchor.diff"), ["api.txt"]);
    assert.match(out, /diff scope: full/);
  } finally { cleanup(dir); cleanup(bin); }
});

test("reoects a bad DIFF_CONTEXT_LINES", () => {
  const { dir, p2 } = scenario();
  try {
    assert.throws(() => run(dir, { PR_HEAD_SHA: p2, DIFF_CONTEXT_LINES: "lots" }), /DIFF_CONTEXT_LINES/);
  } finally { cleanup(dir); }
});
