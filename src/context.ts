import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDiffLines } from "./difflines.ts";
import type { LineMap } from "./difflines.ts";

/** Reference context for the reviewer: other files in the PR, project guidance, and where changed symbols are used. */
export type GrepFn = (symbol: string, root: string, limit: number) => string[];

export interface ContextOptions {
  /** Cap for the whole reference block of one batch, in characters. 0 disables reference context entirely. */
  maxChars: number;
  /** Usages shown per changed symbol. */
  callersPerSymbol: number;
  /** Symbols looked up per batch. */
  maxSymbols: number;
  /** Cap for the project-guidance excerpt. 0 disables it. */
  docChars: number;
  /** Repository root (the checkout). */
  root: string;
  /** Injectable for tests; defaults to `git grep`. */
  grep?: GrepFn;
}

export const DEFAULT_CONTEXT_OPTIONS: Omit<ContextOptions, "root"> = {
  maxChars: 12000, callersPerSymbol: 3, maxSymbols: 12, docChars: 3000,
};

const DOC_CANDIDATES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md", "CONTRIBUTING.md"];
const NOISE_PATH = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|node_modules|dist|build|vendor)(\/|$)|\.min\.(js|css)$|\.map$/;
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "with", "else", "do", "try", "new", "typeof", "await", "super"]);
/** Names so generic that a repository-wide search would be noise. */
const GENERIC = new Set(["main", "init", "test", "setup", "handle", "run", "get", "set", "data", "value", "index", "error", "result",
  "name", "type", "list", "item", "items", "call", "apply", "then", "next", "done", "open", "read", "write", "close", "default", "constructor"]);

/** Annotated diff lines look like "   42 +code"; return the code with its kind, or null for headers and removed lines. */
function annotatedCode(line: string): { kind: "added" | "context"; code: string } | null {
  const match = /^\s*\d+ ([+ ])(.*)$/.exec(line);
  return match ? { kind: match[1] === "+" ? "added" : "context", code: match[2] } : null;
}

export interface FileSummary { path: string; added: number; removed: number; status: "modified" | "new" | "deleted" | "renamed" }

/** One entry per file in a raw (un-annotated) unified diff. */
export function summarizeDiff(rawDiff: string): FileSummary[] {
  const files: FileSummary[] = [];
  for (const chunk of rawDiff.split(/(?=^diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (!header) continue;
    let added = 0, removed = 0, inHunk = false;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("@@")) { inHunk = true; continue; }
      if (!inHunk) continue;
      if (line.startsWith("+")) added++; else if (line.startsWith("-")) removed++;
    }
    const status = /^new file mode/m.test(chunk) ? "new" : /^deleted file mode/m.test(chunk) ? "deleted"
      : /^rename from /m.test(chunk) ? "renamed" : "modified";
    files.push({ path: header[2].trim(), added, removed, status });
  }
  return files;
}

function overviewSection(rawDiff: string, maxChars: number): string {
  const files = summarizeDiff(rawDiff);
  if (!files.length || maxChars <= 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (const f of files) {
    const line = `- ${f.path} (+${f.added}/-${f.removed}${f.status === "modified" ? "" : `, ${f.status}`})`;
    if (used + line.length + 1 > maxChars) { lines.push(`- ...and ${files.length - lines.length} more file(s)`); break; }
    lines.push(line); used += line.length + 1;
  }
  return `### Files changed in this PR (${files.length})\n${lines.join("\n")}`;
}

/** First project-guidance file that exists, truncated. Returns "" when none. */
export function readProjectGuidance(root: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  for (const candidate of DOC_CANDIDATES) {
    const path = join(root, candidate);
    try {
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8").trim();
      if (!text) continue;
      const body = text.length > maxChars ? `${text.slice(0, maxChars).replace(/\n[^\n]*$/, "")}\n[truncated]` : text;
      return `### Project guidance (${candidate})\n${body}`;
    } catch { /* unreadable: try the next candidate */ }
  }
  return "";
}

function identifiersFromDeclaration(code: string): string[] {
  const names: string[] = [];
  const declaration = /\b(?:function\*?|class|interface|enum|type|def|fn|func|struct|trait|module)\s+([A-Za-z_$][\w$]*)/g;
  for (let m = declaration.exec(code); m; m = declaration.exec(code)) names.push(m[1]);
  const arrow = /\b(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(code);
  if (arrow) names.push(arrow[1]);
  const fnExpr = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/.exec(code);
  if (fnExpr) names.push(fnExpr[1]);
  const method = /^\s*(?:(?:public|private|protected|static|async|override|export|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{;=]+)?\s*\{\s*$/.exec(code);
  if (method && !KEYWORDS.has(method[1])) names.push(method[1]);
  return names;
}

/**
 * Names declared or enclosing in the changed code of an ANNOTATED diff piece: declarations on added lines, plus the
 * enclosing function git prints after each hunk header. Generic or very short names are dropped.
 */
export function changedSymbols(annotatedText: string, maxSymbols: number): string[] {
  const seen = new Set<string>();
  const add = (name: string) => {
    if (name.length < 4 || GENERIC.has(name.toLowerCase()) || KEYWORDS.has(name)) return;
    seen.add(name);
  };
  for (const line of annotatedText.split("\n")) {
    const hunk = /^@@ [^@]*@@\s*(.*)$/.exec(line);
    if (hunk && hunk[1]) {
      const found = identifiersFromDeclaration(hunk[1]);
      if (found.length) found.forEach(add);
      else { const call = /([A-Za-z_$][\w$]*)\s*\(/.exec(hunk[1]); if (call) add(call[1]); }
      continue;
    }
    const code = annotatedCode(line);
    if (code?.kind === "added") identifiersFromDeclaration(code.code).forEach(add);
    if (seen.size >= maxSymbols) break;
  }
  return [...seen].slice(0, maxSymbols);
}

const gitGrep: GrepFn = (symbol, root, limit) => {
  try {
    const out = execFileSync("git", ["grep", "-n", "-w", "-F", "-I", "--no-color", "--max-count", "10", "-e", symbol],
      { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter(Boolean).slice(0, limit);
  } catch { return []; } // not a repo, no matches (exit 1), timeout: all mean "no context"
};

/** Usages of the changed symbols elsewhere in the checkout, skipping lines the reviewer already sees in the diff. */
export function usageSection(symbols: string[], visible: LineMap, options: ContextOptions, maxChars: number): { text: string; hits: number } {
  const grep = options.grep ?? gitGrep;
  const blocks: string[] = [];
  let used = 0, hits = 0;
  for (const symbol of symbols) {
    const rows: string[] = [];
    for (const row of grep(symbol, options.root, options.callersPerSymbol * 4)) {
      const m = /^(.+?):(\d+):(.*)$/.exec(row);
      if (!m || NOISE_PATH.test(m[1])) continue;
      const lines = visible.get(m[1]);
      const n = Number(m[2]);
      if (lines && (lines.added.has(n) || lines.context.has(n))) continue; // already in the diff
      rows.push(`  ${m[1]}:${n}: ${m[3].trim().slice(0, 160)}`);
      if (rows.length >= options.callersPerSymbol) break;
    }
    if (!rows.length) continue;
    const block = `\`${symbol}\` is also used at:\n${rows.join("\n")}`;
    if (used + block.length + 1 > maxChars) break;
    blocks.push(block); used += block.length + 1; hits += rows.length;
  }
  return { text: blocks.length ? `### Other usages of symbols changed here (checked-out tree; line numbers approximate)\n${blocks.join("\n")}` : "", hits };
}

export interface BatchContextStat { files: string[]; chars: number; symbols: number; hits: number }
export interface ContextBuilder { (batch: { label: string; text: string }[]): string; stats: BatchContextStat[] }

/**
 * Build the per-batch reference block. Never throws: any failure yields "" so a review is never lost to context.
 * `rawDiff` is the un-annotated diff being reviewed (its lines count as "already visible"); `prDiff` is the full PR diff
 * used for the file overview (they differ when only new commits are reviewed). Each batch is annotated diff text.
 */
export function createContextBuilder(rawDiff: string, options: ContextOptions, prDiff: string = rawDiff): ContextBuilder {
  const cache = new Map<string, string>();
  const stats: BatchContextStat[] = [];
  let shared: { overview: string; guidance: string; visible: LineMap } | null = null;
  const build = (batch: { label: string; text: string }[]): string => {
    if (options.maxChars <= 0) return "";
    try {
      shared ??= {
        overview: overviewSection(prDiff, Math.min(2500, Math.floor(options.maxChars / 4))),
        guidance: readProjectGuidance(options.root, Math.min(options.docChars, Math.floor(options.maxChars / 3))),
        visible: parseDiffLines(rawDiff),
      };
      const symbols = changedSymbols(batch.map((p) => p.text).join("\n"), options.maxSymbols);
      const fixed = [shared.overview, shared.guidance].filter(Boolean);
      const budget = Math.max(0, options.maxChars - fixed.join("\n\n").length - 2);
      const usage = usageSection(symbols, shared.visible, options, budget);
      const text = [...fixed, usage.text].filter(Boolean).join("\n\n").slice(0, options.maxChars);
      stats.push({ files: batch.map((p) => p.label), chars: text.length, symbols: symbols.length, hits: usage.hits });
      return text;
    } catch { return ""; }
  };
  const builder = ((batch: { label: string; text: string }[]) => {
    const key = batch.map((p) => p.label).join("\u0000");
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const text = build(batch);
    cache.set(key, text);
    return text;
  }) as ContextBuilder;
  builder.stats = stats;
  return builder;
}

/** Read the CONTEXT_* environment variables into options. */
export function contextOptionsFromEnv(env: (name: string, fallback?: string) => string, root: string): ContextOptions {
  const int = (name: string, fallback: number) => {
    const raw = env(name);
    if (!raw) return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
    return value;
  };
  return {
    root,
    maxChars: int("CONTEXT_CHARS", DEFAULT_CONTEXT_OPTIONS.maxChars),
    callersPerSymbol: int("CONTEXT_CALLERS", DEFAULT_CONTEXT_OPTIONS.callersPerSymbol),
    maxSymbols: int("CONTEXT_SYMBOLS", DEFAULT_CONTEXT_OPTIONS.maxSymbols),
    docChars: int("CONTEXT_DOC_CHARS", DEFAULT_CONTEXT_OPTIONS.docChars),
  };
}
