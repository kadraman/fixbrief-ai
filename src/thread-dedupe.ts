/** Drop review comments that already have an unresolved thread with the same fingerprint. */

import {
  checklistCovers, findingMarker, fingerprintMarker, mergeChecklistBody, parseFindingMarker, parseFingerprintMarker,
  rewriteGeneratedCommentCount,
  type ChecklistItem, type GitHubReviewPayload,
} from "./findings.ts";

export interface ExistingThread {
  commentId: number;
  body: string;
  resolved: boolean;
  /** Login of the thread's first comment. Threads from anyone else are not reused. */
  author?: string;
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

function openThreadsByFingerprint(threads: ExistingThread[], actor: string | undefined): Map<string, ExistingThread> {
  const open = new Map<string, ExistingThread>();
  for (const thread of threads) {
    if (thread.resolved || !isTrustedThread(thread, actor)) continue;
    const fingerprint = parseFingerprintMarker(thread.body);
    if (!fingerprint) continue;
    const existing = open.get(fingerprint);
    if (!existing || thread.commentId > existing.commentId) open.set(fingerprint, thread);
  }
  return open;
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
  const open = openThreadsByFingerprint(threads, link?.actor);
  const reused: ReusedThread[] = [];
  const seenReused = new Set<number>();
  const keep = <T extends { body: string }>(comments: T[]): T[] => {
    const kept: T[] = [];
    for (const comment of comments) {
      const fingerprint = parseFingerprintMarker(comment.body);
      const existing = fingerprint ? open.get(fingerprint) : undefined;
      if (!existing || !fingerprint) { kept.push(comment); continue; }
      if (!seenReused.has(existing.commentId)) {
        seenReused.add(existing.commentId);
        reused.push({
          id: existing.commentId,
          body: comment.body,
          findingId: parseFindingMarker(comment.body) ?? "",
          fingerprint,
          title: titleFromBody(comment.body),
        });
      }
      // A second finding with the same fingerprint is the same thread. Do not checklist it.
    }
    return kept;
  };
  const comments = keep(payload.comments);
  const fileComments = keep(payload.fileComments ?? []);
  const checklist = (payload.checklist ?? []).filter((item) => {
    const existing = open.get(item.fingerprint);
    if (!existing) return true;
    if (!seenReused.has(existing.commentId)) {
      seenReused.add(existing.commentId);
      reused.push({
        id: existing.commentId,
        body: `${findingMarker(item.id)}\n${fingerprintMarker(item.fingerprint)}\n${item.title}`,
        findingId: item.id,
        fingerprint: item.fingerprint,
        title: item.title,
      });
    }
    return false;
  });
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
