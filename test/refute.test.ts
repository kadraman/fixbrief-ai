import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "../src/findings.ts";
import type { ContextOptions } from "../src/context.ts";
import {
  applyRefuteVerdicts, isDropped, parseRefuteVerdicts, refuteContextForFinding, refuteEnabled,
  refuteFindings, refutePrompt,
} from "../src/refute.ts";

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "RB1", category: "quality", severity: "high", confidence: 0.95, file: "styles.css", line: 4,
  title: "Pseudo-element overlay may block pointer events",
  description: "The ::before overlay intercepts clicks.",
  recommendation: "Add pointer-events: none.",
  evidence: "content: '';",
  ...over,
});

const options = (root: string, grep: ContextOptions["grep"]): ContextOptions => ({
  root, maxChars: 12000, callersPerSymbol: 3, maxSymbols: 12, docChars: 3000,
  maxDefinitions: 6, definitionLines: 80, grep,
});

test("refuteEnabled treats false, 0, no, and off as disabled", () => {
  for (const off of ["false", "0", "no", "off", " FALSE "]) assert.equal(refuteEnabled(off), false);
  for (const on of ["true", "1", "yes", ""]) assert.equal(refuteEnabled(on), true);
});

test("an explicit drop removes only that finding; a reasonless drop and invalid JSON do not", async () => {
  const css = finding();
  const real = finding({ id: "RB2", file: "a.py", line: 3, title: "command injection", description: "shells out", evidence: "os.system(cmd)" });
  const judged = await refuteFindings([css, real], async () => JSON.stringify({
    verdicts: [
      { id: "RB1", keep: false, reason: "hits on ::before go to the button" },
      { id: "RB2", keep: false },
    ],
  }), () => "slice");
  assert.equal(judged.status, "ok");
  assert.equal(judged.dropped, 1);
  assert.equal(isDropped(judged.findings[0]), true);
  assert.equal(judged.findings[0].refute?.reason, "hits on ::before go to the button");
  assert.equal(judged.findings[1].refute, undefined);
  assert.equal(isDropped(judged.findings[1]), false);

  const invalid = await refuteFindings([css], async () => "not json", () => "");
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.dropped, 0);
  assert.equal(invalid.findings[0].refute, undefined);

  const errored = await refuteFindings([css], async () => { throw new Error("down"); }, () => "");
  assert.equal(errored.status, "error");
  assert.match(errored.error ?? "", /down/);
  assert.equal(isDropped(errored.findings[0]), false);
});

test("parseRefuteVerdicts accepts fences and ignores malformed rows", () => {
  const verdicts = parseRefuteVerdicts('```json\n{"verdicts":[{"id":"RB1","keep":"false","reason":"shown"},{"id":""},{"keep":true}]}\n```');
  assert.deepEqual(verdicts, [{ id: "RB1", keep: false, reason: "shown" }]);
  assert.equal(parseRefuteVerdicts('{"findings":[]}'), null);
  const kept = applyRefuteVerdicts([finding({ id: "RB9" })], [{ id: "RB1", keep: false, reason: "nope" }]);
  assert.equal(kept[0].refute, undefined);
});

test("refute context includes a file window and a callee body that the window does not contain", () => {
  const dir = mkdtempSync(join(tmpdir(), "refute-ctx-"));
  const lines = [
    "export class PatternGrid {",
    "  private _onWindowResize = () => {",
    "    this._applyScale();",
    "  };",
    ...Array.from({ length: 80 }, () => "  // padding"),
    "  private _applyScale(): void {",
    "    content.style.width = '1px';",
    "    this._invalidateGlobalCursorLayout();",
    "    this._syncRangeDom();",
    "  }",
    "}",
  ];
  const defLine = lines.findIndex((line) => line.includes("private _applyScale")) + 1;
  try {
    writeFileSync(join(dir, "pattern-grid.ts"), lines.join("\n"));
    writeFileSync(join(dir, "styles.css"), [
      ".bb-pgrid__btn.bb-pgrid__btn--zoom[title]::before {",
      "  content: '';",
      "  position: absolute;",
      "  inset: 0;",
      "}",
      ".bb-pgrid__btn.bb-pgrid__btn--zoom[title]:hover::after {",
      "  content: attr(title);",
      "  pointer-events: none;",
      "}",
    ].join("\n"));
    const grep = (symbol: string) => symbol === "_applyScale"
      ? [`pattern-grid.ts:3:    this._applyScale();`, `pattern-grid.ts:${defLine}:  private _applyScale(): void {`]
      : [];
    const resize = finding({
      id: "RB3", file: "pattern-grid.ts", line: 3, title: "resize handler dropped invalidation",
      description: "The handler now only calls this._applyScale().", evidence: "this._applyScale();",
    });
    const context = refuteContextForFinding(resize, options(dir, grep), 5);
    assert.match(context, /File slice around pattern-grid\.ts:3/);
    assert.match(context, /this\._applyScale\(\)/);
    assert.doesNotMatch(context.split("### Definitions")[0], /_invalidateGlobalCursorLayout/);
    assert.match(context, /_invalidateGlobalCursorLayout/);
    const prompt = refutePrompt([resize], () => context);
    assert.match(prompt, /## RB3/);
    assert.match(prompt, /_invalidateGlobalCursorLayout/);

    const css = refuteContextForFinding(finding({ file: "styles.css", line: 2 }), options(dir, () => []), 8);
    assert.match(css, /pointer-events: none/);
    assert.match(css, /::before/);
    assert.match(css, /::after/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
