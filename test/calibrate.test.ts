import { test } from "node:test";
import assert from "node:assert/strict";
import { csvEscape, parseCsv, parseJsonStream, wilsonLower } from "../scripts/calibrate.ts";

test("parseJsonStream splits back-to-back pages and ignores brackets inside strings", () => {
  const pages = parseJsonStream('[{"b":"x ] [ } {"}]\n[{"b":2}]  [] {"o":1}');
  assert.deepEqual(pages, [[{ b: "x ] [ } {" }], [{ b: 2 }], [], { o: 1 }]);
  assert.deepEqual(parseJsonStream('[{"q":"say \\"hi\\" ]"}]'), [[{ q: 'say "hi" ]' }]]);
});

test("csv escape/parse round-trips commas, quotes and newlines", () => {
  const cells = ["plain", 'a,b', 'say "hi"', "line1\nline2", "", "tail"];
  const parsed = parseCsv(cells.map(csvEscape).join(",") + "\r\n" + "x,y\n");
  assert.deepEqual(parsed[0], cells);
  assert.deepEqual(parsed[1], ["x", "y"]);
});

test("wilsonLower is conservative for small samples", () => {
  assert.equal(wilsonLower(0, 0), 0);
  assert.ok(wilsonLower(3, 3) < 0.5 && wilsonLower(3, 3) > 0.4);
  assert.ok(wilsonLower(90, 100) > 0.8 && wilsonLower(90, 100) < 0.9);
});

import { rescore } from "../scripts/calibrate.ts";
import { SCORING } from "../src/confidence.ts";
test("rescore reproduces the engine's score from a stored breakdown", () => {
  assert.equal(rescore({ level: "high", anchor: "added", evidence: "found", agreement: "n/a" }), 0.95);
  assert.equal(rescore({ level: "medium", anchor: "added", evidence: "found", agreement: "all" }), 0.85);
  assert.equal(rescore({ level: "high", anchor: "none", evidence: "not_found", agreement: "n/a" }), 0.35);
  assert.equal(rescore({ level: "bogus", anchor: "added", evidence: "found" }), null);
  assert.equal(rescore({ anchor: "added", evidence: "found" }), null);
  assert.equal(SCORING.base.high, 0.75);
});
