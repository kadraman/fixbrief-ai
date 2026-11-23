import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintMarker, githubReviewPayload, findingMarker } from "../src/findings.ts";
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
    body: `old\n${findingMarker("RB9")}\n${fingerprintMarker(fingerprint!)}`,
  }], undefined, { repo: "acme/app", pr: "7" });
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
    commentId: 9, resolved: true, body: fingerprintMarker(fingerprint),
  }]);
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
