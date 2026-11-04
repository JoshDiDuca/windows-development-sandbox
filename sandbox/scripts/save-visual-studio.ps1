#Requires -Version 5.1
# Saves a finished Visual Studio install onto the data disk, once (guest/toolchains/native/visual-studio.ts; what goes
# where is decided in vs-persist.ts). -PlanFile is JSON written by the runtime:
#   copies:     [{ name, from, to, optional }]   each mirrored with robocopy (/MIR); a missing optional one is skipped
#   registry:   [{ view: '64'|'32', key, names: [..] | null, recurse }]   string and DWORD values read under HKLM
#   resultFile: where the result goes, as JSON: { copied: [names], registry: [{ view, key, name, kind, value }] }
# -LowPriority runs it (and robocopy) below normal priority. Safe to run again: robocopy copies only what differs.
# Exit 0 when every copy worked, 1 when one failed (no result file then), 2 for a bad plan.
param(
    [Parameter(Mandatory = $true)][string]$PlanFile,
    [switch]$LowPriority
)
$ErrorActionPreference = 'Stop'

if ($LowPriority) {
    try {
        [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
    } catch {
        # Normal priority only makes the copy compete a little more with the sessions.
    }
}

$plan = Get-Content -LiteralPath $PlanFile -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $plan.resultFile -or -not $plan.copies) {
    Write-Error 'save-visual-studio: the plan has no copies or no result file'
    exit 2
}
$robocopy = Join-Path $env:SystemRoot 'System32\Robocopy.exe'

function Copy-Folder([string]$From, [string]$To) {
    New-Item -ItemType Directory -Force -Path $To | Out-Null
    # /MIR drops files a previous capture left; /XJ skips links (the data disk refuses them); /A-:R keeps read-only
    # files rewritable by the next capture.
    & $robocopy $From $To /MIR /COPY:DAT /XJ /A-:R /R:1 /W:1 /MT:16 /NP /NFL /NDL /NJH /NJS | Where-Object { $_ -and $_.Trim() } | Out-Host
    return $LASTEXITCODE
}

$copied = New-Object System.Collections.ArrayList
$failed = New-Object System.Collections.ArrayList
foreach ($copy in @($plan.copies)) {
    if (-not (Test-Path -LiteralPath $copy.from -PathType Container)) {
        if ($copy.optional) { continue }
        [void]$failed.Add($copy.name + ' (' + $copy.from + ' is missing)')
        continue
    }
    $code = Copy-Folder -From $copy.from -To $copy.to
    if ($code -ge 8) { [void]$failed.Add($copy.name + ' (robocopy ' + $code + ')') } else { [void]$copied.Add([string]$copy.name) }
}
if ($failed.Count) {
    Write-Error ('save-visual-studio: could not save ' + ($failed -join ', '))
    exit 1
}

function Get-View([string]$View) {
    if ($View -eq '32') { return [Microsoft.Win32.RegistryView]::Registry32 }
    return [Microsoft.Win32.RegistryView]::Registry64
}

function Read-Values([Microsoft.Win32.RegistryKey]$Key, [string]$Path, [string]$View, $Names, [bool]$Recurse, $Out) {
    $options = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
    foreach ($name in $Key.GetValueNames()) {
        if ($null -ne $Names -and -not ($Names -contains $name)) { continue }
        $kind = $Key.GetValueKind($name)
        $value = $Key.GetValue($name, $null, $options)
        $label = $null
        if ($kind -eq [Microsoft.Win32.RegistryValueKind]::String) { $label = 'string' }
        elseif ($kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) { $label = 'expand' }
        elseif ($kind -eq [Microsoft.Win32.RegistryValueKind]::DWord) { $label = 'dword'; $value = [int]$value }
        if ($null -eq $label -or $null -eq $value) { continue }
        [void]$Out.Add([ordered]@{ view = $View; key = $Path; name = $name; kind = $label; value = $value })
    }
    if (-not $Recurse) { return }
    foreach ($sub in $Key.GetSubKeyNames()) {
        $child = $Key.OpenSubKey($sub)
        if ($null -eq $child) { continue }
        try {
            Read-Values -Key $child -Path ($Path + '\' + $sub) -View $View -Names $Names -Recurse $true -Out $Out
        } finally {
            $child.Close()
        }
    }
}

$values = New-Object System.Collections.ArrayList
foreach ($read in @($plan.registry)) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, (Get-View $read.view))
    try {
        $key = $base.OpenSubKey([string]$read.key)
        if ($null -eq $key) { continue }
        try {
            $names = $null
            if ($null -ne $read.names) { $names = @($read.names) }
            Read-Values -Key $key -Path ([string]$read.key) -View ([string]$read.view) -Names $names -Recurse ([bool]$read.recurse) -Out $values
        } finally {
            $key.Close()
        }
    } finally {
        $base.Close()
    }
}

$result = [ordered]@{ copied = @($copied.ToArray()); registry = @($values.ToArray()) }
$json = ConvertTo-Json -InputObject $result -Depth 6
[System.IO.File]::WriteAllText($plan.resultFile, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Output ('Saved Visual Studio: ' + $copied.Count + ' folders, ' + $values.Count + ' registry values')
exit 0
