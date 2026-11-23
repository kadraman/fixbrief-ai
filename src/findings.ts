#!/usr/bin/env node
/** Canonical Finding model and GitHub review comment renderer. */

import { createHash } from "node:crypto";

/** Canonical finding categories. Style / formatting / lint nits are out of scope. */
export const FINDING_CATEGORIES = [
  "security", "quality", "maintainability", "performance",
  "architecture", "testing", "documentation", "compliance",
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** Allowlist of categories, or `"all"` for every category. */
export type CategoryFilter = Set<FindingCategory> | "all";

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

/** Outcome of the disproof pass for one finding. `keep: false` means it was dropped. */
export interface RefuteNote {
  keep: boolean;
  reason: string;
}

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
  /** Set when a disproof pass judged this finding. Absent when it was not checked. */
  refute?: RefuteNote;
}

export interface GitHubReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
  /** Not sent to the create-review API. Used if that call fails and the finding joins the checklist. */
  fallback?: ChecklistItem;
}

/** A review comment on a whole file. Posted separately; create-review does not accept subject_type. */
export interface GitHubFileComment {
  path: string;
  body: string;
  subject_type: "file";
  /** Not sent to GitHub. Used when the file-comment API rejects the comment. */
  fallback: ChecklistItem;
}

/** One fix-brief finding that cannot be a review thread, collected into a single issue comment. */
export interface ChecklistItem {
  id: string;
  fingerprint: string;
  severity: FindingSeverity;
  file: string;
  line: number;
  endLine?: number;
  title: string;
  description: string;
  recommendation?: string;
}

export interface GitHubReviewPayload {
  event: "COMMENT";
  body: string;
  /** Line comments. Safe to send as create-review `comments` after `fallback` is stripped. */
  comments: GitHubReviewComment[];
  /** File-level review comments for findings whose file is in the diff but whose line is not. */
  fileComments: GitHubFileComment[];
  /** Findings that could not be threaded, including cap overflow. One checklist comment holds all of them. */
  checklist: ChecklistItem[];
}

const CATEGORIES = new Set<string>(FINDING_CATEGORIES);
const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const severities: FindingSeverity[] = ["critical", "high", "medium", "low", "info"];
const icons: Record<FindingSeverity, string> = {
  critical: "🚨", high: "⚠️", medium: "🔶", low: "💡", info: "ℹ️",
};

/** Hidden marker on the one checklist issue comment. */
export const CHECKLIST_MARKER = "<!-- fixbrief-ai-checklist -->";

/** Path form used for cross-run thread identity. A leading `./` is ignored; `a/` and `b/` are real directories. */
export function threadKeyPath(file: string): string {
  return file.replace(/^\.\//, "");
}

export function normalizeThreadTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

/** File and title only. Older reviews used this for the first finding that shared a title. */
export function threadBaseFingerprint(finding: { file: string; title: string }): string {
  const key = `${threadKeyPath(finding.file)}\0${normalizeThreadTitle(finding.title)}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** Stable id for one finding. The line keeps same-title findings apart; reuse across a line shift is decided at match time. */
export function threadFingerprint(finding: { file: string; title: string; line?: number }): string {
  const line = finding.line !== undefined ? `\0${finding.line}` : "";
  const key = `${threadKeyPath(finding.file)}\0${normalizeThreadTitle(finding.title)}${line}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function fingerprintMarker(fingerprint: string): string {
  return `<!-- fixbrief-ai-fp:${fingerprint.replace(/-->/g, "")} -->`;
}

export function parseFingerprintMarker(body: string): string | undefined {
  const match = /<!--\s*fixbrief-ai-fp:([^\s>]+)\s*-->/.exec(body);
  return match?.[1];
}

export function checklistItemMarker(fingerprint: string): string {
  return `<!-- fixbrief-ai-item:${fingerprint.replace(/-->/g, "")} -->`;
}

/** Marker on an agent's report-back reply, so running the brief twice does not post a second reply. */
export function reportMarker(fingerprint: string): string {
  return `<!-- fixbrief-ai-report:${fingerprint.replace(/-->/g, "")} -->`;
}

export function checklistItemFromFinding(finding: Finding): ChecklistItem {
  return {
    id: finding.id,
    fingerprint: threadFingerprint(finding),
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    endLine: finding.endLine,
    title: finding.title,
    description: finding.description,
    recommendation: finding.recommendation,
  };
}

/**
 * Parse a comma/space-separated category allowlist.
 * Empty, `all`, or `*` means every category. Unknown names throw.
 */
export function parseCategories(raw: string): CategoryFilter {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "all" || trimmed === "*") return "all";
  const parts = trimmed.split(/[,|\s]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
  const allowed = new Set<FindingCategory>();
  const unknown: string[] = [];
  for (const part of parts) {
    if (CATEGORIES.has(part)) allowed.add(part as FindingCategory);
    else unknown.push(part);
  }
  if (unknown.length) {
    throw new Error(
      `Unknown categor${unknown.length === 1 ? "y" : "ies"}: ${unknown.join(", ")}. `
      + `Valid: ${FINDING_CATEGORIES.join(", ")} (or all).`,
    );
  }
  if (!allowed.size) throw new Error("CATEGORIES resolved to an empty allowlist");
  return allowed;
}

/** Drop findings whose category is outside the allowlist. */
export function filterByCategories(findings: Finding[], categories: CategoryFilter): Finding[] {
  if (categories === "all") return findings;
  return findings.filter((finding) => categories.has(finding.category));
}

/** Stable label for logs / findings.json (`all` or sorted comma-separated names). */
export function categoriesLabel(categories: CategoryFilter): string {
  if (categories === "all") return "all";
  return [...categories].sort().join(",");
}

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

/** Floor lengths so shrink-to-fit never leaves unreadable stubs like "The scr…". */
const MIN_DESCRIPTION = 120;
const MIN_RECOMMENDATION = 60;
const MIN_TITLE = 24;

/** Render one concise, bounded GitHub review comment. Prefer keeping a GitHub suggestion by shrinking prose first. */
export function renderFinding(
  finding: Finding, maxLength = 800, options?: { suggestion?: boolean },
): string {
  // Copilot-style: severity top-right, prose body, optional suggestion. No confidence percentage.
  const marker = `${findingMarker(finding.id)}\n${fingerprintMarker(threadFingerprint(finding))}`;
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
      if (description.length > MIN_DESCRIPTION) {
        description = shorten(description, Math.max(MIN_DESCRIPTION, description.length - excess - 1));
      } else if (recommendation.length > MIN_RECOMMENDATION) {
        recommendation = shorten(recommendation, Math.max(MIN_RECOMMENDATION, recommendation.length - excess - 1));
      } else if (title.length > MIN_TITLE) {
        title = shorten(title, Math.max(MIN_TITLE, title.length - excess - 1));
      } else {
        break;
      }
      body = compose(includeSuggestion);
    }
    return body;
  };

  let includeSuggestion = options?.suggestion === false ? false : Boolean(suggestion);
  let body = shrinkProse(includeSuggestion);
  // If a suggestion still cannot fit after prose is at the readable floors, drop it and
  // restore full prose. Never truncate mid-fence — an incomplete suggestion absorbs Markdown.
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
    fallback: checklistItemFromFinding(finding),
  };
  if (range) { comment.start_line = finding.line; comment.start_side = "RIGHT"; }
  return comment;
}

export function toFileComment(finding: Finding, body: string): GitHubFileComment {
  return {
    path: finding.file,
    body,
    subject_type: "file",
    fallback: checklistItemFromFinding(finding),
  };
}

/**
 * create-review body. Drops fields GitHub's comments array rejects.
 * Omitting `event` leaves the review pending. The string "PENDING" is not a
 * valid event and returns HTTP 422, so the later submit never runs.
 */
export function createReviewRequest(payload: GitHubReviewPayload, pending: boolean): {
  event?: "COMMENT";
  body?: string;
  comments?: Array<{ path: string; line: number; side: "RIGHT"; body: string; start_line?: number; start_side?: "RIGHT" }>;
} {
  const comments = payload.comments.map((comment) => {
    const out: { path: string; line: number; side: "RIGHT"; body: string; start_line?: number; start_side?: "RIGHT" } = {
      path: comment.path, line: comment.line, side: "RIGHT", body: comment.body,
    };
    if (comment.start_line !== undefined) {
      out.start_line = comment.start_line;
      out.start_side = "RIGHT";
    }
    return out;
  });
  if (pending) return comments.length ? { comments } : {};
  return { event: "COMMENT", body: payload.body, comments };
}

/** File-comment API body. `subject_type` is not valid on create-review. */
export function fileCommentRequest(comment: GitHubFileComment, commitId: string): {
  body: string; commit_id: string; path: string; subject_type: "file";
} {
  return { body: comment.body, commit_id: commitId, path: comment.path, subject_type: "file" };
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
  /** File-level review comments. Counted in the overview; they are threads, not a summary section. */
  fileLevel?: Finding[];
  /** Scored findings that did not meet the thread gate (severity/confidence). */
  belowGateCount?: number;
  /** Pull request title used in the overview. */
  title?: string;
  /** Pull request body (truncated); first paragraph / Changes list are extracted when present. */
  body?: string;
  /** Changed files with review status for the Copilot-style summary. */
  files?: OverviewFile[];
}

/** Whether the payload has anything worth posting (threads, a checklist, or a gated summary section). */
export function payloadHasContent(payload: GitHubReviewPayload): boolean {
  if (payload.comments.length > 0) return true;
  if ((payload.fileComments?.length ?? 0) > 0) return true;
  if ((payload.checklist?.length ?? 0) > 0) return true;
  return /### Could not place on a changed file|### Over the inline cap/.test(payload.body);
}

/** One path (and optional skip reason) for a collapsible file-list footer. */
export interface FileListEntry {
  path: string;
  note?: string;
}

/** Parse `path (reason)` skip strings into path + note. */
export function parseSkippedEntry(entry: string): FileListEntry {
  const match = /^(.*) \(([^)]*)\)\s*$/.exec(entry);
  if (match) return { path: match[1], note: match[2] };
  return { path: entry };
}

/**
 * Markdown footer: short tally plus a `<details>` list of files.
 * `heading` is the bold lead-in (e.g. `**Skipped:**`); `summary` is the accordion label.
 */
export function formatFileListFooter(
  heading: string,
  entries: FileListEntry[],
  summary: string,
): string {
  if (!entries.length) return "";
  const reasonCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.note) reasonCounts.set(entry.note, (reasonCounts.get(entry.note) ?? 0) + 1);
  }
  const tallyParts = [...reasonCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${count} ${reason}`);
  const n = entries.length;
  const fileWord = n === 1 ? "file" : "files";
  const lead = tallyParts.length
    ? `${heading} ${n} ${fileWord} were not reviewed (${tallyParts.join(", ")}).`
    : `${heading} ${n} ${fileWord}.`;
  const bullets = entries.map((entry) => {
    const path = `\`${entry.path.replace(/`/g, "\\`")}\``;
    return entry.note ? `- ${path} (${entry.note})` : `- ${path}`;
  });
  return [lead, "", "<details>", `<summary>${summary}</summary>`, "", ...bullets, "", "</details>"].join("\n");
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

/** Semantic Changes bullets from the PR body only — never a raw path dump (GitHub already lists files). */
function changeBullets(sections: OverviewSections): string[] {
  const fromBody = changesBulletsFromBody(sections.body ?? "");
  if (!fromBody.length) return [];
  if (fromBody.length <= CHANGES_CAP) return fromBody.map((item) => `- ${item}`);
  return [
    ...fromBody.slice(0, CHANGES_CAP).map((item) => `- ${item}`),
    `- _and ${fromBody.length - CHANGES_CAP} more_`,
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

/**
 * Copilot-style per-file details: files with comments, then unreviewed files.
 * Quiet zero-comment reviews are tallied in one line instead of listing every path.
 */
function perFileDetails(files: OverviewFile[]): string[] {
  const withComments = files.filter((file) => file.reviewed && file.comments > 0);
  const unreviewed = files.filter((file) => !file.reviewed);
  const quietReviewed = files.filter((file) => file.reviewed && file.comments === 0).length;
  if (!withComments.length && !unreviewed.length && !quietReviewed) return [];
  const lines = [
    "<details>",
    "<summary>Show a summary per file</summary>",
    "",
  ];
  if (withComments.length) {
    lines.push(...withComments.map(perFileSummaryLine));
  }
  if (quietReviewed) {
    if (withComments.length) lines.push("");
    lines.push(
      `- _${quietReviewed} other reviewed file${quietReviewed === 1 ? "" : "s"} with no comments_`,
    );
  }
  if (unreviewed.length) {
    if (withComments.length || quietReviewed) lines.push("");
    lines.push(...unreviewed.map(perFileSummaryLine));
  }
  lines.push("", "</details>", "");
  return lines;
}

/** Build the create-review overview body shown above the inline comment threads. */
export function reviewOverviewBody(
  inline: Finding[],
  minimumConfidence: number,
  sections: OverviewSections = {},
): string {
  const unanchored = sections.unanchored ?? [];
  const capped = sections.capped ?? [];
  const fileLevel = sections.fileLevel ?? [];
  const belowGateCount = sections.belowGateCount ?? 0;
  const files = sections.files ?? [];
  const reviewedCount = files.filter((file) => file.reviewed).length;
  const totalFiles = files.length;
  const commentCount = inline.length + fileLevel.length;
  const title = (sections.title ?? "").trim();
  const paragraph = firstOverviewParagraph(sections.body ?? "");
  const changes = changeBullets(sections);

  const parts = ["## FixBrief AI review", ""];
  if (title) parts.push(title, "");
  if (paragraph) parts.push(paragraph, "");
  if (changes.length) parts.push("**Changes:**", "", ...changes, "");
  parts.push(
    "**Reviewed changes**",
    "",
    `FixBrief AI reviewed ${reviewedCount} out of ${totalFiles || reviewedCount || "?"} changed file${(totalFiles || reviewedCount) === 1 ? "" : "s"} in this pull request and generated ${commentCount} comment${commentCount === 1 ? "" : "s"}.`,
    "",
  );
  if (!commentCount) {
    parts.push(
      `_No findings met the thread gate (critical/high at or above the confidence floor, or medium findings in the fix brief)._`,
      "",
    );
    if (belowGateCount > 0) {
      parts.push(
        `_${belowGateCount} other finding${belowGateCount === 1 ? " was" : "s were"} scored but stayed below the publish gate (see the workflow job summary)._`,
        "",
      );
    }
  }
  parts.push(...perFileDetails(files));
  // minimumConfidence is part of the gate; kept in the signature for call-site compatibility.
  void minimumConfidence;
  if (unanchored.length) {
    parts.push(
      "### Could not place on a changed file",
      "",
      "_These findings are in the fix brief, but the file is not part of this pull request diff. They are collected in one checklist comment._",
      "",
      ...unanchored.map(summaryFindingBullet),
      "",
    );
  }
  if (capped.length) {
    parts.push(
      "### Over the inline cap",
      "",
      "_These findings exceeded `max-inline-comments`. They are collected in the checklist comment rather than opened as extra threads._",
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
 * Whether a scored finding is eligible for a GitHub review thread.
 * That is the fix-brief set: critical/high at or above `minimumConfidence`, and medium
 * findings at or above the fix-brief floor. Low/info stay in the job summary.
 * One-off medium findings stay out when `requireMultiRun` is set. One-off critical/high
 * findings that already clear the floor still publish.
 */
export function qualifiesForInline(
  finding: Finding,
  minimumConfidence: number,
  requireMultiRun = false,
  fixBriefMediumConfidence = FIX_BRIEF_MEDIUM_CONFIDENCE,
): boolean {
  return qualifiesForFixBrief(finding, minimumConfidence, fixBriefMediumConfidence, requireMultiRun);
}

/** Split anchored findings into review threads, below-threshold leftovers, and cap overflow. */
export function partitionInline(
  anchored: Finding[],
  minimumConfidence: number,
  maxComments: number,
  requireMultiRun = false,
  fixBriefMediumConfidence = FIX_BRIEF_MEDIUM_CONFIDENCE,
): { inline: Finding[]; belowConfidence: Finding[]; capped: Finding[] } {
  const qualify = (finding: Finding) =>
    qualifiesForInline(finding, minimumConfidence, requireMultiRun, fixBriefMediumConfidence);
  const belowConfidence = anchored.filter((finding) => !qualify(finding));
  const ordered = distinctThreadFindings(rankFindings(anchored.filter(qualify)));
  return {
    inline: maxComments > 0 ? ordered.slice(0, maxComments) : ordered,
    belowConfidence,
    capped: maxComments > 0 ? ordered.slice(maxComments) : [],
  };
}

/** Findings that clear the thread gate: line comments, file comments, checklist entries, and cap overflow. */
export function publishableFindings(
  anchored: Finding[],
  unanchored: Finding[],
  minimumConfidence: number,
  maxComments: number,
  requireMultiRun = false,
  fileLevel: Finding[] = [],
  fixBriefMediumConfidence = FIX_BRIEF_MEDIUM_CONFIDENCE,
): { inline: Finding[]; fileLevel: Finding[]; unanchored: Finding[]; capped: Finding[]; all: Finding[] } {
  const qualify = (finding: Finding) =>
    qualifiesForFixBrief(finding, minimumConfidence, fixBriefMediumConfidence, requireMultiRun);
  const fileSet = new Set(fileLevel);
  const unanchoredSet = new Set(unanchored);
  const qualified = distinctThreadFindings(rankFindings(
    [...anchored, ...fileLevel, ...unanchored].filter(qualify),
  ));
  const threadable = qualified.filter((finding) => !unanchoredSet.has(finding));
  const threads = maxComments > 0 ? threadable.slice(0, maxComments) : threadable;
  const capped = maxComments > 0 ? threadable.slice(maxComments) : [];
  const gatedUnanchored = qualified.filter((finding) => unanchoredSet.has(finding));
  const inline = threads.filter((finding) => !fileSet.has(finding));
  const files = threads.filter((finding) => fileSet.has(finding));
  return {
    inline, fileLevel: files, unanchored: gatedUnanchored, capped,
    all: [...threads, ...gatedUnanchored, ...capped],
  };
}

/** Keep the higher-ranked finding when the same file, title, and line appear twice. */
export function distinctThreadFindings(findings: Finding[]): Finding[] {
  const seenAt = new Set<string>();
  const kept: Finding[] = [];
  for (const finding of findings) {
    const at = `${threadKeyPath(finding.file)}\0${normalizeThreadTitle(finding.title)}\0${finding.line}`;
    if (seenAt.has(at)) continue;
    seenAt.add(at);
    kept.push(finding);
  }
  return kept;
}

/** Default confidence floor for medium findings in the fix brief (PR gate stays stricter). */
export const FIX_BRIEF_MEDIUM_CONFIDENCE = 0.75;

/**
 * Whether a scored finding belongs in fix-brief.md.
 * Always includes the PR publish set (critical/high ≥ minimumConfidence), including one-offs.
 * Also includes medium severity at or above fixBriefMediumConfidence (default 0.75).
 * Low/info stay out of the brief (job summary only unless debug-artifacts is on).
 * When requireMultiRun is set, one-off *medium* findings stay out of the brief.
 */
export function qualifiesForFixBrief(
  finding: Finding,
  minimumConfidence: number,
  fixBriefMediumConfidence = FIX_BRIEF_MEDIUM_CONFIDENCE,
  requireMultiRun = false,
): boolean {
  if ((finding.severity === "critical" || finding.severity === "high") && finding.confidence >= minimumConfidence) {
    return true;
  }
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
  fixBriefMediumConfidence = FIX_BRIEF_MEDIUM_CONFIDENCE,
  fileLevel: Finding[] = [],
): GitHubReviewPayload {
  const published = publishableFindings(
    anchored, unanchored, minimumConfidence, maxComments, requireMultiRun, fileLevel, fixBriefMediumConfidence,
  );
  const belowGateCount = rankFindings([...anchored, ...fileLevel, ...unanchored]).filter((finding) =>
    !qualifiesForFixBrief(finding, minimumConfidence, fixBriefMediumConfidence, requireMultiRun)).length;
  return {
    event: "COMMENT",
    body: reviewOverviewBody(published.inline, minimumConfidence, {
      unanchored: published.unanchored,
      capped: published.capped,
      fileLevel: published.fileLevel,
      belowGateCount,
      title: overview.title,
      body: overview.body,
      files: overview.files,
    }),
    comments: published.inline.map((finding) => toReviewComment(finding, render(finding))),
    fileComments: published.fileLevel.map((finding) =>
      toFileComment(finding, render({ ...finding, suggestion: undefined }))),
    checklist: [...published.unanchored, ...published.capped].map(checklistItemFromFinding),
  };
}

function checklistLocation(item: ChecklistItem): string {
  const range = item.endLine !== undefined && item.endLine > item.line
    ? `${item.line}-${item.endLine}` : `${item.line}`;
  return `${item.file}:${range}`;
}

/** One checklist entry. The hidden item marker is how a later run appends without wiping agent notes. */
export function renderChecklistItem(item: ChecklistItem): string {
  const lines = [
    `#### ${item.severity}: ${item.title}`,
    "",
    `\`${checklistLocation(item)}\``,
    "",
    item.description.trim(),
  ];
  if (item.recommendation?.trim()) lines.push("", `**Fix:** ${item.recommendation.trim()}`);
  lines.push(
    "",
    "<what you fixed, or why you skipped this finding>",
    "",
    checklistItemMarker(item.fingerprint),
  );
  return lines.join("\n");
}

export function renderChecklistBody(items: ChecklistItem[]): string {
  return [
    "### FixBrief findings without a review thread",
    "",
    "These findings could not be attached to a changed line. Edit this comment to say what you fixed, or why you skipped each one. Do not open a new pull request comment.",
    "",
    CHECKLIST_MARKER,
    "",
    items.map(renderChecklistItem).join("\n\n"),
    "",
  ].join("\n");
}

export interface LocationRef {
  id: string;
  /** File and title identity. Line shifts stay in the same group. */
  base: string;
  line?: number;
}

/**
 * Pair items that share a file and title. Each side is used once.
 * The closest lines are paired first, so an insertion above several findings
 * keeps each one with its own existing entry.
 */
export function matchByLocation<T extends LocationRef, U extends LocationRef>(current: T[], existing: U[]): Map<string, U> {
  const result = new Map<string, U>();
  const groups = new Map<string, { current: T[]; existing: U[] }>();
  for (const item of current) {
    const group = groups.get(item.base) ?? { current: [], existing: [] };
    group.current.push(item);
    groups.set(item.base, group);
  }
  for (const item of existing) {
    const group = groups.get(item.base);
    if (group) group.existing.push(item);
  }
  for (const group of groups.values()) {
    const left = [...group.current];
    const right = [...group.existing];
    while (left.length && right.length) {
      let bestI = -1, bestJ = -1, bestCost = Number.POSITIVE_INFINITY;
      for (let i = 0; i < left.length; i++) {
        if (left[i].line === undefined) continue;
        for (let j = 0; j < right.length; j++) {
          if (right[j].line === undefined) continue;
          const cost = Math.abs((left[i].line as number) - (right[j].line as number));
          if (cost < bestCost) { bestCost = cost; bestI = i; bestJ = j; }
        }
      }
      if (bestI < 0) break;
      result.set(left[bestI].id, right[bestJ]);
      left.splice(bestI, 1);
      right.splice(bestJ, 1);
    }
  }
  return result;
}

interface ParsedChecklistEntry {
  fingerprint: string;
  file: string;
  line: number;
  title: string;
}

function parseChecklistEntries(body: string): ParsedChecklistEntry[] {
  const entries: ParsedChecklistEntry[] = [];
  const re = /####\s+\w+:\s+(.+)\n+\s*`([^`\n]+):(\d+)(?:-\d+)?`[\s\S]*?<!--\s*fixbrief-ai-item:([^\s>]+)\s*-->/g;
  for (const match of body.matchAll(re)) {
    entries.push({ title: match[1].trim(), file: match[2], line: Number(match[3]), fingerprint: match[4] });
  }
  return entries;
}

/** Checklist items that are not already in the comment, even if a line shift changed their fingerprint. */
export function checklistItemsToAppend(existing: string | undefined, items: ChecklistItem[]): ChecklistItem[] {
  if (!existing?.includes(CHECKLIST_MARKER)) return items;
  const entries = parseChecklistEntries(existing);
  const used = new Set<string>();
  const pending: ChecklistItem[] = [];
  for (const item of items) {
    const exact = entries.find((entry) => entry.fingerprint === item.fingerprint && !used.has(entry.fingerprint));
    if (exact) { used.add(exact.fingerprint); continue; }
    pending.push(item);
  }
  const pairs = matchByLocation(
    pending.map((item) => ({ id: item.fingerprint, base: threadBaseFingerprint(item), line: item.line })),
    entries.filter((entry) => !used.has(entry.fingerprint)).map((entry) => ({
      id: entry.fingerprint,
      base: threadBaseFingerprint({ file: entry.file, title: entry.title }),
      line: entry.line,
    })),
  );
  return pending.filter((item) => !pairs.has(item.fingerprint));
}

/** Append findings that are not already in the comment. Existing text, including agent notes, is kept. */
export function mergeChecklistBody(existing: string | undefined, items: ChecklistItem[]): string {
  if (!existing?.includes(CHECKLIST_MARKER)) return renderChecklistBody(items);
  const missing = checklistItemsToAppend(existing, items);
  if (!missing.length) return `${existing.trimEnd()}\n`;
  return `${existing.trimEnd()}\n\n${missing.map(renderChecklistItem).join("\n\n")}\n`;
}

/**
 * Source of the checklist update used by the report-back command.
 * `current`, `edited`, and `original` are in scope; the result is `next`.
 */
export const CHECKLIST_MERGE_SOURCE = `
const re = /<!--\\s*fixbrief-ai-item:([^\\s>]+)\\s*-->/g;
const blocks = (body) => {
  const marks = [...body.matchAll(re)].map((match) => ({
    fp: match[1],
    end: match.index + match[0].length,
  }));
  return marks.map((mark, index) => {
    const prev = index === 0 ? body.indexOf("<!-- fixbrief-ai-checklist -->") : marks[index - 1].end;
    let from = body.indexOf("\\n#### ", prev < 0 ? 0 : prev);
    if (from < 0) from = prev < 0 ? 0 : prev;
    else from += 1;
    return { fp: mark.fp, from, to: mark.end, text: body.slice(from, mark.end).trim() };
  });
};
const unchanged = new Map(blocks(original).map((item) => [item.fp, item.text]));
const incoming = blocks(edited).filter((item) => unchanged.get(item.fp) !== item.text);
let next = current;
const live = blocks(next);
const rows = [];
for (const item of incoming) {
  const found = live.find((row) => row.fp === item.fp);
  if (found) rows.push({ item, found });
}
rows.sort((a, b) => b.found.from - a.found.from);
for (const row of rows) {
  next = next.slice(0, row.found.from) + row.item.text + next.slice(row.found.to);
}
const have = new Set(blocks(next).map((row) => row.fp));
for (const item of incoming) {
  if (!have.has(item.fp)) next = next.trimEnd() + "\\n\\n" + item.text + "\\n";
}
if (!next.endsWith("\\n")) next += "\\n";
`.trim();

/** Apply checklist items the agent changed. Items still equal to `original` stay as they are on the live comment. */
export function mergeChecklistReport(current: string, edited: string, original = ""): string {
  const run = new Function("current", "edited", "original", `${CHECKLIST_MERGE_SOURCE}\nreturn next;`) as (
    current: string, edited: string, original: string,
  ) => string;
  return run(current, edited, original);
}

export function checklistCovers(existing: string | undefined, items: ChecklistItem[]): boolean {
  if (!items.length) return true;
  if (!existing?.includes(CHECKLIST_MARKER)) return false;
  return checklistItemsToAppend(existing, items).length === 0;
}

/** Replace the overview's "generated N comments" count after threads are dropped as duplicates. */
export function rewriteGeneratedCommentCount(body: string, count: number): string {
  const word = `comment${count === 1 ? "" : "s"}`;
  return body.replace(/generated \d+ comments?/, `generated ${count} ${word}`);
}

/** Targets written beside fix-brief.md so a later step can attach reply commands. */
export interface FixBriefTarget {
  id: string;
  severity: FindingSeverity;
  file: string;
  line: number;
  endLine?: number;
  title: string;
  /** Stable across runs. Built from the file, title, and line. */
  fingerprint: string;
  /** `thread` replies on a review comment. `checklist` updates the single checklist comment. */
  placement: "thread" | "checklist";
  /** True when the finding was posted as a review thread (line or file comment). */
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
    targets: findings.map((finding) => {
      const inline = inlineIds.has(finding.id);
      return {
        id: finding.id,
        severity: finding.severity,
        file: finding.file,
        line: finding.line,
        endLine: finding.endLine,
        title: finding.title,
        fingerprint: threadFingerprint(finding),
        placement: inline ? "thread" as const : "checklist" as const,
        inline,
      };
    }),
  };
}

