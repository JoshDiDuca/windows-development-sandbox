#Requires -Version 5.1
# Puts -Dir first on your PATH (-Add) or takes it off, then tells Windows it changed. -Query only asks: exit 0 when it is on
# your stored PATH, 1 when not. Exit 3: PATH would be too long.
# The fallback for HostTools.exe user-path (host/agent-commands/user-path.ts).
param(
    [Parameter(Mandatory = $true)][string]$Dir,
    [switch]$Add,

    [switch]$Query
)
$ErrorActionPreference = 'Stop'

Add-Type -Path (Join-Path $PSScriptRoot '..\csharp\HostTools\UserPath.cs')
if ($Query) { exit [AgentSandbox.UserPath]::Has($Dir) }
exit [AgentSandbox.UserPath]::Edit($Dir, [bool]$Add)
