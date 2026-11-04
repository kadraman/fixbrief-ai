# FixBrief AI

AI-powered pull request review for GitHub that works with **any model** (OpenAI, Claude, DeepSeek, OpenRouter, Ollama, anything OpenAI-compatible), **doesn't truncate large PRs**, and writes a **fix brief**: a markdown prompt you can hand to an AI coding assistant to apply the fixes.

- **Large PRs:** the diff is split per file (and per hunk for huge files), reviewed in batches, then merged into one review. Skipped files and failed batches are listed in the comment, never silently dropped.
- **Structured findings:** the model returns canonical Findings, which FixBrief AI renders into Copilot-style overview, inline comments and suggestions.
- **Any provider:** two protocols cover nearly everything: `openai` (OpenAI-compatible) and `anthropic`.
- **Fix brief:** creates a `fix-brief.md` that lists each actionable finding with file, problem, suggested fix and a "done when" check, plus rules that tell the assistant to verify each finding before changing anything.
- **TypeScript runtime:** the review pipeline, canonical Finding model, and renderers run on Node.js 22 without third-party packages.

## What's included

```
action.yml                 composite GitHub Action
src/                       TypeScript library and engine
  fixbrief-ai.ts           review engine (also runs standalone)
  findings.ts              canonical Finding types and GitHub renderer
  confidence.ts            evidence checks and confidence scoring
  context.ts               per-batch reference context (overview, guidance, usages)
  difflines.ts             diff line maps and inline comment anchoring
  attach-replies.ts        attach per-finding PR reply commands to fix-brief.md
scripts/                   local CLIs and Action helpers
  review-pr.sh             run against an existing PR from your machine
  review-pr.ps1            PowerShell equivalent
  compute-diffs.sh         review diff + GitHub PR anchor diff for Actions
  calibrate.ts             calibration harness for confidence thresholds
test/                      unit tests (one file per module)
  e2e/                     process-level engine and context tests
examples/fixbrief-ai.yml   workflow that uses the action
.env.example               config template for local runs
```

---

## 1. Try it on an existing PR (no workflow needed)

You need the [GitHub CLI](https://cli.github.com) (`gh auth login` done), Node.js 22.6+, and an API key.

```bash
cp .env.example .env        # then fill in LLM_API_KEY (LLM_MODEL defaults to gpt-5-mini)

# See how the diff would be split, without calling any LLM (no key needed):
scripts/review-pr.sh 123 --repo OWNER/NAME --dry-run

# Run the review. Prints it and saves it; does NOT post to GitHub:
scripts/review-pr.sh 123 --repo OWNER/NAME

# Same, from a PR URL:
scripts/review-pr.sh https://github.com/OWNER/NAME/pull/123

# Post the result as a PR review once you're happy with it.
# If fix-brief.md was produced, it is uploaded as a secret gist and linked from the review:
scripts/review-pr.sh 123 --repo OWNER/NAME --post

# Try a different model without editing .env:
scripts/review-pr.sh 123 --repo OWNER/NAME --provider anthropic --model <model-name>
```

Output goes to `./fixbrief-ai-out/pr-123/`: `review.md`, `fix-brief.md` (if anything was actionable), and the raw `pr.diff`.
The renderer also writes `review-payload.json` (confidence-filtered inline GitHub review comments) and `findings.json` (every scored finding with its confidence breakdown).

Notes:

- Inside a clone of the repo you can omit `--repo`.
- `gh pr diff` is limited by GitHub's API (about 300 files). If it fails and you're inside a clone whose `origin` is that repo, the script falls back to a local `git diff` automatically.
- Variables already exported in your shell win over `.env`.

You can also call the engine directly on any diff:

```bash
git diff main...HEAD | node --experimental-strip-types src/fixbrief-ai.ts --out-dir out
node --experimental-strip-types src/fixbrief-ai.ts --diff my.diff --dry-run
```

---

## 2. Run it on every PR (GitHub Actions)

1. In the repo you want reviewed, add **Settings → Secrets and variables → Actions**:

   | Name | Type | Notes |
   |---|---|---|
   | `LLM_API_KEY` | Secret | your provider's API key |
   | `LLM_MODEL` | Variable | required; recommended default `gpt-5-mini` |
   | `LLM_PROVIDER` | Variable | `openai` (default) or `anthropic` |
   | `LLM_BASE_URL` | Variable | leave unset for OpenAI; set for DeepSeek/OpenRouter/etc. |
2. Copy `examples/fixbrief-ai.yml` to `.github/workflows/fixbrief-ai.yml` and replace `kadraman/fixbrief-ai@v1` with your action reference.

Use `actions/checkout` with `fetch-depth: 0` (as in the example) so very large diffs aren't limited by GitHub's API, synchronize can resolve `github.event.before`, and diffs are computed against the PR head SHA rather than the synthetic merge commit.

### Provider examples

| Provider | `LLM_PROVIDER` | `LLM_MODEL` (example) | `LLM_BASE_URL` |
|---|---|---|---|
| OpenAI (recommended) | `openai` | `gpt-5-mini` | *(blank)* |
| Claude | `anthropic` | provider model id | *(blank)* |
| DeepSeek | `openai` | e.g. `deepseek-v4-pro` | `https://api.deepseek.com` |
| OpenRouter | `openai` | router model id | `https://openrouter.ai/api/v1` |
| Ollama (self-hosted runner) | `openai` | local model name | `http://localhost:11434/v1` |

**Recommended default:** `gpt-5-mini` via OpenAI (`LLM_PROVIDER=openai`, leave `LLM_BASE_URL` unset, `LLM_TEMPERATURE=none`). Model names change often — check your provider's docs. If you previously pointed `LLM_BASE_URL` at DeepSeek/OpenRouter/Ollama and switch back to OpenAI, clear that variable; a leftover override sends requests to the wrong host.

### Action inputs

| Input | Default | Meaning |
|---|---|---|
| `api-key` | required | provider API key |
| `model` | required | model name (recommended: `gpt-5-mini`) |
| `provider` | `openai` | `openai` or `anthropic` |
| `base-url` | | API root override; leave blank for OpenAI |
| `temperature` | `0` | sampling temperature; set to `none` to omit the parameter (recommended for `gpt-5*`) |
| `consistency-runs` | `2` | independent review passes (1–5); later runs use `CONSISTENCY_TEMPERATURE` (default `0.4`). Agreement adjusts confidence scores. Critical/high that clear `minimum-confidence` still publish even if seen in only one run; one-off medium findings stay out of the fix brief |
| `max-output-tokens` | `8192` | required by the Anthropic API |
| `batch-chars` | `100000` | max diff characters packed per API call (~25k tokens); lower it for small-context models |
| `piece-chars` | `20000` | max characters per file piece before hunk-splitting; large files are split even when under `batch-chars` |
| `max-batches` | `40` | cost guard; extra batches are listed as "not reviewed" |
| `minimum-confidence` | `0.85` | confidence floor for published findings; only severity `critical` or `high` at or above this floor appear on the PR (`medium`/`low`/`info` stay in the job summary / `findings.json`) |
| `max-inline-comments` | `0` (all) | optional cap on inline comments; `0` means no cap; overflow still appears in the overview under “Over the inline cap” |
| `workers` | `3` | parallel API calls |
| `fix-brief` | `true` | also produce `fix-brief.md` (PR-gated findings plus medium severity at ≥ `0.75`; override with env `FIX_BRIEF_MEDIUM_CONFIDENCE`) |
| `post-comment` | `true` | post the review as a PR comment |
| `github-token` | `github.token` | needs `pull-requests: write` |
| `diff-context-lines` | `10` | lines of context around each change in the diff the model reads (GitHub's own diff has 3; inline comments are still anchored to that PR diff) |
| `context-chars` | `12000` | cap for the reference context (PR file overview, project guidance, other usages of changed symbols) added to each review call; `0` turns it off |
| `debug-artifacts` | `false` | when `true`, upload `findings.json`, `review-payload.json`, and `scope.txt` (they contain code excerpts) |

Engine-only environment variables (optional, for local runs or advanced tuning): `CONTEXT_CALLERS` (usages shown per changed symbol, default `3`), `CONTEXT_SYMBOLS` (symbols looked up per batch, default `12`), `CONTEXT_DOC_CHARS` (cap for the project-guidance excerpt, default `3000`).

Outputs: `review-path`, `fix-brief-path`, `fix-brief-url`.

---

## Using the fix brief

The PR comment links to the `fix-brief.md` artifact (kept 14 days). Download it, check out the PR branch, and give it to your assistant. For example, with Claude Code:

```bash
claude -p "$(cat fix-brief.md)"
```

or paste/attach it in Copilot, Cursor, or a chat session. The brief tells the assistant to verify each finding first, keep changes minimal, run the tests, and **comment on the pull request for every finding** (what it fixed, or why it skipped it). When FixBrief AI could post an inline thread, the brief includes a `gh` reply command for that comment; otherwise it falls back to a new PR comment. The findings come from an LLM reading diffs in separate batches, so **read the brief before running it** and review the resulting changes like any other PR.

---

## How large diffs are handled

1. Split the diff by file; lockfiles, minified files and binaries are skipped (and listed).
2. A file larger than `piece-chars` (capped by `batch-chars`) is split on hunk boundaries (and on line boundaries inside giant hunks); every part keeps the file header. Split parts are reviewed alone so they are not packed back into one oversized call.
3. Other pieces are packed into batches up to `batch-chars`.
4. Each batch is reviewed in its own call (retrying 429/5xx/529 with backoff). If the model still returns invalid JSON (or the request fails), the batch is split further and retried up to two times. Every batch also gets a bounded **reference context** block: a list of files in the PR, the first project-guidance file found (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, or `CONTRIBUTING.md`), and other usages of symbols declared on changed lines (`git grep` in the checkout). Findings must still be on changed lines in the diff; reference line numbers are approximate.
5. Each response is parsed into the canonical Finding schema. Confidence is computed in code from the model's high/medium/low level plus checked evidence (and agreement across consistency runs). By default the review runs twice (`consistency-runs: 2`); findings are clustered across runs and agreement adjusts the score (±0.10). Findings are then gated to severity `critical`/`high` at or above `minimum-confidence` — including one-offs (a single-run high can still post). Those are posted as inline review comments when the line is on **GitHub's PR diff** (the anchor diff), otherwise under “Could not place inline” / “Over the inline cap”. Medium and below stay off the PR (job summary / `findings.json`). An empty-gate overview notes how many scored findings stayed below the gate. The fix brief includes the PR-gated set **plus** multi-run medium findings scored ≥ `0.75` (env `FIX_BRIEF_MEDIUM_CONFIDENCE`). Low/info and one-off medium findings stay out of the brief. The prompt asks the model to skip style, typing, and docs nits so fewer low-value findings are emitted.

### What gets posted, and when

- **Opened / reopened:** FixBrief AI reviews the full PR diff (`origin/<base>...<PR head SHA>`) and posts a gated PR review (or a one-line empty-gate note when nothing qualifies). Diffs use the PR head commit, not the synthetic merge `HEAD` that `actions/checkout` lands on for `pull_request` events.
- **Synchronize (new commits):** it reviews only the new commits (`before...<PR head SHA>`) when that prior SHA is still an ancestor of the new head. Force-push, rebase, or a missing previous head falls back to the full PR diff. The model sees `diff-context-lines` of context; inline comments are anchored to GitHub's own PR diff. If the incremental review finds nothing that meets the publish gate, **no new comment is posted**, so the earlier review stays in place.
- The review footer names the range (`Reviewed changes since <sha>` vs the full PR) so a partial review is obvious.
- `create-review` failures fall back to an issue comment built from the gated payload — never the ungated `review.md` dump.

Limitations: batches are reviewed independently, so problems that span files in different batches can be missed (reference context reduces that for symbol usages and project rules). Cost scales with PR size; `max-batches` caps it. If **every** batch fails (bad key, wrong model name), the run fails instead of posting an error comment. Incremental synchronize reviews will not re-discover findings that only appear when the whole PR is reviewed together. Symbol extraction is regex-based and language-agnostic.

---

## Security notes

- The diff is sent to your LLM provider. Check that's acceptable for private code.
- Don't wire this to `pull_request_target` with a checkout of the PR head; that would run an untrusted PR with your secrets in reach. The provided workflow uses `pull_request` and skips fork PRs (GitHub withholds secrets from them anyway).
- PR title/body are passed through environment variables, never interpolated into shell code, and the model is told the diff and reference context (project docs, code at usage sites) are untrusted data. A determined prompt injection can still skew a review, so treat output as advice.
- Pin the action to a release tag or commit SHA in your workflow.
- Keep `.env` out of git (it's in `.gitignore`).

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `LLM_API_KEY is not set` | Secret missing, or the PR is from a fork (secrets aren't available) |
| `LLM_MODEL is not set` | Add the `LLM_MODEL` repository variable |
| `HTTP 404` / `model not found` | Wrong model name or `LLM_BASE_URL` |
| `HTTP 400` mentioning `temperature` | The engine retries once without it; set `temperature` to `none` to omit it from the start |
| `HTTP 429` repeatedly | Lower `workers`, or raise your provider's rate limit |
| `Review failed for this part` in the comment | That batch errored after retries; the files are named in the message |
| Context-length errors | Lower `batch-chars` |
| `git diff failed` in the action log | Shallow checkout; use `fetch-depth: 0` |
