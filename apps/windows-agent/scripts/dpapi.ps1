param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('protect', 'unprotect', 'restrict-file')]
  [string]$Operation,

  [Parameter(Mandatory = $false)]
  [string]$TargetPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

if ($Operation -eq 'restrict-file') {
  if ([string]::IsNullOrWhiteSpace($TargetPath) -or -not [System.IO.Path]::IsPathRooted($TargetPath)) {
    throw 'invalid-target'
  }
  $fullPath = [System.IO.Path]::GetFullPath($TargetPath)
  if (-not [System.IO.File]::Exists($fullPath)) { throw 'missing-target' }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($identity)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $identity,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $acl.AddAccessRule($rule)
  [System.IO.File]::SetAccessControl($fullPath, $acl)
  [Console]::Out.Write('ok')
  exit 0
}

$inputStream = [Console]::OpenStandardInput()
$inputBuffer = [System.IO.MemoryStream]::new()
$inputStream.CopyTo($inputBuffer)
$inputBytes = $inputBuffer.ToArray()
if ($inputBytes.Length -lt 1 -or $inputBytes.Length -gt 8388608) { throw 'invalid-input' }
$entropy = [Text.Encoding]::UTF8.GetBytes('codex-plus-windows-dpapi-v1')
try {
  if ($Operation -eq 'protect') {
    $outputBytes = [Security.Cryptography.ProtectedData]::Protect(
      $inputBytes,
      $entropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
  } else {
    $outputBytes = [Security.Cryptography.ProtectedData]::Unprotect(
      $inputBytes,
      $entropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
  }
  try {
    $outputStream = [Console]::OpenStandardOutput()
    $outputStream.Write($outputBytes, 0, $outputBytes.Length)
    $outputStream.Flush()
  } finally {
    [Array]::Clear($outputBytes, 0, $outputBytes.Length)
  }
} finally {
  [Array]::Clear($inputBytes, 0, $inputBytes.Length)
  [Array]::Clear($entropy, 0, $entropy.Length)
  $inputBuffer.Dispose()
}
