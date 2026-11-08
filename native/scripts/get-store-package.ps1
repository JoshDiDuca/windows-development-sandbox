#Requires -Version 5.1
# Fetches a Microsoft Store app's package files (the .msix and the frameworks it needs) into -OutDir with this PC's own
# Store tooling: winget download --source msstore, which uses your own Windows / Microsoft Store access (the script
# never holds or asks for an account token). Prints one line of JSON: { ok, message, files: [file names in OutDir],
# dependencies: [the names among them that are frameworks] }.
# host/apps/store-package.ts hashes and checks the files; the sandbox installs them with Add-AppxPackage.
param(
    [Parameter(Mandatory = $true)][string]$ProductId,
    [Parameter(Mandatory = $true)][string]$PackageName,
    [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = 'Stop'

function Finish([bool]$ok, [string]$message, $files, $dependencies) {
    @{ ok = $ok; message = $message; files = @($files); dependencies = @($dependencies) } | ConvertTo-Json -Compress
    exit 0
}

if ($ProductId -notmatch '^[A-Z0-9]{12}$') { Finish $false 'That is not a Microsoft Store product id.' @() @() }
if ($PackageName -notmatch '^[A-Za-z0-9.]{1,100}$') { Finish $false 'That is not a package name.' @() @() }

$winget = $null
$command = Get-Command -Name winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($command) { $winget = $command.Source }
if (-not $winget) {
    $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
    if (Test-Path -LiteralPath $alias) { $winget = $alias }
}
if (-not $winget) {
    Finish $false 'winget is not on this PC. Install "App Installer" from the Microsoft Store, then launch again.' @() @()
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
# x64 only: the sandbox is 64-bit Windows. winget puts the app in -OutDir and its frameworks (VCLibs, WindowsAppRuntime,
# .NET runtime ...) in -OutDir\Dependencies; they are all needed, and installed first by the sandbox.
$output = & $winget download --id $ProductId --source msstore --architecture x64 --download-directory $OutDir `
    --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Out-String
$code = $LASTEXITCODE

$found = @(Get-ChildItem -LiteralPath $OutDir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -match '^\.(msix|appx|msixbundle|appxbundle)$' })
if ($code -ne 0 -or $found.Count -eq 0) {
    $tail = ($output -replace '[^\x20-\x7E\r\n]', '').Trim()
    if ($tail.Length -gt 400) { $tail = $tail.Substring($tail.Length - 400) }
    $installed = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue | Select-Object -First 1
    $extra = ''
    if ($installed) {
        $extra = ' The app is installed on this PC (' + $installed.Version + '), but Windows does not let its signed package be exported from there.'
    }
    Finish $false ('winget could not download the package (exit ' + $code + ').' + $extra + ' ' + $tail) @() @()
}

# Everything goes up to -OutDir (host code reads the files by name). A name with characters the sandbox's file check
# refuses (spaces, brackets) is changed to plain ones; the file itself is not touched.
$root = (Resolve-Path -LiteralPath $OutDir).Path
$names = @()
$dependencies = @()
foreach ($file in $found) {
    $isDependency = (Split-Path -Parent $file.FullName) -ne $root
    $name = $file.Name -replace '[^A-Za-z0-9._~+-]', '_'
    $target = Join-Path $root $name
    if ($file.FullName -ne $target) {
        if ($names -contains $name) { $name = ([guid]::NewGuid().ToString('N').Substring(0, 6)) + '_' + $name; $target = Join-Path $root $name }
        Move-Item -LiteralPath $file.FullName -Destination $target -Force
    }
    $names += $name
    if ($isDependency) { $dependencies += $name }
}
Finish $true 'ok' $names $dependencies
