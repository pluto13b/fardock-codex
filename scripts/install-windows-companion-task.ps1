[CmdletBinding()]
param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$taskName = 'CodexPlusCompanion'
$launcher = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'start-windows-companion.ps1')).Path
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name

if ($Remove) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
  Write-Output 'CodexPlusCompanion task removed.'
  exit 0
}

if ($null -ne (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
  throw 'CodexPlusCompanion task already exists. Remove it explicitly before reinstalling.'
}

$powerShell = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $powerShell -PathType Leaf)) {
  $powerShell = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop).Source
}
$arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' +
  '"' + $launcher + '"'
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory (Split-Path $launcher -Parent)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Codex Plus production Companion for the current user.' | Out-Null

Write-Output 'CodexPlusCompanion task installed.'
