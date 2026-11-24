import { test } from "node:test";
import assert from "node:assert/strict";
import { parseThreadPage } from "../src/github-threads.ts";

test("parseThreadPage keeps a null current line and the original line", () => {
  const parsed = parseThreadPage({
    data: {
      viewer: { login: "github-actions" },
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{
              isResolved: false,
              comments: { nodes: [{ databaseId: 1, body: "x", path: "a.py", line: null, originalLine: 10, author: { login: "github-actions" } }] },
            }],
          },
        },
      },
    },
  });
  assert.equal(parsed.threads[0].line, null);
  assert.equal(parsed.threads[0].originalLine, 10);
  assert.equal(parsed.actor, "github-actions");
});
