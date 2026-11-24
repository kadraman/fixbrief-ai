/** Drop review comments that already have an unresolved thread with the same fingerprint. */

import {
  checklistCovers, findingMarker, fingerprintMarker, matchByLocation, mergeChecklistBody, parseFindingMarker,
  parseFingerprintMarker, rewriteGeneratedCommentCount, threadBaseFingerprint, threadKeyPath,
  type ChecklistItem, type GitHubReviewPayload,
} from "./findings.ts";

export interface ExistingThread {
  commentId: number;
  body: string;
  resolved: boolean;
  /** Login of the thread's first comment. Threads from anyone else are not reused. */
  author?: string;
  path?: string;
  line?: number | null;
  /** Line the comment was first left on. Used when `line` is null because the diff moved. */
  originalLine?: number;
}

export interface ExistingChecklist {
  id?: number;
  body?: string;
}

export interface ReusedThread {
  id: number;
  /** Body of the comment this run would have posted, so report-back can match the new finding id. */
  body: string;
  findingId: string;
  fingerprint: string;
  title: string;
}

export interface DedupeResult {
  payload: GitHubReviewPayload;
  reused: ReusedThread[];
  checklistAction: "skip" | "create" | "update";
  checklistBody: string;
  checklistCommentId?: number;
  /** True when this run would open no new threads and the checklist does not gain items. */
  quietReview: boolean;
  /** True when the checklist comment should be mentioned in the fix brief. */
  includeChecklist: boolean;
}

function titleFromBody(body: string): string {
  const match = /\*\*([^*]+)\*\*/.exec(body);
  return match?.[1]?.trim() || "Finding";
}

function loginKey(login: string): string {
  return login.trim().toLowerCase().replace(/\[bot\]$/, "");
}

/** True when this thread was opened by the account that is posting the review. */
export function isTrustedThread(thread: ExistingThread, actor: string | undefined): boolean {
  if (!actor || !thread.author) return false;
  return loginKey(thread.author) === loginKey(actor);
}

function newest(threads: ExistingThread[]): ExistingThread | undefined {
  return threads.reduce<ExistingThread | undefined>((best, thread) => {
    if (!best || thread.commentId > best.commentId) return thread;
    return best;
  }, undefined);
}

function threadBaseOf(thread: ExistingThread, bases?: Set<string>): string | undefined {
  if (thread.path) {
    const title = titleFromBody(thread.body);
    if (title !== "Finding") return threadBaseFingerprint({ file: thread.path, title });
  }
  const marker = parseFingerprintMarker(thread.body);
  if (marker && bases?.has(marker)) return marker;
  return undefined;
}

function hasLine(line: number | null | undefined): line is number {
  return typeof line === "number";
}

/** Current anchor, or the original line when GitHub has cleared the current one. */
function threadLocation(thread: ExistingThread): number | undefined {
  if (typeof thread.line === "number") return thread.line;
  if (typeof thread.originalLine === "number") return thread.originalLine;
  return undefined;
}

interface ThreadClaim {
  id: string;
  fingerprint: string;
  base: string;
  path: string;
  line?: number;
  title: string;
  findingId: string;
  body: string;
}

function lineAgrees(thread: ExistingThread, claim: ThreadClaim): boolean {
  const location = threadLocation(thread);
  if (location === undefined || !hasLine(claim.line)) return true;
  return location === claim.line;
}

/**
 * True when several same-title findings have to be assigned together.
 * An exact fingerprint is stale once those lines have shifted, so the group
 * is reconciled from current locations before any fingerprint is trusted.
 */
function reconcilesAsGroup(claims: ThreadClaim[], threads: ExistingThread[], base: string, bases: Set<string>): boolean {
  const lineClaims = claims.filter((claim) => claim.base === base && hasLine(claim.line));
  const located = threads.filter((thread) => threadBaseOf(thread, bases) === base && threadLocation(thread) !== undefined);
  return lineClaims.length >= 2 && located.length >= 2;
}

/**
 * Match findings to unresolved trusted threads.
 * Several same-title findings are paired from their current lines before any
 * fingerprint is trusted. A fingerprint is otherwise used only when it still
 * agrees with the thread's current line. One finding that lost its line, or
 * moved between a line comment and a file comment, reuses the single open
 * thread for that file and title.
 * Accepted outcomes are the "thread reuse policy" test. A scenario that asks
 * for the opposite pairing is a policy change, not a defect here.
 */
function assignOpenThreads(
  claims: ThreadClaim[],
  threads: ExistingThread[],
  actor: string | undefined,
): Map<string, ExistingThread> {
  const bases = new Set(claims.map((claim) => claim.base));
  const trusted = threads.filter((thread) => !thread.resolved && isTrustedThread(thread, actor) && parseFingerprintMarker(thread.body));
  const used = new Set<number>();
  const assigned = new Map<string, ExistingThread>();
  const take = (claim: ThreadClaim, thread: ExistingThread) => {
    used.add(thread.commentId);
    assigned.set(claim.id, thread);
  };
  const grouped = new Set(claims.filter((claim) => reconcilesAsGroup(claims, trusted, claim.base, bases)).map((claim) => claim.base));
  for (const claim of claims) {
    if (hasLine(claim.line) && grouped.has(claim.base)) continue;
    const exact = newest(trusted.filter((thread) => !used.has(thread.commentId) && parseFingerprintMarker(thread.body) === claim.fingerprint && lineAgrees(thread, claim)));
    if (!exact) continue;
    take(claim, exact);
  }
  const lineClaims = claims.filter((claim) => !assigned.has(claim.id) && hasLine(claim.line));
  const lineThreads = trusted.filter((thread) => !used.has(thread.commentId) && threadLocation(thread) !== undefined && threadBaseOf(thread, bases));
  const pairs = matchByLocation(
    lineClaims.map((claim) => ({ id: claim.id, base: claim.base, line: claim.line })),
    lineThreads.map((thread) => ({ id: String(thread.commentId), base: threadBaseOf(thread, bases)!, line: threadLocation(thread) })),
  );
  for (const claim of lineClaims) {
    const thread = lineThreads.find((item) => String(item.commentId) === pairs.get(claim.id)?.id);
    if (!thread) continue;
    take(claim, thread);
  }
  const openClaims = claims.filter((claim) => !assigned.has(claim.id));
  const openThreads = trusted.filter((thread) => !used.has(thread.commentId) && thread.path && threadBaseOf(thread, bases));
  const byBase = new Map<string, { claims: ThreadClaim[]; threads: ExistingThread[] }>();
  for (const claim of openClaims) {
    const group = byBase.get(claim.base) ?? { claims: [], threads: [] };
    group.claims.push(claim);
    byBase.set(claim.base, group);
  }
  for (const thread of openThreads) {
    const base = threadBaseOf(thread, bases);
    const group = base ? byBase.get(base) : undefined;
    if (group) group.threads.push(thread);
  }
  for (const group of byBase.values()) {
    if (group.claims.length !== 1 || group.threads.length !== 1) continue;
    const claim = group.claims[0];
    const thread = group.threads[0];
    if (!thread.path || threadKeyPath(thread.path) !== threadKeyPath(claim.path)) continue;
    if (hasLine(claim.line) && threadLocation(thread) !== undefined) continue;
    take(claim, thread);
  }
  const fileThreads = new Map<string, ExistingThread[]>();
  for (const thread of trusted) {
    if (used.has(thread.commentId) || hasLine(thread.line)) continue;
    const base = threadBaseOf(thread, bases);
    if (!base || !thread.path) continue;
    const list = fileThreads.get(base) ?? [];
    list.push(thread);
    fileThreads.set(base, list);
  }
  for (const list of fileThreads.values()) list.sort((a, b) => b.commentId - a.commentId);
  for (const claim of claims) {
    if (assigned.has(claim.id) || hasLine(claim.line)) continue;
    const list = fileThreads.get(claim.base);
    if (!list) continue;
    const index = list.findIndex((thread) => thread.path && threadKeyPath(thread.path) === threadKeyPath(claim.path));
    if (index < 0) continue;
    const [thread] = list.splice(index, 1);
    take(claim, thread);
  }
  return assigned;
}

function stillOpenBlock(reused: ReusedThread[], repo?: string, pr?: string): string {
  const lines = [
    "### Still open",
    "",
    `_${reused.length} finding${reused.length === 1 ? "" : "s"} already ${reused.length === 1 ? "has" : "have"} an unresolved review thread, so this review does not open another. Reply on the existing thread._`,
    "",
  ];
  for (const item of reused) {
    const link = repo && pr
      ? `[review comment \`${item.id}\`](https://github.com/${repo}/pull/${pr}#discussion_r${item.id})`
      : `review comment \`${item.id}\``;
    lines.push(`- **${item.title}** — ${link}`);
  }
  return lines.join("\n");
}

function insertBeforeFooter(body: string, block: string): string {
  const marker = "\n\n---\n";
  const index = body.indexOf(marker);
  if (index === -1) return `${body.trimEnd()}\n\n${block}\n`;
  return `${body.slice(0, index).trimEnd()}\n\n${block}${body.slice(index)}`;
}

/**
 * Remove line and file comments whose fingerprint already has an unresolved thread.
 * Checklist items that are already in the existing checklist comment are left as-is.
 */
export function dedupeThreads(
  payload: GitHubReviewPayload,
  threads: ExistingThread[],
  existingChecklist?: ExistingChecklist,
  link?: { repo?: string; pr?: string; actor?: string },
): DedupeResult {
  const claims: ThreadClaim[] = [];
  const addComment = (kind: string, comment: { body: string; path: string; line?: number }, index: number) => {
    const fingerprint = parseFingerprintMarker(comment.body);
    const title = titleFromBody(comment.body);
    if (!fingerprint || title === "Finding") return;
    claims.push({
      id: `${kind}:${index}`,
      fingerprint,
      base: threadBaseFingerprint({ file: comment.path, title }),
      path: comment.path,
      line: comment.line,
      title,
      findingId: parseFindingMarker(comment.body) ?? "",
      body: comment.body,
    });
  };
  payload.comments.forEach((comment, index) => addComment("line", comment, index));
  (payload.fileComments ?? []).forEach((comment, index) => addComment("file", comment, index));
  (payload.checklist ?? []).forEach((item, index) => claims.push({
    id: `check:${index}`,
    fingerprint: item.fingerprint,
    base: threadBaseFingerprint(item),
    path: item.file,
    line: item.line,
    title: item.title,
    findingId: item.id,
    body: `${findingMarker(item.id)}\n${fingerprintMarker(item.fingerprint)}\n${item.title}`,
  }));
  const assigned = assignOpenThreads(claims, threads, link?.actor);
  const reused: ReusedThread[] = [];
  const reusedIds = new Set<string>();
  for (const claim of claims) {
    const thread = assigned.get(claim.id);
    if (!thread || reusedIds.has(claim.id)) continue;
    reusedIds.add(claim.id);
    reused.push({
      id: thread.commentId, body: claim.body, findingId: claim.findingId, fingerprint: claim.fingerprint, title: claim.title,
    });
  }
  const taken = new Set(assigned.keys());
  const comments = payload.comments.filter((_, index) => !taken.has(`line:${index}`));
  const fileComments = (payload.fileComments ?? []).filter((_, index) => !taken.has(`file:${index}`));
  const checklist = (payload.checklist ?? []).filter((_, index) => !taken.has(`check:${index}`));
  const covered = checklistCovers(existingChecklist?.body, checklist);
  const checklistAction: DedupeResult["checklistAction"] = checklist.length === 0 || covered
    ? "skip"
    : existingChecklist?.body?.includes("<!-- fixbrief-ai-checklist -->") ? "update" : "create";
  const checklistBody = checklistAction === "skip"
    ? (existingChecklist?.body ?? "")
    : mergeChecklistBody(existingChecklist?.body, checklist);
  let body = rewriteGeneratedCommentCount(payload.body, comments.length + fileComments.length);
  if (reused.length) body = insertBeforeFooter(body, stillOpenBlock(reused, link?.repo, link?.pr));
  const quietReview = comments.length === 0 && fileComments.length === 0 && checklistAction === "skip";
  return {
    payload: { ...payload, body, comments, fileComments, checklist },
    reused,
    checklistAction,
    checklistBody,
    checklistCommentId: existingChecklist?.id,
    quietReview,
    includeChecklist: checklist.length > 0,
  };
}

/** Move file comments GitHub rejected onto the checklist without dropping items already there. */
export function absorbFileCommentFailures(
  result: DedupeResult,
  failures: ChecklistItem[],
  existingChecklist?: ExistingChecklist,
): DedupeResult {
  if (!failures.length) return result;
  const failed = new Set(failures.map((item) => item.fingerprint));
  const fileComments = result.payload.fileComments.filter((comment) => !failed.has(comment.fallback.fingerprint));
  const checklist = [...result.payload.checklist];
  const have = new Set(checklist.map((item) => item.fingerprint));
  for (const item of failures) {
    if (!have.has(item.fingerprint)) checklist.push(item);
  }
  const covered = checklistCovers(existingChecklist?.body, checklist);
  const checklistAction: DedupeResult["checklistAction"] = checklist.length === 0 || covered
    ? "skip"
    : existingChecklist?.body?.includes("<!-- fixbrief-ai-checklist -->") ? "update" : "create";
  const checklistBody = checklistAction === "skip"
    ? (existingChecklist?.body ?? result.checklistBody)
    : mergeChecklistBody(existingChecklist?.body, checklist);
  const note = `_${failures.length} file comment${failures.length === 1 ? "" : "s"} could not be posted and ${failures.length === 1 ? "was" : "were"} added to the checklist._`;
  const body = result.payload.body.includes(note)
    ? result.payload.body
    : insertBeforeFooter(result.payload.body, note);
  const recounted = rewriteGeneratedCommentCount(body, result.payload.comments.length + fileComments.length);
  return {
    ...result,
    payload: { ...result.payload, body: recounted, fileComments, checklist },
    checklistAction,
    checklistBody,
    quietReview: result.payload.comments.length === 0 && fileComments.length === 0 && checklistAction === "skip",
    includeChecklist: checklist.length > 0,
  };
}
