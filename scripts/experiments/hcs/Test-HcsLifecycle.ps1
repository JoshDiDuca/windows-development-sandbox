#Requires -Version 5.1
<#
.SYNOPSIS
  Go/no-go for the HCS engine: create, start, stop and delete compute systems with HcsHost.exe and the documents our
  code generates. For a throwaway machine (a GitHub Actions runner or a Windows Sandbox), never your own PC.
.DESCRIPTION
  Needs an elevated shell, HcsHost.exe, and the folder written by export-documents.mjs (uvm.json, container.json,
  plan.json). Steps: make the two disks (HcsHost create-vhdx), give the utility VM access, create and start the
  Hyper-V utility VM, create and start the container inside it, then terminate both. HcsHost only touches systems
  whose id starts with agent-sandbox- and whose Owner is agent-sandbox. Whatever happens, both systems are terminated
  at the end. Writes <DocumentsDir>\lifecycle.json: one entry per step {name, ok, required, message}.
  Exit code: 0 when every required step passed, 1 otherwise.
.PARAMETER HcsHost
  Full path to HcsHost.exe.
.PARAMETER DocumentsDir
  The folder written by export-documents.mjs.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$HcsHost,
  [Parameter(Mandatory = $true)][string]$DocumentsDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$plan = Get-Content -Raw (Join-Path $DocumentsDir 'plan.json') | ConvertFrom-Json
$steps = New-Object System.Collections.Generic.List[object]

function Invoke-Host([string[]]$Arguments) {
  $out = Join-Path $DocumentsDir ('answer-{0}.json' -f [guid]::NewGuid().ToString('N'))
  & $HcsHost @Arguments --out $out | Out-Null
  if (-not (Test-Path $out)) { return [pscustomobject]@{ ok = $false; hresult = ''; message = 'HcsHost.exe gave no answer' } }
  return Get-Content -Raw $out | ConvertFrom-Json
}

function Add-Step([string]$Name, [bool]$Required, [string[]]$Arguments) {
  $reply = $null
  try { $reply = Invoke-Host $Arguments } catch { $reply = [pscustomobject]@{ ok = $false; hresult = ''; message = $_.Exception.Message } }
  $steps.Add([pscustomobject]@{ name = $Name; ok = [bool]$reply.ok; required = $Required; message = ('{0} {1}' -f $reply.hresult, $reply.message).Trim() })
  Write-Host ('{0}: {1} {2}' -f $Name, $(if ($reply.ok) { 'ok' } else { 'FAILED' }), $reply.message)
  return [bool]$reply.ok
}

function New-Request([string]$Id, [string]$DocumentFile) {
  $file = Join-Path $DocumentsDir ($Id + '-request.json')
  $document = Get-Content -Raw $DocumentFile
  @{ id = $Id; document = $document } | ConvertTo-Json -Compress | Set-Content -Path $file -Encoding UTF8
  return $file
}

function Add-ExpectedFailure([string]$Name, [string[]]$Arguments) {
  $reply = $null
  try { $reply = Invoke-Host $Arguments } catch { $reply = [pscustomobject]@{ ok = $true; hresult = ''; message = $_.Exception.Message } }
  # Passes when HCS (not our own Refused: check) said no.
  $ok = (-not $reply.ok) -and -not ([string]$reply.message).StartsWith('Refused:')
  $steps.Add([pscustomobject]@{ name = $Name; ok = $ok; required = $false; message = ('{0} {1}' -f $reply.hresult, $reply.message).Trim() })
  Write-Host ('{0}: {1} {2}' -f $Name, $(if ($ok) { 'ok' } else { 'FAILED' }), $reply.message)
}

function New-ShareRequest([string]$Id, [string]$Action, [string]$Name, [string]$Path, [bool]$ReadOnly) {
  $file = Join-Path $DocumentsDir ('share-{0}-{1}.json' -f $Action, $Name)
  @{ id = $Id; action = $Action; name = $Name; path = $Path; readOnly = $ReadOnly } | ConvertTo-Json -Compress | Set-Content -Path $file -Encoding UTF8
  return $file
}

# Live folders (docs/design/hcs-live-folders.md): the same HcsModifyComputeSystem request that would add a folder to a
# running Windows Sandbox, sent to OUR running utility VM. Informational until it has passed on both runners.
function Test-LiveFolders([string]$UvmId) {
  $folder = Join-Path $DocumentsDir 'live-folder'
  New-Item -ItemType Directory -Force $folder | Out-Null
  Set-Content -Path (Join-Path $folder 'hello.txt') -Value 'live folder' -Encoding ASCII
  $ro = 'agentsbx-0000000a'
  $rw = 'agentsbx-0000000b'
  $roAdded = Add-Step 'live folder: add a read-only vSMB share (informational)' $false @('share', (New-ShareRequest $UvmId 'add' $ro $folder $true))
  $rwAdded = Add-Step 'live folder: add a writable vSMB share (informational)' $false @('share', (New-ShareRequest $UvmId 'add' $rw $folder $false))
  if ($roAdded) { Add-ExpectedFailure 'live folder: the same name twice is refused by HCS (informational)' @('share', (New-ShareRequest $UvmId 'add' $ro $folder $true)) }
  # Whether the guest sees it: hcsdiag (inbox with the Containers feature) runs a command in our utility VM.
  $hcsdiag = Join-Path $env:SystemRoot 'System32\hcsdiag.exe'
  if ($roAdded -and (Test-Path $hcsdiag)) {
    $log = Join-Path $DocumentsDir 'hcsdiag-exec.txt'
    $p = Start-Process -FilePath $hcsdiag -ArgumentList @('exec', $UvmId, 'cmd.exe /c type \\?\VMSMB\VSMB-{dcc079ae-60ba-4d07-847c-3493609c0870}\' + $ro + '\hello.txt') -NoNewWindow -PassThru -RedirectStandardOutput $log
    $done = $p.WaitForExit(60000)
    if (-not $done) { $p.Kill() }
    $seen = $done -and (Test-Path $log) -and ((Get-Content -Raw $log) -match 'live folder')
    $steps.Add([pscustomobject]@{ name = 'live folder: the guest reads the share (hcsdiag exec, informational)'; ok = [bool]$seen; required = $false; message = $(if (Test-Path $log) { (Get-Content -Raw $log) } else { 'no output' }) })
  }
  if ($roAdded) { Add-Step 'live folder: remove the read-only share (informational)' $false @('share', (New-ShareRequest $UvmId 'remove' $ro $folder $true)) | Out-Null }
  if ($rwAdded) { Add-Step 'live folder: remove the writable share (informational)' $false @('share', (New-ShareRequest $UvmId 'remove' $rw $folder $false)) | Out-Null }
  if ($roAdded) { Add-ExpectedFailure 'live folder: removing a share that is gone fails cleanly (informational)' @('share', (New-ShareRequest $UvmId 'remove' $ro $folder $true)) }
  # Still alive after all of it: properties answer and the state is Running.
  $after = Invoke-Host @('properties', $UvmId)
  $running = $after.ok -and ([string]$after.json -match '"State"\s*:\s*"Running"')
  $steps.Add([pscustomobject]@{ name = 'live folder: the utility VM is still running afterwards (informational)'; ok = [bool]$running; required = $false; message = [string]$after.message })
}

$uvmCreated = $false
$containerCreated = $false
try {
  $disksOk = $true
  foreach ($disk in $plan.disks) {
    if (-not (Add-Step ('create disk ' + (Split-Path $disk -Leaf)) $true @('create-vhdx', $disk, '1'))) { $disksOk = $false }
  }
  if ($disksOk) {
    foreach ($disk in $plan.disks) {
      Add-Step ('grant VM access to ' + (Split-Path $disk -Leaf)) $true @('grant-vm-access', $plan.uvmId, $disk) | Out-Null
    }
    $uvmCreated = Add-Step 'create utility VM (Hyper-V isolation)' $true @('create', (New-Request $plan.uvmId (Join-Path $DocumentsDir 'uvm.json')))
    if ($uvmCreated) {
      if (Add-Step 'start utility VM' $true @('start', $plan.uvmId)) {
        Test-LiveFolders $plan.uvmId
        # The container needs a writable layer made by HcsInitializeWritableLayer, which HcsHost does not have yet:
        # these two steps are expected to fail until it does, so they are informational.
        $containerCreated = Add-Step 'create container in the VM (informational)' $false @('create', (New-Request $plan.containerId (Join-Path $DocumentsDir 'container.json')))
        if ($containerCreated) { Add-Step 'start container (informational)' $false @('start', $plan.containerId) | Out-Null }
      }
    }
  }
}
finally {
  # Only ids that HcsHost created and that carry our Owner can be terminated through it.
  if ($containerCreated) { Add-Step 'terminate container' $true @('terminate', $plan.containerId) | Out-Null }
  if ($uvmCreated) { Add-Step 'terminate utility VM' $true @('terminate', $plan.uvmId) | Out-Null }
  foreach ($disk in $plan.disks) { Remove-Item -Force -ErrorAction SilentlyContinue $disk }
  ConvertTo-Json -InputObject @($steps) -Depth 4 | Set-Content -Path (Join-Path $DocumentsDir 'lifecycle.json') -Encoding UTF8
}

$failed = @($steps | Where-Object { $_.required -and -not $_.ok })
if ($failed.Count -gt 0) { exit 1 }
exit 0
