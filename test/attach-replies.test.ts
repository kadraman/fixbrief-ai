import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachReportBack, matchCommentIds, renderReportBackSection, reportBackItem,
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

test("reportBackItem uses thread reply when a comment id is known", () => {
  const withId = reportBackItem(targets.targets[0], 1001, "owner/name", "42");
  assert.match(withId.command, /\/comments\/1001\/replies/);
  assert.match(withId.command, /Null check/);
  const without = reportBackItem(targets.targets[1], undefined, "owner/name", "42");
  assert.match(without.command, /gh pr comment 42 --repo owner\/name/);
  assert.match(without.command, /Edge case/);
});

test("renderReportBackSection lists reply commands for matched and unmatched findings", () => {
  const section = renderReportBackSection(targets, [
    { id: 1001, body: `body ${findingMarker("RB1")}` },
  ]);
  assert.match(section, /## Report back/);
  assert.match(section, /reply on review comment `1001`/);
  assert.match(section, /\/comments\/1001\/replies/);
  assert.match(section, /no inline thread/);
  assert.match(section, /gh pr comment 42/);
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
