#Requires -Version 5.1
# Writes string registry values from a plan (guest/toolchains/engines/unreal-engines.ts: the Unreal engines'
# registration and the .uproject file association; what goes where is decided in shared/unreal/engines.ts). -PlanFile
# is JSON written by the runtime:
#   values: [{ hive: 'HKLM' | 'HKCU', key, name, value }]   64-bit view, '' = the default value
# Safe to run again. Exit 0 when every value is set, 2 when one could not be.
param([Parameter(Mandatory = $true)][string]$PlanFile)
$ErrorActionPreference = 'Stop'

$plan = Get-Content -LiteralPath $PlanFile -Raw -Encoding UTF8 | ConvertFrom-Json
$failed = New-Object System.Collections.ArrayList
$set = 0
foreach ($v in @($plan.values)) {
    $hive = if ($v.hive -eq 'HKLM') { [Microsoft.Win32.RegistryHive]::LocalMachine } else { [Microsoft.Win32.RegistryHive]::CurrentUser }
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, [Microsoft.Win32.RegistryView]::Registry64)
    try {
        $key = $base.CreateSubKey([string]$v.key)
        try {
            $key.SetValue([string]$v.name, [string]$v.value, [Microsoft.Win32.RegistryValueKind]::String)
            $set++
        } finally {
            $key.Close()
        }
    } catch {
        [void]$failed.Add($v.hive + '\' + $v.key + ' ' + $v.name + ' (' + $_.Exception.Message + ')')
    } finally {
        $base.Close()
    }
}
if ($failed.Count) {
    Write-Host ('Could not set: ' + ($failed -join '; '))
    exit 2
}
Write-Host ('Set ' + $set + ' registry values')
exit 0
