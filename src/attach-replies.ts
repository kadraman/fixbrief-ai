#!/usr/bin/env node
/** Attach pull-request reply commands to fix-brief.md after a review is posted. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKLIST_MERGE_SOURCE, parseFindingMarker, parseFingerprintMarker, reportMarker, threadFingerprint,
  type FixBriefTarget,
  type FixBriefTargetsFile,
  type GitHubReviewPayload,
} from "./findings.ts";

export interface ReviewCommentRef {
  id: number;
  body: string;
  path?: string;
  line?: number | null;
}

export interface ReportBackOptions {
  briefPath: string;
  targets: FixBriefTargetsFile;
  comments: ReviewCommentRef[];
  /** Artifact URL, if already known. The review body includes it when the review is submitted. */
  briefUrl?: string;
  /** The single checklist issue comment, when this run has findings that are not review threads. */
  checklist?: { id?: number; body: string };
}

export interface ReportBackItem {
  target: FixBriefTarget;
  commentId?: number;
  command: string;
}

function targetFingerprint(target: FixBriefTarget): string {
  return target.fingerprint || threadFingerprint(target);
}

function isChecklistTarget(target: FixBriefTarget): boolean {
  if (target.placement === "checklist") return true;
  if (target.placement === "thread") return false;
  return !target.inline;
}

/** Match targets to review comments by fingerprint, then by the hidden finding-id marker. */
export function matchCommentIds(
  targets: FixBriefTarget[],
  comments: ReviewCommentRef[],
): Map<string, number> {
  const byFingerprint = new Map<string, number>();
  const byId = new Map<string, number>();
  for (const comment of comments) {
    const fingerprint = parseFingerprintMarker(comment.body);
    const findingId = parseFindingMarker(comment.body);
    if (fingerprint && !byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, comment.id);
    if (findingId && !byId.has(findingId)) byId.set(findingId, comment.id);
  }
  const matched = new Map<string, number>();
  for (const target of targets) {
    const id = byFingerprint.get(targetFingerprint(target)) ?? byId.get(target.id);
    if (id !== undefined) matched.set(target.id, id);
  }
  return matched;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function locationOf(target: FixBriefTarget): string {
  const range = target.endLine !== undefined && target.endLine > target.line
    ? `${target.line}-${target.endLine}` : `${target.line}`;
  return `${target.file}:${range}`;
}

function replyBodyPlaceholder(target: FixBriefTarget): string {
  return [
    `**${target.title}** (\`${locationOf(target)}\`)`,
    "",
    "<what you fixed, or why you skipped this finding>",
    "",
    reportMarker(targetFingerprint(target)),
  ].join("\n");
}

/**
 * Reply on a review thread once.
 * GitHub has no GET for the replies route, so this lists the pull request's review
 * comments and keeps those whose `in_reply_to_id` is this thread. A failed lookup
 * does not post.
 */
export function threadReplyCommand(
  repo: string, pr: string, commentId: number, body: string, fingerprint: string,
): string {
  const marker = reportMarker(fingerprint);
  return [
    `MARKER=${shellSingleQuote(marker)}`,
    `if ! REPLIES="$(gh api --paginate --slurp "repos/${repo}/pulls/${pr}/comments" --jq '[.[][] | select(.in_reply_to_id == ${commentId}) | .body] | join("\\n")')"; then`,
    `  echo "could not read replies for review comment ${commentId}; not posting"`,
    `  exit 1`,
    "fi",
    `if printf '%s\\n' "$REPLIES" | grep -F -q "$MARKER"; then`,
    `  echo "already reported on review comment ${commentId}"`,
    "else",
    `  gh api --method POST "repos/${repo}/pulls/${pr}/comments/${commentId}/replies" -f body=${shellSingleQuote(body)}`,
    "fi",
  ].join("\n");
}

/** Build one report-back command for a threaded finding. */
export function reportBackItem(
  target: FixBriefTarget,
  commentId: number | undefined,
  repo: string,
  pr: string,
): ReportBackItem {
  const body = replyBodyPlaceholder(target);
  if (commentId !== undefined) {
    return {
      target,
      commentId,
      command: threadReplyCommand(repo, pr, commentId, body, targetFingerprint(target)),
    };
  }
  return { target, command: "" };
}

function checklistCommand(
  repo: string, pr: string, checklist: { id?: number; body: string },
): string {
  if (!checklist.id) {
    return `gh pr comment ${pr} --repo ${repo} --body ${shellSingleQuote(checklist.body)}`;
  }
  const script = `const current = process.argv[1];\nconst edited = process.argv[2];\n${CHECKLIST_MERGE_SOURCE}\nprocess.stdout.write(next);\n`;
  return [
    `if ! CURRENT="$(gh api "repos/${repo}/issues/comments/${checklist.id}" --jq .body)"; then`,
    `  echo "could not read checklist comment ${checklist.id}; not updating"`,
    `  exit 1`,
    "fi",
    `EDITED=${shellSingleQuote(checklist.body)}`,
    `if ! MERGED="$(node --input-type=module -e ${shellSingleQuote(script)} "$CURRENT" "$EDITED")"; then`,
    `  echo "could not merge checklist comment ${checklist.id}; not updating"`,
    `  exit 1`,
    "fi",
    `if [ -z "$MERGED" ]; then`,
    `  echo "checklist merge produced an empty body; not updating"`,
    `  exit 1`,
    "fi",
    `gh api --method PATCH "repos/${repo}/issues/comments/${checklist.id}" -f body="$MERGED"`,
  ].join("\n");
}

/** Markdown section appended to fix-brief.md with concrete gh reply commands. */
export function renderReportBackSection(
  targetsFile: FixBriefTargetsFile,
  comments: ReviewCommentRef[],
  checklist?: { id?: number; body: string },
): string {
  const matched = matchCommentIds(targetsFile.targets, comments);
  const threads = targetsFile.targets.filter((target) => matched.has(target.id) || !isChecklistTarget(target));
  const checklistTargets = targetsFile.targets.filter((target) => isChecklistTarget(target) && !matched.has(target.id));
  const lines = [
    "",
    "## Report back",
    "",
    "After you finish (or skip) each finding above, report back using only the commands in this section.",
    "Reply on the matching review thread when a comment id is listed. When a checklist comment is listed, edit that one comment.",
    "Replace the placeholder text with what you actually did. Run each command at most once.",
    "Do not open any other pull request comment.",
    "",
  ];
  if (!threads.length && !checklistTargets.length) {
    lines.push("_No findings to report back on._", "");
    return lines.join("\n");
  }
  threads.forEach((target, index) => {
    const commentId = matched.get(target.id);
    const item = reportBackItem(target, commentId, targetsFile.repo, targetsFile.pr);
    const where = commentId !== undefined
      ? `reply on review comment \`${commentId}\``
      : "no review thread was posted. Do not open a new pull request comment for this finding.";
    lines.push(
      `### ${index + 1}. ${target.title}`,
      "",
      `- **Location:** \`${locationOf(target)}\``,
      `- **Severity:** ${target.severity}`,
      `- **How to comment:** ${where}`,
      "",
    );
    if (item.command) {
      lines.push("```bash", item.command, "```", "");
    }
  });
  const unmatchedThreads = threads.filter((target) => !matched.has(target.id));
  const showChecklist = checklistTargets.length > 0 || (Boolean(checklist?.body) && unmatchedThreads.length > 0);
  if (showChecklist) {
    const body = checklist?.body?.trim()
      ? checklist.body
      : [
        "### FixBrief findings without a review thread",
        "",
        "Edit this comment. Do not open a new pull request comment.",
        "",
        ...checklistTargets.map((target) => [
          `#### ${target.severity}: ${target.title}`,
          "",
          `\`${locationOf(target)}\``,
          "",
          "<what you fixed, or why you skipped this finding>",
        ].join("\n")),
        "",
      ].join("\n");
    const lead = unmatchedThreads.length && checklistTargets.length === 0
      ? "Review threads could not be posted. Report every finding by editing this one comment. Edit the placeholders, then run the command once."
      : checklist?.id
        ? `These findings share one pull request comment (\`${checklist.id}\`). Edit the placeholders in the command, then run it once.`
        : "These findings are not on review threads. The command posts one pull request comment for all of them. Edit the placeholders, then run it once.";
    lines.push(
      "### Checklist",
      "",
      lead,
      "",
      "```bash",
      checklistCommand(targetsFile.repo, targetsFile.pr, { id: checklist?.id, body }),
      "```",
      "",
    );
  }
  return lines.join("\n");
}

/** Append (or replace) the Report back section on a fix brief. */
export function attachReportBack(options: ReportBackOptions): string {
  const section = renderReportBackSection(options.targets, options.comments, options.checklist);
  let brief = readFileSync(options.briefPath, "utf8");
  const marker = "\n## Report back\n";
  const idx = brief.indexOf(marker);
  if (idx >= 0) brief = brief.slice(0, idx).trimEnd() + "\n";
  brief = `${brief.trimEnd()}\n${section}`;
  writeFileSync(options.briefPath, brief);
  return brief;
}

/** Markdown block linking the fix brief and telling a human how to use it. */
export function briefDownloadBlock(url: string): string {
  return [
    `**Fix brief for an AI assistant:** [download fix-brief.md](${url})`,
    "",
    "Download `fix-brief.md`, check out this pull request's branch, and give the file to a coding assistant (Cursor, Copilot, Claude Code, or similar). It lists each finding to verify before changing code, the smallest fix, and how to reply on the review thread (or the one checklist comment).",
  ].join("\n");
}

/** Link the single checklist issue comment from the review overview. */
export function appendChecklistLink(body: string, url: string): string {
  if (body.includes(url)) return body;
  return `${body.trimEnd()}\n\n**Findings without a review thread:** [checklist comment](${url})\n`;
}

/** Append the fix-brief download link (and usage instructions) to a review overview body. */
export function appendBriefDownloadLink(body: string, url: string): string {
  if (body.includes(`[download fix-brief.md](${url})`)) return body;
  return `${body.trimEnd()}\n\n${briefDownloadBlock(url)}\n`;
}

/**
 * Body for creating a review that stays pending until it is submitted.
 * Create-review accepts APPROVE, REQUEST_CHANGES, and COMMENT. Omitting `event`
 * leaves the review PENDING. The string "PENDING" is not in that enum and
 * returns HTTP 422, which drops the later submit that carries the download link.
 * The overview is sent on submit, once the artifact URL exists.
 */
export function toPendingReviewPayload(
  payload: Pick<GitHubReviewPayload, "comments">,
): { comments?: GitHubReviewPayload["comments"] } {
  if (!payload.comments?.length) return {};
  return { comments: payload.comments };
}

/** Issue-comment fallback: overview (with the download link when a URL is known) plus any inline findings. */
export function overviewIssueComment(
  payload: Pick<GitHubReviewPayload, "body" | "comments">,
  briefUrl = "",
): string {
  const overview = briefUrl
    ? appendBriefDownloadLink(payload.body, briefUrl).trimEnd()
    : payload.body.trimEnd();
  const parts = [overview];
  for (const comment of payload.comments ?? []) {
    parts.push("", "---", "", `**\`${comment.path}:${comment.line}\`**`, "", comment.body);
  }
  return `${parts.join("\n")}\n`;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function usage(): never {
  console.log(`Usage:
  node --experimental-strip-types src/attach-replies.ts \\
    --brief PATH --targets PATH [--comments PATH] [--out PATH]

  --comments PATH     JSON array of {id, body, path?, line?} from posted and reused review comments
  --checklist PATH    JSON {id?, body} for the single checklist issue comment
`);
  process.exit(0);
}

function readCli(argv: string[]) {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    if (!arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    const key = arg.slice(2);
    if (argv[i + 1] === undefined) throw new Error(`${arg} requires a value`);
    values[key] = argv[++i];
  }
  return values;
}

async function main(): Promise<number> {
  const args = readCli(process.argv.slice(2));
  if (!args.brief || !args.targets) {
    console.error("attach-replies.ts requires --brief and --targets");
    return 1;
  }
  if (!existsSync(args.brief)) {
    console.error(`fix brief not found: ${args.brief}`);
    return 1;
  }
  const targets = readJson<FixBriefTargetsFile>(args.targets);
  const comments: ReviewCommentRef[] = args.comments && existsSync(args.comments)
    ? readJson<ReviewCommentRef[]>(args.comments)
    : [];
  const checklist = args.checklist && existsSync(args.checklist)
    ? readJson<{ id?: number; body?: string }>(args.checklist)
    : undefined;
  const brief = attachReportBack({
    briefPath: args.brief,
    targets,
    comments,
    checklist: checklist && (checklist.id || checklist.body)
      ? { id: checklist.id, body: checklist.body ?? "" }
      : undefined,
  });
  if (args.out) writeFileSync(args.out, brief);
  console.log(`Attached report-back for ${targets.targets.length} finding(s) (${comments.length} review comment(s) matched against).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
