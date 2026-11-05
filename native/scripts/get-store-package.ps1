#Requires -Version 5.1
# Fetches a Microsoft Store app's package files (the .msix and the frameworks it needs) into -OutDir with this PC's own
# Store tooling: winget download --source msstore, which uses your own Windows / Microsoft Store access (the script
# never holds or asks for an account token). Prints one line of JSON: { ok, message, files: [file names in OutDir] }.
# host/apps/store-package.ts hashes and checks the files; the sandbox installs them with Add-AppxPackage.
param(
    [Parameter(Mandatory = $true)][string]$ProductId,
    [Parameter(Mandatory = $true)][string]$PackageName,
    [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = 'Stop'

function Finish([bool]$ok, [string]$message, $files) {
    @{ ok = $ok; message = $message; files = @($files) } | ConvertTo-Json -Compress
    exit 0
}

if ($ProductId -notmatch '^[A-Z0-9]{12}$') { Finish $false 'That is not a Microsoft Store product id.' @() }
if ($PackageName -notmatch '^[A-Za-z0-9.]{1,100}$') { Finish $false 'That is not a package name.' @() }

$winget = $null
$command = Get-Command -Name winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($command) { $winget = $command.Source }
if (-not $winget) {
    $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
    if (Test-Path -LiteralPath $alias) { $winget = $alias }
}
if (-not $winget) {
    Finish $false 'winget is not on this PC. Install "App Installer" from the Microsoft Store, then launch again.' @()
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$output = & $winget download --id $ProductId --source msstore --download-directory $OutDir `
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
    Finish $false ('winget could not download the package (exit ' + $code + ').' + $extra + ' ' + $tail) @()
}

# Frameworks may come in a sub-folder: bring every package file up to -OutDir (host code reads them by name).
$names = @()
foreach ($file in $found) {
    if ((Split-Path -Parent $file.FullName) -ne (Resolve-Path -LiteralPath $OutDir).Path) {
        Move-Item -LiteralPath $file.FullName -Destination (Join-Path $OutDir $file.Name) -Force
    }
    $names += $file.Name
}
Finish $true 'ok' $names
