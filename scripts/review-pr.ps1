#Requires -Version 5.1
<#
.SYNOPSIS
  Run fixbrief-ai against an existing pull request from your own machine.
  Nothing is posted to GitHub unless you pass -Post.

.EXAMPLE
  .\scripts\review-pr.ps1 1 -DryRun
  .\scripts\review-pr.ps1 1
  .\scripts\review-pr.ps1 1 -Post
  .\scripts\review-pr.ps1 https://github.com/OWNER/NAME/pull/1 -Provider anthropic -Model claude-sonnet-4-5
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$PR,

  [string]$Repo = "",
  [switch]$DryRun,
  [switch]$Post,
  [string]$Out = "",
  [ValidateSet("", "openai", "anthropic")]
  [string]$Provider = "",
  [string]$Model = "",
  [string]$BaseUrl = "",
  [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Show-Usage {
  @"
Usage:
  .\scripts\review-pr.ps1 <PR number | PR URL> [options]

Options:
  -Repo OWNER/NAME     repository (not needed inside a clone, or with a PR URL)
  -DryRun              show how the diff would be split; make no LLM calls
  -Post                post the review as a comment on the PR
  -Out DIR             output directory (default: .\fixbrief-ai-out\pr-<N>)
  -Provider NAME       openai | anthropic   (overrides LLM_PROVIDER)
  -Model NAME          model name           (overrides LLM_MODEL)
  -BaseUrl URL         API root             (overrides LLM_BASE_URL)
  -Help                show this help

Configuration comes from environment variables or a .env file next to this
repo's root (or in the current directory). See .env.example.

Requires: gh (authenticated), Node.js 22.6+, and for non-dry runs LLM_API_KEY + LLM_MODEL.
"@
}

function Die([string]$Message) {
  Write-Error "error: $Message"
  exit 1
}

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Import-DotEnv([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    if ($line.StartsWith("export ")) { $line = $line.Substring(7).Trim() }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { return }
    $key = $line.Substring(0, $eq).Trim()
    $val = $line.Substring($eq + 1).Trim()
    if ($val.Length -ge 2) {
      $q = $val[0]
      if (($q -eq [char]'"' -or $q -eq [char]"'") -and $val[-1] -eq $q) {
        $val = $val.Substring(1, $val.Length - 2)
      }
    }
    if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { return }
    $existing = [Environment]::GetEnvironmentVariable($key, "Process")
    if ([string]::IsNullOrEmpty($existing)) {
      Set-Item -Path "Env:$key" -Value $val
    }
  }
}

if ($Help -or [string]::IsNullOrWhiteSpace($PR)) {
  Show-Usage
  if ($Help) { exit 0 }
  exit 1
}

$Here = $PSScriptRoot
$Root = Split-Path -Parent $Here

if ($Provider) { $env:LLM_PROVIDER = $Provider }
if ($Model) { $env:LLM_MODEL = $Model }
if ($BaseUrl) { $env:LLM_BASE_URL = $BaseUrl }

if ($PR -match 'github\.com/([^/]+/[^/]+)/pull/([0-9]+)') {
  $Repo = $Matches[1]
  $PR = $Matches[2]
}
if ($PR -notmatch '^[0-9]+$') {
  Die "PR must be a number or a GitHub PR URL"
}

if (-not (Test-Command "gh")) { Die "GitHub CLI (gh) not found: https://cli.github.com" }
if (-not (Test-Command "node")) { Die "Node.js 22+ not found" }

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
$nodeMinor = [int](node -p "process.versions.node.split('.')[1]")
if (($nodeMajor * 10000 + $nodeMinor) -lt 220006) {
  Die "Node.js 22.6+ is required for the TypeScript runtime"
}

Import-DotEnv (Join-Path (Get-Location) ".env")
Import-DotEnv (Join-Path $Root ".env")

if (-not $DryRun) {
  if ([string]::IsNullOrWhiteSpace($env:LLM_API_KEY)) {
    Die "LLM_API_KEY is not set (put it in .env or export it)"
  }
  if ([string]::IsNullOrWhiteSpace($env:LLM_MODEL)) {
    Die "LLM_MODEL is not set (put it in .env, export it, or use -Model)"
  }
}

$ghRepoArgs = @()
if ($Repo) { $ghRepoArgs = @("--repo", $Repo) }

Write-Host "Fetching PR #$PR ..."
try {
  $metaArgs = @("pr", "view", $PR) + $ghRepoArgs + @("--json", "number,title,body,headRefName,baseRefName,url")
  $MetaJson = (& gh @metaArgs | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($MetaJson)) { throw "gh exited $LASTEXITCODE" }
  $Meta = $MetaJson | ConvertFrom-Json
} catch {
  Die "could not read PR #$PR (check the number, -Repo, and 'gh auth status')"
}

$Title = [string]$Meta.title
$Body = [string]$Meta.body
$Head = [string]$Meta.headRefName
$Base = [string]$Meta.baseRefName
$Url = [string]$Meta.url
if (-not $Repo) {
  if ($Url -match 'https?://[^/]+/([^/]+/[^/]+)/pull/') { $Repo = $Matches[1] }
}

if (-not $Out) { $Out = Join-Path (Get-Location) "fixbrief-ai-out\pr-$PR" }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

Write-Host "  $Repo #${PR}: $Title"
Write-Host "  $Head -> $Base"

$diffPath = Join-Path $Out "pr.diff"
$diffErr = Join-Path $Out "gh-diff.err"
$diffOk = $true
try {
  # Avoid PowerShell's `>` redirect (UTF-16 on Windows PowerShell 5.1).
  $diffArgs = @("pr", "diff", $PR) + $ghRepoArgs
  $diffText = & gh @diffArgs 2>$diffErr | Out-String
  if ($LASTEXITCODE -ne 0) {
    $diffOk = $false
  } else {
    # Out-String joins with CRLF; normalize to LF so hunk parsing matches Unix diffs.
    $diffText = $diffText -replace "`r`n", "`n" -replace "`r", "`n"
    [System.IO.File]::WriteAllText($diffPath, $diffText)
  }
} catch {
  $diffOk = $false
}

if (-not $diffOk) {
  $errPreview = ""
  if (Test-Path -LiteralPath $diffErr) {
    $errPreview = (Get-Content -LiteralPath $diffErr -Raw -ErrorAction SilentlyContinue)
    if ($errPreview.Length -gt 200) { $errPreview = $errPreview.Substring(0, 200) }
  }
  Write-Host "  gh pr diff failed: $errPreview"
  git rev-parse --git-dir 1>$null 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  falling back to a local git diff (needs 'origin' to be this repo) ..."
    & git fetch --quiet origin "pull/$PR/head:refs/fixbrief-ai/pr-$PR"
    if ($LASTEXITCODE -ne 0) { Die "git fetch of the PR head failed" }
    & git fetch --quiet origin $Base
    if ($LASTEXITCODE -ne 0) { Die "git fetch of base branch '$Base' failed" }
    $diffText = & git diff --no-color "origin/$Base...refs/fixbrief-ai/pr-$PR" | Out-String
    [System.IO.File]::WriteAllText($diffPath, $diffText)
  } else {
    Die "could not fetch the diff; run this inside a clone of $Repo to enable the git fallback"
  }
}

$diffBytes = (Get-Item -LiteralPath $diffPath).Length
Write-Host "  diff: $diffBytes bytes"

$nodeArgs = @(
  "--experimental-strip-types", (Join-Path $Root "src\fixbrief-ai.ts"),
  "--diff", $diffPath, "--out-dir", $Out,
  "--title", $Title, "--body", $Body, "--pr", $PR, "--repo", $Repo, "--head", $Head, "--base", $Base
)
if ($DryRun) { $nodeArgs += "--dry-run" }

Write-Host ""
& node @nodeArgs
if ($LASTEXITCODE -ne 0) {
  Die "review failed (exit $LASTEXITCODE); see output above"
}

if ($DryRun) { exit 0 }

Write-Host ""
Write-Host "================ review ================"
Get-Content -LiteralPath (Join-Path $Out "review.md") -Raw | Write-Host
Write-Host "========================================"
Write-Host ""
Write-Host "Review:     $(Join-Path $Out 'review.md')"
$briefPath = Join-Path $Out "fix-brief.md"
if (Test-Path -LiteralPath $briefPath) {
  Write-Host "Fix brief:  $briefPath"
}

if ($Post) {
  $payloadPath = Join-Path $Out "review-payload.json"
  $reviewPath = Join-Path $Out "review.md"
  $payloadInfo = Get-Item -LiteralPath $payloadPath -ErrorAction SilentlyContinue
  $inlineCount = 0
  if ($payloadInfo -and $payloadInfo.Length -gt 0) {
    $payload = Get-Content -LiteralPath $payloadPath -Raw | ConvertFrom-Json
    $inlineCount = @($payload.comments).Count
  }
  # Prefer a single PR review (overview + inline threads). Fall back to a summary
  # issue comment when there are no inline findings, or if create-review fails.
  if ($inlineCount -gt 0) {
    Write-Host "Posting PR review with $inlineCount inline comment(s)..."
    & gh api --method POST "repos/$Repo/pulls/$PR/reviews" --input $payloadPath | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "::warning::Inline review failed; posting summary comment only."
      $commentArgs = @("pr", "comment", $PR) + $ghRepoArgs + @("--body-file", $reviewPath)
      & gh @commentArgs | Out-Null
      if ($LASTEXITCODE -ne 0) { Die "failed to post summary comment" }
    } else {
      Write-Host "Posted PR review with inline Signal comments."
    }
  } else {
    Write-Host "No inline findings; posting summary comment only..."
    $commentArgs = @("pr", "comment", $PR) + $ghRepoArgs + @("--body-file", $reviewPath)
    & gh @commentArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "failed to post summary comment" }
  }
  Write-Host "Posted the review to $Url"
} else {
  Write-Host "Not posted (re-run with -Post to publish the review)."
}
