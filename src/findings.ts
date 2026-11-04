#!/usr/bin/env node
/** Canonical Finding model and GitHub review comment renderer. */

export type FindingCategory =
  | "security" | "quality" | "maintainability" | "performance"
  | "architecture" | "testing" | "documentation" | "compliance";

export type ConfidenceLevel = "high" | "medium" | "low";
export type EvidenceStatus = "found" | "partial" | "not_found" | "missing";

/** Base score for each model-reported confidence level. The final confidence is computed in code (confidence.ts). */
export const LEVEL_BASE: Record<ConfidenceLevel, number> = { high: 0.75, medium: 0.55, low: 0.35 };

export interface ConfidenceBreakdown {
  level: ConfidenceLevel; base: number;
  anchor: "added" | "context" | "none"; anchorDelta: number;
  evidence: EvidenceStatus; evidenceDelta: number;
  agreement: "all" | "partial" | "single" | "n/a"; agreementDelta: number;
}

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: number;
  file: string;
  line: number;
  endLine?: number;
  title: string;
  description: string;
  recommendation?: string;
  suggestion?: string;
  ruleId?: string;
  references?: string[];
  level?: ConfidenceLevel;
  evidence?: string;
  confidenceBreakdown?: ConfidenceBreakdown;
}

export interface GitHubReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export interface GitHubReviewPayload {
  event: "COMMENT";
  body: string;
  comments: GitHubReviewComment[];
}

const CATEGORIES = new Set(["security", "quality", "maintainability", "performance", "architecture", "testing", "documentation", "compliance"]);
const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const severities: FindingSeverity[] = ["critical", "high", "medium", "low", "info"];
const icons: Record<FindingSeverity, string> = {
  critical: "🚨", high: "⚠️", medium: "🔶", low: "💡", info: "ℹ️",
};

function toInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}
function numberToLevel(n: number): ConfidenceLevel {
  const x = n > 1 ? n / 100 : n;
  return x >= 0.85 ? "high" : x >= 0.6 ? "medium" : "low";
}
function toLevel(value: unknown): ConfidenceLevel {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "high" || v === "medium" || v === "low") return v;
    const n = Number(v.replace(/%\s*$/, ""));
    return Number.isFinite(n) && n >= 0 ? numberToLevel(n) : "low";
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? numberToLevel(value) : "low";
}
function toText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
    return parts.length ? parts.join(" ") : undefined;
  }
  return undefined;
}

export function normalizeFinding(row: Record<string, unknown>, index: number): Finding | null {
  return findingRejectReason(row) ? null : normalizeFindingUnchecked(row, index);
}

/** Promote under-rated UX/safety guard removals to high so they can clear the publish gate. */
export function applySeverityPolicy(finding: Finding): Finding {
  if (finding.severity === "critical" || finding.severity === "high") return finding;
  const blob = `${finding.title}\n${finding.description}\n${finding.recommendation ?? ""}`;
  if (/dirty[- ]?(draft|guard|navigation)|unsaved[- ]?(draft|changes)|no longer guards? unsaved|without (?:checking|prompting).*(?:dirty|unsaved)/i.test(blob)) {
    return { ...finding, severity: "high" };
  }
  return finding;
}

/**
 * True when the finding is a TypeScript typing/style nit (e.g. use of `any` or a type assertion)
 * rather than a behavioural defect. These are banned by the review prompt and dropped in code.
 */
export function isTypingStyleNit(title: string, description: string, recommendation = ""): boolean {
  const blob = `${title}\n${description}\n${recommendation}`;
  if (/use of\s+[`'"]?any[`'"]?\b/i.test(blob)) return true;
  if (/\b(?:typescript\s+)?[`'"]any[`'"]\b/i.test(blob) && !/\b(runtime|crash|null|undefin|leak|race|inject|secret)\b/i.test(blob)) {
    return true;
  }
  if (/\btype assertions?\b/i.test(blob) && !/\b(runtime|crash|null|undefin|leak|race)\b/i.test(blob)) return true;
  if (/^[^.]{0,80}\bas\s+any\b/i.test(title) || /\bas\s+any\b/i.test(title) && title.length < 80) return true;
  return false;
}

/** Why a raw finding row fails the schema, or null if it would normalize. */
export function findingRejectReason(row: unknown): string | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return "not a JSON object";
  const r = row as Record<string, unknown>;
  const category = typeof r.category === "string" ? r.category.toLowerCase() : "";
  if (!CATEGORIES.has(category)) {
    return `category must be one of ${[...CATEGORIES].join("|")} (got ${JSON.stringify(r.category)})`;
  }
  const severity = typeof r.severity === "string" ? r.severity.toLowerCase() : "";
  if (!SEVERITIES.has(severity)) {
    return `severity must be one of ${[...SEVERITIES].join("|")} (got ${JSON.stringify(r.severity)})`;
  }
  if (!toText(r.file)) return "file is required";
  if (!toText(r.title)) return "title is required";
  if (!toText(r.description)) return "description is required";
  const line = toInt(r.line);
  if (!line || line < 1) return `line must be a positive integer (got ${JSON.stringify(r.line)})`;
  const title = toText(r.title) as string;
  const description = toText(r.description) as string;
  const recommendation = toText(r.recommendation) ?? "";
  if (isTypingStyleNit(title, description, recommendation)) {
    return "typing/style nit (TypeScript any / type assertions are not reportable)";
  }
  return null;
}

function normalizeFindingUnchecked(row: Record<string, unknown>, index: number): Finding {
  const category = (row.category as string).toLowerCase();
  const severity = (row.severity as string).toLowerCase();
  const file = toText(row.file) as string, title = toText(row.title) as string;
  const description = toText(row.description) as string, line = toInt(row.line) as number;
  const endLine = toInt(row.endLine);
  const level = toLevel(row.confidence);
  const evidence = toText(row.evidence)?.slice(0, 1000);
  const suggestion = typeof row.suggestion === "string" && row.suggestion.trim() ? row.suggestion : undefined;
  const references = Array.isArray(row.references) ? row.references.filter((item): item is string => typeof item === "string") : undefined;
  return {
    id: toText(row.id) ?? `F${index + 1}`,
    category: category as Finding["category"], severity: severity as Finding["severity"],
    level, confidence: LEVEL_BASE[level], evidence,
    file, line, endLine: endLine !== undefined && endLine > line ? endLine : undefined,
    title, description, recommendation: toText(row.recommendation), suggestion,
    ruleId: toText(row.ruleId), references,
  };
}

export interface RejectedFinding { index: number; reason: string; row: unknown }
export interface ParseResult {
  ok: boolean; findings: Finding[]; dropped: number; rejected: RejectedFinding[];
}

const emptyParse = (): ParseResult => ({ ok: false, findings: [], dropped: 0, rejected: [] });

/** ok=false: the reply was not usable JSON. ok=true with no findings: a valid "nothing found". */
export function parseResponse(response: string): ParseResult {
  const text = response.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  let data: unknown;
  try { data = JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return emptyParse();
    try { data = JSON.parse(match[0]); } catch { return emptyParse(); }
  }
  const rows = Array.isArray(data) ? data
    : typeof data === "object" && data !== null ? (data as Record<string, unknown>).findings : undefined;
  if (!Array.isArray(rows)) return emptyParse();
  const findings: Finding[] = [];
  const rejected: RejectedFinding[] = [];
  rows.forEach((row, index) => {
    const reason = findingRejectReason(row);
    if (reason) { rejected.push({ index, reason, row }); return; }
    findings.push(applySeverityPolicy(normalizeFindingUnchecked(row as Record<string, unknown>, index)));
  });
  return { ok: true, findings, dropped: rejected.length, rejected };
}

/** Prompt fragment asking the model to correct rejected finding rows only. */
export function repairFindingsPrompt(rejected: RejectedFinding[]): string {
  const items = rejected.map((item, i) => {
    let serialized: string;
    try { serialized = JSON.stringify(item.row); }
    catch { serialized = "[unserializable]"; }
    if (serialized.length > 800) serialized = `${serialized.slice(0, 797)}...`;
    return `${i + 1}. reason: ${item.reason}\n   item: ${serialized}`;
  }).join("\n");
  return [
    "",
    "Your previous reply included findings that failed validation. Do NOT resend the findings that were already accepted.",
    "Reply with ONLY a JSON object {\"findings\":[...]} containing corrected versions of the rejected items below, or {\"findings\":[]} if they were not real findings.",
    "Each corrected item must include: category (security|quality|maintainability|performance|architecture|testing|documentation|compliance), severity (critical|high|medium|low|info), confidence (\"high\"|\"medium\"|\"low\"), file, line (positive integer), title, description, evidence.",
    "",
    "Rejected items:",
    items,
  ].join("\n");
}

export function parseFindings(response: string): Finding[] { return parseResponse(response).findings; }

/** Hidden HTML marker so a later step can match an inline thread to a finding id. */
export function findingMarker(id: string): string {
  return `<!-- fixbrief-ai:${id.replace(/-->/g, "")} -->`;
}

/** Extract the finding id from a comment body that contains a fixbrief-ai (or legacy reviewbrief) marker. */
export function parseFindingMarker(body: string): string | undefined {
  const match = /<!--\s*(?:fixbrief-ai|reviewbrief):([^\s-->][^>]*)\s*-->/.exec(body);
  return match?.[1]?.trim() || undefined;
}

function severityLabel(severity: FindingSeverity): string {
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}

/** Render one concise, bounded GitHub review comment. Prefer keeping a GitHub suggestion by shrinking prose first. */
export function renderFinding(finding: Finding, maxLength = 800): string {
  // Copilot-style: severity top-right, prose body, optional suggestion. No confidence percentage.
  const marker = findingMarker(finding.id);
  const fullTitle = finding.title.trim();
  const fullDescription = finding.description.trim();
  const fullRecommendation = finding.recommendation?.trim() ?? "";
  let title = fullTitle;
  let description = fullDescription;
  let recommendation = fullRecommendation;
  const suggestion = finding.suggestion?.trimEnd() ?? "";
  let suggestionNote = "";
  const suggestionFence = fenceFor(suggestion);
  const severity = `<div align="right"><b>${severityLabel(finding.severity)}</b></div>`;

  const compose = (includeSuggestion: boolean) => {
    const parts = [severity, "", `**${title}**`, "", description];
    if (recommendation) parts.push("", `**Fix:** ${recommendation}`);
    if (includeSuggestion && suggestion) parts.push("", `${suggestionFence}suggestion`, suggestion, suggestionFence);
    if (suggestionNote) parts.push("", suggestionNote);
    parts.push("", marker);
    return parts.join("\n");
  };

  const shrinkProse = (includeSuggestion: boolean): string => {
    let body = compose(includeSuggestion);
    while (body.length > maxLength) {
      const excess = body.length - maxLength;
      if (description.length) {
        description = shorten(description, Math.max(0, description.length - excess - 1));
      } else if (recommendation.length) {
        recommendation = shorten(recommendation, Math.max(0, recommendation.length - excess - 1));
      } else if (title.length) {
        title = shorten(title, Math.max(0, title.length - excess - 1));
      } else {
        break;
      }
      body = compose(includeSuggestion);
    }
    return body;
  };

  let includeSuggestion = Boolean(suggestion);
  let body = shrinkProse(includeSuggestion);
  // Only drop the suggestion when it still cannot fit after prose is exhausted.
  // Never truncate mid-fence — an incomplete suggestion block absorbs following Markdown.
  if (body.length > maxLength && includeSuggestion) {
    includeSuggestion = false;
    suggestionNote = "**Suggestion omitted:** it exceeds the comment length limit.";
    title = fullTitle;
    description = fullDescription;
    recommendation = fullRecommendation;
    body = shrinkProse(false);
  }
  if (body.length <= maxLength) return body;
  // Keep the marker when truncating so thread matching still works.
  const budget = Math.max(0, maxLength - marker.length - 2);
  return `${body.slice(0, budget).replace(/\n[^\n]*$/, "").trimEnd()}\n\n${marker}`;
}

function shorten(value: string, length: number): string {
  if (length <= 0) return "";
  if (value.length <= length) return value;
  return `${value.slice(0, length - 1).trimEnd()}…`;
}

/** Choose a markdown fence longer than any backtick run inside the suggestion body. */
function fenceFor(text: string): string {
  const runs = text.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  return "`".repeat(Math.max(3, longest + 1));
}

export function toReviewComment(finding: Finding, body: string): GitHubReviewComment {
  const range = finding.endLine !== undefined && finding.endLine > finding.line;
  const comment: GitHubReviewComment = {
    path: finding.file, line: range ? (finding.endLine as number) : finding.line, side: "RIGHT", body,
  };
  if (range) { comment.start_line = finding.line; comment.start_side = "RIGHT"; }
  return comment;
}

function findingFingerprint(finding: Finding): string {
  return JSON.stringify([finding.file, finding.line, finding.category, finding.title]);
}

/** Title, location, description, and recommendation for overview-only (non-inline) findings. */
function summaryFindingBullet(finding: Finding): string {
  const icon = icons[finding.severity];
  const range = Number.isInteger(finding.endLine) && (finding.endLine as number) > finding.line
    ? `${finding.line}-${finding.endLine}` : `${finding.line}`;
  const title = finding.title.replace(/\s+/g, " ").trim();
  const description = finding.description.replace(/\s+/g, " ").trim();
  const recommendation = finding.recommendation?.replace(/\s+/g, " ").trim();
  const lines = [
    `- ${icon} **${title}** (\`${finding.file}:${range}\`)`,
    `  ${description}`,
  ];
  if (recommendation) lines.push(`  **Recommendation:** ${recommendation}`);
  return lines.join("\n");
}

/** One changed file as shown in the Copilot-style overview / per-file summary. */
export interface OverviewFile {
  path: string;
  /** Whether the file was included in a reviewed batch. */
  reviewed: boolean;
  /** Inline comments generated for this file. */
  comments: number;
  /** Optional reason the file was skipped (lockfile, binary, over max-batches). */
  note?: string;
}

export interface OverviewSections {
  unanchored?: Finding[];
  capped?: Finding[];
  /** Scored findings that did not meet the publish gate (severity/confidence). */
  belowGateCount?: number;
  /** Pull request title used in the overview. */
  title?: string;
  /** Pull request body (truncated); first paragraph / Changes list are extracted when present. */
  body?: string;
  /** Changed files with review status for the Copilot-style summary. */
  files?: OverviewFile[];
}

/** Whether the payload has anything worth posting (inline comments or gated summary sections). */
export function payloadHasContent(payload: GitHubReviewPayload): boolean {
  if (payload.comments.length > 0) return true;
  return /### Could not place inline|### Over the inline cap/.test(payload.body);
}

const CHANGES_CAP = 20;

/** First non-heading, non-list paragraph from a PR body. */
export function firstOverviewParagraph(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const chunk: string[] = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) continue;
      started = true;
      chunk.push(trimmed);
      continue;
    }
    if (!trimmed) break;
    if (/^#{1,6}\s/.test(trimmed) || /^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) break;
    chunk.push(trimmed);
  }
  return chunk.join(" ").replace(/\s+/g, " ").trim();
}

/** Bullet lines under a Changes heading in the PR body, when present. */
export function changesBulletsFromBody(body: string): string[] {
  const text = body.replace(/\r\n/g, "\n");
  const match = /(?:^|\n)#{1,6}\s*Changes\s*\n([\s\S]*?)(?=\n#{1,6}\s|\n---\s*\n|$)/i.exec(text)
    ?? /(?:^|\n)\*\*Changes:?\*\*:?\s*\n([\s\S]*?)(?=\n#{1,6}\s|\n\*\*[A-Z]|\n---\s*\n|$)/i.exec(text);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*+]\s+\S/.test(line) || /^\d+\.\s+\S/.test(line))
    .map((line) => line.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean);
}

function changeBullets(sections: OverviewSections): string[] {
  const fromBody = changesBulletsFromBody(sections.body ?? "");
  if (fromBody.length) {
    if (fromBody.length <= CHANGES_CAP) return fromBody.map((item) => `- ${item}`);
    return [
      ...fromBody.slice(0, CHANGES_CAP).map((item) => `- ${item}`),
      `- _and ${fromBody.length - CHANGES_CAP} more_`,
    ];
  }
  const files = sections.files ?? [];
  if (!files.length) return ["- _(no file list available)_"];
  if (files.length <= CHANGES_CAP) {
    return files.map((file) => `- \`${file.path.replace(/`/g, "\\`")}\``);
  }
  return [
    ...files.slice(0, CHANGES_CAP).map((file) => `- \`${file.path.replace(/`/g, "\\`")}\``),
    `- _and ${files.length - CHANGES_CAP} more_`,
  ];
}

function perFileSummaryLine(file: OverviewFile): string {
  const path = `\`${file.path.replace(/`/g, "\\`")}\``;
  if (!file.reviewed) {
    return `- ${path}: not reviewed${file.note ? ` (${file.note})` : ""}`;
  }
  const n = file.comments;
  return `- ${path}: reviewed, ${n} comment${n === 1 ? "" : "s"}`;
}

/** Build the create-review overview body shown above the inline comment threads. */
export function reviewOverviewBody(
  inline: Finding[],
  minimumConfidence: number,
  sections: OverviewSections = {},
): string {
  const unanchored = sections.unanchored ?? [];
  const capped = sections.capped ?? [];
  const belowGateCount = sections.belowGateCount ?? 0;
  const files = sections.files ?? [];
  const reviewedCount = files.filter((file) => file.reviewed).length;
  const totalFiles = files.length;
  const commentCount = inline.length;
  const title = (sections.title ?? "").trim();
  const paragraph = firstOverviewParagraph(sections.body ?? "");

  const parts = ["## Pull request overview", ""];
  if (title) parts.push(title, "");
  if (paragraph) parts.push(paragraph, "");
  parts.push("**Changes:**", "", ...changeBullets(sections), "");
  parts.push(
    "**Reviewed changes**",
    "",
    `FixBrief AI reviewed ${reviewedCount} out of ${totalFiles || reviewedCount || "?"} changed file${(totalFiles || reviewedCount) === 1 ? "" : "s"} in this pull request and generated ${commentCount} comment${commentCount === 1 ? "" : "s"}.`,
    "",
  );
  if (!inline.length) {
    parts.push(
      `_No inline findings met the publish gate (critical/high at or above the confidence floor)._`,
      "",
    );
    if (belowGateCount > 0) {
      parts.push(
        `_${belowGateCount} other finding${belowGateCount === 1 ? " was" : "s were"} scored but stayed below the publish gate (see \`findings.json\` / the job summary)._`,
        "",
      );
    }
  }
  if (files.length) {
    parts.push(
      "<details>",
      "<summary>Show a summary per file</summary>",
      "",
      ...files.map(perFileSummaryLine),
      "",
      "</details>",
      "",
    );
  }
  // minimumConfidence is part of the gate; kept in the signature for call-site compatibility.
  void minimumConfidence;
  if (unanchored.length) {
    parts.push(
      "### Could not place inline",
      "",
      "_Critical/high findings at or above the confidence floor whose line is not on the reviewed diff._",
      "",
      ...unanchored.map(summaryFindingBullet),
      "",
    );
  }
  if (capped.length) {
    parts.push(
      "### Over the inline cap",
      "",
      "_Critical/high findings at or above the confidence floor that exceeded `max-inline-comments`._",
      "",
      ...capped.map(summaryFindingBullet),
      "",
    );
  }
  return parts.join("\n").trimEnd() + "\n";
}

/** De-duplicate (highest confidence wins) and rank findings in a fully deterministic order. */
export function rankFindings(findings: Finding[]): Finding[] {
  const unique = new Map<string, Finding>();
  for (const finding of findings) {
    const fingerprint = findingFingerprint(finding);
    const existing = unique.get(fingerprint);
    if (!existing || finding.confidence > existing.confidence) unique.set(fingerprint, finding);
  }
  return [...unique.values()].sort((a, b) =>
    severities.indexOf(a.severity) - severities.indexOf(b.severity)
    || b.confidence - a.confidence
    || a.file.localeCompare(b.file)
    || a.line - b.line
    || a.title.localeCompare(b.title)
    || a.category.localeCompare(b.category));
}

/** True when consistency scoring says the finding appeared in more than one run. */
export function hasMultiRunAgreement(finding: Finding): boolean {
  const agreement = finding.confidenceBreakdown?.agreement;
  return agreement === "all" || agreement === "partial";
}

/**
 * Whether a scored finding is eligible for an inline GitHub review comment.
 * Calibrated against beatbax: only critical/high above the confidence floor post inline;
 * medium/low/info stay off the PR (they remain in findings.json / the job summary).
 * Agreement across consistency runs adjusts the confidence score; it does not hide
 * critical/high findings that already clear the floor (one-off highs still publish).
 * `requireMultiRun` is accepted for call-site compatibility and is unused here.
 */
export function qualifiesForInline(
  finding: Finding, minimumConfidence: number, _requireMultiRun = false,
): boolean {
  if (finding.confidence < minimumConfidence) return false;
  if (finding.severity !== "critical" && finding.severity !== "high") return false;
  return true;
}

/** Split anchored findings into inline comments, below-threshold leftovers, and cap overflow. */
export function partitionInline(
  anchored: Finding[], minimumConfidence: number, maxComments: number, requireMultiRun = false,
): { inline: Finding[]; belowConfidence: Finding[]; capped: Finding[] } {
  const belowConfidence = anchored.filter((finding) => !qualifiesForInline(finding, minimumConfidence, requireMultiRun));
  const ordered = rankFindings(anchored.filter((finding) => qualifiesForInline(finding, minimumConfidence, requireMultiRun)));
  return {
    inline: maxComments > 0 ? ordered.slice(0, maxComments) : ordered,
    belowConfidence,
    capped: maxComments > 0 ? ordered.slice(maxComments) : [],
  };
}

/** Findings that clear the publish gate: inline threads plus gated overview sections. */
export function publishableFindings(
  anchored: Finding[],
  unanchored: Finding[],
  minimumConfidence: number,
  maxComments: number,
  requireMultiRun = false,
): { inline: Finding[]; unanchored: Finding[]; capped: Finding[]; all: Finding[] } {
  const { inline, capped } = partitionInline(anchored, minimumConfidence, maxComments, requireMultiRun);
  const gatedUnanchored = rankFindings(
    unanchored.filter((finding) => qualifiesForInline(finding, minimumConfidence, requireMultiRun)),
  );
  return { inline, unanchored: gatedUnanchored, capped, all: [...inline, ...gatedUnanchored, ...capped] };
}

/** Default confidence floor for medium findings in the fix brief (PR gate stays stricter). */
export const FIX_BRIEF_MEDIUM_CONFIDENCE = 0.75;

/**
 * Whether a scored finding belongs in fix-brief.md.
 * Always includes the PR publish set (critical/high ≥ minimumConfidence), including one-offs.
 * Also includes medium severity at or above fixBriefMediumConfidence (default 0.75).
 * Low/info stay out of the brief (job summary / findings.json only).
 * When requireMultiRun is set, one-off *medium* findings stay out of the brief.
 */
export function qualifiesForFixBrief(
  finding: Finding,
  minimumConfidence: number,
  fixBriefMediumConfidence = FIX_BRIEF_MEDIUM_CONFIDENCE,
  requireMultiRun = false,
): boolean {
  if (qualifiesForInline(finding, minimumConfidence)) return true;
  if (finding.severity !== "medium") return false;
  if (requireMultiRun && !hasMultiRunAgreement(finding)) return false;
  return finding.confidence >= fixBriefMediumConfidence;
}

/** Ranked findings that should drive the AI fix brief. */
export function fixBriefFindings(
  findings: Finding[],
  minimumConfidence: number,
  fixBriefMediumConfidence = FIX_BRIEF_MEDIUM_CONFIDENCE,
  requireMultiRun = false,
): Finding[] {
  return rankFindings(findings.filter((finding) =>
    qualifiesForFixBrief(finding, minimumConfidence, fixBriefMediumConfidence, requireMultiRun)));
}

/** Filter, deduplicate, rank, and build the GitHub create-review payload. */
export function githubReviewPayload(
  anchored: Finding[],
  minimumConfidence = 0.85,
  maxComments = Number.POSITIVE_INFINITY,
  render: (finding: Finding) => string = renderFinding,
  unanchored: Finding[] = [],
  requireMultiRun = false,
  overview: Pick<OverviewSections, "title" | "body" | "files"> = {},
): GitHubReviewPayload {
  const published = publishableFindings(anchored, unanchored, minimumConfidence, maxComments, requireMultiRun);
  const belowGateCount = Math.max(0, anchored.length + unanchored.length - published.all.length);
  return {
    event: "COMMENT",
    body: reviewOverviewBody(published.inline, minimumConfidence, {
      unanchored: published.unanchored,
      capped: published.capped,
      belowGateCount,
      title: overview.title,
      body: overview.body,
      files: overview.files,
    }),
    comments: published.inline.map((finding) => toReviewComment(finding, render(finding))),
  };
}

/** Targets written beside fix-brief.md so a later step can attach reply commands. */
export interface FixBriefTarget {
  id: string;
  severity: FindingSeverity;
  file: string;
  line: number;
  endLine?: number;
  title: string;
  /** True when the finding was posted as an inline review comment. */
  inline: boolean;
}

export interface FixBriefTargetsFile {
  schemaVersion: 1;
  repo: string;
  pr: string;
  targets: FixBriefTarget[];
}

export function buildFixBriefTargets(
  findings: Finding[],
  inlineIds: Set<string>,
  repo: string,
  pr: string,
): FixBriefTargetsFile {
  return {
    schemaVersion: 1,
    repo,
    pr,
    targets: findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      endLine: finding.endLine,
      title: finding.title,
      inline: inlineIds.has(finding.id),
    })),
  };
}

