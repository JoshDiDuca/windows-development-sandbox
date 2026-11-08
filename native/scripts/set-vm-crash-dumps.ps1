#Requires -Version 5.1
# Keeps a crash dump of the program that runs the sandbox's VM (vmwp.exe) when it crashes: turns Windows Error
# Reporting's LocalDumps for vmwp.exe on or off, or says whether it is on. Prints one line of JSON: { on, folder }.
# 'on' and 'off' change HKLM and a folder under ProgramData, so they need administrator rights (the caller runs this
# through run-elevated.ps1); 'status' only reads.
#   on      LocalDumps\vmwp.exe: DumpFolder (REG_EXPAND_SZ), DumpType 1 (mini dump), DumpCount 5; the folder is created
#           and the Hyper-V virtual machines group (S-1-5-83-0, vmwp.exe runs as NT VIRTUAL MACHINE\<id>) may write in it.
#   off     removes that key (the dumps already written stay).
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('on', 'off', 'status')][string]$Action,
    [string]$Folder = (Join-Path $env:ProgramData 'AgentSandbox\vm-dumps')
)
$ErrorActionPreference = 'Stop'

$key = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\vmwp.exe'
$virtualMachinesSid = 'S-1-5-83-0'
$dumpCount = 5
$miniDump = 1

function Get-DumpState {
    $on = $false
    $current = $Folder
    $item = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    if ($item -and $item.DumpFolder) {
        $on = $true
        $current = [string]$item.DumpFolder
    }
    [ordered]@{ on = $on; folder = $current }
}

function Enable-DumpCapture {
    if (-not (Test-Path -LiteralPath $Folder)) {
        New-Item -ItemType Directory -Path $Folder -Force | Out-Null
    }
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    & $icacls $Folder /grant ('*' + $virtualMachinesSid + ':(OI)(CI)M') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'icacls could not give the virtual machines group access to ' + $Folder }
    if (-not (Test-Path -Path $key)) {
        New-Item -Path $key -Force | Out-Null
    }
    New-ItemProperty -Path $key -Name 'DumpFolder' -Value $Folder -PropertyType ExpandString -Force | Out-Null
    New-ItemProperty -Path $key -Name 'DumpType' -Value $miniDump -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $key -Name 'DumpCount' -Value $dumpCount -PropertyType DWord -Force | Out-Null
}

function Disable-DumpCapture {
    if (Test-Path -Path $key) {
        Remove-Item -Path $key -Recurse -Force
    }
}

if ($Action -eq 'on') { Enable-DumpCapture }
elseif ($Action -eq 'off') { Disable-DumpCapture }
Get-DumpState | ConvertTo-Json -Compress
