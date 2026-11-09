import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { parseDiffLines } from "./difflines.ts";
import type { LineMap } from "./difflines.ts";

/** Reference context for the reviewer: other files in the PR, project guidance, usages, and callee bodies. */
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
  /** Callees whose bodies are read from the checkout. 0 disables definition lookup. */
  maxDefinitions: number;
  /** Max lines of one function body included from the checkout. */
  definitionLines: number;
  /** Repository root (the checkout). */
  root: string;
  /** Injectable for tests; defaults to `git grep`. */
  grep?: GrepFn;
}

export const DEFAULT_CONTEXT_OPTIONS: Omit<ContextOptions, "root"> = {
  maxChars: 12000, callersPerSymbol: 3, maxSymbols: 12, docChars: 3000,
  maxDefinitions: 6, definitionLines: 80,
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

/** A keyword that takes parentheses, so the name is not a callee. `new` starts a constructor, not a dropped side effect. */
const CALL_PREFIX = /(?:function\*?|class|interface|enum|def|fn|func|struct|trait|catch|if|for|while|switch|typeof|new)\s*$/;

/** Names invoked on `code` (not only added diff lines). Declarations and generic names are dropped. */
export function calledSymbolsFromCode(code: string, maxSymbols: number): string[] {
  const seen = new Set<string>();
  const add = (name: string) => {
    if (name.length < 4 || GENERIC.has(name.toLowerCase()) || KEYWORDS.has(name)) return;
    seen.add(name);
  };
  for (const line of code.split("\n")) {
    const declared = new Set(identifiersFromDeclaration(line));
    const call = /([A-Za-z_$][\w$]*)\s*\(/g;
    for (let match = call.exec(line); match; match = call.exec(line)) {
      if (declared.has(match[1]) || CALL_PREFIX.test(line.slice(0, match.index))) continue;
      add(match[1]);
      if (seen.size >= maxSymbols) return [...seen];
    }
  }
  return [...seen];
}

/** Callees on added lines of an ANNOTATED diff piece, capped and filtered like {@link changedSymbols}. */
export function calledSymbols(annotatedText: string, maxSymbols: number): string[] {
  const added: string[] = [];
  for (const line of annotatedText.split("\n")) {
    const code = annotatedCode(line);
    if (code?.kind === "added") added.push(code.code);
  }
  return calledSymbolsFromCode(added.join("\n"), maxSymbols);
}

/** True when `code` declares `symbol` (function, method, class, or const binding), not merely calls it. */
export function isDefinitionLine(symbol: string, code: string): boolean {
  if (identifiersFromDeclaration(code).includes(symbol)) return true;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:function\\*?|class|def|fn|func)\\s+${escaped}\\b|(?:const|let|var|val)\\s+${escaped}\\b`).test(code);
}

function staysInside(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Join `file` onto `root` and reject paths that escape the checkout, including through a symlink. */
export function safeRepoPath(root: string, file: string): string | null {
  if (!file || file.includes("\0") || isAbsolute(file)) return null;
  const abs = join(root, file);
  if (!staysInside(root, abs)) return null;
  try {
    const resolved = realpathSync(abs);
    if (!staysInside(realpathSync(root), resolved)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function codeForBraces(line: string): string {
  const noLineComment = line.replace(/\/\/.*$/, "");
  return noLineComment.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");
}

/** Lines of a definition starting at `startLine` (1-based), through the matching closing brace, capped at `maxLines`. */
export function sliceDefinition(fileText: string, startLine: number, maxLines: number): string {
  const lines = fileText.split(/\r?\n/);
  const start = Math.max(0, startLine - 1);
  if (start >= lines.length || maxLines <= 0) return "";
  const collected: string[] = [];
  let depth = 0;
  let seenOpen = false;
  for (let i = start; i < lines.length && collected.length < maxLines; i++) {
    const line = lines[i];
    collected.push(line);
    for (const ch of codeForBraces(line)) {
      if (ch === "{") { depth++; seenOpen = true; }
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
    if (seenOpen && depth === 0) break;
  }
  return collected.join("\n");
}

function definedInBatch(symbol: string, annotatedText: string): boolean {
  for (const line of annotatedText.split("\n")) {
    const annotated = annotatedCode(line);
    const code = annotated ? annotated.code : line.replace(/^@@ [^@]*@@\s*/, "");
    if (isDefinitionLine(symbol, code)) return true;
  }
  return false;
}

const gitGrep: GrepFn = (symbol, root, limit) => {
  try {
    const count = String(Math.min(Math.max(limit, 1), 200));
    const out = execFileSync("git", ["grep", "-n", "-w", "-F", "-I", "--no-color", "--max-count", count, "-e", symbol],
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

function piecePath(label: string): string {
  return label.replace(/ \(part \d+\/\d+\)$/, "");
}

function pickDefinition(symbol: string, rows: string[], prefer: Set<string>): { path: string; line: number } | null {
  const found: { path: string; line: number; preferred: boolean }[] = [];
  for (const row of rows) {
    const match = /^(.+?):(\d+):(.*)$/.exec(row);
    if (!match || NOISE_PATH.test(match[1]) || !isDefinitionLine(symbol, match[3])) continue;
    found.push({ path: match[1], line: Number(match[2]), preferred: prefer.has(match[1]) });
  }
  found.sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.line - b.line);
  return found[0] ? { path: found[0].path, line: found[0].line } : null;
}

/**
 * Bodies of functions the changed lines call, read from the checkout.
 * Skips a symbol already defined in this batch. Line numbers are approximate.
 */
export function definitionSection(
  symbols: string[], batchText: string, preferPaths: string[], options: ContextOptions, maxChars: number,
): { text: string; count: number } {
  const definitionLines = options.definitionLines ?? DEFAULT_CONTEXT_OPTIONS.definitionLines;
  if (maxChars <= 0 || definitionLines <= 0 || !symbols.length) return { text: "", count: 0 };
  const grep = options.grep ?? gitGrep;
  const prefer = new Set(preferPaths);
  const header = "### Definitions of functions called by the changed lines (checked-out tree; line numbers approximate)";
  const blocks: string[] = [];
  let used = header.length + 1;
  for (const symbol of symbols) {
    if (definedInBatch(symbol, batchText)) continue;
    let hit: { path: string; line: number } | null = null;
    try { hit = pickDefinition(symbol, grep(symbol, options.root, 80), prefer); }
    catch { hit = null; }
    if (!hit) continue;
    const abs = safeRepoPath(options.root, hit.path);
    if (!abs || !existsSync(abs)) continue;
    let body = "";
    try { body = sliceDefinition(readFileSync(abs, "utf8"), hit.line, definitionLines); }
    catch { body = ""; }
    if (!body.trim()) continue;
    const numbered = body.split("\n").map((line, index) => `  ${hit.line + index}: ${line}`).join("\n");
    const block = `\`${symbol}\` at ${hit.path}:${hit.line}:\n${numbered}`;
    if (used + block.length + 1 > maxChars) break;
    blocks.push(block);
    used += block.length + 1;
  }
  if (!blocks.length) return { text: "", count: 0 };
  return { text: `${header}\n${blocks.join("\n")}`, count: blocks.length };
}

export interface BatchContextStat { files: string[]; chars: number; symbols: number; hits: number; definitions: number }
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
      const batchText = batch.map((p) => p.text).join("\n");
      const symbols = changedSymbols(batchText, options.maxSymbols);
      const maxDefinitions = options.maxDefinitions ?? DEFAULT_CONTEXT_OPTIONS.maxDefinitions;
      const callees = maxDefinitions > 0 ? calledSymbols(batchText, maxDefinitions) : [];
      const fixed = [shared.overview, shared.guidance].filter(Boolean);
      const budget = Math.max(0, options.maxChars - fixed.join("\n\n").length - 2);
      const definitionBudget = callees.length ? Math.max(0, Math.floor(budget * 0.6)) : 0;
      const definitions = definitionSection(callees, batchText, batch.map((p) => piecePath(p.label)), options, definitionBudget);
      const usageBudget = Math.max(0, budget - (definitions.text ? definitions.text.length + 2 : 0));
      const usage = usageSection(symbols, shared.visible, options, usageBudget);
      const text = [...fixed, definitions.text, usage.text].filter(Boolean).join("\n\n").slice(0, options.maxChars);
      stats.push({
        files: batch.map((p) => p.label), chars: text.length, symbols: symbols.length,
        hits: usage.hits, definitions: definitions.count,
      });
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
    maxDefinitions: int("CONTEXT_DEFINITIONS", DEFAULT_CONTEXT_OPTIONS.maxDefinitions),
    definitionLines: int("DEFINITION_LINES", DEFAULT_CONTEXT_OPTIONS.definitionLines),
  };
}
