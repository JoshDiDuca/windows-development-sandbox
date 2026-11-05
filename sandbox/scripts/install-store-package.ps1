#Requires -Version 5.1
# Installs a Microsoft Store app from its package files with Add-AppxPackage (guest/apps/store-app.ts). -ListFile is
# JSON written by the runtime: { main: "<full path of the app's .msix>", dependencies: ["<full path>", ...] }. The
# package keeps the publisher's signature (nothing is repacked), so Windows checks it as it would any Store package.
# The sandbox's Windows is new on every boot: this runs on every boot, from the package kept on the data disk.
param(
    [Parameter(Mandatory = $true)][string]$ListFile,
    [Parameter(Mandatory = $true)][string]$PackageName
)
$ErrorActionPreference = 'Stop'

if ($PackageName -notmatch '^[A-Za-z0-9.]{1,100}$') { throw 'That is not a package name.' }
$list = ConvertFrom-Json -InputObject (Get-Content -LiteralPath $ListFile -Raw -Encoding UTF8)
$dependencies = @()
if ($list.dependencies) { $dependencies = @($list.dependencies | ForEach-Object { $_ }) }

$existing = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $existing) {
    if ($dependencies.Count -gt 0) {
        Add-AppxPackage -Path $list.main -DependencyPath $dependencies
    }
    else {
        Add-AppxPackage -Path $list.main
    }
    $existing = Get-AppxPackage -Name $PackageName -ErrorAction Stop | Select-Object -First 1
}
[pscustomobject]@{ name = [string]$existing.Name; version = [string]$existing.Version; family = [string]$existing.PackageFamilyName } |
    ConvertTo-Json -Compress
