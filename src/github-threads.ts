#!/usr/bin/env node
/** Read unresolved review threads and the FixBrief checklist comment from a pull request. */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKLIST_MARKER } from "./findings.ts";
import type { ExistingThread } from "./thread-dedupe.ts";

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          comments(first: 1) { nodes { databaseId body path line originalLine author { login } } }
        }
      }
    }
  }
}`;

interface ThreadPage {
  data?: {
    viewer?: { login?: string };
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<{
            isResolved?: boolean;
            comments?: { nodes?: Array<{ databaseId?: number; body?: string; path?: string; line?: number | null; originalLine?: number | null; author?: { login?: string } | null }> };
          }>;
        };
      };
    };
  };
  errors?: Array<{ message?: string }>;
}

export function parseThreadPage(page: ThreadPage): { threads: ExistingThread[]; next?: string; actor?: string } {
  if (page.errors?.length) {
    throw new Error(page.errors.map((error) => error.message || "GraphQL error").join("; "));
  }
  const connection = page.data?.repository?.pullRequest?.reviewThreads;
  const threads: ExistingThread[] = [];
  for (const node of connection?.nodes ?? []) {
    const comment = node.comments?.nodes?.[0];
    if (!comment?.databaseId) continue;
    const author = comment.author?.login;
    threads.push({
      commentId: comment.databaseId,
      body: comment.body ?? "",
      resolved: node.isResolved === true,
      ...(author ? { author } : {}),
      ...(comment.path ? { path: comment.path } : {}),
      ...(typeof comment.line === "number" || comment.line === null ? { line: comment.line ?? null } : {}),
      ...(typeof comment.originalLine === "number" ? { originalLine: comment.originalLine } : {}),
    });
  }
  const next = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor ?? undefined : undefined;
  return { threads, next, actor: page.data?.viewer?.login };
}

function gh(args: string[], input?: string): string {
  const result = spawnSync("gh", args, { input, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "gh failed").trim());
  }
  return result.stdout;
}

function fetchThreads(owner: string, name: string, pr: number): { threads: ExistingThread[]; actor?: string } {
  const threads: ExistingThread[] = [];
  let actor: string | undefined;
  let cursor: string | null = null;
  do {
    const page = JSON.parse(gh(["api", "graphql", "--input", "-"], JSON.stringify({
      query: THREADS_QUERY,
      variables: { owner, name, number: pr, cursor },
    }))) as ThreadPage;
    const parsed = parseThreadPage(page);
    threads.push(...parsed.threads);
    actor ??= parsed.actor;
    cursor = parsed.next ?? null;
  } while (cursor);
  return { threads, actor };
}

/** `gh api --paginate` prints one JSON array per page with no separator. */
function parseJsonArrays(text: string): Array<{ id?: number; body?: string }> {
  const rows: Array<{ id?: number; body?: string }> = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "[") { if (depth === 0) start = i; depth++; }
    else if (ch === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        const page = JSON.parse(text.slice(start, i + 1)) as Array<{ id?: number; body?: string }>;
        rows.push(...page);
        start = -1;
      }
    }
  }
  return rows;
}

function fetchChecklist(repo: string, pr: number): { id: number; body: string } | null {
  const raw = gh(["api", "--paginate", `repos/${repo}/issues/${pr}/comments`]);
  let found: { id: number; body: string } | null = null;
  for (const comment of parseJsonArrays(raw)) {
    if (comment.id && (comment.body ?? "").includes(CHECKLIST_MARKER)) {
      found = { id: comment.id, body: comment.body ?? "" };
    }
  }
  return found;
}

function main(): void {
  const args = process.argv.slice(2);
  const repo = args[args.indexOf("--repo") + 1];
  const pr = args[args.indexOf("--pr") + 1];
  const out = args[args.indexOf("--out") + 1];
  if (!repo || !pr || !out || repo.startsWith("--") || pr.startsWith("--")) {
    throw new Error("usage: github-threads.ts --repo OWNER/NAME --pr N --out FILE");
  }
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`repo must be OWNER/NAME, got ${repo}`);
  const { threads, actor } = fetchThreads(owner, name, Number(pr));
  if (!actor) console.warn("Could not read the authenticated login; existing threads will not be reused.");
  const checklist = fetchChecklist(repo, Number(pr));
  writeFileSync(out, JSON.stringify({ threads, checklist, actor: actor ?? null }, null, 2));
  console.log(`Fetched ${threads.length} review thread(s)${checklist ? ` and checklist comment ${checklist.id}` : ""}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
