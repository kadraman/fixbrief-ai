#!/usr/bin/env node
/**
 * fixbrief-ai calibration harness.
 *
 * Runs the review engine over previously closed PRs of a repository, collects every finding it produces,
 * lets you label them (true positive / false positive), and reports how precise each confidence level is,
 * which minimum-confidence threshold to use, and how stable the results are between runs.
 *
 *   node scripts/calibrate.ts collect --repo OWNER/NAME [--limit 20] [--runs 1] [--dry-run]
 *   node scripts/calibrate.ts label   --repo OWNER/NAME
 *   node scripts/calibrate.ts report  --repo OWNER/NAME [--target-precision 0.8] [--min-samples 5] [--rescore]
 *
 * `report --rescore` recomputes every confidence from the stored breakdown using the SCORING constants in
 * confidence.ts, so you can tune those constants against the same labeled findings without new model calls.
 *
 * Requires Node.js 22+, an authenticated GitHub CLI (`gh auth login`), and the LLM_* environment variables
 * used by the engine (LLM_API_KEY, LLM_MODEL, ...). A `.env` in the current directory or the repo root is
 * loaded automatically (existing shell variables win). Use `collect --dry-run` first: it needs no API key.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCORING } from "../src/confidence.ts";

/** Load KEY=VALUE lines from a .env file without overriding variables already set in the environment. */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key]) continue;
    let value = body.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// ------------------------------------------------------------------ types
type PrInfo = {
  number: number; title: string; body: string; url: string; state: string;
  mergedAt: string | null; closedAt: string | null; headRefName: string; baseRefName: string;
  additions: number; deletions: number; changedFiles: number;
  author?: { login?: string; is_bot?: boolean };
};
type HumanComment = { path: string; line: number | null; user: string; createdAt: string; body: string };
type FindingRecord = {
  id: string; category: string; severity: string; level?: string; confidence: number;
  confidenceBreakdown?: { level?: string; anchor?: string; evidence?: string; agreement?: string };
  file: string; line: number; endLine?: number; title: string; description: string; evidence?: string;
  anchored?: boolean; inline?: boolean;
};
type FindingsFile = { schemaVersion?: number; model?: string; minimumConfidence?: number; findings: FindingRecord[]; failedBatches?: string[] };
type Label = "tp" | "fp" | "unsure" | "";
type Row = {
  key: string; pr: number; prUrl: string; file: string; line: number; severity: string; category: string;
  level: string; confidence: number; anchored: boolean; inline: boolean; evidence: string; anchor: string;
  humanCommented: boolean; title: string; description: string; label: Label; notes: string;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const CSV_COLUMNS = ["key", "pr", "pr_url", "file", "line", "severity", "category", "level", "confidence", "anchored",
  "inline", "evidence_check", "anchor", "human_commented", "title", "description", "label", "notes"];

// ------------------------------------------------------------------ helpers
function fail(message: string): never { throw new Error(message); }

function gh(args: string[]): string | null {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (result.error) fail(`could not run gh: ${result.error.message} (install https://cli.github.com and run 'gh auth login')`);
  if (result.status !== 0) {
    console.warn(`  gh ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || "").trim().slice(0, 200)}`);
    return null;
  }
  return result.stdout;
}

/** `gh api --paginate` prints one JSON array per page back to back; split them without assuming a separator. */
export function parseJsonStream(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') { inString = true; continue; }
    if (ch === "[" || ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "]" || ch === "}") { depth--; if (depth === 0 && start >= 0) { out.push(JSON.parse(text.slice(start, i + 1))); start = -1; } }
  }
  return out;
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}
function writeJson(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value, null, 2)); }

// CSV (RFC 4180 subset: quotes, embedded commas/newlines)
export function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = ""; if (row.some((cell) => cell !== "")) rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((cell) => cell !== "")) rows.push(row); }
  return rows;
}

export function wilsonLower(successes: number, n: number): number {
  if (n === 0) return 0;
  const z = 1.96, p = successes / n;
  return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n);
}
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

type Options = Record<string, string | boolean>;
const BOOLEAN_FLAGS = new Set(["dry-run", "force", "include-bots", "count-author-comments", "rescore", "help"]);
function parseArgs(argv: string[]): { command: string; opts: Options } {
  const [command = "", ...rest] = argv;
  const opts: Options = {};
  if (command.startsWith("-")) return { command, opts };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) opts[name] = true;
    else { const value = rest[++i]; if (value === undefined) fail(`--${name} needs a value`); opts[name] = value; }
  }
  return { command, opts };
}
function numOpt(opts: Options, name: string, fallback: number): number {
  if (opts[name] === undefined) return fallback;
  const n = Number(opts[name]);
  if (!Number.isFinite(n) || n < 0) fail(`--${name} must be a non-negative number`);
  return n;
}
function repoOpt(opts: Options): string {
  const repo = String(opts.repo ?? "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail("--repo OWNER/NAME is required (for example --repo kadraman/beatbax)");
  return repo;
}
const outDir = (opts: Options, repo: string) => String(opts.out ?? join("calibration", repo.replace("/", "__")));

// ------------------------------------------------------------------ collect
function listPrs(repo: string, opts: Options): PrInfo[] {
  const scan = numOpt(opts, "scan", 300);
  const raw = gh(["pr", "list", "--repo", repo, "--state", "all", "--limit", String(scan), "--json",
    "number,title,body,url,state,mergedAt,closedAt,headRefName,baseRefName,additions,deletions,changedFiles,author"]);
  if (raw === null) fail("could not list pull requests (check the repo name and 'gh auth status')");
  const wanted = String(opts.state ?? "both");
  if (!["merged", "closed", "both"].includes(wanted)) fail("--state must be merged, closed or both");
  const since = opts.since ? Date.parse(String(opts.since)) : 0;
  if (opts.since && Number.isNaN(since)) fail("--since must be a date such as 2025-01-31");
  const maxFiles = numOpt(opts, "max-files", 80);
  const explicit = opts.pr ? new Set(String(opts.pr).split(",").map((s) => Number(s.trim()))) : null;

  let prs = (JSON.parse(raw) as PrInfo[]).filter((pr) => pr.state !== "OPEN");
  if (explicit) prs = prs.filter((pr) => explicit.has(pr.number));
  else {
    prs = prs.filter((pr) => wanted === "both" || (wanted === "merged") === (pr.state === "MERGED"));
    prs = prs.filter((pr) => Date.parse(pr.closedAt ?? pr.mergedAt ?? "") >= since);
    if (!opts["include-bots"]) prs = prs.filter((pr) => !(pr.author?.is_bot || /\[bot\]$|^app\//.test(pr.author?.login ?? "")));
    prs = prs.filter((pr) => pr.changedFiles <= maxFiles);
  }
  prs.sort((a, b) => Date.parse(b.closedAt ?? "") - Date.parse(a.closedAt ?? ""));
  return explicit ? prs : prs.slice(0, numOpt(opts, "limit", 20));
}

function fetchHumanComments(repo: string, pr: PrInfo, countAuthor: boolean): HumanComment[] {
  const raw = gh(["api", `repos/${repo}/pulls/${pr.number}/comments`, "--paginate"]);
  if (raw === null) return [];
  return (parseJsonStream(raw).flat() as any[])
    .filter((c) => c?.user && c.user.type !== "Bot" && !/\[bot\]$/.test(c.user.login ?? ""))
    .filter((c) => countAuthor || c.user.login !== pr.author?.login)
    .map((c) => ({ path: String(c.path ?? ""), line: c.line ?? c.original_line ?? null, user: String(c.user.login),
      createdAt: String(c.created_at ?? ""), body: String(c.body ?? "").slice(0, 500) }));
}

function collect(opts: Options): void {
  const repo = repoOpt(opts);
  const out = outDir(opts, repo);
  const runs = Math.max(1, numOpt(opts, "runs", 1));
  const maxDiffChars = numOpt(opts, "max-diff-chars", 400000);
  const engine = String(opts.engine ?? join(HERE, "../src/fixbrief-ai.ts"));
  const prs = listPrs(repo, opts);

  console.log(`Selected ${prs.length} closed PR(s) from ${repo}; ${prs.length * runs} engine run(s) planned.\n`);
  console.log("  #     state    files  +/-            title");
  for (const pr of prs) {
    console.log(`  ${String(pr.number).padEnd(5)} ${pr.state.toLowerCase().padEnd(8)} ${String(pr.changedFiles).padStart(5)}  ${`+${pr.additions}/-${pr.deletions}`.padEnd(14)} ${pr.title.slice(0, 60)}`);
  }
  if (opts["dry-run"]) { console.log("\nDry run: nothing was fetched or sent to a model."); return; }
  if (!prs.length) fail("no pull requests matched; widen --scan/--since/--max-files or pass --pr");
  if (!process.env.LLM_API_KEY?.trim()) fail("LLM_API_KEY is not set (put it in .env or export it)");
  if (!process.env.LLM_MODEL?.trim()) fail("LLM_MODEL is not set (put it in .env or export it)");

  mkdirSync(out, { recursive: true });
  let done = 0, skipped = 0, failed = 0;
  for (const pr of prs) {
    const dir = join(out, "prs", String(pr.number));
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, "pr.json"), pr);
    const diffPath = join(dir, "pr.diff");
    if (!existsSync(diffPath)) {
      const diff = gh(["pr", "diff", String(pr.number), "--repo", repo]);
      if (diff === null) { console.log(`#${pr.number}: skipped (could not fetch diff)`); skipped++; continue; }
      writeFileSync(diffPath, diff);
    }
    if (readFileSync(diffPath, "utf8").length > maxDiffChars) {
      console.log(`#${pr.number}: skipped (diff larger than --max-diff-chars ${maxDiffChars})`); skipped++; continue;
    }
    if (!existsSync(join(dir, "human-comments.json"))) {
      writeJson(join(dir, "human-comments.json"), fetchHumanComments(repo, pr, Boolean(opts["count-author-comments"])));
    }
    for (let run = 1; run <= runs; run++) {
      const runDir = join(dir, `run-${run}`);
      if (existsSync(join(runDir, "findings.json")) && !opts.force) { console.log(`#${pr.number} run ${run}: cached`); continue; }
      mkdirSync(runDir, { recursive: true });
      console.log(`#${pr.number} run ${run}/${runs}: reviewing...`);
      const result = spawnSync(process.execPath, [...process.execArgv, engine, "--diff", diffPath, "--out-dir", runDir,
        "--title", pr.title, "--body", pr.body ?? "", "--pr", String(pr.number), "--repo", repo,
        "--head", pr.headRefName, "--base", pr.baseRefName, "--no-fix-brief"],
      { encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
      if (result.status !== 0 || !existsSync(join(runDir, "findings.json"))) {
        failed++;
        writeFileSync(join(runDir, "error.txt"), `${result.stderr ?? ""}\n${result.stdout ?? ""}`.slice(-4000));
        console.log(`  failed (exit ${result.status}); see ${join(runDir, "error.txt")}`);
      } else done++;
    }
  }
  console.log(`\nDone: ${done} run(s) completed, ${failed} failed, ${skipped} PR(s) skipped. Output: ${out}`);
  console.log("Next: node scripts/calibrate.ts label --repo " + repo);
}

// ------------------------------------------------------------------ rows / label
const keyOf = (pr: number, file: string, line: number, title: string) =>
  createHash("sha1").update(`${pr}|${file}|${line}|${title}`).digest("hex").slice(0, 12);

function prDirs(out: string): number[] {
  const root = join(out, "prs");
  if (!existsSync(root)) fail(`nothing collected yet in ${root}; run 'collect' first`);
  return readdirSync(root).filter((name) => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b);
}

/** Recompute confidence from a stored breakdown with the current SCORING constants (null if not possible). */
export function rescore(b: NonNullable<FindingRecord["confidenceBreakdown"]>): number | null {
  if (!b.level || !b.anchor || !b.evidence) return null;
  const parts = [
    SCORING.base[b.level as keyof typeof SCORING.base],
    SCORING.anchor[b.anchor as keyof typeof SCORING.anchor],
    SCORING.evidence[b.evidence as keyof typeof SCORING.evidence],
    b.agreement && b.agreement !== "n/a" ? SCORING.agreement[b.agreement as keyof typeof SCORING.agreement] : 0,
  ];
  if (parts.some((p) => typeof p !== "number")) return null;
  return Math.round(Math.min(1, Math.max(0, parts.reduce((sum, p) => sum + p, 0))) * 100) / 100;
}

function loadRows(out: string, rescoreOn = false): Row[] {
  const rows: Row[] = [];
  for (const number of prDirs(out)) {
    const dir = join(out, "prs", String(number));
    const file = readJson<FindingsFile>(join(dir, "run-1", "findings.json"));
    if (!file) continue;
    const pr = readJson<PrInfo>(join(dir, "pr.json"));
    const comments = readJson<HumanComment[]>(join(dir, "human-comments.json")) ?? [];
    for (const s of file.findings) {
      const b = s.confidenceBreakdown ?? {};
      rows.push({
        key: keyOf(number, s.file, s.line, s.title), pr: number, prUrl: pr?.url ?? "", file: s.file, line: s.line,
        severity: s.severity, category: s.category, level: s.level ?? "",
        confidence: rescoreOn ? (rescore({ ...b, level: b.level ?? s.level }) ?? s.confidence) : s.confidence,
        anchored: s.anchored ?? false, inline: s.inline ?? false, evidence: b.evidence ?? "n/a", anchor: b.anchor ?? "n/a",
        humanCommented: comments.some((c) => c.path === s.file && c.line !== null && Math.abs(c.line - s.line) <= 5),
        title: s.title, description: s.description.replace(/\s+/g, " ").slice(0, 400), label: "", notes: "",
      });
    }
  }
  return rows;
}

function loadLabels(path: string): Map<string, { label: Label; notes: string }> {
  const labels = new Map<string, { label: Label; notes: string }>();
  if (!existsSync(path)) return labels;
  const [header, ...body] = parseCsv(readFileSync(path, "utf8"));
  if (!header) return labels;
  const col = (name: string) => header.indexOf(name);
  for (const cells of body) {
    const raw = (cells[col("label")] ?? "").trim().toLowerCase();
    const label: Label = raw === "tp" || raw === "fp" || raw === "unsure" ? raw : "";
    labels.set(cells[col("key")] ?? "", { label, notes: cells[col("notes")] ?? "" });
  }
  return labels;
}

function label(opts: Options): void {
  const repo = repoOpt(opts);
  const out = outDir(opts, repo);
  const csvPath = join(out, "labels.csv");
  const rows = loadRows(out);
  if (!rows.length) fail("no findings found; run 'collect' first (and check the run-1/error.txt files)");
  const existing = loadLabels(csvPath);
  if (existsSync(csvPath)) copyFileSync(csvPath, `${csvPath}.bak`);
  rows.sort((a, b) => a.pr - b.pr || a.file.localeCompare(b.file) || a.line - b.line);
  const lines = [CSV_COLUMNS.join(",")];
  let carried = 0;
  for (const row of rows) {
    const previous = existing.get(row.key);
    if (previous?.label) carried++;
    const cells = [row.key, row.pr, row.prUrl, row.file, row.line, row.severity, row.category, row.level, row.confidence,
      row.anchored, row.inline, row.evidence, row.anchor, row.humanCommented, row.title, row.description,
      previous?.label ?? "", previous?.notes ?? ""];
    lines.push(cells.map(csvEscape).join(","));
  }
  writeFileSync(csvPath, lines.join("\n") + "\n");
  const currentKeys = new Set(rows.map((r) => r.key));
  const orphaned = [...existing].filter(([key, v]) => v.label && !currentKeys.has(key)).length;
  console.log(`Wrote ${csvPath}: ${rows.length} finding(s), ${carried} existing label(s) kept, ${rows.length - carried} to label.`);
  if (orphaned) console.log(`Warning: ${orphaned} earlier label(s) no longer match any finding (the previous file is saved as labels.csv.bak).`);
  console.log("Open it in a spreadsheet and fill the 'label' column with: tp (real issue), fp (wrong or not worth flagging), or unsure.");
  console.log("Then run: node scripts/calibrate.ts report --repo " + repo);
}

// ------------------------------------------------------------------ report
type Group = { n: number; tp: number; fp: number; unsure: number; unlabeled: number; human: number };
function tally(rows: Row[]): Group {
  const g: Group = { n: rows.length, tp: 0, fp: 0, unsure: 0, unlabeled: 0, human: 0 };
  for (const r of rows) {
    if (r.label === "tp") g.tp++; else if (r.label === "fp") g.fp++; else if (r.label === "unsure") g.unsure++; else g.unlabeled++;
    if (r.humanCommented) g.human++;
  }
  return g;
}
function groupTable(title: string, rows: Row[], keyFn: (r: Row) => string, order?: string[]): string {
  const groups = new Map<string, Row[]>();
  for (const r of rows) { const k = keyFn(r); groups.set(k, [...(groups.get(k) ?? []), r]); }
  const keys = [...groups.keys()].sort((a, b) => order ? order.indexOf(a) - order.indexOf(b) : a.localeCompare(b));
  const lines = [`### ${title}`, "", "| group | findings | labeled | tp | fp | precision | 95% low | human-commented |", "|---|---:|---:|---:|---:|---:|---:|---:|"];
  for (const k of keys) {
    const g = tally(groups.get(k)!);
    const labeled = g.tp + g.fp;
    lines.push(`| ${k} | ${g.n} | ${labeled} | ${g.tp} | ${g.fp} | ${labeled ? pct(g.tp / labeled) : "-"} | ${labeled ? pct(wilsonLower(g.tp, labeled)) : "-"} | ${g.n ? pct(g.human / g.n) : "-"} |`);
  }
  return lines.join("\n");
}
const bucket = (c: number) => c >= 1 ? "0.9-1.0" : `${(Math.floor(c * 10) / 10).toFixed(1)}-${(Math.floor(c * 10) / 10 + 0.09).toFixed(2)}`;
const same = (a: { file: string; category: string; line: number }, b: { file: string; category: string; line: number }) =>
  a.file === b.file && a.category === b.category && Math.abs(a.line - b.line) <= 3;

function stability(out: string): string | null {
  let pairs = 0, matched = 0, union = 0, diffSum = 0, diffCount = 0, prCount = 0;
  for (const number of prDirs(out)) {
    const dir = join(out, "prs", String(number));
    const runs = readdirSync(dir).filter((n) => /^run-\d+$/.test(n)).sort()
      .map((n) => readJson<FindingsFile>(join(dir, n, "findings.json"))).filter((f): f is FindingsFile => !!f);
    if (runs.length < 2) continue;
    prCount++;
    for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
      pairs++;
      const a = runs[i].findings, b = runs[j].findings;
      const used = new Set<number>();
      let m = 0;
      for (const sa of a) {
        const idx = b.findIndex((sb, k) => !used.has(k) && same(sa, sb));
        if (idx >= 0) { used.add(idx); m++; diffSum += Math.abs(sa.confidence - b[idx].confidence); diffCount++; }
      }
      matched += m; union += a.length + b.length - m;
    }
  }
  if (!pairs) return null;
  return [`### Stability across runs (${prCount} PR(s), ${pairs} run pair(s))`, "",
    `- finding overlap (Jaccard): **${union ? pct(matched / union) : "n/a"}**`,
    `- mean confidence difference for matched findings: **${diffCount ? (diffSum / diffCount).toFixed(3) : "n/a"}**`,
    "- Higher overlap and a smaller difference mean more deterministic output. Compare before/after changing the prompt, temperature or scoring."].join("\n");
}

function report(opts: Options): void {
  const repo = repoOpt(opts);
  const out = outDir(opts, repo);
  const target = numOpt(opts, "target-precision", 0.8);
  const minSamples = numOpt(opts, "min-samples", 5);
  const rows = loadRows(out, Boolean(opts.rescore));
  if (!rows.length) fail("no findings found; run 'collect' first");
  const labels = loadLabels(join(out, "labels.csv"));
  for (const r of rows) { const l = labels.get(r.key); if (l) { r.label = l.label; r.notes = l.notes; } }

  const prs = new Set(rows.map((r) => r.pr));
  const overall = tally(rows);
  const labeled = overall.tp + overall.fp;
  const md: string[] = [`# FixBrief AI calibration report: ${repo}`, "",
    ...(opts.rescore ? ["_Confidence values were recomputed with the current SCORING constants (`--rescore`)._", ""] : []),
    `- PRs analysed: **${prs.size}**; findings: **${rows.length}** (${(rows.length / prs.size).toFixed(1)} per PR)`,
    `- labels: tp ${overall.tp}, fp ${overall.fp}, unsure ${overall.unsure}, unlabeled ${overall.unlabeled}`,
    labeled ? `- overall precision: **${pct(overall.tp / labeled)}** (95% lower bound ${pct(wilsonLower(overall.tp, labeled))}, n=${labeled})` : "- overall precision: no tp/fp labels yet", ""];

  md.push("## Threshold sweep", "", `Target precision ${pct(target)}, at least ${minSamples} labeled findings. "per PR" counts all findings at or above the threshold, labeled or not.`, "",
    "| min confidence | findings/PR | labeled | tp | precision | 95% low | tp kept |", "|---:|---:|---:|---:|---:|---:|---:|");
  const totalTp = overall.tp;
  let recommended: number | null = null;
  for (let t = 0.3; t <= 0.951; t += 0.05) {
    const th = Math.round(t * 100) / 100;
    const kept = rows.filter((r) => r.confidence >= th);
    const g = tally(kept), lab = g.tp + g.fp;
    const precision = lab ? g.tp / lab : null;
    if (recommended === null && precision !== null && lab >= minSamples && precision >= target) recommended = th;
    md.push(`| ${th.toFixed(2)} | ${(kept.length / prs.size).toFixed(1)} | ${lab} | ${g.tp} | ${precision === null ? "-" : pct(precision)} | ${lab ? pct(wilsonLower(g.tp, lab)) : "-"} | ${totalTp ? pct(g.tp / totalTp) : "-"} |`);
  }
  md.push("", recommended !== null
    ? `**Recommended MINIMUM_CONFIDENCE: ${recommended.toFixed(2)}** (lowest threshold meeting the target with enough labels).`
    : labeled ? "**No threshold reaches the target precision with enough labeled samples.** Label more findings, lower the target, or improve the prompt/scoring."
      : "**No recommendation yet:** label findings first (`label` command). Until then, use the human-commented column as a rough proxy.", "");

  md.push("## Breakdowns", "",
    groupTable("By confidence bucket", rows, (r) => bucket(r.confidence)), "",
    groupTable("By model level", rows, (r) => r.level || "n/a", ["high", "medium", "low", "n/a"]), "",
    groupTable("By evidence check", rows, (r) => r.evidence, ["found", "partial", "not_found", "missing", "n/a"]), "",
    groupTable("By anchor", rows, (r) => r.anchor, ["added", "context", "none", "n/a"]), "",
    groupTable("By severity", rows, (r) => r.severity, ["critical", "high", "medium", "low", "info"]), "",
    groupTable("By category", rows, (r) => r.category), "");
  md.push("> `human-commented` is the share of findings within 5 lines of a human review comment on the same file. It is a weak proxy (reviewers miss things and comment on style), useful mainly when few labels exist.", "");
  const stable = stability(out);
  if (stable) md.push(stable, "");
  else md.push("_Stability: run `collect --runs 2` (or more) to measure how repeatable the results are._", "");

  const text = md.join("\n");
  writeFileSync(join(out, "report.md"), text);
  console.log(text);
  console.log(`\nSaved ${join(out, "report.md")}`);
}

// ------------------------------------------------------------------ main
function main(): void {
  loadDotEnv(join(process.cwd(), ".env"));
  loadDotEnv(join(HERE, "..", ".env"));
  const { command, opts } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || command === "-h" || opts.help) {
    console.log("Usage: node scripts/calibrate.ts <collect|label|report> --repo OWNER/NAME [options]\nSee the header of this file for details.");
    return;
  }
  if (command === "collect") collect(opts);
  else if (command === "label") label(opts);
  else if (command === "report") report(opts);
  else fail(`unknown command: ${command}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) { console.error(`error: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
