import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotateDiff, parseDiffLines } from "../src/difflines.ts";
import {
  calledSymbols, changedSymbols, contextOptionsFromEnv, createContextBuilder, definitionSection, isDefinitionLine,
  readProjectGuidance, sliceDefinition, summarizeDiff, usageSection,
} from "../src/context.ts";
import type { ContextOptions } from "../src/context.ts";

const DIFF = [
  "diff --git a/src/api.ts b/src/api.ts", "index 111..222 100644", "--- a/src/api.ts", "+++ b/src/api.ts",
  "@@ -10,6 +10,9 @@ export class UserService {",
  " const keep = 1;",
  "-  old(a) {}",
  "+  async fetchUser(id: string, opts?: Options) {",
  "+    if (id) {",
  "+    return load(id);",
  "+  }",
  "+const buildQuery = (user: User) => user.id;",
  "+function run() {}",
  "+function renderProfile(user) {}",
  " tail",
  "diff --git a/src/new.ts b/src/new.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@", "+export const x = 1;", "+export const y = 2;",
  "diff --git a/old.ts b/old.ts", "deleted file mode 100644", "--- a/old.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-gone",
].join("\n");
const annotated = DIFF.split(/(?=^diff --git )/m).map(annotateDiff).join("\n");
const opts = (over: Partial<ContextOptions> = {}): ContextOptions => ({
  root: "/nonexistent", maxChars: 12000, callersPerSymbol: 3, maxSymbols: 12, docChars: 3000,
  maxDefinitions: 6, definitionLines: 80, ...over,
});

test("summarizeDiff counts lines and recognises new and deleted files", () => {
  const files = summarizeDiff(DIFF);
  assert.deepEqual(files.map((f) => [f.path, f.added, f.removed, f.status]), [
    ["src/api.ts", 7, 1, "modified"], ["src/new.ts", 2, 0, "new"], ["old.ts", 0, 1, "deleted"]]);
});

test("changedSymbols finds declarations on added lines and the enclosing function; ignores noise", () => {
  const symbols = changedSymbols(annotated, 12);
  assert.ok(symbols.includes("UserService"), "enclosing class from the hunk header");
  assert.ok(symbols.includes("fetchUser"), "method declaration");
  assert.ok(symbols.includes("buildQuery"), "arrow function");
  assert.ok(symbols.includes("renderProfile"), "function declaration");
  for (const noise of ["run", "if", "keep", "old", "load", "id"]) assert.ok(!symbols.includes(noise), `should not include ${noise}`);
  assert.equal(changedSymbols(annotated, 2).length, 2);
});

test("usageSection skips lines already visible in the diff, noise paths, and caps per symbol", () => {
  const visible = parseDiffLines(DIFF);
  const grep = () => ["src/api.ts:11: in the diff already", "node_modules/x/i.js:1: vendor", "src/a.ts:5:  const u = fetchUser(1);",
    "src/b.ts:9:  fetchUser(2)", "src/c.ts:3:  fetchUser(3)", "src/d.ts:3:  fetchUser(4)"];
  const { text, hits } = usageSection(["fetchUser"], visible, opts({ grep }), 5000);
  assert.equal(hits, 3);
  assert.match(text, /src\/a\.ts:5:/);
  assert.doesNotMatch(text, /node_modules|in the diff already|src\/d\.ts/);
  assert.equal(usageSection(["fetchUser"], visible, opts({ grep }), 40).text, "");   // over budget: dropped, not truncated mid-line
});

test("readProjectGuidance prefers AGENTS.md, truncates on a line boundary, and returns '' when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-doc-"));
  try {
    assert.equal(readProjectGuidance(dir, 500), "");
    writeFileSync(join(dir, "CONTRIBUTING.md"), "contrib rules");
    assert.match(readProjectGuidance(dir, 500), /CONTRIBUTING\.md/);
    writeFileSync(join(dir, "AGENTS.md"), Array.from({ length: 50 }, (_, i) => `rule ${i}: do the thing`).join("\n"));
    const doc = readProjectGuidance(dir, 200);
    assert.match(doc, /Project guidance \(AGENTS\.md\)/);
    assert.match(doc, /\[truncated\]$/);
    assert.ok(doc.length < 320);
    assert.equal(readProjectGuidance(dir, 0), "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("createContextBuilder: disabled at 0, bounded, memoised, and never throws", () => {
  const batch = [{ label: "src/api.ts", text: annotated }];
  assert.equal(createContextBuilder(DIFF, opts({ maxChars: 0 }))(batch), "");
  let calls = 0;
  const grep = () => { calls++; return ["src/a.ts:5:  fetchUser(1)"]; };
  const builder = createContextBuilder(DIFF, opts({ grep, maxChars: 900 }));
  const first = builder(batch);
  assert.match(first, /Files changed in this PR \(3\)/);
  assert.match(first, /src\/a\.ts:5/);
  assert.ok(first.length <= 900);
  const callsAfterFirst = calls;
  assert.equal(builder(batch), first);
  assert.equal(calls, callsAfterFirst, "second call is served from the cache");
  assert.equal(builder.stats.length, 1);
  assert.ok(builder.stats[0].symbols >= 3 && builder.stats[0].hits >= 1);
  const throwing = createContextBuilder(DIFF, opts({ grep: () => { throw new Error("boom"); } }));
  assert.equal(throwing(batch), "");
});

test("calledSymbols reads callees on added lines and skips declarations, keywords, and generic names", () => {
  const symbols = calledSymbols(annotated, 12);
  assert.deepEqual(symbols, ["load"]);
  const resize = [
    "@@ -1,3 +1,3 @@ private _onWindowResize",
    "    1   private _onWindowResize = () => {",
    "-    this._invalidateGlobalCursorLayout();",
    "    2 +    this._applyScale();",
    "    3   };",
    "    4 +  private _applyScale(): void {",
  ].join("\n");
  assert.deepEqual(calledSymbols(resize, 6), ["_applyScale"]);
});

test("sliceDefinition stops at the matching brace and caps the line count", () => {
  const source = [
    "function other() { return 1; }",
    "private _applyScale(): void {",
    "  content.style.width = '1px';",
    "  if (ready) { this._invalidateGlobalCursorLayout(); }",
    "  this._syncRangeDom();",
    "}",
    "function next() { return 2; }",
  ].join("\n");
  const body = sliceDefinition(source, 2, 80);
  assert.match(body, /_invalidateGlobalCursorLayout/);
  assert.match(body, /_syncRangeDom/);
  assert.doesNotMatch(body, /function next/);
  assert.equal(sliceDefinition(source, 2, 2).split("\n").length, 2);
});

test("definitionSection includes a callee body from the checkout and skips one already in the batch", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-def-"));
  const source = [
    "export class PatternGrid {",
    "  private _onWindowResize = () => {",
    "    this._applyScale();",
    "  };",
    "  private _applyScale(): void {",
    "    content.style.width = '1px';",
    "    this._invalidateGlobalCursorLayout();",
    "    this._syncRangeDom();",
    "  }",
    "}",
  ].join("\n");
  try {
    writeFileSync(join(dir, "pattern-grid.ts"), source);
    const batch = [
      "@@ -1,4 +1,4 @@ private _onWindowResize",
      "    2   private _onWindowResize = () => {",
      "-    this._invalidateGlobalCursorLayout();",
      "    3 +    this._applyScale();",
      "    4   };",
    ].join("\n");
    assert.equal(isDefinitionLine("_applyScale", "    this._applyScale();"), false);
    assert.equal(isDefinitionLine("_applyScale", "  private _applyScale(): void {"), true);
    const grep = (symbol: string) => symbol === "_applyScale"
      ? ["pattern-grid.ts:3:    this._applyScale();", "pattern-grid.ts:5:  private _applyScale(): void {", "other.ts:1:  function _applyScale() { return 1; }"]
      : [];
    const section = definitionSection(["_applyScale"], batch, ["pattern-grid.ts"], opts({ root: dir, grep }), 5000);
    assert.equal(section.count, 1);
    assert.match(section.text, /Definitions of functions called by the changed lines/);
    assert.match(section.text, /pattern-grid\.ts:5:/);
    assert.match(section.text, /_invalidateGlobalCursorLayout/);
    assert.doesNotMatch(section.text, /other\.ts/);
    const already = `${batch}\n    5 +  private _applyScale(): void {\n    6 +    this._invalidateGlobalCursorLayout();\n    7 +  }`;
    assert.equal(definitionSection(["_applyScale"], already, ["pattern-grid.ts"], opts({ root: dir, grep }), 5000).text, "");
    const builder = createContextBuilder("diff --git a/pattern-grid.ts b/pattern-grid.ts\n", opts({ root: dir, grep, maxChars: 8000 }));
    const text = builder([{ label: "pattern-grid.ts", text: batch }]);
    assert.match(text, /_invalidateGlobalCursorLayout/);
    assert.equal(builder.stats[0].definitions, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("contextOptionsFromEnv reads CONTEXT_* and rejects bad values", () => {
  const env = (values: Record<string, string>) => (name: string, fallback = "") => values[name] ?? fallback;
  const o = contextOptionsFromEnv(env({ CONTEXT_CHARS: "5000", CONTEXT_CALLERS: "2", CONTEXT_DEFINITIONS: "4", DEFINITION_LINES: "40" }), "/r");
  assert.deepEqual(
    [o.maxChars, o.callersPerSymbol, o.maxSymbols, o.docChars, o.maxDefinitions, o.definitionLines, o.root],
    [5000, 2, 12, 3000, 4, 40, "/r"],
  );
  assert.equal(contextOptionsFromEnv(env({ CONTEXT_CHARS: "0" }), "/r").maxChars, 0);
  assert.equal(contextOptionsFromEnv(env({}), "/r").maxDefinitions, 6);
  assert.throws(() => contextOptionsFromEnv(env({ CONTEXT_CHARS: "lots" }), "/r"), /CONTEXT_CHARS/);
  assert.throws(() => contextOptionsFromEnv(env({ CONTEXT_CALLERS: "-1" }), "/r"), /CONTEXT_CALLERS/);
  assert.throws(() => contextOptionsFromEnv(env({ DEFINITION_LINES: "-1" }), "/r"), /DEFINITION_LINES/);
});
