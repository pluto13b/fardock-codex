[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$node = (Get-Command node -ErrorAction Stop).Source
$tsx = Join-Path $workspaceRoot 'node_modules\tsx\dist\cli.mjs'
$cli = Join-Path $workspaceRoot 'services\relay\src\owner-verifier-cli.ts'
$output = Join-Path $workspaceRoot '.tmp\windows-companion\owner-verifier.json'

if (Test-Path -LiteralPath $output) {
  throw 'Owner verifier output already exists; move or delete that exact temporary file first.'
}

$username = Read-Host 'Owner account name'
$securePassword = Read-Host 'Owner password (8+ bytes)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $payload = @{ username = $username; password = $plainPassword } | ConvertTo-Json -Compress
  $payload | & $node $tsx $cli --output $output
  if ($LASTEXITCODE -ne 0) { throw 'Owner verifier creation failed.' }
} finally {
  if ($null -ne $pointer -and $pointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
  $plainPassword = $null
  $payload = $null
  $securePassword.Dispose()
}
