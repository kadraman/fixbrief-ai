#!/usr/bin/env node
/** Attach pull-request reply commands to fix-brief.md after a review is posted. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseFindingMarker,
  type FixBriefTarget,
  type FixBriefTargetsFile,
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
  /** Artifact / gist URL, if already known (optional; usually patched into the review separately). */
  briefUrl?: string;
}

export interface ReportBackItem {
  target: FixBriefTarget;
  commentId?: number;
  command: string;
}

/** Match targets to posted review comments by the hidden <!-- fixbrief-ai:id --> marker. */
export function matchCommentIds(
  targets: FixBriefTarget[],
  comments: ReviewCommentRef[],
): Map<string, number> {
  const byId = new Map<string, number>();
  for (const comment of comments) {
    const findingId = parseFindingMarker(comment.body);
    if (!findingId || byId.has(findingId)) continue;
    byId.set(findingId, comment.id);
  }
  // Only return ids for targets we care about (keeps the map focused).
  const matched = new Map<string, number>();
  for (const target of targets) {
    const id = byId.get(target.id);
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
  ].join("\n");
}

/** Build one report-back command for a finding (thread reply when possible). */
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
      command: `gh api --method POST repos/${repo}/pulls/${pr}/comments/${commentId}/replies -f body=${shellSingleQuote(body)}`,
    };
  }
  const prComment = [
    `### ${target.severity}: ${target.title}`,
    "",
    `\`${locationOf(target)}\``,
    "",
    "<what you fixed, or why you skipped this finding>",
  ].join("\n");
  return {
    target,
    command: `gh pr comment ${pr} --repo ${repo} --body ${shellSingleQuote(prComment)}`,
  };
}

/** Markdown section appended to fix-brief.md with concrete gh reply commands. */
export function renderReportBackSection(
  targetsFile: FixBriefTargetsFile,
  comments: ReviewCommentRef[],
): string {
  const matched = matchCommentIds(targetsFile.targets, comments);
  const items = targetsFile.targets.map((target) =>
    reportBackItem(target, matched.get(target.id), targetsFile.repo, targetsFile.pr));
  const lines = [
    "",
    "## Report back",
    "",
    "After you finish (or skip) each finding above, post a short note on the pull request.",
    "Prefer the thread-reply command when a comment id is listed; otherwise use the PR comment command.",
    "Replace the placeholder text with what you actually did.",
    "",
  ];
  if (!items.length) {
    lines.push("_No findings to report back on._", "");
    return lines.join("\n");
  }
  items.forEach((item, index) => {
    const { target, commentId } = item;
    const where = commentId !== undefined
      ? `reply on review comment \`${commentId}\``
      : "new pull request comment (no inline thread)";
    lines.push(
      `### ${index + 1}. ${target.title}`,
      "",
      `- **Location:** \`${locationOf(target)}\``,
      `- **Severity:** ${target.severity}`,
      `- **How to comment:** ${where}`,
      "",
      "```bash",
      item.command,
      "```",
      "",
    );
  });
  return lines.join("\n");
}

/** Append (or replace) the Report back section on a fix brief. */
export function attachReportBack(options: ReportBackOptions): string {
  const section = renderReportBackSection(options.targets, options.comments);
  let brief = readFileSync(options.briefPath, "utf8");
  const marker = "\n## Report back\n";
  const idx = brief.indexOf(marker);
  if (idx >= 0) brief = brief.slice(0, idx).trimEnd() + "\n";
  brief = `${brief.trimEnd()}\n${section}`;
  writeFileSync(options.briefPath, brief);
  return brief;
}

/** Append the fix-brief download link to a review overview body. */
export function appendBriefDownloadLink(body: string, url: string): string {
  const line = `**Fix brief for an AI assistant:** [download fix-brief.md](${url})`;
  if (body.includes(line) || body.includes(`[download fix-brief.md](${url})`)) return body;
  return `${body.trimEnd()}\n\n${line}\n`;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function usage(): never {
  console.log(`Usage:
  node --experimental-strip-types src/attach-replies.ts \\
    --brief PATH --targets PATH [--comments PATH] [--out PATH]

  --comments PATH   JSON array of {id, body, path?, line?} from the posted review
                    (omit or use an empty array when no review was posted)
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
  const brief = attachReportBack({ briefPath: args.brief, targets, comments });
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
