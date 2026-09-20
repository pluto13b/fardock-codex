[CmdletBinding()]
param([Parameter(Mandatory=$true)][uri]$Origin)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodePath = (Get-Command node -ErrorAction Stop).Source
$codexPath = Join-Path $workspaceRoot '.cache\codex-runtime-0.153.4\package\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
$tsx = Join-Path $workspaceRoot 'node_modules\tsx\dist\cli.mjs'
$runner = Join-Path $workspaceRoot 'apps\windows-agent\src\production-runner.ts'

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $codexPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $tsx -PathType Leaf) -or
    -not (Test-Path -LiteralPath $runner -PathType Leaf) -or
    [IO.Path]::GetExtension($codexPath) -ine '.exe') {
  throw 'Codex Plus production runtime is incomplete.'
}

$runtimeTemp = Join-Path $workspaceRoot '.tmp'
New-Item -ItemType Directory -Path $runtimeTemp -Force | Out-Null
$env:TEMP = $runtimeTemp
$env:TMP = $runtimeTemp

$logDirectory = Join-Path $workspaceRoot '.data\windows-companion\logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stdout = Join-Path $logDirectory 'process.stdout.log'
$stderr = Join-Path $logDirectory 'process.stderr.log'
foreach ($log in @($stdout, $stderr)) {
  if (Test-Path -LiteralPath $log -PathType Leaf) {
    Move-Item -LiteralPath $log -Destination ($log + '.previous') -Force
  }
}
$runnerArguments = @(
  ('"' + $tsx + '"'), ('"' + $runner + '"'),
  '--origin', $Origin.AbsoluteUri.TrimEnd('/'),
  '--codex-executable', ('"' + $codexPath + '"'),
  '--workspace', ('"' + $workspaceRoot + '"')
)
$companion = Start-Process -FilePath $nodePath -ArgumentList $runnerArguments `
  -WorkingDirectory $workspaceRoot -WindowStyle Hidden -Wait -PassThru `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr
exit $companion.ExitCode
