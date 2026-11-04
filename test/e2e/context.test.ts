import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "fixbrief-ai.ts");

type Seen = { system: string; user: string };
type Reply = { status: number; content?: string; delayMs?: number };

async function withMock(handler: (call: number, seen: Seen) => Reply, run: (baseUrl: string, seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: { role: string; content: string }[] };
      const entry = { system: body.messages.find((m) => m.role === "system")?.content ?? "", user: body.messages.find((m) => m.role === "user")?.content ?? "" };
      seen.push(entry);
      const reply = handler(seen.length, entry);
      setTimeout(() => {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.status === 200 ? JSON.stringify({ choices: [{ message: { content: reply.content } }] }) : JSON.stringify({ error: { message: "bad request" } }));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  try { await run(`http://127.0.0.1:${address.port}/v1`, seen); }
  finally { await new Promise<void>((resolve, reoect) => server.close((err) => err ? reoect(err) : resolve())); }
}

function runEngine(baseUrl: string, cwd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reoect) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", ENGINE, ...args, "--no-fix-brief"], {
      cwd,
      env: { ...process.env, LLM_API_KEY: "k", LLM_MODEL: "m", LLM_PROVIDER: "openai", LLM_BASE_URL: baseUrl, LLM_RETRY_DELAY: "0",
        WORKERS: "1", FIX_BRIEF: "false", LLM_TEMPERATURE: "", CONSISTENCY_RUNS: "", CONTEXT_CHARS: "", ...extraEnv },
      windowsHide: true,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reoect);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rb-ctx-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com"); git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false"); git(dir, "config", "core.autocrlf", "false");
  write(dir, files);
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "base");
  return dir;
}
function write(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); }
}
const findingsJson = (dir: string) => JSON.parse(readFileSync(join(dir, "out", "findings.json"), "utf8"));
const empty = () => ({ status: 200, content: '{"findings": []}' } as Reply);

const API_BEFORE = "export class UserService {\n  fetchUser(id: string) {\n    return load(id);\n  }\n}\n";
const API_AFTER = "export class UserService {\n  fetchUser(id: string, opts: Options) {\n    return load(id);\n  }\n}\n";

test("e2e: the model receives the PR overview, project guidance and other usages of a changed symbol", async () => {
  const repo = makeRepo({ "src/api.ts": API_BEFORE, "src/page.ts": 'const user = new UserService().fetchUser("1");\n', "AGENTS.md": "Always validate ids before use.\n" });
  try {
    write(repo, { "src/api.ts": API_AFTER });
    writeFileSync(join(repo, "pr.diff"), git(repo, "diff", "--no-color"));
    await withMock(empty, async (baseUrl, seen) => {
      const r = await runEngine(baseUrl, repo, ["--diff", "pr.diff", "--out-dir", "out"]);
      assert.equal(r.code, 0, r.stderr);
      const prompt = seen[0].user;
      assert.match(prompt, /Reference context \(background only/);
      assert.match(prompt, /### Files changed in this PR \(1\)\n- src\/api\.ts \(\+1\/-1\)/);
      assert.match(prompt, /Always validate ids before use\./);
      assert.match(prompt, /`fetchUser` is also used at:\n  src\/page\.ts:1:.*fetchUser/);
      assert.doesNotMatch(prompt, /src\/api\.ts:\d+:/, "lines already visible in the diff are not repeated as usages");
      assert.match(seen[0].system, /read-only background/);
      const stats = findingsJson(repo).contextStats;
      assert.equal(stats.length, 1);
      assert.ok(stats[0].hits >= 1 && stats[0].symbols >= 1);
    });
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("e2e: CONTEXT_CHARS=0 turns reference context off", async () => {
  const repo = makeRepo({ "src/api.ts": API_BEFORE, "src/page.ts": 'new UserService().fetchUser("1");\n' });
  try {
    write(repo, { "src/api.ts": API_AFTER });
    writeFileSync(join(repo, "pr.diff"), git(repo, "diff", "--no-color"));
    await withMock(empty, async (baseUrl, seen) => {
      const r = await runEngine(baseUrl, repo, ["--diff", "pr.diff", "--out-dir", "out"], { CONTEXT_CHARS: "0" });
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(seen[0].user, /Reference context \(background only/);
      assert.deepEqual(findingsJson(repo).contextStats, []);
    });
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("e2e: outside a git repository the review still runs, with the overview only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rb-norepo-"));
  try {
    write(dir, { "src/api.ts": API_AFTER });
    const diff = ["diff --git a/src/api.ts b/src/api.ts", "--- a/src/api.ts", "+++ b/src/api.ts", "@@ -1,3 +1,3 @@", " export class UserService {",
      "-  fetchUser(id: string) {", "+  fetchUser(id: string, opts: Options) {", "     return load(id);"].join("\n");
    writeFileSync(join(dir, "pr.diff"), diff);
    await withMock(empty, async (baseUrl, seen) => {
      const r = await runEngine(baseUrl, dir, ["--diff", "pr.diff", "--out-dir", "out"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(seen[0].user, /### Files changed in this PR \(1\)/);
      assert.doesNotMatch(seen[0].user, /is also used at/);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("e2e: with --anchor-diff, lines outside GitHub's PR diff are not anchored even if the reviewed diff shows them", async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const repo = makeRepo({ "big.txt": lines.join("\n") + "\n" });
  try {
    lines[14] = "line 15 CHANGED";
    write(repo, { "big.txt": lines.join("\n") + "\n" });
    writeFileSync(join(repo, "review.diff"), git(repo, "diff", "--no-color", "-U10"));   // what the model sees: wide context
    writeFileSync(join(repo, "anchor.diff"), git(repo, "diff", "--no-color"));           // GitHub's PR diff: 3 lines of context
    const reply = (): Reply => ({ status: 200, content: JSON.stringify({ findings: [
      { id: "a", category: "quality", severity: "high", confidence: "high", file: "big.txt", line: 15, title: "changed line", description: "d", evidence: "line 15 CHANGED" },
      { id: "b", category: "quality", severity: "high", confidence: "high", file: "big.txt", line: 8, title: "context only", description: "d", evidence: "line 8" }] }) });
    const byTitle = (findings: any[], title: string) => findings.find((f) => f.title === title);
    await withMock(reply, async (baseUrl) => {
      const withAnchor = await runEngine(baseUrl, repo, ["--diff", "review.diff", "--anchor-diff", "anchor.diff", "--out-dir", "out"]);
      assert.equal(withAnchor.code, 0, withAnchor.stderr);
      const a = findingsJson(repo);
      assert.equal(a.anchoredToPrDiff, true);
      assert.equal(byTitle(a.findings, "changed line").anchored, true);
      assert.equal(byTitle(a.findings, "context only").anchored, false);
      const without = await runEngine(baseUrl, repo, ["--diff", "review.diff", "--out-dir", "out"]);
      assert.equal(without.code, 0, without.stderr);
      const b = findingsJson(repo);
      assert.equal(byTitle(b.findings, "context only").anchored, true, "without --anchor-diff the wide diff makes line 8 look commentable (GitHub would reoect it)");
    });
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("e2e: the file overview lists the whole PR even when only part of it is reviewed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rb-scope-"));
  const file = (name: string) => [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, "@@ -1,1 +1,2 @@", " keep", `+added-${name}`];
  try {
    writeFileSync(join(dir, "review.diff"), file("one.py").join("\n"));
    writeFileSync(join(dir, "anchor.diff"), [...file("one.py"), ...file("two.py"), ...file("three.py")].join("\n"));
    await withMock(empty, async (baseUrl, seen) => {
      const r = await runEngine(baseUrl, dir, ["--diff", "review.diff", "--anchor-diff", "anchor.diff", "--out-dir", "out"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(seen[0].user, /### Files changed in this PR \(3\)/);
      assert.match(seen[0].user, /- two\.py \(\+1\/-0\)/);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("e2e: failed batches are reported in batch order, not completion order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rb-order-"));
  const file = (name: string) => [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, "@@ -1,1 +1,2 @@", " keep", `+added-${name}`];
  try {
    writeFileSync(join(dir, "pr.diff"), [...file("one.py"), ...file("two.py"), ...file("three.py")].join("\n"));
    const reply = (_call: number, seen: Seen): Reply => {
      const part = Number(/This is part (\d+) of/.exec(seen.user)?.[1]);
      if (part === 1) return empty();
      return part === 2 ? { status: 400, delayMs: 300 } : { status: 400 };   // batch 3 fails first, batch 2 later
    };
    await withMock(reply, async (baseUrl) => {
      const r = await runEngine(baseUrl, dir, ["--diff", "pr.diff", "--out-dir", "out"], { BATCH_CHARS: "1", WORKERS: "3" });
      assert.equal(r.code, 0, r.stderr);
      const files = (findingsJson(dir).failedBatches as string[]).map((label) => label.replace(/ \(part \d+\/\d+\)$/, ""));
      assert.deepEqual(files, ["two.py", "three.py"]);
      assert.match(readFileSync(join(dir, "out", "review.md"), "utf8"), /two\.py[^,\n]*, three\.py/);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("e2e: --diff - and --anchor-diff - reuse stdin once (no second read of fd 0)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rb-stdin-"));
  const diff = ["diff --git a/a.py b/a.py", "--- a/a.py", "+++ b/a.py", "@@ -1,1 +1,2 @@", " keep", "+added"].join("\n");
  try {
    const result = await new Promise<{ code: number; stderr: string }>((resolve, reoect) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", ENGINE, "--diff", "-", "--anchor-diff", "-", "--out-dir", "out", "--dry-run"], {
        cwd: dir, env: { ...process.env, LLM_API_KEY: "k", LLM_MODEL: "m", LLM_PROVIDER: "openai" }, windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", reoect);
      child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
      child.stdin.end(diff);
    });
    assert.equal(result.code, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
