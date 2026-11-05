#Requires -Version 5.1
# Starts an installed Microsoft Store app with command-line arguments (a shortcut to shell:AppsFolder cannot pass any).
# The Perplexity desktop app is started with its own profile folder and its DevTools port, so the sandbox can keep
# its perplexity.ai sign-in (guest/browser/perplexity-app.ts). -Port 0 picks a free port, written to the profile.
param(
    [Parameter(Mandatory = $true)][string]$PackageName,
    [string]$UserDataDir = '',
    [int]$Port = -1
)
$ErrorActionPreference = 'Stop'

if ($PackageName -notmatch '^[A-Za-z0-9.]{1,100}$') { throw 'That is not a package name.' }
$package = Get-AppxPackage -Name $PackageName -ErrorAction Stop | Select-Object -First 1
if (-not $package) { throw ($PackageName + ' is not installed.') }
$manifest = Get-AppxPackageManifest -Package $package
$application = @($manifest.Package.Applications.Application)[0]
$aumid = $package.PackageFamilyName + '!' + $application.Id

$arguments = ''
if ($UserDataDir) {
    New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
    Remove-Item -LiteralPath (Join-Path $UserDataDir 'DevToolsActivePort') -Force -ErrorAction SilentlyContinue
    $arguments = '--user-data-dir="' + $UserDataDir + '"'
}
if ($Port -ge 0) { $arguments = ($arguments + ' --remote-debugging-port=' + $Port).Trim() }

Add-Type -Path (Join-Path $PSScriptRoot '..\csharp\AppActivation.cs')
$processId = [SbxAppActivation]::Start($aumid, $arguments)
Write-Output $processId
