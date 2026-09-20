[CmdletBinding()]
param([switch]$BuildOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $projectRoot 'apps/windows-companion-preview'
$output = Join-Path $projectRoot '.tmp/windows-ui-preview'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$env:TEMP = Join-Path $projectRoot '.tmp'
$env:TMP = $env:TEMP
$framework = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
$executable = Join-Path $output 'CodexPlusUiPreview.exe'
$arguments = @('/nologo', '/optimize+', '/target:winexe', '/platform:x64', '/codepage:65001', '/utf8output', ('/out:' + $executable), ('/resource:' + (Join-Path $source 'PreviewView.xaml') + ',PreviewView.xaml'), '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Xaml.dll')
foreach ($assembly in @('PresentationFramework.dll', 'PresentationCore.dll', 'WindowsBase.dll')) { $arguments += '/reference:' + (Join-Path $framework ('WPF\' + $assembly)) }
# An explicit list keeps production backend classes out of this assembly.
foreach ($file in @('Program.cs', 'PreviewWindow.cs', 'Motion.cs', 'RenderClock.cs', 'ConnectionSculpture.cs', 'GlassOptics.cs', 'SpatialBackdrop.cs')) { $arguments += Join-Path $source $file }
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'Preview compilation failed.' }
Copy-Item -LiteralPath (Join-Path $projectRoot 'apps/windows-companion/assets/lucide/LICENSE') -Destination (Join-Path $output 'Lucide-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $source 'README.md') -Destination (Join-Path $output 'README.md')
$check = Start-Process -FilePath $executable -ArgumentList @('--check', ('"' + (Join-Path $output 'checks') + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $output 'checks.stdout.log') -RedirectStandardError (Join-Path $output 'checks.stderr.log')
if ($check.ExitCode -ne 0) { Get-Content -LiteralPath (Join-Path $output 'checks.stderr.log') -Encoding UTF8; throw 'Preview checks failed.' }
Get-Content -LiteralPath (Join-Path $output 'checks.stdout.log') -Encoding UTF8
if (-not $BuildOnly) {
    $previewProcess = Start-Process -FilePath $executable -WorkingDirectory $projectRoot -WindowStyle Normal -PassThru
    [pscustomobject]@{pid=$previewProcess.Id;executable=$executable} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'preview-process.json') -Encoding UTF8
    Write-Output ('Preview opened: ' + $executable)
}
