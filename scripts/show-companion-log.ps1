[CmdletBinding()]
param(
  [ValidateRange(1, 500)]
  [int]$Tail = 100
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$logFile = Join-Path $workspaceRoot '.data\windows-companion\logs\companion.jsonl'
if (-not (Test-Path -LiteralPath $logFile -PathType Leaf)) {
  Write-Output 'Companion diagnostic log has not been created yet.'
  exit 0
}

Get-Content -LiteralPath $logFile -Tail $Tail -Encoding utf8 |
  ForEach-Object {
    try { $_ | ConvertFrom-Json -ErrorAction Stop }
    catch { [pscustomobject]@{ timestamp = $null; event = 'invalid-log-line' } }
  } |
  Select-Object timestamp,event,method,operation,outcome,durationMs,frameBytes,generation,stage,category,reason |
  Format-Table -AutoSize
