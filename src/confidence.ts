import { LEVEL_BASE } from "./findings.ts";
import type { ConfidenceBreakdown, EvidenceStatus, Finding } from "./findings.ts";
import { resolvePath } from "./difflines.ts";
import type { FileLines, LineMap } from "./difflines.ts";

/** Every constant that influences confidence lives here. Tune these using the calibration report. */
export const SCORING = {
  base: LEVEL_BASE,
  anchor: { added: 0.10, context: 0.05, none: -0.15 },
  evidence: { found: 0.10, partial: 0.0, not_found: -0.25, missing: -0.10 },
  agreement: { all: 0.10, partial: 0.0, single: -0.10 },
} as const;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
/** The prompt shows lines as "   42 +code"; models sometimes copy that prefix into `evidence`. */
const stripAnnotation = (line: string) => line.replace(/^\s*\d+\s[+ ]/, "");
const stripMarker = (line: string) => line.replace(/^[+-]\s?/, "");

/** Deterministically check that the quoted evidence really appears at (or within 2 lines of) the cited lines. */
export function verifyEvidence(finding: Finding, lines: FileLines | undefined): EvidenceStatus {
  const raw = finding.evidence?.trim();
  if (!raw) return "missing";
  if (!lines) return "not_found";
  const window: string[] = [];
  for (let n = finding.line - 2; n <= (finding.endLine ?? finding.line) + 2; n++) {
    const text = lines.text.get(n);
    if (text !== undefined) window.push(normalize(text));
  }
  const wanted = raw.split("\n").map((line) => normalize(stripAnnotation(line))).filter((line) => line.length >= 3);
  if (!wanted.length) return "missing";
  const joined = window.join(" ");
  if (joined.includes(normalize(wanted.join(" ")))) return "found";
  const hit = (needle: string) => window.some((line) => line.includes(needle) || line.includes(stripMarker(needle)));
  const hits = wanted.filter(hit).length;
  return hits === wanted.length ? "found" : hits > 0 ? "partial" : "not_found";
}

export interface Agreement { found: number; runs: number }

/** Compute the final confidence from the model's level plus facts the code can check. Pure and deterministic. */
export function scoreFinding(finding: Finding, map: LineMap, agreement?: Agreement): Finding {
  const path = resolvePath(map, finding.file);
  const lines = path ? map.get(path) : undefined;
  const level = finding.level ?? "low";
  const base = SCORING.base[level];
  const anchor = lines?.added.has(finding.line) ? "added" : lines?.context.has(finding.line) ? "context" : "none";
  const evidence = verifyEvidence(finding, lines);
  let agree: ConfidenceBreakdown["agreement"] = "n/a";
  if (agreement && agreement.runs > 1) {
    agree = agreement.found >= agreement.runs ? "all" : agreement.found === 1 ? "single" : "partial";
  }
  const anchorDelta = SCORING.anchor[anchor];
  const evidenceDelta = SCORING.evidence[evidence];
  const agreementDelta = agree === "n/a" ? 0 : SCORING.agreement[agree];
  const raw = base + anchorDelta + evidenceDelta + agreementDelta;
  const confidence = Math.round(Math.min(1, Math.max(0, raw)) * 100) / 100;
  return {
    ...finding, level, confidence,
    confidenceBreakdown: { level, base, anchor, anchorDelta, evidence, evidenceDelta, agreement: agree, agreementDelta },
  };
}

const LEVEL_RANK = { high: 3, medium: 2, low: 1 } as const;

/**
 * Group findings from several independent runs. Two findings match when they
 * share file and category and their lines are within `tolerance`. Each run counts at most once.
 */
export function clusterRuns(runs: Finding[][], tolerance = 3): { finding: Finding; found: number }[] {
  const clusters: { finding: Finding; seen: Set<number> }[] = [];
  runs.forEach((findings, runIndex) => {
    for (const finding of findings) {
      const match = clusters.find((c) => !c.seen.has(runIndex) && c.finding.file === finding.file
        && c.finding.category === finding.category && Math.abs(c.finding.line - finding.line) <= tolerance);
      if (match) {
        match.seen.add(runIndex);
        if (LEVEL_RANK[finding.level ?? "low"] > LEVEL_RANK[match.finding.level ?? "low"]) match.finding = finding;
      } else {
        clusters.push({ finding, seen: new Set([runIndex]) });
      }
    }
  });
  return clusters.map((c) => ({ finding: c.finding, found: c.seen.size }));
}
