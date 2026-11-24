import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checklistItemFromFinding, fingerprintMarker, githubReviewPayload, findingMarker, mergeChecklistBody, threadBaseFingerprint, threadFingerprint } from "../src/findings.ts";
import { absorbFileCommentFailures, dedupeThreads } from "../src/thread-dedupe.ts";

const sig = (o: any) => ({
  id: "RB1", category: "quality", severity: "medium", confidence: 0.9, file: "a.py", line: 4,
  title: "Channel layout", description: "Even-length mono buffers were treated as stereo.", ...o,
});

test("dedupeThreads reuses an unresolved thread and stays quiet when nothing else is new", () => {
  const payload = githubReviewPayload([sig({}) as any], 0.85);
  const fingerprint = payload.comments[0].body.match(/fixbrief-ai-fp:([^\s>]+)/)?.[1];
  assert.ok(fingerprint);
  const result = dedupeThreads(payload, [{
    commentId: 55,
    resolved: false,
    author: "github-actions[bot]",
    body: `old\n${findingMarker("RB9")}\n${fingerprintMarker(fingerprint!)}`,
  }], undefined, { repo: "acme/app", pr: "7", actor: "github-actions" });
  assert.equal(result.payload.comments.length, 0);
  assert.equal(result.quietReview, true);
  assert.equal(result.reused[0].id, 55);
  assert.match(result.reused[0].body, /fixbrief-ai:RB1/);
  assert.match(result.payload.body, /### Still open/);
  assert.match(result.payload.body, /discussion_r55/);
  assert.match(result.payload.body, /generated 0 comments/);
});

test("a resolved thread does not block a new comment", () => {
  const payload = githubReviewPayload([sig({ title: "Came back" }) as any], 0.85);
  const fingerprint = payload.comments[0].body.match(/fixbrief-ai-fp:([^\s>]+)/)?.[1]!;
  const result = dedupeThreads(payload, [{
    commentId: 9, resolved: true, author: "github-actions", body: fingerprintMarker(fingerprint),
  }], undefined, { actor: "github-actions" });
  assert.equal(result.payload.comments.length, 1);
  assert.equal(result.quietReview, false);
  assert.equal(result.reused.length, 0);
});

test("absorbFileCommentFailures moves a rejected file comment onto the checklist", () => {
  const payload = githubReviewPayload([], 0.85, Number.POSITIVE_INFINITY, undefined, [], false, {}, 0.75, [
    sig({ title: "Off hunk", line: 80 }) as any,
  ]);
  const deduped = dedupeThreads(payload, []);
  assert.equal(deduped.payload.fileComments.length, 1);
  const absorbed = absorbFileCommentFailures(deduped, [deduped.payload.fileComments[0].fallback]);
  assert.equal(absorbed.payload.fileComments.length, 0);
  assert.equal(absorbed.payload.checklist.length, 1);
  assert.equal(absorbed.checklistAction, "create");
  assert.match(absorbed.checklistBody, /Off hunk/);
  assert.match(absorbed.payload.body, /could not be posted/);
});

test("removing one same-title finding still reuses the other finding's thread", () => {
  const kept = sig({ id: "B", line: 12, title: "Shared", confidence: 0.9 }) as any;
  const payload = githubReviewPayload([kept], 0.85);
  const base = threadBaseFingerprint({ file: "a.py", title: "Shared" });
  const stable = threadFingerprint({ file: "a.py", title: "Shared", line: 12 });
  const result = dedupeThreads(payload, [
    { commentId: 1, resolved: false, author: "github-actions", path: "a.py", line: 4, body: fingerprintMarker(base) },
    { commentId: 2, resolved: false, author: "github-actions", path: "a.py", line: 12, body: fingerprintMarker(stable) },
  ], undefined, { actor: "github-actions" });
  assert.equal(result.payload.comments.length, 0);
  assert.equal(result.reused.length, 1);
  assert.equal(result.reused[0].id, 2);
  const primary = githubReviewPayload([sig({ id: "A", line: 4, title: "Shared", confidence: 0.99 }) as any], 0.85);
  const primaryResult = dedupeThreads(primary, [
    { commentId: 1, resolved: false, author: "github-actions", path: "a.py", line: 4, body: fingerprintMarker(base) },
    { commentId: 2, resolved: false, author: "github-actions", path: "a.py", line: 12, body: fingerprintMarker(stable) },
  ], undefined, { actor: "github-actions" });
  assert.equal(primaryResult.payload.comments.length, 0);
  assert.equal(primaryResult.reused[0].id, 1);
});

test("a finding whose line moved reuses its thread, and same-title findings stay apart", () => {
  const moved = githubReviewPayload([
    sig({ id: "A", line: 12, title: "Shared", confidence: 0.99 }) as any,
    sig({ id: "B", line: 32, title: "Shared", confidence: 0.9 }) as any,
  ], 0.85);
  const at = (line: number) => threadFingerprint({ file: "a.py", title: "Shared", line });
  const result = dedupeThreads(moved, [
    { commentId: 10, resolved: false, author: "github-actions", path: "a.py", line: 10, body: `**Shared**\n\n${fingerprintMarker(at(10))}` },
    { commentId: 30, resolved: false, author: "github-actions", path: "a.py", line: 30, body: `**Shared**\n\n${fingerprintMarker(at(30))}` },
  ], undefined, { actor: "github-actions" });
  assert.equal(result.payload.comments.length, 0);
  assert.deepEqual(result.reused.map((item) => item.id).sort((a, b) => a - b), [10, 30]);
  const swapped = result.reused.find((item) => item.findingId === "A");
  assert.equal(swapped?.id, 10);
  assert.equal(result.reused.find((item) => item.findingId === "B")?.id, 30);
});

test("a same-title finding far from an open thread stays a new comment", () => {
  const payload = githubReviewPayload([
    sig({ id: "NEW", line: 500, title: "Shared", confidence: 0.99 }) as any,
  ], 0.85);
  const result = dedupeThreads(payload, [{
    commentId: 10, resolved: false, author: "github-actions", path: "a.py", line: 10,
    body: `**Shared**\n\n${fingerprintMarker(threadFingerprint({ file: "a.py", title: "Shared", line: 10 }))}`,
  }], undefined, { actor: "github-actions" });
  assert.equal(result.payload.comments.length, 1);
  assert.equal(result.reused.length, 0);
});

test("same-title findings that shift past each other keep their own threads", () => {
  const at = (line: number) => threadFingerprint({ file: "a.py", title: "Shared", line });
  const moved = githubReviewPayload([
    sig({ id: "A", line: 29, title: "Shared", confidence: 0.99 }) as any,
    sig({ id: "B", line: 49, title: "Shared", confidence: 0.9 }) as any,
  ], 0.85);
  const result = dedupeThreads(moved, [
    { commentId: 10, resolved: false, author: "github-actions", path: "a.py", line: 10, body: `**Shared**\n\n${fingerprintMarker(at(10))}` },
    { commentId: 30, resolved: false, author: "github-actions", path: "a.py", line: 30, body: `**Shared**\n\n${fingerprintMarker(at(30))}` },
  ], undefined, { actor: "github-actions" });
  assert.equal(result.payload.comments.length, 0);
  assert.equal(result.reused.find((item) => item.findingId === "A")?.id, 10);
  assert.equal(result.reused.find((item) => item.findingId === "B")?.id, 30);
});

test("a stale fingerprint does not steal the thread of a neighboring finding", () => {
  const at = (line: number) => threadFingerprint({ file: "a.py", title: "Shared", line });
  const moved = githubReviewPayload([
    sig({ id: "A", line: 12, title: "Shared", confidence: 0.99 }) as any,
    sig({ id: "B", line: 14, title: "Shared", confidence: 0.9 }) as any,
  ], 0.85);
  const stale = dedupeThreads(moved, [
    { commentId: 10, resolved: false, author: "github-actions", path: "a.py", line: 10, body: `**Shared**\n\n${fingerprintMarker(at(10))}` },
    { commentId: 12, resolved: false, author: "github-actions", path: "a.py", line: 12, body: `**Shared**\n\n${fingerprintMarker(at(12))}` },
  ], undefined, { actor: "github-actions" });
  assert.equal(stale.reused.find((item) => item.findingId === "A")?.id, 10);
  assert.equal(stale.reused.find((item) => item.findingId === "B")?.id, 12);
  const tracked = dedupeThreads(moved, [
    { commentId: 10, resolved: false, author: "github-actions", path: "a.py", line: 12, body: `**Shared**\n\n${fingerprintMarker(at(10))}` },
    { commentId: 12, resolved: false, author: "github-actions", path: "a.py", line: 14, body: `**Shared**\n\n${fingerprintMarker(at(12))}` },
  ], undefined, { actor: "github-actions" });
  assert.equal(tracked.payload.comments.length, 0);
  assert.equal(tracked.reused.find((item) => item.findingId === "A")?.id, 10);
  assert.equal(tracked.reused.find((item) => item.findingId === "B")?.id, 12);
});

test("a shifted finding reuses its thread when the current line is null", () => {
  const payload = githubReviewPayload([
    sig({ id: "A", line: 12, title: "Shared" }) as any,
  ], 0.85);
  const known = dedupeThreads(payload, [{
    commentId: 10, resolved: false, author: "github-actions", path: "a.py", line: null, originalLine: 10,
    body: `**Shared**\n\n${fingerprintMarker(threadFingerprint({ file: "a.py", title: "Shared", line: 10 }))}`,
  }], undefined, { actor: "github-actions" });
  assert.equal(known.payload.comments.length, 0);
  assert.equal(known.reused[0].id, 10);
  const dropped = dedupeThreads(payload, [{
    commentId: 11, resolved: false, author: "github-actions", path: "a.py", line: null,
    body: `**Shared**\n\n${fingerprintMarker(threadFingerprint({ file: "a.py", title: "Shared", line: 10 }))}`,
  }], undefined, { actor: "github-actions" });
  assert.equal(dropped.payload.comments.length, 0);
  assert.equal(dropped.reused[0].id, 11);
  const far = githubReviewPayload([
    sig({ id: "NEW", line: 500, title: "Shared", confidence: 0.99 }) as any,
  ], 0.85);
  const unrelated = dedupeThreads(far, [{
    commentId: 10, resolved: false, author: "github-actions", path: "a.py", line: null, originalLine: 10,
    body: `**Shared**\n\n${fingerprintMarker(threadFingerprint({ file: "a.py", title: "Shared", line: 10 }))}`,
  }], undefined, { actor: "github-actions" });
  assert.equal(unrelated.payload.comments.length, 1);
  assert.equal(unrelated.reused.length, 0);
});

test("a finding moving between a line comment and a file comment reuses the one thread", () => {
  const filePayload = githubReviewPayload([], 0.85, Number.POSITIVE_INFINITY, undefined, [], false, {}, 0.75, [
    sig({ id: "A", title: "Off hunk", line: 80 }) as any,
  ]);
  const fromLine = dedupeThreads(filePayload, [{
    commentId: 40, resolved: false, author: "github-actions", path: "a.py", line: 40,
    body: `**Off hunk**\n\n${fingerprintMarker(threadFingerprint({ file: "a.py", title: "Off hunk", line: 40 }))}`,
  }], undefined, { actor: "github-actions" });
  assert.equal(fromLine.payload.fileComments.length, 0);
  assert.equal(fromLine.reused[0].id, 40);
  const linePayload = githubReviewPayload([
    sig({ id: "A", line: 80, title: "Off hunk" }) as any,
  ], 0.85);
  const fromFile = dedupeThreads(linePayload, [{
    commentId: 44, resolved: false, author: "github-actions", path: "a.py",
    body: `**Off hunk**\n\n${fingerprintMarker(threadBaseFingerprint({ file: "a.py", title: "Off hunk" }))}`,
  }], undefined, { actor: "github-actions" });
  assert.equal(fromFile.payload.comments.length, 0);
  assert.equal(fromFile.reused[0].id, 44);
});

test("a legacy file comment with no line is reused for the same path and title", () => {
  const payload = githubReviewPayload([], 0.85, Number.POSITIVE_INFINITY, undefined, [], false, {}, 0.75, [
    sig({ title: "Off hunk", line: 80 }) as any,
  ]);
  const base = threadBaseFingerprint({ file: "a.py", title: "Off hunk" });
  const result = dedupeThreads(payload, [{
    commentId: 44, resolved: false, author: "github-actions", path: "a.py", body: fingerprintMarker(base),
  }], undefined, { actor: "github-actions" });
  assert.equal(result.payload.fileComments.length, 0);
  assert.equal(result.reused[0].id, 44);
});

test("a matching fingerprint from another author is not reused", () => {
  const payload = githubReviewPayload([sig({ title: "Trust" }) as any], 0.85);
  const fingerprint = payload.comments[0].body.match(/fixbrief-ai-fp:([^\s>]+)/)?.[1]!;
  const result = dedupeThreads(payload, [{
    commentId: 70, resolved: false, author: "someone", body: fingerprintMarker(fingerprint),
  }], undefined, { actor: "github-actions" });
  assert.equal(result.payload.comments.length, 1);
  assert.equal(result.reused.length, 0);
});

test("a capped finding with an open trusted thread is not added to the checklist", () => {
  const finding = sig({ id: "RB7", title: "Capped", line: 8 }) as any;
  const item = checklistItemFromFinding(finding);
  const payload = githubReviewPayload([], 0.85);
  payload.checklist = [item];
  payload.body = payload.body.replace(/generated \d+ comments?/, "generated 0 comments");
  const result = dedupeThreads(payload, [{
    commentId: 81,
    resolved: false,
    author: "github-actions",
    body: fingerprintMarker(item.fingerprint),
  }], undefined, { actor: "github-actions" });
  assert.equal(result.payload.checklist.length, 0);
  assert.equal(result.checklistAction, "skip");
  assert.equal(result.reused[0].id, 81);
  assert.match(result.reused[0].body, /fixbrief-ai:RB7/);
});

test("absorb reads post-plan.json and keeps a rejected file comment on the checklist", () => {
  const dir = mkdtempSync(join(tmpdir(), "fixbrief-absorb-"));
  const payload = githubReviewPayload([], 0.85, Number.POSITIVE_INFINITY, undefined, [], false, {}, 0.75, [
    sig({ title: "Off hunk", line: 80 }) as any,
  ]);
  const deduped = dedupeThreads(payload, [], undefined, { actor: "github-actions" });
  writeFileSync(join(dir, "deduped-payload.json"), JSON.stringify(deduped.payload));
  writeFileSync(join(dir, "checklist-plan.json"), JSON.stringify({
    action: deduped.checklistAction,
    commentId: null,
    body: deduped.checklistBody,
    includeInBrief: deduped.includeChecklist,
  }));
  writeFileSync(join(dir, "post-plan.json"), JSON.stringify({ quietReview: false }));
  writeFileSync(join(dir, "file-comment-failures.json"), JSON.stringify([deduped.payload.fileComments[0].fallback]));
  const run = spawnSync(process.execPath, [
    "--experimental-strip-types", "src/post-plan.ts", "absorb",
    "--out-dir", dir,
    "--failures", join(dir, "file-comment-failures.json"),
    "--pending", "true",
  ], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const plan = JSON.parse(readFileSync(join(dir, "checklist-plan.json"), "utf8"));
  assert.equal(plan.action, "create");
  assert.match(plan.body, /Off hunk/);
});

function lineThread(line: number, title = "Shared", commentId = line) {
  return {
    commentId, resolved: false, author: "github-actions", path: "a.py", line,
    body: `**${title}**\n\n${fingerprintMarker(threadFingerprint({ file: "a.py", title, line: commentId === line ? line : commentId }))}`,
  };
}

/**
 * Specification for matching a new finding to an open thread or checklist entry.
 * A review finding that asks for the opposite result is a policy change, not a defect.
 */
test("thread reuse policy", () => {
  const actor = { actor: "github-actions" };
  const shared = (id: string, line: number) => sig({ id, line, title: "Shared", confidence: 0.99 }) as any;
  const reuse = (findings: any[], threads: any[]) => dedupeThreads(githubReviewPayload(findings, 0.85), threads, undefined, actor);
  const pair = (result: ReturnType<typeof dedupeThreads>, id: string) => result.reused.find((item) => item.findingId === id)?.id;

  const near = reuse([shared("A", 12)], [lineThread(10)]);
  assert.equal(near.payload.comments.length, 0);
  assert.equal(pair(near, "A"), 10);

  const far = reuse([shared("NEW", 500)], [lineThread(10)]);
  assert.equal(far.payload.comments.length, 1);
  assert.equal(far.reused.length, 0);

  const shifted = reuse([shared("A", 12), shared("B", 32)], [lineThread(10), lineThread(30)]);
  assert.equal(shifted.payload.comments.length, 0);
  assert.equal(pair(shifted, "A"), 10);
  assert.equal(pair(shifted, "B"), 30);

  const passed = reuse([shared("A", 12), shared("B", 14)], [lineThread(10), lineThread(12)]);
  assert.equal(pair(passed, "A"), 10);
  assert.equal(pair(passed, "B"), 12);

  const tracked = dedupeThreads(githubReviewPayload([shared("A", 12), shared("B", 14)], 0.85), [
    { ...lineThread(12, "Shared", 10), body: `**Shared**\n\n${fingerprintMarker(threadFingerprint({ file: "a.py", title: "Shared", line: 10 }))}` },
    { ...lineThread(14, "Shared", 12), body: `**Shared**\n\n${fingerprintMarker(threadFingerprint({ file: "a.py", title: "Shared", line: 12 }))}` },
  ], undefined, actor);
  assert.equal(pair(tracked, "A"), 10);
  assert.equal(pair(tracked, "B"), 12);

  const exactLosesToSharedOffset = reuse([shared("A", 20), shared("B", 30)], [lineThread(10), lineThread(20)]);
  assert.equal(exactLosesToSharedOffset.payload.comments.length, 0);
  assert.equal(pair(exactLosesToSharedOffset, "A"), 10);
  assert.equal(pair(exactLosesToSharedOffset, "B"), 20);

  const clearedNear = dedupeThreads(githubReviewPayload([shared("A", 12)], 0.85), [{
    ...lineThread(10), line: null, originalLine: 10,
  }], undefined, actor);
  assert.equal(clearedNear.payload.comments.length, 0);
  assert.equal(pair(clearedNear, "A"), 10);
  const clearedFar = dedupeThreads(githubReviewPayload([shared("NEW", 500)], 0.85), [{
    ...lineThread(10), line: null, originalLine: 10,
  }], undefined, actor);
  assert.equal(clearedFar.payload.comments.length, 1);
  assert.equal(clearedFar.reused.length, 0);

  const filePayload = githubReviewPayload([], 0.85, Number.POSITIVE_INFINITY, undefined, [], false, {}, 0.75, [
    sig({ id: "A", title: "Off hunk", line: 80 }) as any,
  ]);
  const fromLine = dedupeThreads(filePayload, [lineThread(40, "Off hunk")], undefined, actor);
  assert.equal(fromLine.payload.fileComments.length, 0);
  assert.equal(fromLine.reused[0].id, 40);
  const legacy = dedupeThreads(filePayload, [{
    commentId: 44, resolved: false, author: "github-actions", path: "a.py",
    body: `**Off hunk**\n\n${fingerprintMarker(threadBaseFingerprint({ file: "a.py", title: "Off hunk" }))}`,
  }], undefined, actor);
  assert.equal(legacy.payload.fileComments.length, 0);
  assert.equal(legacy.reused[0].id, 44);

  const original = checklistItemFromFinding(sig({ id: "RB1", title: "Moved", file: "a.py", line: 10 }) as any);
  const existing = mergeChecklistBody(undefined, [original]);
  const movedItem = mergeChecklistBody(existing, [
    checklistItemFromFinding(sig({ id: "RB2", title: "Moved", file: "a.py", line: 12 }) as any),
  ]);
  assert.equal(movedItem.split("fixbrief-ai-item:").length, 2);
  const distantItem = mergeChecklistBody(existing, [
    checklistItemFromFinding(sig({ id: "RB3", title: "Moved", file: "a.py", line: 500 }) as any),
  ]);
  assert.equal(distantItem.split("fixbrief-ai-item:").length, 3);
  assert.match(distantItem, /`a.py:500`/);
});
