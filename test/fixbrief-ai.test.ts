import { test } from "node:test";
import assert from "node:assert/strict";
import { packBatches, splitBatchForRetry, splitDiff } from "../src/fixbrief-ai.ts";

test("splitDiff force-splits files above piece-chars even when under batch-chars", () => {
  const hunk = Array.from({ length: 80 }, (_, i) => `+line_${i}_xxxxxxxxxxxxxxxxxxxxxxxx`).join("\n");
  const file = ["diff --git a/big.ts b/big.ts", "--- a/big.ts", "+++ b/big.ts", "@@ -0,0 +1,80 @@", hunk].join("\n");
  const annotatedLen = file.length;
  assert.ok(annotatedLen > 2000);
  const underBatch = splitDiff(file, 100000, 1500);
  assert.ok(underBatch.pieces.length >= 2, `expected split, got ${underBatch.pieces.length}`);
  assert.ok(underBatch.pieces.every((p) => / \(part \d+\/\d+\)$/.test(p.label)));
  assert.ok(underBatch.pieces.every((p) => p.text.length <= 1500 + 200));
  const noSplit = splitDiff(file, 100000, 100000);
  assert.equal(noSplit.pieces.length, 1);
  assert.equal(noSplit.pieces[0].label, "big.ts");
});

test("packBatches keeps split file parts in solo batches; packs small files together", () => {
  const small = [
    { label: "a.ts", text: "a".repeat(100) },
    { label: "b.ts", text: "b".repeat(100) },
    { label: "big.ts (part 1/2)", text: "x".repeat(500) },
    { label: "big.ts (part 2/2)", text: "y".repeat(500) },
    { label: "c.ts", text: "c".repeat(100) },
  ];
  const batches = packBatches(small, 1000);
  assert.deepEqual(batches.map((b) => b.map((p) => p.label)), [
    ["a.ts", "b.ts"],
    ["big.ts (part 1/2)"],
    ["big.ts (part 2/2)"],
    ["c.ts"],
  ]);
});

test("splitBatchForRetry bisects multi-piece and large solo batches", () => {
  assert.deepEqual(
    splitBatchForRetry([{ label: "a", text: "1" }, { label: "b", text: "2" }])?.map((b) => b[0].label),
    ["a", "b"],
  );
  assert.equal(splitBatchForRetry([{ label: "tiny", text: "short" }]), null);
  const big = "@@ -0,0 +1,800 @@\n" + Array.from({ length: 800 }, (_, i) => `+row${i}_xxxxxxxx\n`).join("");
  assert.ok(big.length >= 4000);
  const parts = splitBatchForRetry([{ label: "big.ts", text: big }]);
  assert.ok(parts && parts.length >= 2);
  assert.ok(parts.every((b) => /big\.ts \(part \d+\/\d+\)$/.test(b[0].label)));
});
