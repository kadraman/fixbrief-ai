#!/usr/bin/env bash
#
# Run fixbrief-ai against an existing pull request from your own machine.
# Nothing is posted to GitHub unless you pass --post.
#
# Usage:
#   scripts/review-pr.sh <PR number | PR URL> [options]
#
# Options:
#   --repo OWNER/NAME     repository (not needed inside a clone, or with a PR URL)
#   --dry-run             show how the diff would be split; make no LLM calls
#   --post                post the review as a PR review; uploads fix-brief.md as a
#                         secret gist and links it from the review body when present
#   --out DIR             output directory (default: ./fixbrief-ai-out/pr-<N>)
#   --provider NAME       openai | anthropic   (overrides LLM_PROVIDER)
#   --model NAME          model name           (overrides LLM_MODEL)
#   --base-url URL        API root             (overrides LLM_BASE_URL)
#   -h, --help            show this help
#
# Configuration comes from environment variables or a .env file next to this
# repo's root (or in the current directory). See .env.example.
#
# Requires: gh (authenticated), Node.js 22+, and for non-dry runs LLM_API_KEY + LLM_MODEL.

set -euo pipefail

usage() { sed -n '3,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { echo "error: $*" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

PR="" REPO="" POST=0 DRY=0 OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)      REPO="${2:?--repo needs a value}"; shift 2 ;;
    --dry-run)   DRY=1; shift ;;
    --post)      POST=1; shift ;;
    --out)       OUT="${2:?--out needs a value}"; shift 2 ;;
    --provider)  export LLM_PROVIDER="${2:?--provider needs a value}"; shift 2 ;;
    --model)     export LLM_MODEL="${2:?--model needs a value}"; shift 2 ;;
    --base-url)  export LLM_BASE_URL="${2:?--base-url needs a value}"; shift 2 ;;
    -h|--help)   usage; exit 0 ;;
    -*)          die "unknown option: $1 (try --help)" ;;
    *)           [ -z "$PR" ] || die "unexpected argument: $1"; PR="$1"; shift ;;
  esac
done

[ -n "$PR" ] || { usage; exit 1; }

# Accept a full PR URL
if [[ "$PR" =~ github\.com/([^/]+/[^/]+)/pull/([0-9]+) ]]; then
  REPO="${BASH_REMATCH[1]}"
  PR="${BASH_REMATCH[2]}"
fi
[[ "$PR" =~ ^[0-9]+$ ]] || die "PR must be a number or a GitHub PR URL"

command -v gh >/dev/null 2>&1 || die "GitHub CLI (gh) not found: https://cli.github.com"
command -v node >/dev/null 2>&1 || die "Node.js 22+ not found"
NODE_VERSION="$(node -p 'process.versions.node.split(".").map(Number)[0] * 10000 + process.versions.node.split(".").map(Number)[1]')"
[ "$NODE_VERSION" -ge 220006 ] || die "Node.js 22.6+ is required for the TypeScript runtime"

# Load .env files without overriding variables that are already set
load_env() {
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    line="${line#export }"
    key="${line%%=*}"
    val="${line#*=}"
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [ -z "${!key:-}" ]; then export "$key=$val"; fi
  done < "$1"
}
load_env "$PWD/.env"
load_env "$ROOT/.env"

if [ "$DRY" -eq 0 ]; then
  [ -n "${LLM_API_KEY:-}" ] || die "LLM_API_KEY is not set (put it in .env or export it)"
  [ -n "${LLM_MODEL:-}" ]   || die "LLM_MODEL is not set (put it in .env, export it, or use --model)"
fi

# The ${arr[@]+...} idiom keeps empty arrays safe under 'set -u' on macOS bash 3.2
GH_REPO=()
[ -z "$REPO" ] || GH_REPO=(--repo "$REPO")

echo "Fetching PR #$PR ..."
META="$(gh pr view "$PR" ${GH_REPO[@]+"${GH_REPO[@]}"} --json number,title,body,headRefName,baseRefName,headRefOid,url)" \
  || die "could not read PR #$PR (check the number, --repo, and 'gh auth status')"

meta_get() { node -e 'const value=JSON.parse(process.argv[1])[process.argv[2]]; if (value) process.stdout.write(value)' "$META" "$1"; }
TITLE="$(meta_get title)"
BODY="$(meta_get body)"
HEAD="$(meta_get headRefName)"
HEAD_SHA="$(meta_get headRefOid)"
BASE="$(meta_get baseRefName)"
URL="$(meta_get url)"
[ -n "$REPO" ] || REPO="$(printf '%s' "$URL" | sed -E 's#https?://[^/]+/([^/]+/[^/]+)/pull/.*#\1#')"

OUT="${OUT:-$PWD/fixbrief-ai-out/pr-$PR}"
mkdir -p "$OUT"

echo "  $REPO #$PR: $TITLE"
echo "  $HEAD -> $BASE"

# Fetch the diff. 'gh pr diff' is limited by GitHub's API (about 300 files /
# 20k lines); fall back to a local git diff when you're inside a clone.
if ! gh pr diff "$PR" ${GH_REPO[@]+"${GH_REPO[@]}"} > "$OUT/pr.diff" 2> "$OUT/gh-diff.err"; then
  echo "  gh pr diff failed: $(head -c 200 "$OUT/gh-diff.err")"
  if git rev-parse --git-dir >/dev/null 2>&1; then
    echo "  falling back to a local git diff (needs 'origin' to be this repo) ..."
    git fetch --quiet origin "pull/$PR/head:refs/fixbrief-ai/pr-$PR" \
      || die "git fetch of the PR head failed"
    git fetch --quiet origin "$BASE" || die "git fetch of base branch '$BASE' failed"
    git diff --no-color "origin/$BASE...refs/fixbrief-ai/pr-$PR" > "$OUT/pr.diff"
  else
    die "could not fetch the diff; run this inside a clone of $REPO to enable the git fallback"
  fi
fi
echo "  diff: $(wc -c < "$OUT/pr.diff" | tr -d ' ') bytes"

ARGS=(--diff "$OUT/pr.diff" --out-dir "$OUT"
      --title "$TITLE" --body "$BODY" --pr "$PR" --repo "$REPO" --head "$HEAD" --base "$BASE")
[ "$DRY" -eq 0 ] || ARGS+=(--dry-run)

echo
rc=0
node --experimental-strip-types "$ROOT/src/fixbrief-ai.ts" "${ARGS[@]}" || rc=$?
[ "$rc" -eq 0 ] || die "review failed (exit $rc); see output above"

if [ "$DRY" -eq 1 ]; then
  exit 0
fi

echo
echo "================ review ================"
cat "$OUT/review.md"
echo "========================================"
echo
echo "Review:     $OUT/review.md"
[ ! -f "$OUT/fix-brief.md" ] || echo "Fix brief:  $OUT/fix-brief.md"

if [ "$POST" -eq 1 ]; then
  [ -s "$OUT/review-payload.json" ] || die "review-payload.json is missing; cannot post"

  # Same posting path as the GitHub Action: threads, file comments, one checklist.
  # opened (not synchronize) so an explicit --post still publishes a review when
  # every finding already has an open thread.
  echo "Posting the review..."
  REPO="$REPO" PR_NUMBER="$PR" PR_ACTION=opened HEAD_SHA="${HEAD_SHA:-}" \
    bash "$ROOT/scripts/post-review.sh" "$OUT" "$ROOT"
  set -a
  # shellcheck disable=SC1091
  source "$OUT/post-result.env"
  set +a
  REVIEW_ID="${review_id:-}"

  if [ -f "$OUT/fix-brief.md" ] && [ -f "$OUT/fix-brief-targets.json" ]; then
    CHECKLIST_ARGS=()
    if [ -f "$OUT/checklist-comment.json" ]; then
      CHECKLIST_ARGS=(--checklist "$OUT/checklist-comment.json")
    fi
    node --experimental-strip-types "$ROOT/src/attach-replies.ts" \
      --brief "$OUT/fix-brief.md" --targets "$OUT/fix-brief-targets.json" \
      --comments "$OUT/posted-comments.json" \
      ${CHECKLIST_ARGS[@]+"${CHECKLIST_ARGS[@]}"}
  fi

  # Secret gists are unlisted but reachable by anyone with the URL (same as artifact links).
  if [ -f "$OUT/fix-brief.md" ]; then
    echo "Uploading fix-brief.md as a secret gist..."
    BRIEF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fixbrief-ai-gist.XXXXXX")" || die "mktemp failed"
    BRIEF_COPY="$BRIEF_DIR/fix-brief-pr-${PR}.md"
    cp "$OUT/fix-brief.md" "$BRIEF_COPY"
    GIST_OUT="$(gh gist create \
      --desc "FixBrief AI fix brief for ${REPO} PR #${PR}" \
      "$BRIEF_COPY")" \
      || { rm -rf "$BRIEF_DIR"; die "failed to create gist for fix-brief.md"; }
    rm -rf "$BRIEF_DIR"
    BRIEF_URL="$(printf '%s\n' "$GIST_OUT" | grep -E '^https://gist\.github\.com/' | tail -n1)"
    [ -n "$BRIEF_URL" ] || die "gh gist create did not print a gist URL (got: $GIST_OUT)"
    printf '%s\n' "$BRIEF_URL" > "$OUT/fix-brief-url.txt"
    echo "Fix brief gist: $BRIEF_URL"
  fi
  if [ -n "$REVIEW_ID" ]; then
    PAYLOAD="$OUT/deduped-payload.json"
    [ -f "$PAYLOAD" ] || PAYLOAD="$OUT/review-payload.json"
    CHECKLIST_URL=""
    if [ -f "$OUT/checklist-comment.json" ]; then
      CHECKLIST_ID="$(node -e 'const row=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(row.id?String(row.id):"")' "$OUT/checklist-comment.json")"
      if [ -n "$CHECKLIST_ID" ]; then
        CHECKLIST_URL="https://github.com/${REPO}/pull/${PR}#issuecomment-${CHECKLIST_ID}"
      fi
    fi
    SUBMIT="$OUT/review-submit.json"
    node --experimental-strip-types --input-type=module -e '
      import { readFileSync, writeFileSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      const { appendBriefDownloadLink, appendChecklistLink } = await import(pathToFileURL(process.argv[4]).href);
      const payload = JSON.parse(readFileSync(process.argv[1], "utf8"));
      let body = payload.body;
      const checklistUrl = process.argv[5];
      const briefUrl = process.argv[2];
      if (checklistUrl) body = appendChecklistLink(body, checklistUrl);
      if (briefUrl) body = appendBriefDownloadLink(body, briefUrl);
      writeFileSync(process.argv[3], JSON.stringify({ body, event: "COMMENT" }));
    ' "$PAYLOAD" "${BRIEF_URL:-}" "$SUBMIT" "$ROOT/src/attach-replies.ts" "${CHECKLIST_URL:-}"
    gh api --method POST "repos/$REPO/pulls/$PR/reviews/$REVIEW_ID/events" --input "$SUBMIT" >/dev/null \
      || echo "warning: could not submit the pending review"
  elif [ -f "$OUT/comment.md" ]; then
    node --experimental-strip-types --input-type=module -e '
      import { readFileSync, writeFileSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      const { appendBriefDownloadLink } = await import(pathToFileURL(process.argv[3]).href);
      let body = readFileSync(process.argv[1], "utf8");
      const briefUrl = process.argv[2];
      if (briefUrl) body = appendBriefDownloadLink(body, briefUrl);
      writeFileSync(process.argv[1], body.endsWith("\n") ? body : body + "\n");
    ' "$OUT/comment.md" "${BRIEF_URL:-}" "$ROOT/src/attach-replies.ts"
    CHECKLIST_ID=""
    if [ -f "$OUT/checklist-comment.json" ]; then
      CHECKLIST_ID="$(node -e 'const row=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(row.id?String(row.id):"")' "$OUT/checklist-comment.json")"
    fi
    if [ -n "$CHECKLIST_ID" ]; then
      node --input-type=module -e '
        import { readFileSync, writeFileSync } from "node:fs";
        writeFileSync(process.argv[2], JSON.stringify({ body: readFileSync(process.argv[1], "utf8") }));
      ' "$OUT/comment.md" "$OUT/issue-comment.json"
      gh api --method PATCH "repos/$REPO/issues/comments/$CHECKLIST_ID" --input "$OUT/issue-comment.json" >/dev/null \
        || echo "warning: could not add the fix-brief link to the fallback comment"
    else
      gh pr comment "$PR" --repo "$REPO" --body-file "$OUT/comment.md" \
        || echo "warning: could not post the fallback comment"
    fi
  fi
  echo "Posted the review to $URL"
else
  if [ -f "$OUT/fix-brief.md" ] && [ -f "$OUT/fix-brief-targets.json" ]; then
    echo "[]" > "$OUT/posted-comments.json"
    node --experimental-strip-types "$ROOT/src/attach-replies.ts" \
      --brief "$OUT/fix-brief.md" --targets "$OUT/fix-brief-targets.json" \
      --comments "$OUT/posted-comments.json"
  fi
  echo "Not posted (re-run with --post to publish the review)."
fi
