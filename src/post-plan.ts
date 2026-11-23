#!/usr/bin/env node
/** Turn a review payload plus existing threads into the files the poster uploads. */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createReviewRequest, fileCommentRequest, renderChecklistBody,
  type ChecklistItem, type GitHubReviewPayload,
} from "./findings.ts";
import { absorbFileCommentFailures, dedupeThreads, type DedupeResult, type ExistingThread } from "./thread-dedupe.ts";

interface ExistingReview {
  threads?: ExistingThread[];
  checklist?: { id?: number; body?: string } | null;
  actor?: string | null;
}

interface FileCommentJob {
  request: ReturnType<typeof fileCommentRequest>;
  fallback: ChecklistItem;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function arg(name: string, args: string[]): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function requireArg(name: string, args: string[]): string {
  const value = arg(name, args);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function writePlan(outDir: string, result: DedupeResult, head: string, pending: boolean, writeReused = true): void {
  const review = createReviewRequest(result.payload, pending);
  const jobs: FileCommentJob[] = result.payload.fileComments.map((comment) => ({
    request: fileCommentRequest(comment, head),
    fallback: comment.fallback,
  }));
  writeFileSync(join(outDir, "deduped-payload.json"), JSON.stringify(result.payload, null, 2));
  writeFileSync(join(outDir, "review-create.json"), JSON.stringify(review, null, 2));
  writeFileSync(join(outDir, "file-comment-jobs.json"), JSON.stringify(jobs, null, 2));
  writeFileSync(join(outDir, "checklist-plan.json"), JSON.stringify({
    action: result.checklistAction,
    commentId: result.checklistCommentId ?? null,
    body: result.checklistBody,
    includeInBrief: result.includeChecklist,
  }, null, 2));
  if (writeReused) {
    writeFileSync(join(outDir, "reused-comments.json"), JSON.stringify(
      result.reused.map((item) => ({ id: item.id, body: item.body })), null, 2,
    ));
  }
  writeFileSync(join(outDir, "post-plan.json"), JSON.stringify({
    quietReview: result.quietReview,
    checklistAction: result.checklistAction,
    includeChecklist: result.includeChecklist,
    lineCount: result.payload.comments.length,
    fileCount: result.payload.fileComments.length,
    reusedCount: result.reused.length,
  }, null, 2));
}

function plan(args: string[]): void {
  const outDir = requireArg("--out-dir", args);
  const payload = readJson<GitHubReviewPayload>(requireArg("--payload", args));
  payload.fileComments ??= [];
  payload.checklist ??= [];
  const existingPath = arg("--existing", args);
  const existing = existingPath ? readJson<ExistingReview>(existingPath) : {};
  const pending = arg("--pending", args) !== "false";
  const result = dedupeThreads(
    payload,
    existing.threads ?? [],
    existing.checklist ?? undefined,
    { repo: arg("--repo", args), pr: arg("--pr", args), actor: existing.actor ?? undefined },
  );
  writePlan(outDir, result, arg("--head", args) ?? "", pending);
}

function absorb(args: string[]): void {
  const outDir = requireArg("--out-dir", args);
  const payload = readJson<GitHubReviewPayload>(join(outDir, "deduped-payload.json"));
  const planFile = readJson<{
    action: DedupeResult["checklistAction"]; commentId: number | null; body: string; includeInBrief: boolean;
  }>(join(outDir, "checklist-plan.json"));
  const failures = readJson<ChecklistItem[]>(requireArg("--failures", args));
  const posted = readJson<{ quietReview?: boolean }>(join(outDir, "post-plan.json"));
  const current: DedupeResult = {
    payload,
    reused: [],
    checklistAction: planFile.action,
    checklistBody: planFile.body,
    checklistCommentId: planFile.commentId ?? undefined,
    quietReview: posted.quietReview === true,
    includeChecklist: planFile.includeInBrief,
  };
  const existingPath = arg("--existing", args);
  const existing = existingPath ? readJson<ExistingReview>(existingPath) : {};
  const result = absorbFileCommentFailures(current, failures, existing.checklist ?? undefined);
  // The review was already created before failures were known. quietReview stays about
  // whether that create should have been skipped: no remaining threads and no checklist change.
  result.quietReview = result.payload.comments.length === 0
    && result.payload.fileComments.length === 0
    && result.checklistAction === "skip";
  writePlan(outDir, result, arg("--head", args) ?? "", arg("--pending", args) !== "false", false);
}

/** One issue comment used when create-review fails. Includes the checklist marker when there are findings. */
export function fallbackIssueBody(payload: GitHubReviewPayload): string {
  const items: ChecklistItem[] = [
    ...payload.comments.map((comment) => comment.fallback).filter((item): item is ChecklistItem => !!item),
    ...payload.fileComments.map((comment) => comment.fallback),
    ...payload.checklist,
  ];
  const checklist = items.length ? renderChecklistBody(items) : "";
  return `${[payload.body.trimEnd(), checklist].filter(Boolean).join("\n\n")}\n`;
}

function fallback(args: string[]): void {
  const payload = readJson<GitHubReviewPayload>(requireArg("--payload", args));
  payload.fileComments ??= [];
  payload.checklist ??= [];
  writeFileSync(requireArg("--out", args), fallbackIssueBody(payload));
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "plan") plan(args.slice(1));
  else if (command === "absorb") absorb(args.slice(1));
  else if (command === "fallback") fallback(args.slice(1));
  else throw new Error("usage: post-plan.ts plan|absorb|fallback ...");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
