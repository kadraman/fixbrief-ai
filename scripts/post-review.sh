#!/usr/bin/env bash
# Post the review payload in OUT as review threads, file comments, and at most one checklist comment.
# Usage: scripts/post-review.sh OUT_DIR ROOT
# Env: REPO, PR_NUMBER, HEAD_SHA, GH_TOKEN, and optional PR_ACTION (opened|synchronize|reopened).
# Writes OUT/post-result.env (posted, pending, review_id), posted-comments.json, and
# checklist-comment.json when the brief should update that comment.

set -euo pipefail

OUT="${1:?output directory}"
ROOT="${2:?repository root}"
PR_ACTION="${PR_ACTION:-opened}"
HEAD_SHA="${HEAD_SHA:-}"
: "${REPO:?REPO is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"

NODE=(node --experimental-strip-types)
POSTED=false
PENDING=false
REVIEW_ID=""
FALLBACK=false

echo "[]" > "$OUT/posted-comments.json"
echo "[]" > "$OUT/file-comment-failures.json"
rm -f "$OUT/checklist-comment.json"

if ! "${NODE[@]}" "$ROOT/src/github-threads.ts" --repo "$REPO" --pr "$PR_NUMBER" --out "$OUT/existing-review.json"; then
  echo "::warning::Could not read existing review threads; posting without dedupe."
  printf '%s\n' '{"threads":[],"checklist":null}' > "$OUT/existing-review.json"
fi

"${NODE[@]}" "$ROOT/src/post-plan.ts" plan \
  --payload "$OUT/review-payload.json" \
  --existing "$OUT/existing-review.json" \
  --out-dir "$OUT" \
  --head "$HEAD_SHA" \
  --repo "$REPO" \
  --pr "$PR_NUMBER" \
  --pending true

plan_get() {
  node -e 'const plan=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const value=plan[process.argv[2]]; process.stdout.write(value===undefined||value===null?"":String(value))' "$OUT/post-plan.json" "$1"
}
QUIET="$(plan_get quietReview)"
LINE_COUNT="$(plan_get lineCount)"
FILE_COUNT="$(plan_get fileCount)"

save_review_comments() {
  local id="$1"
  if [ -z "$id" ]; then return; fi
  if RAW="$(gh api --paginate "repos/$REPO/pulls/$PR_NUMBER/reviews/$id/comments")"; then
    printf '%s' "$RAW" | node --input-type=module -e '
      import { readFileSync, writeFileSync } from "node:fs";
      const raw = readFileSync(0, "utf8").trim();
      let rows = [];
      try { rows = JSON.parse(raw || "[]"); } catch { rows = []; }
      if (!Array.isArray(rows)) rows = [];
      writeFileSync(process.argv[1], JSON.stringify(rows.map((comment) => ({
        id: comment.id, body: comment.body || "", path: comment.path, line: comment.line ?? null,
      })), null, 2));
    ' "$OUT/review-comments.json"
  fi
}

append_json() {
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const file = process.argv[1];
    const row = JSON.parse(process.argv[2]);
    const rows = JSON.parse(readFileSync(file, "utf8"));
    rows.push(row);
    writeFileSync(file, JSON.stringify(rows, null, 2));
  ' "$1" "$2"
}

post_file_comments() {
  local count
  count="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length))' "$OUT/file-comment-jobs.json")"
  local i=0
  while [ "$i" -lt "$count" ]; do
    node --input-type=module -e '
      import { readFileSync, writeFileSync } from "node:fs";
      const jobs = JSON.parse(readFileSync(process.argv[1], "utf8"));
      const job = jobs[Number(process.argv[2])];
      writeFileSync(process.argv[3], JSON.stringify(job.request));
      writeFileSync(process.argv[4], JSON.stringify(job.fallback));
    ' "$OUT/file-comment-jobs.json" "$i" "$OUT/one-request.json" "$OUT/one-fallback.json"
    if RESP="$(gh api --method POST "repos/$REPO/pulls/$PR_NUMBER/comments" --input "$OUT/one-request.json")"; then
      printf '%s' "$RESP" > "$OUT/one-response.json"
      node --input-type=module -e '
        import { readFileSync, writeFileSync } from "node:fs";
        const response = JSON.parse(readFileSync(process.argv[1], "utf8"));
        const rows = JSON.parse(readFileSync(process.argv[2], "utf8"));
        rows.push({ id: response.id, body: response.body || "", path: response.path, line: response.line ?? null });
        writeFileSync(process.argv[2], JSON.stringify(rows, null, 2));
      ' "$OUT/one-response.json" "$OUT/file-posted.json"
    else
      echo "::warning::File comment was rejected; it will be added to the checklist."
      FALLBACK_JSON="$(node -e 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))' "$OUT/one-fallback.json")"
      append_json "$OUT/file-comment-failures.json" "$FALLBACK_JSON"
    fi
    i=$((i + 1))
  done
}

write_checklist_file() {
  local id="$1"
  local body_file="$2"
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const body = readFileSync(process.argv[2], "utf8");
    const id = Number(process.argv[1]);
    writeFileSync(process.argv[3], JSON.stringify({ id: Number.isFinite(id) && id > 0 ? id : undefined, body }, null, 2));
  ' "$id" "$body_file" "$OUT/checklist-comment.json"
}

if [ "$QUIET" = "true" ] && [ "$PR_ACTION" = "synchronize" ]; then
  echo "Nothing new to post on this push; leaving the earlier review in place."
else
  echo "[]" > "$OUT/file-posted.json"
  if REVIEW_JSON="$(gh api --method POST "repos/$REPO/pulls/$PR_NUMBER/reviews" --input "$OUT/review-create.json" 2>"$OUT/create-review.err")"; then
    REVIEW_ID="$(printf '%s' "$REVIEW_JSON" | node --input-type=module -e 'import { readFileSync } from "node:fs"; console.log(JSON.parse(readFileSync(0,"utf8")).id || "")')"
    POSTED=true
    PENDING=true
    echo "Created pending review ${REVIEW_ID} with ${LINE_COUNT} line comment(s) and ${FILE_COUNT} file comment(s) to add."
    if [ "$FILE_COUNT" != "0" ]; then
      post_file_comments
    fi
    if [ "$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length))' "$OUT/file-comment-failures.json")" != "0" ]; then
      "${NODE[@]}" "$ROOT/src/post-plan.ts" absorb \
        --out-dir "$OUT" \
        --failures "$OUT/file-comment-failures.json" \
        --existing "$OUT/existing-review.json" \
        --head "$HEAD_SHA" \
        --pending true
    fi
    save_review_comments "$REVIEW_ID"
  else
    detail=""
    if [ -s "$OUT/create-review.err" ]; then detail="$(tr '\n' ' ' < "$OUT/create-review.err")"; fi
    echo "::warning::create-review failed${detail:+: $detail}. Posting one issue comment instead of per-finding comments."
    "${NODE[@]}" "$ROOT/src/post-plan.ts" fallback --payload "$OUT/deduped-payload.json" --out "$OUT/comment.md"
    node --input-type=module -e '
      import { readFileSync, writeFileSync } from "node:fs";
      writeFileSync(process.argv[2], JSON.stringify({ body: readFileSync(process.argv[1], "utf8") }));
    ' "$OUT/comment.md" "$OUT/issue-comment.json"
    if RESP="$(gh api --method POST "repos/$REPO/issues/$PR_NUMBER/comments" --input "$OUT/issue-comment.json")"; then
      COMMENT_ID="$(printf '%s' "$RESP" | node --input-type=module -e 'import { readFileSync } from "node:fs"; console.log(JSON.parse(readFileSync(0,"utf8")).id || "")')"
      write_checklist_file "$COMMENT_ID" "$OUT/comment.md"
      FALLBACK=true
      echo "Posted one fallback issue comment ${COMMENT_ID}. The fix-brief link will be added after the artifact is uploaded."
    else
      FALLBACK=true
      echo "::warning::Could not post the fallback issue comment."
    fi
  fi
fi

if [ "$FALLBACK" != "true" ]; then
  CHECKLIST_ACTION="$(node -e 'const plan=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(plan.action || "skip")' "$OUT/checklist-plan.json")"
  INCLUDE="$(node -e 'const plan=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(plan.includeInBrief ? "true" : "false")' "$OUT/checklist-plan.json")"
  CHECKLIST_ID="$(node -e 'const plan=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(plan.commentId ? String(plan.commentId) : "")' "$OUT/checklist-plan.json")"
  node -e 'const fs=require("fs"); const plan=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); fs.writeFileSync(process.argv[2], plan.body || "")' "$OUT/checklist-plan.json" "$OUT/checklist-body.md"
  if [ "$CHECKLIST_ACTION" = "create" ]; then
    node --input-type=module -e '
      import { readFileSync, writeFileSync } from "node:fs";
      writeFileSync(process.argv[2], JSON.stringify({ body: readFileSync(process.argv[1], "utf8") }));
    ' "$OUT/checklist-body.md" "$OUT/issue-comment.json"
    if RESP="$(gh api --method POST "repos/$REPO/issues/$PR_NUMBER/comments" --input "$OUT/issue-comment.json")"; then
      CHECKLIST_ID="$(printf '%s' "$RESP" | node --input-type=module -e 'import { readFileSync } from "node:fs"; console.log(JSON.parse(readFileSync(0,"utf8")).id || "")')"
      write_checklist_file "$CHECKLIST_ID" "$OUT/checklist-body.md"
      echo "Posted checklist comment ${CHECKLIST_ID}."
    else
      echo "::warning::Could not post the checklist comment."
    fi
  elif [ "$CHECKLIST_ACTION" = "update" ] && [ -n "$CHECKLIST_ID" ]; then
    node --input-type=module -e '
      import { readFileSync, writeFileSync } from "node:fs";
      writeFileSync(process.argv[2], JSON.stringify({ body: readFileSync(process.argv[1], "utf8") }));
    ' "$OUT/checklist-body.md" "$OUT/issue-comment.json"
    if gh api --method PATCH "repos/$REPO/issues/comments/$CHECKLIST_ID" --input "$OUT/issue-comment.json" >/dev/null; then
      write_checklist_file "$CHECKLIST_ID" "$OUT/checklist-body.md"
      echo "Updated checklist comment ${CHECKLIST_ID}."
    else
      echo "::warning::Could not update the checklist comment."
    fi
  elif [ "$INCLUDE" = "true" ] && [ -n "$CHECKLIST_ID" ]; then
    write_checklist_file "$CHECKLIST_ID" "$OUT/checklist-body.md"
  fi
fi

node --input-type=module -e '
  import { readFileSync, writeFileSync, existsSync } from "node:fs";
  const read = (path) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  const rows = [...read(process.argv[1]), ...read(process.argv[2]), ...read(process.argv[3])];
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    if (!row || row.id === undefined || seen.has(row.id)) continue;
    seen.add(row.id);
    unique.push({ id: row.id, body: row.body || "", path: row.path, line: row.line ?? null });
  }
  writeFileSync(process.argv[4], JSON.stringify(unique, null, 2));
' "$OUT/review-comments.json" "$OUT/file-posted.json" "$OUT/reused-comments.json" "$OUT/posted-comments.json" || echo "[]" > "$OUT/posted-comments.json"

{
  echo "posted=$POSTED"
  echo "pending=$PENDING"
  echo "fallback=$FALLBACK"
  echo "review_id=$REVIEW_ID"
} > "$OUT/post-result.env"
echo "Post step finished (posted=$POSTED pending=$PENDING review=$REVIEW_ID)."
