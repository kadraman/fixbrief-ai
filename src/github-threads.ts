#!/usr/bin/env node
/** Read unresolved review threads and the FixBrief checklist comment from a pull request. */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKLIST_MARKER } from "./findings.ts";
import type { ExistingThread } from "./thread-dedupe.ts";

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          comments(first: 1) { nodes { databaseId body } }
        }
      }
    }
  }
}`;

interface ThreadPage {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<{
            isResolved?: boolean;
            comments?: { nodes?: Array<{ databaseId?: number; body?: string }> };
          }>;
        };
      };
    };
  };
  errors?: Array<{ message?: string }>;
}

export function parseThreadPage(page: ThreadPage): { threads: ExistingThread[]; next?: string } {
  if (page.errors?.length) {
    throw new Error(page.errors.map((error) => error.message || "GraphQL error").join("; "));
  }
  const connection = page.data?.repository?.pullRequest?.reviewThreads;
  const threads: ExistingThread[] = [];
  for (const node of connection?.nodes ?? []) {
    const comment = node.comments?.nodes?.[0];
    if (!comment?.databaseId) continue;
    threads.push({
      commentId: comment.databaseId,
      body: comment.body ?? "",
      resolved: node.isResolved === true,
    });
  }
  const next = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor ?? undefined : undefined;
  return { threads, next };
}

function gh(args: string[], input?: string): string {
  const result = spawnSync("gh", args, { input, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "gh failed").trim());
  }
  return result.stdout;
}

function fetchThreads(owner: string, name: string, pr: number): ExistingThread[] {
  const threads: ExistingThread[] = [];
  let cursor: string | null = null;
  do {
    const page = JSON.parse(gh(["api", "graphql", "--input", "-"], JSON.stringify({
      query: THREADS_QUERY,
      variables: { owner, name, number: pr, cursor },
    }))) as ThreadPage;
    const parsed = parseThreadPage(page);
    threads.push(...parsed.threads);
    cursor = parsed.next ?? null;
  } while (cursor);
  return threads;
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
  const threads = fetchThreads(owner, name, Number(pr));
  const checklist = fetchChecklist(repo, Number(pr));
  writeFileSync(out, JSON.stringify({ threads, checklist }, null, 2));
  console.log(`Fetched ${threads.length} review thread(s)${checklist ? ` and checklist comment ${checklist.id}` : ""}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
