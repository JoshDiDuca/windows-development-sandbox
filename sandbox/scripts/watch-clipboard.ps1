#Requires -Version 5.1
# Prints "changed" each time the clipboard changes, until process -ProcessId ends (shared/pty/clipboard-watch.ts).
# Exit code: 0 = the process ended, 2 = it could not be opened (see SbxClipboardWatch.Run in csharp\ClipboardWatch.cs).
param([Parameter(Mandatory = $true)][uint32]$ProcessId)
$ErrorActionPreference = 'Stop'

Add-Type -Path @((Join-Path $PSScriptRoot '..\csharp\ClipboardText.cs'), (Join-Path $PSScriptRoot '..\csharp\ClipboardWatch.cs'))
exit [SbxClipboardWatch]::Run($ProcessId)
