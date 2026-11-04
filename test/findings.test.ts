import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySeverityPolicy, findingRejectReason, fixBriefFindings, githubReviewPayload, isTypingStyleNit,
  parseFindingMarker, parseResponse, partitionInline, publishableFindings, qualifiesForFixBrief,
  qualifiesForInline, rankFindings, renderFinding, repairFindingsPrompt, reviewOverviewBody,
} from "../src/findings.ts";

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
  assert.equal(parseFindingMarker(body), "S");
});

test("renderFinding omits only when the suggestion block itself cannot fit", () => {
  const huge = Array.from({ length: 40 }, (_, i) => `line_${i}_xxxxxxxxxxxxxxxx`).join("\n");
  const body = renderFinding(sig({
    description: "Short problem statement.",
    recommendation: "Rewrite the block.",
    suggestion: huge,
  }) as any, 800);
  assert.match(body, /Suggestion omitted/);
  assert.doesNotMatch(body, /```suggestion/);
  assert.match(body, /Short problem statement/);
  assert.ok(body.length <= 800);
  assert.equal(parseFindingMarker(body), "S");
});

test("review overview body uses Copilot-style sections; below-gate stay off the PR", () => {
  const empty = reviewOverviewBody([], 0.85);
  assert.match(empty, /## Pull request overview/);
  assert.match(empty, /No inline findings met the publish gate/);
  assert.doesNotMatch(empty, /Also noted/);
  const emptyWithBelow = reviewOverviewBody([], 0.85, { belowGateCount: 3 });
  assert.match(emptyWithBelow, /3 other findings were scored but stayed below the publish gate/);
  const body = reviewOverviewBody([
    sig({ severity: "high", title: "CRLF blank context", file: "src/difflines.ts", line: 34 }),
    sig({ severity: "critical", confidence: 0.95, title: "Fence length", file: "src/findings.ts", line: 128 }),
  ] as any, 0.85, {
    title: "Fix CRLF and fence length",
    body: "This PR hardens the diff parser.\n\n## Changes\n- Fix CRLF context\n- Fix fence length\n",
    files: [
      { path: "src/difflines.ts", reviewed: true, comments: 1 },
      { path: "src/findings.ts", reviewed: true, comments: 1 },
      { path: "other.py", reviewed: false, comments: 0, note: "not on reviewed diff" },
    ],
    unanchored: [sig({
      confidence: 0.9, title: "Unanchored high", file: "other.py", line: 1,
      description: "Cannot attach this line.", recommendation: "Move the change onto an added line.",
    }) as any],
  });
  assert.match(body, /## Pull request overview/);
  assert.match(body, /Fix CRLF and fence length/);
  assert.match(body, /This PR hardens the diff parser\./);
  assert.match(body, /\*\*Changes:\*\*/);
  assert.match(body, /- Fix CRLF context/);
  assert.match(body, /FixBrief AI reviewed 2 out of 3 changed files/);
  assert.match(body, /generated 2 comments/);
  assert.match(body, /Show a summary per file/);
  assert.match(body, /`src\/difflines\.ts`: reviewed, 1 comment/);
  assert.doesNotMatch(body, /\| Severity \| Count \|/);
  assert.doesNotMatch(body, /confidence ≥/);
  assert.match(body, /### Could not place inline/);
  assert.match(body, /\*\*Unanchored high\*\*/);
  assert.match(body, /Cannot attach this line\./);
  assert.match(body, /\*\*Recommendation:\*\* Move the change onto an added line\./);
  assert.doesNotMatch(body, /Also noted/);
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
  assert.match(payload.body, /## Pull request overview/);
  assert.match(payload.body, /generated 1 comment/);
  assert.doesNotMatch(payload.body, /\*\*Keep\*\*/);
  assert.doesNotMatch(payload.body, /Also noted/);
  assert.doesNotMatch(payload.body, /\*\*Drop\*\*/);
  assert.doesNotMatch(payload.body, /\*\*Low severity drop\*\*/);
  assert.doesNotMatch(payload.body, /\*\*Medium never inline\*\*/);
  assert.doesNotMatch(payload.body, /\*\*Unanchored medium\*\*/);
  assert.match(payload.body, /### Could not place inline/);
  assert.match(payload.body, /\*\*Unanchored high\*\*/);
  assert.match(payload.body, /\*\*Recommendation:\*\* fix it/);
  assert.equal(payload.comments.length, 1);
  assert.match(payload.comments[0].body, /<div align="right"><b>High<\/b><\/div>/);
  assert.doesNotMatch(payload.comments[0].body, /% confidence/);
  const capped = githubReviewPayload([
    sig({ confidence: 0.95, title: "First", line: 2 }),
    sig({ confidence: 0.9, title: "Second", line: 3, description: "Over cap.", recommendation: "Raise the cap." }),
  ] as any, 0.85, 1);
  assert.equal(capped.comments.length, 1);
  assert.match(capped.body, /### Over the inline cap/);
  assert.match(capped.body, /\*\*Second\*\*/);
  assert.match(capped.body, /\*\*Recommendation:\*\* Raise the cap\./);
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

test("qualifiesForInline: only critical/high above confidence floor; medium/low/info never inline", () => {
  const mk = (o: any) => ({ id: "S", category: "quality", severity: "high", confidence: 0.85, file: "a.py", line: 1, title: "t", description: "d", ...o });
  assert.equal(qualifiesForInline(mk({}) as any, 0.85), true);
  assert.equal(qualifiesForInline(mk({ severity: "critical", confidence: 0.85 }) as any, 0.85), true);
  assert.equal(qualifiesForInline(mk({ severity: "high", confidence: 0.84 }) as any, 0.85), false);
  assert.equal(qualifiesForInline(mk({ severity: "medium", confidence: 0.99 }) as any, 0.85), false);
  assert.equal(qualifiesForInline(mk({ severity: "low", confidence: 0.99 }) as any, 0.85), false);
  assert.equal(qualifiesForInline(mk({ severity: "info", confidence: 0.99 }) as any, 0.85), false);
  const gated = partitionInline([
    mk({ line: 1, severity: "high", confidence: 0.9 }),
    mk({ line: 2, severity: "critical", confidence: 0.85, title: "crit" }),
    mk({ line: 3, severity: "medium", confidence: 0.99, title: "m-hi" }),
    mk({ line: 4, severity: "low", confidence: 0.99, title: "low" }),
  ] as any, 0.85, 0);
  assert.deepEqual(gated.inline.map((s) => s.line), [2, 1]);
  assert.deepEqual(gated.belowConfidence.map((s) => s.line).sort((a, b) => a - b), [3, 4]);
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
