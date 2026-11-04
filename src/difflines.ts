import type { Finding } from "./findings.ts";

export interface FileLines { added: Set<number>; context: Set<number>; text: Map<number, string> }
export type LineMap = Map<string, FileLines>;

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function cleanPath(raw: string): string {
  return raw.replace(/\t.*$/, "").trim().replace(/^"(.*)"$/, "$1").replace(/^b\//, "");
}

function splitDiffLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/** New-file (RIGHT side) line numbers that GitHub accepts review comments on. Run on the ORIGINAL diff. */
export function parseDiffLines(diff: string): LineMap {
  const map: LineMap = new Map();
  let current: FileLines | null = null;
  let inHunk = false;
  let newLine = 0;
  const lines = splitDiffLines(diff);
  lines.forEach((line, index) => {
    if (line.startsWith("diff --git ")) { current = null; inHunk = false; return; }
    if (!inHunk && line.startsWith("+++ ")) {
      const target = line.slice(4);
      if (target.trim() === "/dev/null") { current = null; return; }
      current = { added: new Set(), context: new Set(), text: new Map() };
      map.set(cleanPath(target), current);
      return;
    }
    const hunk = HUNK.exec(line);
    if (hunk) { inHunk = true; newLine = Number(hunk[1]); return; }
    if (!inHunk || !current) return;
    const marker = line[0];
    if (marker === "+") { current.added.add(newLine); current.text.set(newLine, line.slice(1)); newLine++; }
    else if (marker === " ") { current.context.add(newLine); current.text.set(newLine, line.slice(1)); newLine++; }
    else if (line === "" && index < lines.length - 1) { current.context.add(newLine); current.text.set(newLine, ""); newLine++; } // blank context line whose space was stripped
    // "-" (removed) and "\" ("No newline at end of file") consume no new-file line
  });
  return map;
}

/** Find the diff path a model-reported file name refers to (tolerates "./" and "a/" "b/" prefixes). */
export function resolvePath(map: LineMap, file: string): string | undefined {
  return [file, file.replace(/^\.\//, ""), file.replace(/^[ab]\//, "")].find((candidate) => map.has(candidate));
}

/** Prefix every added/context line with its new-file line number so the model never has to count. */
export function annotateDiff(fileDiff: string): string {
  let inHunk = false;
  let newLine = 0;
  const lines = splitDiffLines(fileDiff);
  return lines.map((line, index) => {
    if (line.startsWith("diff --git ")) { inHunk = false; return line; }
    const hunk = HUNK.exec(line);
    if (hunk) { inHunk = true; newLine = Number(hunk[1]); return line; }
    if (!inHunk) return line;
    const marker = line[0];
    if (marker === "+" || marker === " ") return `${String(newLine++).padStart(5)} ${marker}${line.slice(1)}`;
    if (line === "" && index < lines.length - 1) return `${String(newLine++).padStart(5)}  `;
    return `      ${line}`; // removed line or "\ No newline": no number
  }).join("\n");
}

/** Split findings into those GitHub can attach inline and those that must stay in the summary. */
export function anchorFindings(findings: Finding[], map: LineMap): { anchored: Finding[]; unanchored: Finding[] } {
  const anchored: Finding[] = [], unanchored: Finding[] = [];
  for (const finding of findings) {
    const path = resolvePath(map, finding.file);
    const lines = path ? map.get(path) : undefined;
    const commentable = (n: number) => !!lines && (lines.added.has(n) || lines.context.has(n));
    if (!path || !lines || !commentable(finding.line)) { unanchored.push(finding); continue; }
    let { endLine, suggestion } = finding;
    if (endLine !== undefined) {
      const maxKnown = Math.max(0, ...lines.added, ...lines.context);
      // Reject absurd / cross-file endLine before looping (untrusted model output).
      let valid = Number.isInteger(endLine) && endLine > finding.line && endLine <= maxKnown;
      for (let n = finding.line; valid && n <= (endLine as number); n++) valid = commentable(n);
      if (!valid) { endLine = undefined; suggestion = undefined; } // a range suggestion is unsafe on a single line
    }
    anchored.push({ ...finding, file: path, endLine, suggestion });
  }
  return { anchored, unanchored };
}
