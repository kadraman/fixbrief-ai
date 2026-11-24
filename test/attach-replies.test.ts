import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendBriefDownloadLink, attachReportBack, briefDownloadBlock, matchCommentIds,
  overviewIssueComment, renderReportBackSection, reportBackItem, toPendingReviewPayload,
} from "../src/attach-replies.ts";
import { findingMarker, type FixBriefTargetsFile } from "../src/findings.ts";

const targets: FixBriefTargetsFile = {
  schemaVersion: 1,
  repo: "owner/name",
  pr: "42",
  targets: [
    {
      id: "RB1", severity: "high", file: "a.ts", line: 10, title: "Null check", inline: true,
    },
    {
      id: "RB2", severity: "medium", file: "b.ts", line: 3, title: "Edge case", inline: false,
    },
  ],
};

test("matchCommentIds maps fixbrief-ai markers to comment ids", () => {
  const matched = matchCommentIds(targets.targets, [
    { id: 1001, body: `note\n\n${findingMarker("RB1")}` },
    { id: 1002, body: "unrelated" },
  ]);
  assert.equal(matched.get("RB1"), 1001);
  assert.equal(matched.has("RB2"), false);
});

test("matchCommentIds accepts legacy reviewbrief markers", () => {
  const matched = matchCommentIds(targets.targets, [
    { id: 2001, body: "legacy\n\n<!-- reviewbrief:RB1 -->" },
  ]);
  assert.equal(matched.get("RB1"), 2001);
});

test("reportBackItem replies once on a thread and does not invent a pull request comment", () => {
  const withId = reportBackItem(targets.targets[0], 1001, "owner/name", "42");
  assert.match(withId.command, /in_reply_to_id == 1001/);
  assert.match(withId.command, /--paginate --slurp/);
  assert.match(withId.command, /could not read replies for review comment 1001; not posting/);
  assert.match(withId.command, /\/comments\/1001\/replies/);
  assert.match(withId.command, /Null check/);
  assert.match(withId.command, /already reported on review comment 1001/);
  assert.match(withId.command, /fixbrief-ai-report:/);
  assert.ok(withId.command.indexOf("not posting") < withId.command.indexOf("/comments/1001/replies"));
  const without = reportBackItem(targets.targets[1], undefined, "owner/name", "42");
  assert.equal(without.command, "");
});

test("renderReportBackSection replies on threads and updates one checklist comment", () => {
  const section = renderReportBackSection(targets, [
    { id: 1001, body: `body ${findingMarker("RB1")}` },
  ], { id: 77, body: "### FixBrief findings without a review thread\n\nEdge case\n" });
  assert.match(section, /## Report back/);
  assert.match(section, /reply on review comment `1001`/);
  assert.match(section, /\/comments\/1001\/replies/);
  assert.match(section, /Do not open any other pull request comment/);
  assert.match(section, /issues\/comments\/77/);
  assert.match(section, /could not read checklist comment 77; not updating/);
  assert.ok(section.indexOf("issues/comments/77\" --jq .body") < section.indexOf("method PATCH"));
  assert.equal(section.split("gh pr comment").length, 1);
  const unmatched = renderReportBackSection(targets, []);
  assert.match(unmatched, /no review thread was posted/);
  assert.match(unmatched, /gh pr comment 42/);
  assert.equal(unmatched.split("gh pr comment").length, 2);
});

test("attachReportBack appends and replaces the Report back section", () => {
  const dir = mkdtempSync(join(tmpdir(), "fixbrief-ai-attach-"));
  const briefPath = join(dir, "fix-brief.md");
  writeFileSync(briefPath, "# Fix brief\n\n## Findings\n\n### 1. Null check\n");
  attachReportBack({
    briefPath,
    targets,
    comments: [{ id: 55, body: findingMarker("RB1") }],
  });
  let text = readFileSync(briefPath, "utf8");
  assert.match(text, /## Findings/);
  assert.match(text, /## Report back/);
  assert.match(text, /\/comments\/55\/replies/);
  // Re-attach replaces rather than duplicating.
  attachReportBack({
    briefPath,
    targets,
    comments: [{ id: 99, body: findingMarker("RB1") }],
  });
  text = readFileSync(briefPath, "utf8");
  assert.equal(text.split("## Report back").length, 2);
  assert.match(text, /\/comments\/99\/replies/);
  assert.doesNotMatch(text, /\/comments\/55\/replies/);
});

test("toPendingReviewPayload omits event so GitHub leaves the review pending", () => {
  const empty = toPendingReviewPayload({ comments: [] });
  assert.deepEqual(empty, {});
  assert.equal("event" in empty, false);
  assert.equal("body" in empty, false);
  const withComments = toPendingReviewPayload({
    comments: [{ path: "a.ts", line: 4, side: "RIGHT", body: "note" }],
  });
  assert.equal("event" in withComments, false);
  assert.equal(withComments.comments?.length, 1);
  assert.equal(withComments.comments?.[0].path, "a.ts");
});

test("overviewIssueComment includes the download link and inline findings", () => {
  const text = overviewIssueComment({
    body: "## Review\n\nHello.",
    comments: [{ path: "a.ts", line: 4, side: "RIGHT", body: "Check this." }],
  }, "https://example.com/fix-brief.md");
  assert.match(text, /\[download fix-brief\.md\]\(https:\/\/example\.com\/fix-brief\.md\)/);
  assert.match(text, /`a\.ts:4`/);
  assert.match(text, /Check this\./);
  const plain = overviewIssueComment({ body: "Hello.\n", comments: [] });
  assert.equal(plain, "Hello.\n");
  assert.doesNotMatch(plain, /download fix-brief/);
});

test("appendBriefDownloadLink adds usage instructions and does not duplicate", () => {
  const url = "https://example.com/fix-brief.md";
  const block = briefDownloadBlock(url);
  assert.match(block, /\[download fix-brief\.md\]\(https:\/\/example\.com\/fix-brief\.md\)/);
  assert.match(block, /check out this pull request/);
  assert.match(block, /coding assistant/);
  const once = appendBriefDownloadLink("## Pull request overview\n\nHello.\n", url);
  assert.match(once, /Download `fix-brief\.md`/);
  assert.match(once, /reply on the review thread/);
  const twice = appendBriefDownloadLink(once, url);
  assert.equal(twice, once);
  assert.equal(twice.split("download fix-brief.md").length, 2);
});
