import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySeverityPolicy, categoriesLabel, filterByCategories, findingRejectReason,
  fixBriefFindings, formatFileListFooter, githubReviewPayload, isTypingStyleNit,
  parseCategories, parseFindingMarker, parseResponse, parseSkippedEntry, partitionInline,
  payloadHasContent, publishableFindings, qualifiesForFixBrief, qualifiesForInline,
  rankFindings, renderFinding, repairFindingsPrompt, reviewOverviewBody,
  checklistItemFromFinding, mergeChecklistBody, mergeChecklistReport, renderChecklistBody, threadFingerprint,
} from "../src/findings.ts";
import { reviewSystemPrompt } from "../src/fixbrief-ai.ts";

const sig = (o: any) => ({ id: "S", category: "security", severity: "high", confidence: 0.95, file: "a.py", line: 2, title: "t", description: "d", ...o });

test("parseResponse: prose is not ok, empty array is ok, array recommendation survives rendering", () => {
  assert.equal(parseResponse("Looks fine overall.").ok, false);
  assert.deepEqual(parseResponse('{"findings": []}'), { ok: true, findings: [], dropped: 0, rejected: [] });
  const r = parseResponse('```json\n{"findings":[{"id":1,"category":"Security","severity":"HIGH","confidence":"85%","file":"a.py","line":"2","title":"t","description":"d","recommendation":["do A","do B"]},{"bad":true}]}\n```');
  assert.equal(r.ok, true); assert.equal(r.dropped, 1); assert.equal(r.findings.length, 1);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /category/);
  assert.equal(r.findings[0].line, 2); assert.equal(r.findings[0].level, "high"); assert.equal(r.findings[0].confidence, 0.75);
  assert.equal(r.findings[0].recommendation, "do A do B");
  assert.doesNotThrow(() => renderFinding(r.findings[0]));
});

test("findingRejectReason and repairFindingsPrompt describe schema failures", () => {
  assert.equal(findingRejectReason({
    category: "security", severity: "high", file: "a.py", line: 1, title: "t", description: "d",
  }), null);
  assert.match(findingRejectReason({ category: "bug", severity: "high", file: "a.py", line: 1, title: "t", description: "d" }) ?? "", /category/);
  assert.match(findingRejectReason({ category: "security", severity: "high", file: "a.py", line: "x", title: "t", description: "d" }) ?? "", /line/);
  const prompt = repairFindingsPrompt([{
    index: 0, reason: "line must be a positive integer (got \"x\")",
    row: { category: "security", severity: "high", file: "a.py", line: "x", title: "t", description: "d" },
  }]);
  assert.match(prompt, /Rejected items/);
  assert.match(prompt, /line must be a positive integer/);
  assert.match(prompt, /Do NOT resend the findings that were already accepted/);
});

test("applySeverityPolicy promotes removed dirty/unsaved-draft guards to high", () => {
  const med = applySeverityPolicy(sig({
    severity: "medium", confidence: 0.9, title: "Dirty-draft navigation guard removed",
    description: "selectInstrument no longer prompts on unsaved draft changes.",
  }) as any);
  assert.equal(med.severity, "high");
  const other = applySeverityPolicy(sig({
    severity: "medium", title: "Loop listener may re-enter", description: "Idempotency concern.",
  }) as any);
  assert.equal(other.severity, "medium");
  const parsed = parseResponse(JSON.stringify({
    findings: [{
      id: "1", category: "quality", severity: "medium", confidence: "high", file: "a.ts", line: 1,
      title: "Dirty guard removed from instrument picker", description: "No longer checks unsaved draft.",
      evidence: "setSelected(name)",
    }],
  }));
  assert.equal(parsed.findings[0].severity, "high");
});

test("TypeScript any / type-assertion nits are rejected", () => {
  assert.equal(isTypingStyleNit("Use of `any` for rawAst parameter", "Parameter is typed as any."), true);
  assert.equal(isTypingStyleNit("Dirty draft guard removed", "Users can lose unsaved edits."), false);
  assert.match(findingRejectReason({
    category: "quality", severity: "medium", file: "a.ts", line: 1,
    title: "Use of `any` for channels map", description: "channels is typed as any.",
  }) ?? "", /typing\/style nit/);
  const parsed = parseResponse(JSON.stringify({
    findings: [
      { id: "1", category: "quality", severity: "medium", confidence: "high", file: "a.ts", line: 1,
        title: "Use of `any` for x", description: "typed as any", evidence: "const x: any = 1" },
      { id: "2", category: "security", severity: "high", confidence: "high", file: "a.ts", line: 2,
        title: "SQL injection", description: "user input in query", evidence: "db.query(user)" },
    ],
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].title, "SQL injection");
  assert.equal(parsed.dropped, 1);
  assert.match(parsed.rejected[0].reason, /typing\/style nit/);
});

test("renderFinding picks a fence longer than any backtick run in the suggestion", () => {
  const body = renderFinding(sig({ suggestion: "use ````code```` here" }) as any, 2000);
  assert.match(body, /\n`````suggestion\n/);
  assert.match(body, /\n`````\n/);
});

test("renderFinding uses Copilot-style severity, omits confidence %, and keeps a marker", () => {
  const body = renderFinding(sig({
    id: "RB1",
    title: "Truthiness bug",
    description: "`token.pan` of `0` is ignored.",
    recommendation: "Use an explicit `!== undefined` check.",
  }) as any, 2000);
  assert.match(body, /<div align="right"><b>High<\/b><\/div>/);
  assert.match(body, /\*\*Truthiness bug\*\*/);
  assert.match(body, /token\.pan/);
  assert.match(body, /\*\*Fix:\*\* Use an explicit/);
  assert.doesNotMatch(body, /% confidence/);
  assert.doesNotMatch(body, /🚨|⚠️/);
  assert.equal(parseFindingMarker(body), "RB1");
});

test("renderFinding keeps a short suggestion by shrinking long prose first", () => {
  const longDesc = "D".repeat(900);
  const body = renderFinding(sig({
    description: longDesc,
    recommendation: "Pin to a commit SHA.",
    suggestion: "uses: kadraman/fixbrief-ai@abc123",
  }) as any, 800);
  assert.match(body, /```suggestion\nuses: kadraman\/fixbrief-ai@abc123\n```/);
  assert.doesNotMatch(body, /Suggestion omitted/);
  assert.ok(body.length <= 800);
  assert.ok(!body.includes(longDesc));
  assert.match(body, /D…/);
  assert.ok((body.match(/D+/)?.[0].length ?? 0) >= 120);
  assert.equal(parseFindingMarker(body), "S");
});

test("renderFinding omits a large suggestion instead of crushing the description", () => {
  const huge = Array.from({ length: 40 }, (_, i) => `line_${i}_xxxxxxxxxxxxxxxx`).join("\n");
  const description = "Script truncates target source file after replacing BUNDLED_SAMPLES. "
    + "The script writes a new BUNDLED_SAMPLES block and drops the remainder of the file.";
  const body = renderFinding(sig({
    description,
    recommendation: "Preserve the remainder of the original file after the original BUNDLED_SAMPLES block.",
    suggestion: huge,
  }) as any, 800);
  assert.match(body, /Suggestion omitted/);
  assert.doesNotMatch(body, /```suggestion/);
  assert.match(body, /Script truncates target source file/);
  assert.doesNotMatch(body, /The scr…/);
  assert.ok(body.length <= 800);
  assert.equal(parseFindingMarker(body), "S");
});

test("review overview body uses Copilot-style sections; below-gate stay off the PR", () => {
  const empty = reviewOverviewBody([], 0.85);
  assert.match(empty, /## FixBrief AI review/);
  assert.match(empty, /No findings met the thread gate/);
  assert.doesNotMatch(empty, /Also noted/);
  const emptyWithBelow = reviewOverviewBody([], 0.85, { belowGateCount: 3 });
  assert.match(emptyWithBelow, /3 other findings were scored but stayed below the publish gate \(see the workflow job summary\)/);
  const body = reviewOverviewBody([
    sig({ severity: "high", title: "CRLF blank context", file: "src/difflines.ts", line: 34 }),
    sig({ severity: "critical", confidence: 0.95, title: "Fence length", file: "src/findings.ts", line: 128 }),
  ] as any, 0.85, {
    title: "Fix CRLF and fence length",
    body: "This PR hardens the diff parser.\n\n## Changes\n- Fix CRLF context\n- Fix fence length\n",
    files: [
      { path: "src/difflines.ts", reviewed: true, comments: 1 },
      { path: "src/findings.ts", reviewed: true, comments: 1 },
      { path: "quiet.ts", reviewed: true, comments: 0 },
      { path: "other.py", reviewed: false, comments: 0, note: "not on reviewed diff" },
    ],
    unanchored: [sig({
      confidence: 0.9, title: "Unanchored high", file: "other.py", line: 1,
      description: "Cannot attach this line.", recommendation: "Move the change onto an added line.",
    }) as any],
  });
  assert.match(body, /## FixBrief AI review/);
  assert.match(body, /Fix CRLF and fence length/);
  assert.match(body, /This PR hardens the diff parser\./);
  assert.match(body, /\*\*Changes:\*\*/);
  assert.match(body, /- Fix CRLF context/);
  assert.match(body, /FixBrief AI reviewed 3 out of 4 changed files/);
  assert.match(body, /generated 2 comments/);
  assert.match(body, /Show a summary per file/);
  assert.match(body, /`src\/difflines\.ts`: reviewed, 1 comment/);
  assert.match(body, /1 other reviewed file with no comments/);
  assert.doesNotMatch(body, /`quiet\.ts`/);
  assert.doesNotMatch(body, /\| Severity \| Count \|/);
  assert.doesNotMatch(body, /confidence ≥/);
  assert.match(body, /### Could not place on a changed file/);
  assert.match(body, /\*\*Unanchored high\*\*/);
  assert.match(body, /Cannot attach this line\./);
  assert.match(body, /\*\*Recommendation:\*\* Move the change onto an added line\./);
  assert.doesNotMatch(body, /Also noted/);
  // Without a PR-body Changes section, do not dump raw file paths.
  const noPathDump = reviewOverviewBody([], 0.85, {
    title: "Paths only",
    files: [{ path: "a.py", reviewed: true, comments: 0 }, { path: "b.py", reviewed: true, comments: 0 }],
  });
  assert.doesNotMatch(noPathDump, /\*\*Changes:\*\*/);
  assert.doesNotMatch(noPathDump, /`a\.py`/);
  assert.match(noPathDump, /2 other reviewed files with no comments/);
  const payload = githubReviewPayload([
    sig({ confidence: 0.9, title: "Keep" }),
    sig({ confidence: 0.5, title: "Drop" }),
    sig({ severity: "low", confidence: 0.95, title: "Low severity drop" }),
    sig({ severity: "medium", confidence: 0.99, title: "Medium never inline" }),
  ] as any, 0.85, undefined, undefined, [
    sig({ file: "other.py", line: 1, title: "Unanchored high", confidence: 0.9, description: "d", recommendation: "fix it" }) as any,
    sig({ file: "other.py", line: 2, title: "Unanchored medium", severity: "medium", confidence: 0.99, description: "skip" }) as any,
  ], false, {
    title: "Keep the gate",
    files: [{ path: "a.py", reviewed: true, comments: 1 }],
  });
  assert.match(payload.body, /## FixBrief AI review/);
  assert.match(payload.body, /generated 2 comments/);
  assert.doesNotMatch(payload.body, /\*\*Keep\*\*/);
  assert.doesNotMatch(payload.body, /Also noted/);
  assert.doesNotMatch(payload.body, /\*\*Drop\*\*/);
  assert.doesNotMatch(payload.body, /\*\*Low severity drop\*\*/);
  assert.doesNotMatch(payload.body, /### Also in the fix brief/);
  assert.doesNotMatch(payload.body, /\*\*Medium never inline\*\*/);
  assert.match(payload.body, /\*\*Unanchored medium\*\*/);
  assert.match(payload.body, /### Could not place on a changed file/);
  assert.match(payload.body, /\*\*Unanchored high\*\*/);
  assert.match(payload.body, /\*\*Recommendation:\*\* fix it/);
  assert.equal(payload.comments.length, 2);
  assert.equal(payload.checklist.length, 2);
  assert.match(payload.comments.map((comment) => comment.body).join("\n"), /<div align="right"><b>High<\/b><\/div>/);
  assert.match(payload.comments.map((comment) => comment.body).join("\n"), /fixbrief-ai-fp:/);
  assert.doesNotMatch(payload.comments[0].body, /% confidence/);
  const capped = githubReviewPayload([
    sig({ confidence: 0.95, title: "First", line: 2 }),
    sig({ confidence: 0.9, title: "Second", line: 3, description: "Over cap.", recommendation: "Raise the cap." }),
  ] as any, 0.85, 1);
  assert.equal(capped.comments.length, 1);
  assert.equal(capped.checklist.length, 1);
  assert.equal(capped.checklist[0].title, "Second");
  assert.match(capped.body, /### Over the inline cap/);
  assert.match(capped.body, /\*\*Second\*\*/);
  assert.match(capped.body, /\*\*Recommendation:\*\* Raise the cap\./);
});

test("fix-brief medium findings are review threads; weaker findings stay off the pull request", () => {
  const payload = githubReviewPayload([
    sig({ confidence: 0.9, title: "Inline high", line: 1 }),
    sig({ severity: "medium", confidence: 0.75, title: "Brief medium", line: 2, description: "Edge case.", recommendation: "Guard it." }),
    sig({ severity: "medium", confidence: 0.74, title: "Too weak medium", line: 3 }),
    sig({ severity: "low", confidence: 0.99, title: "Low stays off", line: 4 }),
  ] as any, 0.85);
  assert.equal(payload.comments.length, 2);
  assert.match(payload.body, /generated 2 comments/);
  assert.doesNotMatch(payload.body, /### Also in the fix brief/);
  assert.doesNotMatch(payload.body, /\*\*Brief medium\*\*/);
  assert.match(payload.comments.map((comment) => comment.body).join("\n"), /\*\*Brief medium\*\*/);
  assert.match(payload.comments.map((comment) => comment.body).join("\n"), /Edge case\./);
  assert.doesNotMatch(payload.body, /\*\*Too weak medium\*\*/);
  assert.doesNotMatch(payload.body, /\*\*Low stays off\*\*/);
  assert.doesNotMatch(payload.body, /\*\*Inline high\*\*/);
  assert.equal(payloadHasContent(payload), true);

  const briefOnly = githubReviewPayload([
    sig({ severity: "medium", confidence: 0.8, title: "Only in brief", line: 5, description: "Worth noting." }),
  ] as any, 0.85);
  assert.equal(briefOnly.comments.length, 1);
  assert.match(briefOnly.comments[0].body, /\*\*Only in brief\*\*/);
  assert.equal(payloadHasContent(briefOnly), true);
});

test("parseCategories / filterByCategories allowlist findings; unknown names throw", () => {
  assert.equal(parseCategories(""), "all");
  assert.equal(parseCategories("all"), "all");
  assert.equal(parseCategories("*"), "all");
  const allowed = parseCategories("security, Compliance quality");
  assert.ok(allowed !== "all");
  assert.deepEqual([...allowed].sort(), ["compliance", "quality", "security"]);
  assert.equal(categoriesLabel(allowed), "compliance,quality,security");
  assert.throws(() => parseCategories("security,style"), /Unknown category: style/);
  assert.throws(() => parseCategories("???"), /Unknown/);
  const findings = [
    sig({ category: "security", title: "sec" }),
    sig({ category: "quality", title: "qual" }),
    sig({ category: "documentation", title: "docs" }),
  ] as any;
  assert.deepEqual(filterByCategories(findings, "all").map((f) => f.title), ["sec", "qual", "docs"]);
  assert.deepEqual(filterByCategories(findings, allowed).map((f) => f.title), ["sec", "qual"]);
  const narrowed = reviewSystemPrompt(allowed);
  assert.match(narrowed, /Category filter: only emit findings whose category is one of: compliance, quality, security/);
  assert.equal(reviewSystemPrompt("all"), reviewSystemPrompt());
  assert.doesNotMatch(reviewSystemPrompt("all"), /Category filter:/);
  assert.match(reviewSystemPrompt("all"), /OWASP-class/);
  assert.match(reviewSystemPrompt("all"), /linters, formatters, and dedicated SAST tools/);
  assert.match(reviewSystemPrompt("all"), /omit the finding instead of grading it high/);
  assert.match(reviewSystemPrompt("all"), /pseudo-element blocks clicks or hover/);
});

test("formatFileListFooter tallies reasons and collapses files into a details accordion", () => {
  assert.equal(formatFileListFooter("**Skipped:**", [], "Show skipped files"), "");
  assert.deepEqual(parseSkippedEntry("samples/a.dmc (binary)"), { path: "samples/a.dmc", note: "binary" });
  assert.deepEqual(parseSkippedEntry("plain.ts"), { path: "plain.ts" });
  const skipped = formatFileListFooter("**Skipped:**", [
    { path: "a.dmc", note: "binary" },
    { path: "b.dmc", note: "binary" },
    { path: "package-lock.json", note: "lockfile/generated/binary" },
  ], "Show skipped files");
  assert.match(skipped, /\*\*Skipped:\*\* 3 files were not reviewed \(2 binary, 1 lockfile\/generated\/binary\)\./);
  assert.match(skipped, /<summary>Show skipped files<\/summary>/);
  assert.match(skipped, /`a\.dmc` \(binary\)/);
  assert.match(skipped, /`package-lock\.json` \(lockfile\/generated\/binary\)/);
  const unreviewed = formatFileListFooter(
    "**Not reviewed (exceeded MAX_BATCHES=40):**",
    [{ path: "big.ts" }, { path: "huge.ts" }],
    "Show not reviewed files",
  );
  assert.match(unreviewed, /\*\*Not reviewed \(exceeded MAX_BATCHES=40\):\*\* 2 files\./);
  assert.match(unreviewed, /`big\.ts`/);
  assert.doesNotMatch(unreviewed, /were not reviewed/);
});

test("normalizeFinding maps confidence levels and numbers; missing is low", () => {
  const level = (c: unknown) => parseResponse(JSON.stringify({ findings: [{ category: "quality", severity: "low", file: "a", line: 1, title: "t", description: "d", confidence: c }] })).findings[0];
  assert.deepEqual(["high", "MEDIUM", 0.9, "70%", 0.2, undefined].map((c) => level(c).level), ["high", "medium", "high", "medium", "low", "low"]);
  assert.equal(level("high").confidence, 0.75);
  assert.equal(parseResponse(JSON.stringify({ findings: [{ category: "quality", severity: "low", file: "a", line: 1, title: "t", description: "d", confidence: "high", evidence: "x = 1" }] })).findings[0].evidence, "x = 1");
});

test("rankFindings/partitionInline: highest-confidence duplicate wins, threshold, cap, input order does not matter", () => {
  const mk = (o: any) => ({ id: "S", category: "security", severity: "high", confidence: 0.9, file: "a.py", line: 3, title: "t", description: "d", ...o });
  const input = [mk({ confidence: 0.86 }), mk({ confidence: 0.95 }), mk({ line: 5, title: "u", severity: "critical" }), mk({ line: 7, title: "v", confidence: 0.5 }), mk({ line: 9, title: "w", confidence: 0.85 })] as any;
  const part = partitionInline(input, 0.85, 0);
  assert.deepEqual(part.inline.map((s) => [s.line, s.confidence]), [[5, 0.9], [3, 0.95], [9, 0.85]]);
  assert.deepEqual(part.belowConfidence.map((s) => s.line), [7]);
  assert.equal(part.capped.length, 0);
  const capped = partitionInline(input, 0.85, 2);
  assert.equal(capped.inline.length, 2);
  assert.deepEqual(capped.capped.map((s) => s.line), [9]);
  assert.deepEqual(partitionInline([...input].reverse(), 0.85, 0), part);
  assert.deepEqual(rankFindings([...input].reverse()), rankFindings(input));
  const a = mk({ category: "quality" }), b = mk({ category: "security" });
  assert.deepEqual(rankFindings([b, a] as any).map((s) => s.category), ["quality", "security"]);
});

test("qualifiesForInline: fix-brief findings are threads; low/info and weak mediums are not", () => {
  const mk = (o: any) => ({ id: "S", category: "quality", severity: "high", confidence: 0.85, file: "a.py", line: 1, title: "t", description: "d", ...o });
  assert.equal(qualifiesForInline(mk({}) as any, 0.85), true);
  assert.equal(qualifiesForInline(mk({ severity: "critical", confidence: 0.85 }) as any, 0.85), true);
  assert.equal(qualifiesForInline(mk({ severity: "high", confidence: 0.84 }) as any, 0.85), false);
  assert.equal(qualifiesForInline(mk({ severity: "medium", confidence: 0.75, title: "med" }) as any, 0.85), true);
  assert.equal(qualifiesForInline(mk({ severity: "medium", confidence: 0.74, title: "weak" }) as any, 0.85), false);
  assert.equal(qualifiesForInline(mk({ severity: "low", confidence: 0.99 }) as any, 0.85), false);
  assert.equal(qualifiesForInline(mk({ severity: "info", confidence: 0.99 }) as any, 0.85), false);
  const gated = partitionInline([
    mk({ line: 1, severity: "high", confidence: 0.9 }),
    mk({ line: 2, severity: "critical", confidence: 0.85, title: "crit" }),
    mk({ line: 3, severity: "medium", confidence: 0.99, title: "m-hi" }),
    mk({ line: 4, severity: "low", confidence: 0.99, title: "low" }),
  ] as any, 0.85, 0);
  assert.deepEqual(gated.inline.map((s) => s.line), [2, 1, 3]);
  assert.deepEqual(gated.belowConfidence.map((s) => s.line), [4]);
});

test("fix brief includes PR-gated findings plus medium at ≥ 0.75; skips low/info", () => {
  const mk = (o: any) => ({ id: "S", category: "quality", severity: "high", confidence: 0.85, file: "a.py", line: 1, title: "t", description: "d", ...o });
  assert.equal(qualifiesForFixBrief(mk({}) as any, 0.85), true);
  assert.equal(qualifiesForFixBrief(mk({ severity: "medium", confidence: 0.75, title: "m" }) as any, 0.85), true);
  assert.equal(qualifiesForFixBrief(mk({ severity: "medium", confidence: 0.74, title: "m-low" }) as any, 0.85), false);
  assert.equal(qualifiesForFixBrief(mk({ severity: "low", confidence: 0.99, title: "low" }) as any, 0.85), false);
  assert.equal(qualifiesForFixBrief(mk({ severity: "info", confidence: 0.99, title: "info" }) as any, 0.85), false);
  assert.equal(qualifiesForFixBrief(mk({ severity: "high", confidence: 0.84, title: "hi-low" }) as any, 0.85), false);
  const brief = fixBriefFindings([
    mk({ line: 1, severity: "high", confidence: 0.9, title: "keep-high" }),
    mk({ line: 2, severity: "medium", confidence: 0.75, title: "keep-med" }),
    mk({ line: 3, severity: "medium", confidence: 0.74, title: "drop-med" }),
    mk({ line: 4, severity: "low", confidence: 0.9, title: "drop-low" }),
  ] as any, 0.85);
  assert.deepEqual(brief.map((s) => s.title), ["keep-high", "keep-med"]);
});

test("requireMultiRun: one-off high still publishes; one-off medium stays out of the fix brief", () => {
  const mk = (o: any) => ({
    id: "S", category: "quality", severity: "high", confidence: 0.95, file: "a.py", line: 1, title: "t", description: "d",
    confidenceBreakdown: { level: "high", base: 0.75, anchor: "added", anchorDelta: 0.1, evidence: "found", evidenceDelta: 0.1, agreement: "all", agreementDelta: 0.1 },
    ...o,
  });
  const agreed = mk({ title: "agreed" });
  const once = mk({
    title: "once", line: 2, confidence: 0.85, confidenceBreakdown: {
      level: "high", base: 0.75, anchor: "added", anchorDelta: 0.1, evidence: "found", evidenceDelta: 0.1,
      agreement: "single", agreementDelta: -0.1,
    },
  });
  const medOnce = mk({
    title: "med-once", line: 3, severity: "medium", confidence: 0.75, confidenceBreakdown: {
      level: "medium", base: 0.55, anchor: "added", anchorDelta: 0.1, evidence: "found", evidenceDelta: 0.1,
      agreement: "single", agreementDelta: -0.1,
    },
  });
  const medAgreed = mk({
    title: "med-agreed", line: 4, severity: "medium", confidence: 0.75, confidenceBreakdown: {
      level: "medium", base: 0.55, anchor: "added", anchorDelta: 0.1, evidence: "found", evidenceDelta: 0.1,
      agreement: "all", agreementDelta: 0.1,
    },
  });
  assert.equal(qualifiesForInline(agreed as any, 0.85, true), true);
  assert.equal(qualifiesForInline(once as any, 0.85, true), true);
  assert.equal(qualifiesForFixBrief(once as any, 0.85, 0.75, true), true);
  assert.equal(qualifiesForFixBrief(medOnce as any, 0.85, 0.75, true), false);
  assert.equal(qualifiesForFixBrief(medAgreed as any, 0.85, 0.75, true), true);
  const published = publishableFindings([agreed, once] as any, [], 0.85, 0, true);
  assert.deepEqual(published.inline.map((s) => s.title), ["agreed", "once"]);
  assert.deepEqual(fixBriefFindings([agreed, once, medOnce, medAgreed] as any, 0.85, 0.75, true).map((s) => s.title),
    ["agreed", "once", "med-agreed"]);
});

test("file-level findings become file comments; files outside the diff become checklist items", () => {
  const payload = githubReviewPayload([], 0.85, Number.POSITIVE_INFINITY, undefined, [
    sig({ file: "missing.py", line: 1, title: "Missing", confidence: 0.9, description: "not in diff", recommendation: "move it" }) as any,
  ], false, {}, 0.75, [
    sig({ file: "a.py", line: 99, title: "Off hunk", suggestion: "nope" }) as any,
  ]);
  assert.equal(payload.comments.length, 0);
  assert.equal(payload.fileComments.length, 1);
  assert.equal(payload.fileComments[0].subject_type, "file");
  assert.equal(payload.fileComments[0].path, "a.py");
  assert.doesNotMatch(payload.fileComments[0].body, /```suggestion/);
  assert.match(payload.fileComments[0].body, /fixbrief-ai-fp:/);
  assert.equal(payload.checklist.length, 1);
  assert.equal(payload.checklist[0].title, "Missing");
  assert.match(payload.body, /generated 1 comment/);
});

test("thread fingerprint ignores line number and a leading dot-slash, and keeps a/ and b/ directories", () => {
  const left = threadFingerprint({ file: "./a.py", title: "Keep  Harmonics" });
  const right = threadFingerprint({ file: "a.py", title: "keep harmonics" });
  assert.equal(left, right);
  assert.equal(left, threadFingerprint({ file: "a.py", line: 40, title: "keep harmonics" }));
  assert.notEqual(left, threadFingerprint({ file: "a.py", title: "other" }));
  assert.notEqual(
    threadFingerprint({ file: "a/config.ts", title: "Same" }),
    threadFingerprint({ file: "b/config.ts", title: "Same" }),
  );
  assert.notEqual(
    threadFingerprint({ file: "a/config.ts", title: "Same" }),
    threadFingerprint({ file: "config.ts", title: "Same" }),
  );
});

test("two findings with the same file and title at different lines both stay in the review", () => {
  const payload = githubReviewPayload([
    sig({ id: "A", line: 4, title: "Shared", confidence: 0.9 }),
    sig({ id: "B", line: 12, title: "Shared", confidence: 0.86 }),
    sig({ id: "C", line: 4, title: "Shared", confidence: 0.99 }),
  ] as any, 0.85);
  assert.equal(payload.comments.length, 2);
  const fingerprints = payload.comments.map((comment) => comment.body.match(/fixbrief-ai-fp:([^\s>]+)/)?.[1]);
  assert.equal(fingerprints[0], threadFingerprint({ file: "a.py", title: "Shared" }));
  assert.notEqual(fingerprints[0], fingerprints[1]);
  assert.match(payload.comments.map((comment) => comment.body).join("\n"), /fixbrief-ai:A|fixbrief-ai:C/);
  assert.match(payload.comments.map((comment) => comment.body).join("\n"), /fixbrief-ai:B/);
});

test("mergeChecklistBody appends new items and keeps text the agent already wrote", () => {
  const first = checklistItemFromFinding(sig({ id: "RB1", title: "First", file: "a.py", line: 1 }) as any);
  const second = checklistItemFromFinding(sig({ id: "RB2", title: "Second", file: "b.py", line: 2 }) as any);
  const existing = mergeChecklistBody(undefined, [first]).replace(
    "<what you fixed, or why you skipped this finding>",
    "Fixed the first one.",
  );
  const merged = mergeChecklistBody(existing, [first, second]);
  assert.match(merged, /Fixed the first one\./);
  assert.match(merged, /#### high: Second/);
  assert.equal(merged.split("fixbrief-ai-checklist").length, 2);
  assert.equal(mergeChecklistBody(merged, [first, second]), `${merged.trimEnd()}\n`);
});

test("mergeChecklistReport keeps the download link and later checklist edits", () => {
  const first = checklistItemFromFinding(sig({ id: "RB1", title: "First", file: "a.py", line: 1 }) as any);
  const later = checklistItemFromFinding(sig({ id: "RB9", title: "Later", file: "c.py", line: 3 }) as any);
  const current = `${renderChecklistBody([first, later]).trimEnd()}\n\n**Fix brief:** [download fix-brief.md](https://example.com/brief)\n`;
  const edited = renderChecklistBody([first]).replace(
    "<what you fixed, or why you skipped this finding>",
    "Fixed the first one.",
  );
  const merged = mergeChecklistReport(current, edited);
  assert.match(merged, /Fixed the first one\./);
  assert.match(merged, /#### high: Later/);
  assert.match(merged, /download fix-brief\.md/);
  assert.equal(merged.split("<what you fixed").length, 2);
});
