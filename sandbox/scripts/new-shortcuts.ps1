#Requires -Version 5.1
# Creates .lnk shortcuts (desktop, Start menu) in one call (guest/apps, the VS Code step). -ListFile is JSON written by
# the runtime: [{ link, target, workingDirectory?, arguments? }].
param([Parameter(Mandatory = $true)][string]$ListFile)
$ErrorActionPreference = 'Stop'

$shell = New-Object -ComObject WScript.Shell
# Windows PowerShell 5.1 hands a JSON array over as ONE object: pipe it through ForEach-Object to get its elements.
$entries = @(ConvertFrom-Json -InputObject (Get-Content -LiteralPath $ListFile -Raw -Encoding UTF8) | ForEach-Object { $_ })
foreach ($entry in $entries) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $entry.link) | Out-Null
    $shortcut = $shell.CreateShortcut($entry.link)
    $shortcut.TargetPath = $entry.target
    if ($entry.workingDirectory) { $shortcut.WorkingDirectory = $entry.workingDirectory }
    if ($entry.arguments) { $shortcut.Arguments = $entry.arguments }
    $shortcut.Save()
}
