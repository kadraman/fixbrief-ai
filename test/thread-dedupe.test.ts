import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checklistItemFromFinding, fingerprintMarker, githubReviewPayload, findingMarker } from "../src/findings.ts";
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
