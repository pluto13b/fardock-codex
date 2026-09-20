[CmdletBinding()]
param([ValidateRange(10, 100)][int]$Samples = 30)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot
$env:TEMP = Join-Path $projectRoot '.tmp'
$env:TMP = $env:TEMP
$env:CODEX_PLUS_LINK_BENCHMARK = '1'
$env:CODEX_PLUS_LINK_SAMPLES = [string]$Samples
pnpm --filter @codex-plus/windows-agent exec vitest run tests/e2ee-action-bridge.test.ts -t 'controlled link latency benchmark'
if ($LASTEXITCODE -ne 0) { throw 'The controlled link benchmark failed; do not publish its latency as a successful result.' }
Write-Output 'Reports: .tmp/link-benchmark/lab-sqlite.json and lab-anchored.json'
