#Requires -Version 5.1
# Machine-wide environment variables and PATH folders, so every new terminal tab and anything an agent starts sees the
# same tools (guest/setup/environment.ts). -SettingsFile is JSON written by the runtime:
#   vars: { name: value }   set machine-wide (with additive: only the ones not set yet)
#   path: string | null      replaces the machine PATH (already ordered and de-duplicated by the runtime)
#   add: [folders]           added to PATH when missing: in front, or (additive) at the end
#   create: [folders]        created first (folders a tool fills in later, such as pip's Scripts)
# The PATH is always saved without duplicates (case, trailing slash) and Explorer / Windows Terminal are told.
param([Parameter(Mandatory = $true)][string]$SettingsFile)
$ErrorActionPreference = 'Stop'

$settings = Get-Content -LiteralPath $SettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
$additive = [bool]$settings.additive

function Get-Key([string]$folder) {
    $key = $folder.Trim().Trim('"')
    if ($key.Length -gt 3) { $key = $key.TrimEnd('\', '/') }
    return $key.ToLowerInvariant()
}

function Join-Folders([string[]]$folders) {
    $seen = @{}
    $kept = foreach ($folder in $folders) {
        if ([string]::IsNullOrWhiteSpace($folder)) { continue }
        $key = Get-Key $folder
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $folder.Trim()
    }
    return ($kept -join ';')
}

foreach ($folder in @($settings.create)) {
    if ($folder) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
}

# The boot, its background re-persist and the daemon can all run this script: the read-modify-write of the machine
# Environment key happens under one named mutex (an abandoned mutex, from a killed script, is ours to take).
$mutex = New-Object System.Threading.Mutex($false, 'Global\AgentSandboxMachineEnv')
$owned = $false
try {
    try {
        $owned = $mutex.WaitOne(60000)
    } catch [System.Threading.AbandonedMutexException] {
        $owned = $true
    }
    if (-not $owned) { throw 'Another script has held the machine environment lock for over 60 seconds' }
    foreach ($variable in $settings.vars.PSObject.Properties) {
        if ($additive -and [Environment]::GetEnvironmentVariable($variable.Name, 'Machine')) { continue }
        [Environment]::SetEnvironmentVariable($variable.Name, [string]$variable.Value, 'Machine')
    }

    if ($null -ne $settings.path) {
        [Environment]::SetEnvironmentVariable('Path', (Join-Folders ([string]$settings.path -split ';')), 'Machine')
    }

    if ($settings.add) {
        $current = [Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';'
        $known = @{}
        foreach ($folder in $current) { $known[(Get-Key $folder)] = $true }
        $missing = @($settings.add | Where-Object { -not $known.ContainsKey((Get-Key $_)) })
        if ($missing.Count) {
            $combined = if ($additive) { $current + $missing } else { $missing + $current }
            [Environment]::SetEnvironmentVariable('Path', (Join-Folders $combined), 'Machine')
        }
    }
} finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

try {
    Add-Type -Path (Join-Path $PSScriptRoot '..\csharp\EnvBroadcast.cs')
    [AgentSandbox.EnvBroadcast]::Notify()
} catch {
    # Programs started later read the registry anyway; only windows that are already open miss the news.
}
