import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiffLines } from "../src/difflines.ts";
import { clusterRuns, scoreFinding, verifyEvidence } from "../src/confidence.ts";

const DIFF = [
  "diff --git a/a.py b/a.py", "--- a/a.py", "+++ b/a.py",
  "@@ -1,4 +1,6 @@", " import os", "-old", "+def run(cmd):", "+    os.system(cmd)", "+    return True", " # end", " x = 1",
].join("\n");
const map = parseDiffLines(DIFF);
const sig = (o: any = {}) => ({ id: "S", category: "security", severity: "high", level: "high", confidence: 0.75, file: "a.py", line: 3,
  title: "t", description: "d", evidence: "os.system(cmd)", ...o });

test("verifyEvidence: found, annotation prefix, partial, not found, missing, outside window, trivial lines", () => {
  const lines = map.get("a.py");
  assert.equal(verifyEvidence(sig() as any, lines), "found");
  assert.equal(verifyEvidence(sig({ evidence: "    3 +    os.system(cmd)" }) as any, lines), "found");
  assert.equal(verifyEvidence(sig({ evidence: "def run(cmd):\nsubprocess.call(cmd)" }) as any, lines), "partial");
  assert.equal(verifyEvidence(sig({ evidence: "eval(user_input)" }) as any, lines), "not_found");
  assert.equal(verifyEvidence(sig({ evidence: undefined }) as any, lines), "missing");
  assert.equal(verifyEvidence(sig({ evidence: "}" }) as any, lines), "missing");
  assert.equal(verifyEvidence(sig({ line: 40, evidence: "os.system(cmd)" }) as any, lines), "not_found");
  assert.equal(verifyEvidence(sig({ evidence: "+    os.system(cmd)" }) as any, lines), "found");
});

test("scoreFinding is deterministic and follows the table", () => {
  const score = (o: any, a?: any) => scoreFinding(sig(o) as any, map, a).confidence;
  assert.equal(score({}), 0.95);
  assert.equal(score({ line: 5, evidence: "# end" }), 0.90);
  assert.equal(score({ evidence: undefined }), 0.75);
  assert.equal(score({ evidence: "nothing like this" }), 0.60);
  assert.equal(score({ file: "zzz.py" }), 0.35);
  assert.equal(score({ level: "low" }), 0.55);
  assert.equal(score({ level: "medium" }, { found: 2, runs: 2 }), 0.85);
  assert.equal(score({ level: "medium", line: 5, evidence: "# end" }, { found: 2, runs: 2 }), 0.80);
  assert.equal(score({}, { found: 3, runs: 3 }), 1);
  assert.equal(score({}, { found: 1, runs: 2 }), 0.85);
  assert.deepEqual(scoreFinding(sig() as any, map), scoreFinding(sig() as any, map));
  assert.equal(scoreFinding(sig() as any, map).confidenceBreakdown!.agreement, "n/a");
});

test("clusterRuns counts each run once and keeps distinct findings apart", () => {
  const a = sig({ line: 10 }), b = sig({ line: 12 }), other = sig({ category: "quality", line: 10 }), far = sig({ line: 50 });
  const r = clusterRuns([[a, far], [b, other]] as any);
  assert.deepEqual(r.map((c) => [c.finding.line, c.found]), [[10, 2], [50, 1], [10, 1]]);
  const twoInOneRun = clusterRuns([[sig({ line: 10 }), sig({ line: 11 })]] as any);
  assert.equal(twoInOneRun.length, 2);
  assert.deepEqual(clusterRuns([[a], [b]] as any), clusterRuns([[a], [b]] as any));
});
