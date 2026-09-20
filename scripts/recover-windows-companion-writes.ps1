[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodePath = 'C:\Program Files\node.exe'
$tsx = Join-Path $workspaceRoot 'node_modules\tsx\dist\cli.mjs'
$recovery = Join-Path $workspaceRoot 'apps\windows-agent\src\operator-recovery.ts'

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $tsx -PathType Leaf) -or
    -not (Test-Path -LiteralPath $recovery -PathType Leaf)) {
  throw 'Codex Plus recovery runtime is incomplete.'
}

$runtimeTemp = Join-Path $workspaceRoot '.tmp'
New-Item -ItemType Directory -Path $runtimeTemp -Force | Out-Null
$env:TEMP = $runtimeTemp
$env:TMP = $runtimeTemp

& $nodePath $tsx $recovery
exit $LASTEXITCODE
