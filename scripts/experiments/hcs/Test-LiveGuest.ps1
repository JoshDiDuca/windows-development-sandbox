#Requires -Version 5.1
<#
.SYNOPSIS
  Manual test of the guest half of live folders (docs/design/hcs-live-folders.md), INSIDE a Windows Sandbox only.
.DESCRIPTION
  Shows one of this sandbox's own vSMB shares (a .wsb mapped folder) a second time, read-only, at a new
  C:\Workspace\live-test-<random> with the bind filter, lists it, checks a write is refused, and removes the mapping
  again; the folder must be gone afterwards. The sandbox's own mapping of that share is not touched (a new virtual
  root, BINDFLT_FLAG_NO_MULTIPLE_TARGETS). It is a manual script, not a self-test: it maps a real share of the
  running sandbox. Run it from an administrator PowerShell in the sandbox:
    powershell -ExecutionPolicy Bypass -File scripts\experiments\hcs\Test-LiveGuest.ps1
  Exit code 0 when every step passed.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if (-not (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Containers\CmService' -ErrorAction SilentlyContinue) -and $env:USERNAME -ne 'WDAGUtilityAccount') {
  Write-Host 'This is not a Windows Sandbox; nothing was done.'
  exit 2
}
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$work = Join-Path $env:TEMP ('live-guest-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$exe = Join-Path $work 'BindMount.exe'
& $csc /nologo /optimize /target:exe "/out:$exe" (Join-Path $PSScriptRoot 'BindMount.cs') | Out-Null
if (-not (Test-Path $exe)) { Write-Host 'BindMount.cs did not compile.'; exit 1 }

$failed = 0
function Step([string]$Name, [bool]$Ok, [string]$Detail = '') {
  Write-Host ('{0}: {1} {2}' -f $Name, $(if ($Ok) { 'ok' } else { 'FAILED' }), $Detail)
  if (-not $Ok) { $script:failed++ }
}

# A share the .wsb mapped read-only (flags 0x21) is preferred: then even the write test cannot reach a real folder.
$listing = & $exe list
$share = $null
$shareReadOnly = $false
$flags = 0
foreach ($line in $listing) {
  if ($line -match '^flags 0x([0-9A-Fa-f]+)') { $flags = [Convert]::ToInt32($Matches[1], 16); continue }
  if ($line -match 'VSMB-\{dcc079ae-60ba-4d07-847c-3493609c0870\}\\([0-9a-f]{64})\\') {
    $ro = ($flags -band 1) -ne 0
    if (-not $share -or ($ro -and -not $shareReadOnly)) { $share = $Matches[1]; $shareReadOnly = $ro }
  }
}
Step 'find one of the sandbox''s own shares' ($null -ne $share) $share
$madeParent = $false
if ($share -and -not (Test-Path -LiteralPath 'C:\Workspace')) {
  # The bind filter needs the virtual root's parent (0x80070002 otherwise, like a missing share); the daemon makes it.
  New-Item -ItemType Directory 'C:\Workspace' | Out-Null
  $madeParent = $true
}
if ($share) {
  $folder = 'C:\Workspace\live-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $mapped = (& $exe map-existing $folder $share) -join ' '
  Step 'map it at a new folder (read-only)' ($LASTEXITCODE -eq 0) $mapped
  if ($LASTEXITCODE -eq 0) {
    $items = @(Get-ChildItem -LiteralPath $folder -Force -ErrorAction SilentlyContinue)
    Step 'the folder lists the share' ($items.Count -gt 0) ('{0} entries' -f $items.Count)
    $attrs = (Get-Item -LiteralPath $folder -Force).Attributes
    Step 'it is a plain folder (not a link)' (-not ($attrs -band [IO.FileAttributes]::ReparsePoint)) "$attrs"
    if ($shareReadOnly) {
      $writeRefused = $false
      try { Set-Content -LiteralPath (Join-Path $folder ('live-test-' + [Guid]::NewGuid().ToString('N') + '.txt')) -Value x -ErrorAction Stop } catch { $writeRefused = $true }
      Step 'a write is refused' $writeRefused
    } else {
      Write-Host 'a write is refused: skipped (no read-only share to test on without touching a real folder)'
    }
    $unmapped = (& $exe unmap $folder) -join ' '
    Step 'unmap' ($LASTEXITCODE -eq 0) $unmapped
    Step 'the folder is gone afterwards' (-not (Test-Path -LiteralPath $folder))
  }
}
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
if ($madeParent -and @(Get-ChildItem -LiteralPath 'C:\Workspace' -Force).Count -eq 0) { Remove-Item -LiteralPath 'C:\Workspace' }
if ($failed -gt 0) { exit 1 }
exit 0
