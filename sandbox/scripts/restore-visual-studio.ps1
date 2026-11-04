#Requires -Version 5.1
# Puts a saved Visual Studio back at boot, in seconds (guest/toolchains/native/visual-studio.ts; what goes where is
# decided in vs-persist.ts): the small folders programs look for at fixed paths are copied back, then the registry
# values that point at the big folders on the data disk and the Setup Configuration COM class are written. -PlanFile is
# JSON written by the runtime:
#   copies:   [{ name, from, to, mode: 'all' | 'missing' }]   'all': robocopy /E (only what differs is copied);
#                                                            'missing': each subfolder only when the target has none
#   registry: [{ view: '64'|'32', key, name, kind: 'string'|'expand'|'dword', value }]   under HKLM ('' = default)
# Safe to run again. Exit 0 when everything is in place, 1 when a copy failed, 2 when a registry value could not be set.
param([Parameter(Mandatory = $true)][string]$PlanFile)
$ErrorActionPreference = 'Stop'

$plan = Get-Content -LiteralPath $PlanFile -Raw -Encoding UTF8 | ConvertFrom-Json
$robocopy = Join-Path $env:SystemRoot 'System32\Robocopy.exe'

function Copy-Folder([string]$From, [string]$To) {
    New-Item -ItemType Directory -Force -Path $To | Out-Null
    & $robocopy $From $To /E /COPY:DAT /XJ /R:1 /W:1 /MT:16 /NP /NFL /NDL /NJH /NJS | Where-Object { $_ -and $_.Trim() } | Out-Host
    return $LASTEXITCODE
}

$copied = 0
$failed = New-Object System.Collections.ArrayList
foreach ($copy in @($plan.copies)) {
    if (-not (Test-Path -LiteralPath $copy.from -PathType Container)) {
        [void]$failed.Add($copy.name + ' (' + $copy.from + ' is missing)')
        continue
    }
    if ($copy.mode -eq 'missing') {
        foreach ($child in Get-ChildItem -LiteralPath $copy.from -Directory) {
            $target = Join-Path $copy.to $child.Name
            if (Test-Path -LiteralPath $target) { continue }
            $code = Copy-Folder -From $child.FullName -To $target
            if ($code -ge 8) { [void]$failed.Add($copy.name + '\' + $child.Name + ' (robocopy ' + $code + ')') }
        }
        $copied++
        continue
    }
    $code = Copy-Folder -From $copy.from -To $copy.to
    if ($code -ge 8) { [void]$failed.Add($copy.name + ' (robocopy ' + $code + ')') } else { $copied++ }
}
if ($failed.Count) {
    Write-Error ('restore-visual-studio: could not copy ' + ($failed -join ', '))
    exit 1
}

$set = 0
$bad = New-Object System.Collections.ArrayList
foreach ($entry in @($plan.registry)) {
    $view = [Microsoft.Win32.RegistryView]::Registry64
    if ($entry.view -eq '32') { $view = [Microsoft.Win32.RegistryView]::Registry32 }
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
    try {
        $key = $base.CreateSubKey([string]$entry.key)
        try {
            if ($entry.kind -eq 'dword') {
                $key.SetValue([string]$entry.name, [int]$entry.value, [Microsoft.Win32.RegistryValueKind]::DWord)
            } elseif ($entry.kind -eq 'expand') {
                $key.SetValue([string]$entry.name, [string]$entry.value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
            } else {
                $key.SetValue([string]$entry.name, [string]$entry.value, [Microsoft.Win32.RegistryValueKind]::String)
            }
            $set++
        } finally {
            $key.Close()
        }
    } catch {
        [void]$bad.Add($entry.view + ':' + $entry.key + '\' + $entry.name + ' (' + $_.Exception.Message + ')')
    } finally {
        $base.Close()
    }
}
if ($bad.Count) {
    Write-Error ('restore-visual-studio: could not set ' + ($bad -join '; '))
    exit 2
}
Write-Output ('Restored Visual Studio: ' + $copied + ' folders in place, ' + $set + ' registry values set')
exit 0
