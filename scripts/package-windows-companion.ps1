[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot
$env:TEMP = Join-Path $projectRoot '.tmp'
$env:TMP = $env:TEMP
node scripts/build-windows-companion-release.mjs
if ($LASTEXITCODE -ne 0) { throw 'Windows Companion build failed.' }
$releaseDirectory = Join-Path $projectRoot '.tmp\releases\CodexPlusCompanion-0.5.3-win-x64'
$zip = $releaseDirectory + '.zip'
Compress-Archive -LiteralPath $releaseDirectory -DestinationPath $zip -CompressionLevel Optimal -Force
Write-Output ('Windows Companion release: ' + $zip)
