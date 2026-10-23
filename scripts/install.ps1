# windows-development-sandbox installer. Run it in PowerShell:
#   irm https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/install.ps1 | iex
# It asks "1) Just me  2) Everyone on this PC (needs admin)", checks this PC can run Windows Sandbox (and offers to turn
# the feature on), then installs the tool with a private Node.js used only by it (nothing else is installed system-wide).
# With options (the file is run as a script block, since irm | iex cannot pass options):
#   & ([scriptblock]::Create((irm https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/install.ps1))) -Scope AllUsers -AutoUpdate
#   -Scope CurrentUser|AllUsers   Where to install (env WDS_SCOPE). AllUsers needs an admin PowerShell.
#   -AutoUpdate / -NoAutoUpdate   Install new versions by itself (env WDS_AUTOUPDATE=1 / 0); asked once when neither is given.
#   -AddUsers a,b                 AllUsers: also put these Windows users in the group "Agent Sandbox Users" (env WDS_ADDUSERS).
#   -Share / -NoShare             AllUsers: let the group use a sandbox you start, or not (env WDS_SHARE=1 / 0); asked
#                                 once when neither is given.
#   -ContainedStorageHelper / -NoContainedStorageHelper
#                                 AllUsers: install the storage helper (the Windows service AgentSandboxStorage), so
#                                 contained storage mounts its disk image without a permission prompt each time, or remove
#                                 it (env WDS_STORAGEHELPER=1 / 0); asked once when neither is given (default no).
#   -Uninstall [-RemoveData]      Remove the program (and, with -RemoveData, the saved data, after you type DELETE; or
#                                 pass -Confirm:$false). Env WDS_UNINSTALL=1, WDS_REMOVEDATA=1.
#   -Version x.y.z                Install this release instead of the latest, also an older one than the installed one
#                                 (env WDS_VERSION). Your saved data is never touched.
#   -StartMenuShortcut            Also make a Start menu shortcut (env WDS_SHORTCUT=1). Off by default: some antivirus
#                                 tools (Malwarebytes: "Trojan.Loader") flag a shortcut that starts a command script.
# If an upgrade fails after it started changing the install, the previous version is put back (pointers and commands),
# automatic updates are switched off (and the scheduled task removed for AllUsers) and the message says so.
# Other environment variables: WDS_PACKAGE (install this tgz or URL instead of the latest release), WDS_SHA256 (its
# checksum), WDS_ALLOW_UNVERIFIED=1 (install a release GitHub lists no checksum for), WDS_INSTALL_ROOT (CurrentUser: the
# install folder, default %LOCALAPPDATA%\WindowsDevelopmentSandbox).
# The release package must match the SHA-256 GitHub lists for it; with none listed the install is refused.
# Windows PowerShell 5.1 compatible. The work runs in a script block so `return` never closes the user's window under iex.
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  # '' is allowed so that a missing WDS_SCOPE is not an error when this file is run with iex (it checks defaults too).
  [ValidateSet('', 'CurrentUser', 'AllUsers')][string]$Scope = $env:WDS_SCOPE,
  [switch]$AutoUpdate,
  [switch]$NoAutoUpdate,
  [string[]]$AddUsers,
  [switch]$Share,
  [switch]$NoShare,
  [switch]$ContainedStorageHelper,
  [switch]$NoContainedStorageHelper,
  [switch]$Uninstall,
  [switch]$RemoveData,
  # An exact release to install (also an older one than the installed version); empty: the latest.
  [ValidatePattern('^(\d+\.\d+\.\d+)?$')][string]$Version = $env:WDS_VERSION,
  [switch]$StartMenuShortcut,
  # Test aid: prints the text of one shim as kind:name:target (cmd:sandbox:dist/bin/sandbox.js) and stops.
  [string]$PrintShim
)
& {
  # Not 'Stop': Windows PowerShell 5.1 would turn warnings on stderr into fatal errors.
  $ErrorActionPreference = 'Continue'
  $repo = 'JoshDiDuca/windows-development-sandbox'
  $packageName = 'windows-development-sandbox'
  $groupName = 'Agent Sandbox Users'
  $feature = 'Containers-DisposableClientVM'
  $enableCommand = "Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart"
  $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
  $interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
  $problems = New-Object System.Collections.Generic.List[string]
  $rebootNeeded = $false

  function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
  function Ok($text) { Write-Host "   OK      $text" -ForegroundColor Green }
  function Warn($text) { Write-Host "   WARNING $text" -ForegroundColor Yellow }
  function Problem($text) { Write-Host "   PROBLEM $text" -ForegroundColor Red; $problems.Add([string]$text) }
  function Ask($question) {
    if (-not $interactive) { return $false }
    $answer = Read-Host "   $question [y/N]"
    return $answer -match '^(y|yes)$'
  }
  function Test-Admin {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  }
  function Refresh-Path {
    # Keep what this session already had and add what installers registered.
    $pathParts = @($env:Path -split ';') + @([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';') + @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';')
    $env:Path = ($pathParts | Where-Object { $_ } | Select-Object -Unique) -join ';'
  }
  function Remove-Inside($path, $root) {
    # The only deletes in this script: a folder this script made, never anything outside the folder it was given.
    $full = [IO.Path]::GetFullPath($path).TrimEnd('\')
    $base = [IO.Path]::GetFullPath($root).TrimEnd('\')
    if (-not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "refusing to delete $full (not inside $base)" }
    if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue }
  }
  function Write-TextAtomic($path, $text, $encoding) {
    # Written next to the target, then renamed over it: a reader sees the old file or the new one, never half of one.
    New-Item -ItemType Directory -Force (Split-Path -Parent $path) | Out-Null
    $temp = $path + '.tmp-' + [guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($temp, $text, $encoding)
    Move-Item -LiteralPath $temp -Destination $path -Force
  }
  function Write-AsciiAtomic($path, $text) { Write-TextAtomic $path $text (New-Object Text.ASCIIEncoding) }
  function Write-JsonAtomic($path, $object) { Write-TextAtomic $path (($object | ConvertTo-Json -Depth 6) + "`r`n") (New-Object Text.UTF8Encoding($false)) }
  function Write-Pointer($path, $value, $pattern) {
    if ($value -notmatch $pattern) { throw "refusing to write '$value' to $path" }
    Write-AsciiAtomic $path ($value + "`r`n")
  }
  function Read-Pointer($path, $pattern) {
    try { $value = ([IO.File]::ReadAllText($path)).Trim() } catch { return $null }
    if ($value -match $pattern) { return $value }
    return $null
  }
  function Get-ShimText($kind, $name, $target) {
    # The same text as shimText() in src/host/install/shims.ts (a self-test compares them): change both together.
    if ($name -notmatch '^[a-z0-9][a-z0-9-]*$') { throw "$name is not a command name" }
    if ($target -notmatch '^[A-Za-z0-9_./-]+$' -or $target -match '\.\.') { throw "$target is not a program path inside the package" }
    if ($kind -eq 'sh') {
      return (@(
        '#!/bin/sh',
        '# Generated by windows-development-sandbox. Runs the version that active-version points to.',
        'root=$(cd "$(dirname "$0")/.." && pwd)',
        'node_version=$(tr -d "\r\n" < "$root/active-node")',
        'version=$(tr -d "\r\n" < "$root/active-version")',
        ('exec "$root/node/$node_version/node.exe" "$root/versions/$version/package/' + $target + '" "$@"'),
        ''
      ) -join "`n")
    }
    return (@(
      '@echo off',
      'setlocal',
      'set /p V=<"%~dp0..\active-version"',
      'set /p N=<"%~dp0..\active-node"',
      ('"%~dp0..\node\%N%\node.exe" "%~dp0..\versions\%V%\package\' + $target.Replace('/', '\') + '" %*'),
      ''
    ) -join "`r`n")
  }

  if ($PrintShim) {
    $parts = $PrintShim -split ':', 3
    $shimTarget = if ($parts.Count -ge 3) { $parts[2] } else { 'dist/bin/' + $parts[1] + '.js' }
    [Console]::Out.Write((Get-ShimText $parts[0] $parts[1] $shimTarget))
    return
  }

  # Environment fallbacks, for irm | iex where no options can be passed.
  if ($env:WDS_UNINSTALL -eq '1') { $Uninstall = [switch]$true }
  if ($env:WDS_REMOVEDATA -eq '1') { $RemoveData = [switch]$true }
  if ($env:WDS_AUTOUPDATE -eq '1') { $AutoUpdate = [switch]$true }
  if ($env:WDS_AUTOUPDATE -eq '0') { $NoAutoUpdate = [switch]$true }
  if ($env:WDS_SHARE -eq '1') { $Share = [switch]$true }
  if ($env:WDS_SHARE -eq '0') { $NoShare = [switch]$true }
  if ($env:WDS_STORAGEHELPER -eq '1') { $ContainedStorageHelper = [switch]$true }
  if ($env:WDS_STORAGEHELPER -eq '0') { $NoContainedStorageHelper = [switch]$true }
  if ($env:WDS_SHORTCUT -eq '1') { $StartMenuShortcut = [switch]$true }
  if ($env:WDS_ADDUSERS -and -not $AddUsers) { $AddUsers = @($env:WDS_ADDUSERS -split ',') }
  $usersToAdd = @($AddUsers | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

  function Open-PathKey($machine) {
    if ($machine) { return [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment') }
    return [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  }
  function Send-EnvironmentChange {
    # Tell running programs (Explorer, so new terminals) that the environment changed.
    try {
      Add-Type -Namespace WdsInstall -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);' -ErrorAction Stop
    } catch { }
    try {
      $ignored = [UIntPtr]::Zero
      [void][WdsInstall.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$ignored)
    } catch { Warn 'Open a new terminal (or sign out and in) to pick up the new PATH.' }
  }
  function Add-PathEntry($dir, $machine) {
    # Adds this one folder to the PATH (yours, or the whole PC's) and touches nothing else in it. The value is read and
    # written back unexpanded (so entries such as %USERPROFILE%\bin stay as they are), and a PATH that would get too
    # long is left alone.
    $key = Open-PathKey $machine
    try {
      $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if (@($raw -split ';') | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') }) { return }
      $new = if ($raw) { $raw.TrimEnd(';') + ';' + $dir } else { $dir }
      if ($new.Length -gt 32000) { Warn "Your PATH is too long to add $dir. Add it yourself in Settings > System > About > Advanced system settings > Environment Variables."; return }
      $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
      $key.SetValue('Path', $new, $kind)
    } finally { $key.Close() }
    Send-EnvironmentChange
  }
  function Remove-PathEntry($dir, $machine) {
    $key = Open-PathKey $machine
    try {
      $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $kept = @($raw -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $dir.TrimEnd('\') })
      if ($kept.Count -eq @($raw -split ';' | Where-Object { $_ }).Count) { return }
      $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
      $key.SetValue('Path', ($kept -join ';'), $kind)
    } finally { $key.Close() }
    Send-EnvironmentChange
  }
  function Set-Shortcut($file, $target) {
    New-Item -ItemType Directory -Force (Split-Path -Parent $file) | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($file)
    $link.TargetPath = $target
    $link.Description = 'Windows Development Sandbox'
    $link.Save()
  }
  function Download-File($url, $file) {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest $url -OutFile $file -UseBasicParsing
  }
  function Test-Sha256($file, $expected) {
    return $expected -match '^[0-9a-fA-F]{64}$' -and (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ieq $expected
  }
  function Test-SandboxRunning { return [bool](Get-Process -Name 'WindowsSandbox*' -ErrorAction SilentlyContinue) }
  function Remove-StorageHelper($packageDir) {
    # The storage helper service (installs for everyone only): its own script stops it, dismounts what it mounted and
    # deletes it. A version without that script but a service left behind: stopped and deleted here. Nothing installed:
    # nothing to do.
    if (-not (Get-Service -Name 'AgentSandboxStorage' -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath (Join-Path $toolFolder 'helper'))) { return }
    $removeScript = if ($packageDir) { Join-Path $packageDir 'native\scripts\set-storage-helper.ps1' } else { $null }
    if ($removeScript -and (Test-Path -LiteralPath $removeScript)) {
      $removeOutput = & $powershellExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $removeScript -Remove -InstallRoot $toolFolder 2>&1 | Out-String
      if ($removeOutput.Trim()) { Write-Host "   $($removeOutput.Trim())" }
      if ($LASTEXITCODE -eq 0) { Ok 'storage helper removed' } else { Warn "Could not remove the storage helper service AgentSandboxStorage (exit $LASTEXITCODE)." }
    } elseif (Get-Service -Name 'AgentSandboxStorage' -ErrorAction SilentlyContinue) {
      Stop-Service -Name 'AgentSandboxStorage' -Force -ErrorAction SilentlyContinue
      & (Join-Path $env:SystemRoot 'System32\sc.exe') delete AgentSandboxStorage | Out-Null
      if ($LASTEXITCODE -eq 0) { Ok 'storage helper removed' } else { Warn "Could not delete the service AgentSandboxStorage (exit $LASTEXITCODE)." }
    }
  }
  function Stop-Watchers {
    # A background watcher left by an older version (it outlived its sandbox) holds files that must be replaced. Stopped
    # only when no Windows Sandbox runs: while one does, its watcher is still needed.
    if (Test-SandboxRunning) { return }
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match '(windows-development-sandbox|agent-sandbox).*\s_watch(\s|$)' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Ok "stopped a leftover background watcher (process $($_.ProcessId))" }
  }

  Write-Host 'windows-development-sandbox installer' -ForegroundColor White
  Write-Host 'Runs AI coding agents in Windows Sandbox, a throwaway Windows that is wiped when it closes.'

  # Where to install -----------------------------------------------------------------------------------------------
  $scopeName = $Scope
  if (-not $scopeName -and $Uninstall) {
    # Remove what is installed: the one install there is, or ask which when there are both.
    $userRoot = if ($env:WDS_INSTALL_ROOT) { $env:WDS_INSTALL_ROOT } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'WindowsDevelopmentSandbox' } else { $null }
    $hasUser = $userRoot -and (Test-Path -LiteralPath (Join-Path $userRoot 'active-version'))
    $hasMachine = $env:ProgramFiles -and (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'WindowsDevelopmentSandbox\active-version'))
    if ($hasUser -and $hasMachine) {
      if (-not $interactive) { Problem 'There is an install for just you and one for everyone. Say which to remove with -Scope CurrentUser or -Scope AllUsers.'; return }
      Write-Host ''
      Write-Host '   Remove:'
      Write-Host '     1) The install for just me'
      Write-Host '     2) The install for everyone on this PC (needs admin)'
      $choice = Read-Host '   Choose 1 or 2'
      if ($choice -match '^\s*1') { $scopeName = 'CurrentUser' } elseif ($choice -match '^\s*2') { $scopeName = 'AllUsers' } else { Write-Host '   Nothing removed.'; return }
    } elseif ($hasMachine) { $scopeName = 'AllUsers' }
    else { $scopeName = 'CurrentUser' }
  }
  if (-not $scopeName) {
    if ($interactive -and -not $Uninstall) {
      Write-Host ''
      Write-Host '   Install for:'
      Write-Host '     1) Just me'
      Write-Host '     2) Everyone on this PC (needs admin)'
      $choice = Read-Host '   Choose 1 or 2 [1]'
      $scopeName = if ($choice -match '^\s*2') { 'AllUsers' } else { 'CurrentUser' }
    } else { $scopeName = 'CurrentUser' }
  }
  $machine = $scopeName -eq 'AllUsers'
  if (-not $env:LOCALAPPDATA -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) { Problem 'LOCALAPPDATA is not set, so there is nowhere safe to install.'; return }
  if ($machine) {
    if (-not $env:ProgramFiles -or -not [IO.Path]::IsPathRooted($env:ProgramFiles)) { Problem 'ProgramFiles is not set, so there is nowhere safe to install.'; return }
    $toolFolder = Join-Path $env:ProgramFiles 'WindowsDevelopmentSandbox'
  } elseif ($env:WDS_INSTALL_ROOT) {
    if (-not [IO.Path]::IsPathRooted($env:WDS_INSTALL_ROOT)) { Problem 'WDS_INSTALL_ROOT must be a full path.'; return }
    $toolFolder = [IO.Path]::GetFullPath($env:WDS_INSTALL_ROOT).TrimEnd('\')
  } else {
    # This tool's own folder, always under LOCALAPPDATA, never anything that could resolve to a profile or the current folder.
    $toolFolder = Join-Path $env:LOCALAPPDATA 'WindowsDevelopmentSandbox'
  }
  $binFolder = Join-Path $toolFolder 'bin'
  $machineData = Join-Path $(if ($env:ProgramData) { $env:ProgramData } else { 'C:\ProgramData' }) 'AgentSandbox'
  $shortcutFolder = [Environment]::GetFolderPath($(if ($machine) { 'CommonPrograms' } else { 'Programs' }))
  $shortcutFile = Join-Path $shortcutFolder 'Windows Development Sandbox.lnk'
  if ($machine -and -not (Test-Admin)) {
    Problem 'Installing for everyone needs admin rights.'
    Write-Host '   Run this in an admin PowerShell (right-click Start > Terminal (Admin)), or install for just you with -Scope CurrentUser.'
    return
  }

  # An install for just you cannot work next to one for everyone: the PC's PATH comes before yours, so every sandbox
  # command would still start the install for everyone (and an install that never runs says "OK" for nothing).
  if (-not $machine -and -not $Uninstall -and -not $env:WDS_INSTALL_ROOT -and $env:ProgramFiles -and (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'WindowsDevelopmentSandbox\active-version'))) {
    Problem 'There is already an install for everyone on this PC; an install for just you would never run (the PC''s PATH comes first).'
    Write-Host '   To use the install for everyone, nothing is needed: update it with sandbox update (admin) or install again with -Scope AllUsers.'
    Write-Host '   To switch to an install for just you, remove the one for everyone first, in an admin PowerShell:'
    Write-Host "     & ([scriptblock]::Create((irm https://github.com/$repo/releases/latest/download/install.ps1))) -Uninstall -Scope AllUsers"
    Write-Host '   then run this installer again with -Scope CurrentUser. Your saved data is kept.'
    return
  }

  # Uninstall ------------------------------------------------------------------------------------------------------
  if ($Uninstall) {
    Step "Removing windows-development-sandbox ($scopeName) from $toolFolder"
    $wasInstalled = Test-Path -LiteralPath $toolFolder
    Stop-Watchers
    $active = Read-Pointer (Join-Path $toolFolder 'active-version') '^\d+\.\d+\.\d+$'
    $taskScript = if ($active) { Join-Path $toolFolder "versions\$active\package\native\scripts\set-update-task.ps1" } else { $null }
    if ($machine -and $taskScript -and (Test-Path -LiteralPath $taskScript)) {
      & $powershellExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $taskScript -Remove | Out-Null
      if ($LASTEXITCODE -eq 0) { Ok 'automatic updates removed' } else { Warn "Could not remove the scheduled task \WindowsDevelopmentSandbox\Update (exit $LASTEXITCODE)." }
    }
    if ($machine) { Remove-StorageHelper $(if ($active) { Join-Path $toolFolder "versions\$active\package" } else { $null }) }
    Remove-PathEntry $binFolder $machine
    Ok 'taken off the PATH'
    if (Test-Path -LiteralPath $shortcutFile) { Remove-Item -LiteralPath $shortcutFile -Force -ErrorAction SilentlyContinue; Ok 'Start menu shortcut removed' }
    foreach ($name in 'bin', 'node', 'versions', 'staging', 'helper', 'active-version', 'active-node', 'install.json', 'update-state.json', 'update.lock') {
      Remove-Inside (Join-Path $toolFolder $name) $toolFolder
    }
    if ((Test-Path -LiteralPath $toolFolder) -and -not (Get-ChildItem -LiteralPath $toolFolder -Force)) { Remove-Item -LiteralPath $toolFolder -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $toolFolder) { Warn "$toolFolder still has files in it (something may be using them); delete it when nothing runs." }
    elseif ($wasInstalled) { Ok 'program removed' }
    else { Write-Host '   Nothing was installed there.' }
    # Just you: the shared per-user folder is the default now; data an older version left in your profile still counts.
    $userData = Join-Path $env:LOCALAPPDATA 'AgentSandbox'
    if (-not $machine -and -not (Test-Path -LiteralPath $userData)) { $userData = Join-Path $machineData "users\$env:USERNAME" }
    $dataFolder = if ($machine) { $machineData } else { $userData }
    if (-not $RemoveData) {
      Write-Host "   Your saved data is kept in $dataFolder. To delete it too: install.ps1 -Uninstall -Scope $scopeName -RemoveData"
    } elseif (Test-Path -LiteralPath $dataFolder) {
      $approved = $ConfirmPreference -eq 'None'
      if (-not $approved -and $interactive) {
        if ($machine) { Write-Host "   This deletes the saved data of EVERY user of this PC (accounts, history, sandbox settings) in $dataFolder." }
        else { Write-Host "   This deletes your saved data (accounts, history, sandbox settings) in $dataFolder." }
        $approved = (Read-Host '   Type DELETE to continue') -ceq 'DELETE'
      }
      if (-not $approved) { Warn 'Saved data was not deleted (nothing typed, or no terminal; use -Confirm:$false in scripts).' }
      else {
        if (Test-SandboxRunning) { Warn 'A Windows Sandbox is running; close it first for everything to be deleted.' }
        Remove-Item -LiteralPath $dataFolder -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $dataFolder) { Warn "Some files in $dataFolder could not be deleted." } else { Ok "saved data removed ($dataFolder)" }
        if ($machine) {
          try { Remove-LocalGroup -Name $groupName -ErrorAction Stop; Ok "group $groupName removed" } catch { }
        }
      }
    } else { Ok 'there was no saved data' }
    return
  }

  # 1. Windows edition -------------------------------------------------------------------------------------------
  Step 'Checking your Windows edition'
  $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  $edition = [string]$cv.EditionID
  $build = [int]$cv.CurrentBuildNumber
  if ($edition -like 'Core*') {
    Problem "This PC runs Windows Home ($edition). Windows Sandbox is only part of Windows Pro, Enterprise and Education."
    Write-Host '   Upgrade to Windows Pro (Settings > System > Activation), then run this installer again.'
    return
  }
  if ($edition -like 'Server*') {
    Problem "This is Windows Server ($edition). Windows Sandbox needs Windows 10/11 Pro, Enterprise or Education."
    return
  }
  if ($build -lt 18305) {
    Problem "Windows build $build is too old. Windows Sandbox needs Windows 10 version 1903 or newer; run Windows Update."
    return
  }
  if ($edition -match '^(Professional|Enterprise|Education|IoTEnterprise)') { Ok "$($cv.ProductName -replace 'Windows 10', $(if ($build -ge 22000) { 'Windows 11' } else { 'Windows 10' })) ($edition, build $build)" }
  else { Warn "Not sure edition '$edition' has Windows Sandbox (it needs Pro, Enterprise or Education). Carrying on." }

  # 2. Hardware --------------------------------------------------------------------------------------------------
  Step 'Checking virtualization and memory'
  $cs = Get-CimInstance Win32_ComputerSystem
  $cpus = @(Get-CimInstance Win32_Processor)
  # With Hyper-V running, the CPU reports firmware virtualization as off, so a running hypervisor also counts.
  if ($cs.HypervisorPresent -or ($cpus | Where-Object { $_.VirtualizationFirmwareEnabled })) { Ok 'CPU virtualization is on' }
  else {
    Problem 'CPU virtualization looks switched off.'
    Write-Host '   Restart into your BIOS/UEFI settings and turn on Intel VT-x / AMD-V (sometimes called SVM), then try again.'
  }
  $ramGb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
  if ($ramGb -lt 4) { Problem "Only $ramGb GB of memory. Windows Sandbox needs at least 4 GB." }
  elseif ($ramGb -lt 8) { Warn "$ramGb GB of memory. It works, but 8 GB or more is recommended." }
  else { Ok "$ramGb GB of memory" }

  # 3. Windows Sandbox feature -----------------------------------------------------------------------------------
  Step 'Checking the Windows Sandbox feature'
  $exe = Join-Path $env:SystemRoot 'System32\WindowsSandbox.exe'
  # InstallState 1 = enabled. The query needs the Windows servicing service; when that is off, go by the program file.
  try { $state = (Get-CimInstance Win32_OptionalFeature -Filter "Name='$feature'" -ErrorAction Stop).InstallState } catch { $state = $null }
  if ($null -eq $state -and (Test-Path $exe)) { $state = 1 }
  if ($state -eq 1 -and (Test-Path $exe)) { Ok 'Windows Sandbox is enabled' }
  elseif ($state -eq 1) { Warn 'Windows Sandbox is enabled, but Windows needs a restart to finish.'; $rebootNeeded = $true }
  else {
    Write-Host '   Windows Sandbox is not turned on yet.'
    if (Ask 'Turn it on now? Windows will ask for admin permission') {
      Write-Host '   Enabling Windows Sandbox (this can take a minute)...'
      try {
        $p = Start-Process -FilePath $powershellExe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', "$enableCommand | Out-Null"
        if ($p.ExitCode -eq 0) { Ok 'Windows Sandbox enabled. Restart Windows to finish.'; $rebootNeeded = $true }
        else { Problem "Enabling Windows Sandbox failed (exit code $($p.ExitCode))." }
      } catch { Problem 'The admin prompt was declined, so Windows Sandbox was not enabled.' }
    } else {
      Problem 'Windows Sandbox is not enabled.'
      Write-Host '   To turn it on yourself, run this in an admin PowerShell, then restart Windows:'
      Write-Host "     $enableCommand" -ForegroundColor White
    }
  }

  function Disable-AutoUpdate($reason) {
    # A failed install must not retry by itself: switch updates off in install.json and, for everyone, remove the scheduled
    # task (this window is an administrator then). Never throws: a task that stays still reads install.json and does nothing.
    try {
      $file = Join-Path $toolFolder 'install.json'
      if (Test-Path -LiteralPath $file) {
        $installSettings = Get-Content -LiteralPath $file -Raw -ErrorAction Stop | ConvertFrom-Json
        $installSettings | Add-Member -NotePropertyName autoUpdate -NotePropertyValue $false -Force
        Write-JsonAtomic $file $installSettings
      }
    } catch { Warn "Could not switch off automatic updates in install.json: $_" }
    if ($machine) {
      try {
        $current = Read-Pointer (Join-Path $toolFolder 'active-version') '^\d+\.\d+\.\d+$'
        $removeTaskScript = if ($current) { Join-Path $toolFolder "versions\$current\package\native\scripts\set-update-task.ps1" } else { $null }
        if ($removeTaskScript -and (Test-Path -LiteralPath $removeTaskScript)) { & $powershellExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $removeTaskScript -Remove | Out-Null }
      } catch { }
    }
    Write-Host "   Automatic updates are off ($reason). Turn them back on with: sandbox update --auto on" -ForegroundColor Yellow
  }

  # 4. What is installed now -------------------------------------------------------------------------------------
  Step 'Looking for an earlier install'
  $oldVersion = Read-Pointer (Join-Path $toolFolder 'active-version') '^\d+\.\d+\.\d+$'
  $oldNode = Read-Pointer (Join-Path $toolFolder 'active-node') '^v\d+\.\d+\.\d+$'
  $record = $null
  try { $record = Get-Content -LiteralPath (Join-Path $toolFolder 'install.json') -Raw -ErrorAction Stop | ConvertFrom-Json } catch { }
  # The commands of the version being replaced: its shims are put back if the new version fails.
  $oldBins = @{}
  if ($oldVersion) {
    try {
      $oldMeta = Get-Content -LiteralPath (Join-Path $toolFolder "versions\$oldVersion\package\package.json") -Raw -ErrorAction Stop | ConvertFrom-Json
      if ($oldMeta.bin) { foreach ($property in $oldMeta.bin.PSObject.Properties) { $oldBins[$property.Name] = [string]$property.Value } }
    } catch { }
    if (-not $oldBins.Count) { $oldBins['sandbox'] = 'dist/bin/sandbox.js' }
  }
  $packageFetched = $false
  $restoreFailed = $false
  function Restore-Previous($newBins, $shimsTouched, $pointersTouched) {
    # Puts the replaced version back: its pointers (when it is a different folder from the new one) and its shims, and
    # drops the commands only the new version had. Returns $true when the old version runs again.
    $ok = $true
    if (-not $oldVersion -or -not $oldNode) { return $false }
    if (($oldVersion -eq $newVersion -and -not $asideRestored) -or -not (Test-Path -LiteralPath (Join-Path $toolFolder "versions\$oldVersion\package\package.json"))) { return $false }
    try {
      if ($pointersTouched) {
        Write-Pointer (Join-Path $toolFolder 'active-node') $oldNode '^v\d+\.\d+\.\d+$'
        Write-Pointer (Join-Path $toolFolder 'active-version') $oldVersion '^\d+\.\d+\.\d+$'
      }
      if ($shimsTouched) {
        foreach ($command in $oldBins.Keys) {
          Write-AsciiAtomic (Join-Path $binFolder "$command.cmd") (Get-ShimText 'cmd' $command $oldBins[$command])
          Write-AsciiAtomic (Join-Path $binFolder $command) (Get-ShimText 'sh' $command $oldBins[$command])
        }
        foreach ($command in @($newBins.Keys)) {
          if (-not $oldBins.ContainsKey($command)) { Remove-Item -LiteralPath (Join-Path $binFolder "$command.cmd"), (Join-Path $binFolder $command) -Force -ErrorAction SilentlyContinue }
        }
      }
    } catch { Warn "Could not go back to version ${oldVersion}: $_"; $ok = $false }
    return $ok
  }
  # npm globals (the package under either name) and the 1.x private Node that ran them.
  $legacyNode = Join-Path $toolFolder 'node'
  $legacyNpms = New-Object System.Collections.Generic.List[string]
  $userNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($userNpm) { $legacyNpms.Add($userNpm.Source) }
  if (Test-Path -LiteralPath (Join-Path $legacyNode 'npm.cmd')) { $legacyNpms.Add((Join-Path $legacyNode 'npm.cmd')) }
  $npmGlobals = New-Object System.Collections.Generic.List[object]
  foreach ($npm in ($legacyNpms | Select-Object -Unique)) {
    foreach ($pkg in 'windows-development-sandbox', 'agent-sandbox') {
      $listed = (& $npm ls -g --depth=0 $pkg 2>$null | Out-String)
      if ($listed -match "$([regex]::Escape($pkg))@") { $npmGlobals.Add(@{ npm = $npm; package = $pkg }) }
    }
  }
  $legacyWrappers = @()
  if (Test-Path -LiteralPath $binFolder) {
    $legacyWrappers = @(Get-ChildItem -LiteralPath $binFolder -Filter '*.cmd' -File -ErrorAction SilentlyContinue | Where-Object {
      (Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue) -match '^@"[^"]+\.cmd" %\*\s*$'
    })
  }
  if ($oldVersion) { Ok "version $oldVersion is installed in $toolFolder; it is replaced by this one (and kept for a rollback)" }
  if ($npmGlobals.Count) { Write-Host "   Found the older npm install: $((@($npmGlobals | ForEach-Object { $_.package }) | Select-Object -Unique) -join ', '); it is removed once the new one works." }
  if ($legacyWrappers.Count) { Write-Host "   Found $($legacyWrappers.Count) command wrapper(s) of version 1.x in $binFolder; they are replaced." }
  if (-not $oldVersion -and -not $npmGlobals.Count -and -not $legacyWrappers.Count) { Ok 'nothing installed yet' }

  # 5. Private Node.js -------------------------------------------------------------------------------------------
  # Nothing is installed system-wide: a private Node (the official zip, checksum-verified) lives next to the tool and
  # runs only it. Only its commands go on the PATH, not node itself.
  Step 'Getting the private Node.js'
  $nodeVersion = $null
  try {
    New-Item -ItemType Directory -Force $toolFolder | Out-Null
    # A loop, not a pipeline: Windows PowerShell 5.1 passes a JSON array down the pipeline as ONE object.
    $lts = $null
    foreach ($release in (Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing)) { if ($release.lts) { $lts = $release.version; break } }
    if ($lts -notmatch '^v\d+\.\d+\.\d+$') { throw 'no Node.js LTS release found' }
    $nodeTarget = Join-Path $toolFolder "node\$lts"
    if (Test-Path -LiteralPath (Join-Path $nodeTarget 'node.exe')) { Ok "Node.js $lts is already here" }
    else {
      Write-Host "   Downloading Node.js $lts just for this tool (into $nodeTarget; nothing is installed system-wide) ..."
      $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
      $name = "node-$lts-win-$arch"
      # A fresh folder of our own for the download, so the only things deleted are folders made here.
      $work = Join-Path $toolFolder ('download-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Force $work | Out-Null
      try {
        $zip = Join-Path $work "$name.zip"
        Download-File "https://nodejs.org/dist/$lts/$name.zip" $zip
        $sums = (Invoke-WebRequest "https://nodejs.org/dist/$lts/SHASUMS256.txt" -UseBasicParsing).Content
        $expected = @($sums -split "`n" | Where-Object { $_ -match " $name\.zip\s*$" } | ForEach-Object { ($_ -split '\s+')[0] })
        if ($expected.Count -ne 1 -or -not (Test-Sha256 $zip $expected[0])) { throw "checksum mismatch for $name.zip" }
        $staging = Join-Path $work 'x'
        Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force
        if (-not (Test-Path -LiteralPath (Join-Path $staging "$name\node.exe"))) { throw 'node.exe is not in the download' }
        New-Item -ItemType Directory -Force (Split-Path -Parent $nodeTarget) | Out-Null
        Move-Item -LiteralPath (Join-Path $staging $name) -Destination $nodeTarget
      } finally { Remove-Inside $work $toolFolder }
      Ok "Node.js $lts in $nodeTarget"
    }
    $nodeVersion = $lts
  } catch {
    if ($oldNode -and (Test-Path -LiteralPath (Join-Path $toolFolder "node\$oldNode\node.exe"))) {
      Warn "Could not download Node.js ($_); keeping $oldNode."
      $nodeVersion = $oldNode
    } else {
      Problem "Could not download Node.js: $_"
      Write-Host '   Check your internet connection and run this again.'
      return
    }
  }
  $nodeExe = Join-Path $toolFolder "node\$nodeVersion\node.exe"

  # 6. The release package ---------------------------------------------------------------------------------------
  # Downloaded first and checked against the SHA-256 GitHub publishes for it. A package you named yourself with
  # WDS_PACKAGE is installed as given (and checked against WDS_SHA256 when you set it).
  Step 'Getting windows-development-sandbox'
  $download = Join-Path $toolFolder ('download-' + [guid]::NewGuid().ToString('N'))
  $tgz = $null
  try {
    New-Item -ItemType Directory -Force $download | Out-Null
    if ($env:WDS_PACKAGE) {
      if ($env:WDS_PACKAGE -match '^https?://') {
        $tgz = Join-Path $download 'package.tgz'
        Download-File $env:WDS_PACKAGE $tgz
        $packageFetched = $true
      } elseif (Test-Path -LiteralPath $env:WDS_PACKAGE -PathType Leaf) { $tgz = (Resolve-Path -LiteralPath $env:WDS_PACKAGE).ProviderPath }
      else { throw "WDS_PACKAGE ($env:WDS_PACKAGE) is not a file or an https address" }
      if ($env:WDS_SHA256) {
        if (-not (Test-Sha256 $tgz $env:WDS_SHA256)) { throw 'the package does not match WDS_SHA256' }
        Ok 'package found and its SHA-256 matches WDS_SHA256'
      } else { Warn 'Installing the package named in WDS_PACKAGE as given (no WDS_SHA256 to check it against).' }
    } else {
      $releaseUrl = if ($Version) { "https://api.github.com/repos/$repo/releases/tags/v$Version" } else { "https://api.github.com/repos/$repo/releases/latest" }
      $release = Invoke-RestMethod $releaseUrl -UseBasicParsing -Headers @{ 'User-Agent' = 'windows-development-sandbox-installer' }
      $asset = @($release.assets | Where-Object { $_.name -match '^windows-development-sandbox-\d+\.\d+\.\d+\.tgz$' })[0]
      if (-not $asset) { throw 'the release has no windows-development-sandbox-x.y.z.tgz' }
      $expected = if ("$($asset.digest)" -match '^sha256:([0-9a-fA-F]{64})$') { $Matches[1] } else { $null }
      if (-not $expected) {
        # Without a digest in the API, the release's SHA256SUMS file lists it.
        $sumsAsset = @($release.assets | Where-Object { $_.name -eq 'SHA256SUMS' })[0]
        if ($sumsAsset) {
          $sumsText = (Invoke-WebRequest $sumsAsset.browser_download_url -UseBasicParsing).Content
          if ($sumsText -is [byte[]]) { $sumsText = [Text.Encoding]::UTF8.GetString($sumsText) }
          foreach ($line in ($sumsText -split "`n")) { if ($line.Trim() -match "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($asset.name))$") { $expected = $Matches[1] } }
        }
      }
      $tgz = Join-Path $download $asset.name
      Download-File $asset.browser_download_url $tgz
      $packageFetched = $true
      if ($expected) {
        if (-not (Test-Sha256 $tgz $expected)) { throw 'the download does not match the SHA-256 GitHub lists for it' }
        Ok 'package downloaded and its SHA-256 matches'
      } elseif ($env:WDS_ALLOW_UNVERIFIED -eq '1') { Warn 'GitHub lists no SHA-256 for this package; installing it unverified because WDS_ALLOW_UNVERIFIED=1.' }
      else { throw 'GitHub lists no SHA-256 for this package, so it cannot be checked, and it is not installed. To install it anyway, set $env:WDS_ALLOW_UNVERIFIED = "1" and run the installer again.' }
    }
  } catch {
    Problem "Could not get the package: $_"
    Remove-Inside $download $toolFolder
    # Nothing was changed yet, so the earlier version still runs. A package that arrived but was refused (checksum) is a
    # failed install: automatic updates go off. No download at all (the network) is not: the next try may work.
    if ($oldVersion -and $packageFetched) {
      Write-Host "   Nothing was changed: you are still on version $oldVersion."
      Disable-AutoUpdate 'the package did not pass its checks'
    }
    return
  }

  # 7. Put the version in place, then switch to it ------------------------------------------------------------------
  Step "Installing into $toolFolder"
  $newVersion = $null
  $createdVersion = $false
  $asideDir = $null
  $asideRestored = $false
  $activated = $false
  $shimsTouched = $false
  $bins = @{}
  try {
    Stop-Watchers
    $stage = Join-Path $toolFolder ('staging\' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $stage | Out-Null
    try {
      & $tarExe -xf $tgz -C $stage
      if ($LASTEXITCODE -ne 0) { throw "tar could not unpack the package (exit code $LASTEXITCODE)" }
      $packageJson = Join-Path $stage 'package\package.json'
      if (-not (Test-Path -LiteralPath $packageJson)) { throw 'the package has no package/package.json' }
      $meta = Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json
      if ($meta.name -ne $packageName) { throw "the package is $($meta.name), not $packageName" }
      if ("$($meta.version)" -notmatch '^\d+\.\d+\.\d+$') { throw "the package has no x.y.z version ($($meta.version))" }
      $newVersion = "$($meta.version)"
      if ($oldVersion -and ([version]$newVersion) -lt ([version]$oldVersion)) { Write-Host "   Installing an older version: $newVersion over $oldVersion. Your saved data is not touched." -ForegroundColor Yellow }
      $versionDir = Join-Path $toolFolder "versions\$newVersion"
      if (Test-Path -LiteralPath $versionDir) {
        # A reinstall of the same version: the installed copy waits aside until the new one works, so a failure can put
        # it back. The name is not x.y.z, so nothing takes it for an installed version.
        $asideDir = Join-Path $toolFolder ("versions\$newVersion.previous-" + [guid]::NewGuid().ToString('N'))
        try { Move-Item -LiteralPath $versionDir -Destination $asideDir -ErrorAction Stop }
        catch { $asideDir = $null; throw "version $newVersion is installed and in use; close the sandbox and every terminal running it, then try again" }
      }
      New-Item -ItemType Directory -Force (Join-Path $toolFolder 'versions') | Out-Null
      Move-Item -LiteralPath $stage -Destination $versionDir
      $createdVersion = $true
    } finally { Remove-Inside (Join-Path $toolFolder 'staging') $toolFolder }
    $packageDir = Join-Path $versionDir 'package'
    $entry = Join-Path $packageDir 'dist\bin\sandbox.js'
    $started = (& $nodeExe $entry --version --short 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $started -ne $newVersion) { throw "version $newVersion did not start: $started" }
    Ok "version $newVersion starts"

    # The commands: one shim pair per bin entry of the package, then the pointers they read.
    $bins = @{}
    if ($meta.bin) { foreach ($property in $meta.bin.PSObject.Properties) { $bins[$property.Name] = [string]$property.Value } }
    if (-not $bins.ContainsKey('sandbox')) { throw 'the package has no sandbox command' }
    New-Item -ItemType Directory -Force $binFolder | Out-Null
    $shimsTouched = $true
    foreach ($command in $bins.Keys) {
      Write-AsciiAtomic (Join-Path $binFolder "$command.cmd") (Get-ShimText 'cmd' $command $bins[$command])
      Write-AsciiAtomic (Join-Path $binFolder $command) (Get-ShimText 'sh' $command $bins[$command])
    }
    foreach ($wrapper in $legacyWrappers) { if (-not $bins.ContainsKey([IO.Path]::GetFileNameWithoutExtension($wrapper.Name))) { Remove-Item -LiteralPath $wrapper.FullName -Force -ErrorAction SilentlyContinue } }
    $activated = $true
    Write-Pointer (Join-Path $toolFolder 'active-node') $nodeVersion '^v\d+\.\d+\.\d+$'
    Write-Pointer (Join-Path $toolFolder 'active-version') $newVersion '^\d+\.\d+\.\d+$'
    $through = (& (Join-Path $binFolder 'sandbox.cmd') --version --short 2>&1 | Out-String).Trim()
    if ($through -ne $newVersion) { throw "the sandbox command did not run version $newVersion ($through)" }
    Ok "the sandbox command runs version $newVersion"
  } catch {
    Problem "Could not install: $_"
    if ($asideDir -and (Test-Path -LiteralPath $asideDir)) {
      # The same version was being reinstalled: the copy that worked goes back in place.
      if ($createdVersion) { Remove-Inside $versionDir (Join-Path $toolFolder 'versions') }
      if (-not (Test-Path -LiteralPath $versionDir)) {
        try { Move-Item -LiteralPath $asideDir -Destination $versionDir -ErrorAction Stop; $asideRestored = $true } catch { Warn "Could not put the installed copy back from ${asideDir}: $_" }
      }
      $createdVersion = $false
    }
    if ($oldVersion) {
      # An upgrade or reinstall: put the earlier version back (pointers and commands) before anything else.
      $wentBack = Restore-Previous $bins $shimsTouched $activated
      if ($wentBack) { Write-Host "   The install was undone: you are on version $oldVersion again." -ForegroundColor Yellow }
      else { Warn "Could not put version $oldVersion back by itself. Run this installer again to repair the install." }
      Disable-AutoUpdate 'the install failed'
    }
    if ($createdVersion -and -not ($oldVersion -and $oldVersion -eq $newVersion)) { Remove-Inside (Join-Path $toolFolder "versions\$newVersion") (Join-Path $toolFolder 'versions') }
    Remove-Inside $download $toolFolder
    return
  }
  Remove-Inside $download $toolFolder
  # Keep this version and the one it replaced (a rollback); older ones go.
  if (Test-Path -LiteralPath (Join-Path $toolFolder 'versions')) {
    Get-ChildItem -LiteralPath (Join-Path $toolFolder 'versions') -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' -and $_.Name -ne $newVersion -and $_.Name -ne $oldVersion } | ForEach-Object { Remove-Inside $_.FullName (Join-Path $toolFolder 'versions') }
  }

  # PATH and Start menu.
  Add-PathEntry $binFolder $machine
  $env:Path = "$binFolder;$env:Path"
  Ok "$binFolder is on the PATH"
  if ($StartMenuShortcut) {
    try { Set-Shortcut $shortcutFile (Join-Path $binFolder 'sandbox.cmd'); Ok 'Start menu shortcut (some antivirus tools flag it; see docs/install.md)' } catch { Warn "Could not make the Start menu shortcut: $_" }
  } else {
    # A shortcut that starts a command script looks like a malware loader to some antivirus tools (a false positive,
    # but an alarming one): none by default, and the one an earlier install made goes.
    foreach ($old in @($shortcutFile, (Join-Path ([Environment]::GetFolderPath('Programs')) 'Windows Development Sandbox.lnk'))) {
      if (Test-Path -LiteralPath $old) {
        Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $old)) { Ok "removed the Start menu shortcut $old (run sandbox in a terminal)" }
      }
    }
  }

  # 8. Everyone: the group, the machine folders and the machine settings --------------------------------------------
  $groupSid = $null
  if ($machine) {
    Step 'Setting up this PC for several users'
    try {
      if (-not (Get-LocalGroup -Name $groupName -ErrorAction SilentlyContinue)) { New-LocalGroup -Name $groupName -Description 'May use a shared Windows Development Sandbox' | Out-Null }
      $groupSid = (Get-LocalGroup -Name $groupName).SID.Value
      $members = @([Security.Principal.WindowsIdentity]::GetCurrent().Name) + $usersToAdd
      foreach ($member in ($members | Select-Object -Unique)) {
        try { Add-LocalGroupMember -Group $groupName -Member $member -ErrorAction Stop; Ok "$member is in the group $groupName" }
        catch { if ("$_" -match 'already a member') { Ok "$member is already in the group $groupName" } else { Warn "Could not add $member to $groupName ($_)." } }
      }

      # The machine tree. Each folder's permissions are written whole on every run, so a changed one is put right.
      $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
      $adminsSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
      $ownerSid = New-Object Security.Principal.SecurityIdentifier('S-1-3-0')
      $groupId = New-Object Security.Principal.SecurityIdentifier($groupSid)
      function New-Rule($sid, $rights, $inherit, $propagation) {
        return New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]$rights, [Security.AccessControl.InheritanceFlags]$inherit, [Security.AccessControl.PropagationFlags]$propagation, [Security.AccessControl.AccessControlType]::Allow)
      }
      function Set-FolderAcl($path, $rules) {
        New-Item -ItemType Directory -Force $path | Out-Null
        $item = Get-Item -LiteralPath $path -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "refusing a link: $path" }
        $acl = Get-Acl -LiteralPath $path
        $before = $acl.GetSecurityDescriptorSddlForm('Access')
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($existing in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($existing) }
        foreach ($rule in $rules) { $acl.AddAccessRule($rule) }
        # Set-Acl re-walks everything below (every user's storage: minutes), so only a folder that differs is written.
        if ($acl.GetSecurityDescriptorSddlForm('Access') -eq $before) { return }
        Set-Acl -LiteralPath $path -AclObject $acl
      }
      $both = 'ContainerInherit, ObjectInherit'
      $adminRules = @((New-Rule $systemSid 'FullControl' $both 'None'), (New-Rule $adminsSid 'FullControl' $both 'None'))
      # Root: administrators change it, the group reads (config.json, migrations.json).
      Set-FolderAcl $machineData ($adminRules + (New-Rule $groupId 'ReadAndExecute' $both 'None'))
      # Its owner too (a per-user install may have made it): only administrators may change the folder that holds the
      # machine settings and the storage helper's log and record. Only this folder's owner changes; nothing is walked.
      & (Join-Path $env:SystemRoot 'System32\icacls.exe') $machineData /setowner '*S-1-5-32-544' /Q | Out-Null
      # users\: the group lists and creates folders here (this folder only); whoever creates a folder owns it alone.
      Set-FolderAcl (Join-Path $machineData 'users') ($adminRules + @((New-Rule $groupId 'ReadAndExecute, CreateDirectories' 'None' 'None'), (New-Rule $ownerSid 'FullControl' $both 'InheritOnly')))
      # active\: the group lists and creates files here, and reads every file; only the creator changes its own.
      Set-FolderAcl (Join-Path $machineData 'active') ($adminRules + @((New-Rule $groupId 'ReadAndExecute, CreateFiles' 'None' 'None'), (New-Rule $groupId 'Read' 'ObjectInherit' 'InheritOnly'), (New-Rule $ownerSid 'FullControl' 'ObjectInherit' 'InheritOnly')))
      Ok "$machineData and its permissions are in place"

      # The machine settings: where each user's data goes, and whether a sandbox is shared. Asked once; -Share / -NoShare
      # set it (also over an existing file). Not called $share: PowerShell names ignore case, and that is the -Share switch.
      $machineConfig = Join-Path $machineData 'config.json'
      $shareChoice = if ($Share) { $true } elseif ($NoShare) { $false } else { $null }
      if (Test-Path -LiteralPath $machineConfig) {
        if ($null -eq $shareChoice) { Ok "keeping the machine settings in $machineConfig" }
        else {
          $settings = Get-Content -LiteralPath $machineConfig -Raw | ConvertFrom-Json
          if ($settings.sharing) { $settings.sharing | Add-Member -NotePropertyName otherUsers -NotePropertyValue $shareChoice -Force }
          else { $settings | Add-Member -NotePropertyName sharing -NotePropertyValue ([pscustomobject]@{ otherUsers = $shareChoice }) -Force }
          Write-JsonAtomic $machineConfig $settings
          Ok "sharing with other users: $(if ($shareChoice) { 'on' } else { 'off' })"
        }
      } else {
        if ($null -eq $shareChoice) { $shareChoice = Ask 'Let other users of this PC use a sandbox you start?' }
        $settings = [ordered]@{ storage = [ordered]@{ root = '%ProgramData%\AgentSandbox\users\%USERNAME%' }; sharing = [ordered]@{ otherUsers = [bool]$shareChoice } }
        Write-JsonAtomic $machineConfig $settings
        Ok "machine settings written to $machineConfig (sharing with other users: $(if ($shareChoice) { 'on' } else { 'off' }))"
      }
      Write-Host '   Users added to the group must sign out and in once.' -ForegroundColor Yellow
    } catch {
      Problem "Could not set up this PC for several users: $_"
      Write-Host '   The program is installed; fix the problem and run the installer again.'
    }
  }

  # 8b. Everyone: the storage helper, asked once ---------------------------------------------------------------------
  # A Windows service that mounts contained storage (a beta feature) without a permission prompt each time. It runs as
  # SYSTEM and answers only members of the group, for their own disk image in their own folder (docs/security.md).
  $helperOn = $false
  if ($machine) {
    if ($ContainedStorageHelper) { $helperOn = $true }
    elseif ($NoContainedStorageHelper) { $helperOn = $false }
    elseif ($record -and $null -ne $record.storageHelper) { $helperOn = [bool]$record.storageHelper }
    else {
      Step 'Storage helper (for contained storage, beta)'
      Write-Host '   Contained storage keeps sandbox tools and logs in one disk image; mounting it needs administrator rights.'
      $helperOn = Ask 'Install a small Windows service so that it mounts without a Windows permission prompt each time?'
    }
    if ($helperOn -and -not $groupSid) {
      Warn 'The storage helper needs the group Agent Sandbox Users, which could not be set up; it was not installed.'
      $helperOn = $false
    } elseif ($helperOn) {
      Step 'Installing the storage helper'
      $helperScript = Join-Path $packageDir 'native\scripts\set-storage-helper.ps1'
      $output = & $powershellExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helperScript -Install -GroupSid $groupSid -InstallRoot $toolFolder -Sources (Join-Path $packageDir 'native\csharp\StorageHelper') 2>&1 | Out-String
      if ($LASTEXITCODE -eq 0) { Ok 'the service AgentSandboxStorage runs; contained storage mounts without a permission prompt' }
      else {
        Problem "Could not install the storage helper (exit $LASTEXITCODE): $($output.Trim())"
        Write-Host '   Contained storage still works; it asks for permission each time.'
        $helperOn = $false
      }
    } else {
      Remove-StorageHelper $packageDir
    }
  }

  # 9. Automatic updates: asked once ----------------------------------------------------------------------------------
  # PowerShell names ignore case: this must not be called $autoUpdate, which IS the -AutoUpdate switch.
  $updatesOn = $false
  if ($AutoUpdate) { $updatesOn = $true }
  elseif ($NoAutoUpdate) { $updatesOn = $false }
  elseif ($record -and $null -ne $record.autoUpdate) { $updatesOn = [bool]$record.autoUpdate }
  else {
    Step 'Automatic updates'
    $updatesOn = Ask 'Install new versions by itself when no sandbox is running?'
  }
  $installedAt = if ($record -and $record.installedAt) { [string]$record.installedAt } else { (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
  Write-JsonAtomic (Join-Path $toolFolder 'install.json') ([ordered]@{ scope = $(if ($machine) { 'machine' } else { 'user' }); groupSid = $groupSid; autoUpdate = [bool]$updatesOn; storageHelper = [bool]$helperOn; installedAt = $installedAt })
  $cli = Join-Path $binFolder 'sandbox.cmd'
  if ($machine -and ($updatesOn -or $NoAutoUpdate)) {
    # The new version creates (or removes) the scheduled task itself.
    & $cli update --auto $(if ($updatesOn) { 'on' } else { 'off' })
    if ($LASTEXITCODE -ne 0) { Warn 'Could not set up automatic updates; run sandbox update --auto on in an admin terminal.' }
  }
  if ($updatesOn) { Ok 'automatic updates are on' }

  # 10. Remove what the new install replaces --------------------------------------------------------------------------
  if ($npmGlobals.Count -or (Test-Path -LiteralPath (Join-Path $legacyNode 'node.exe'))) {
    Step 'Removing the older install'
    foreach ($global in $npmGlobals) {
      & $global.npm uninstall -g $global.package 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { Ok "removed the npm package $($global.package)" } else { Warn "Could not remove the npm package $($global.package); run: npm uninstall -g $($global.package)" }
    }
    # The 1.x private Node sat straight in node\; the new ones are in node\v22.x.y\.
    if (Test-Path -LiteralPath $legacyNode) {
      Get-ChildItem -LiteralPath $legacyNode -Force | Where-Object { $_.Name -notmatch '^v\d+\.\d+\.\d+$' } | ForEach-Object { Remove-Inside $_.FullName $legacyNode }
    }
  }
  # Older installs next to this one: the per-user install (never runs next to an all-users one) and the pre-rename
  # C:\Scripts\agent-sandbox layout. Each is offered for removal (default no); without a terminal only the command is shown.
  function Remove-OlderInstall($root, $label, $removeFolder) {
    Remove-PathEntry (Join-Path $root 'bin') $false
    if ($removeFolder) {
      if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Warn "$root is a link; left alone."; return }
      Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      foreach ($name in 'bin', 'node', 'versions', 'staging', 'active-version', 'active-node', 'install.json', 'update-state.json', 'update.lock') {
        Remove-Inside (Join-Path $root $name) $root
      }
      if ((Test-Path -LiteralPath $root) -and -not (Get-ChildItem -LiteralPath $root -Force)) { Remove-Item -LiteralPath $root -Force -ErrorAction SilentlyContinue }
      $oldShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Windows Development Sandbox.lnk'
      if (Test-Path -LiteralPath $oldShortcut) { Remove-Item -LiteralPath $oldShortcut -Force -ErrorAction SilentlyContinue }
    }
    if (Test-Path -LiteralPath $root) { Warn "$root still has files in it (something may be using them); delete it when nothing runs." }
    else { Ok "removed $label ($root); your saved data was not touched" }
  }
  $userInstall = Join-Path $env:LOCALAPPDATA 'WindowsDevelopmentSandbox'
  if ($machine -and (Test-Path -LiteralPath (Join-Path $userInstall 'bin'))) {
    Warn "An install for just you is in $userInstall. It never runs: the install for everyone comes first on the PATH."
    if (-not (Ask 'Remove the install for just you now? Your saved data is kept.')) {
      Write-Host "   Remove it later with: install.ps1 -Uninstall -Scope CurrentUser" -ForegroundColor Yellow
    } else { Remove-OlderInstall $userInstall 'the install for just you' $false }
  }
  $scriptsInstall = 'C:\Scripts\agent-sandbox'
  if (Test-Path -LiteralPath (Join-Path $scriptsInstall 'bin')) {
    Warn "An older layout of this tool is in $scriptsInstall (its bin folder is on your PATH); it is not used any more."
    if (-not (Ask "Delete $scriptsInstall and take it off the PATH?")) {
      Write-Host "   Remove it later with: Remove-Item -Recurse -Force '$scriptsInstall' (and take $scriptsInstall\bin off your PATH)" -ForegroundColor Yellow
    } else { Remove-OlderInstall $scriptsInstall 'the older layout' $true }
  }
  if ($machine -and (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'AgentSandbox'))) {
    # Measured, not moved: this window is an administrator, so files moved from here would end up owned by Administrators.
    $oldData = Join-Path $env:LOCALAPPDATA 'AgentSandbox'
    $dataBytes = [long]((Get-ChildItem -LiteralPath $oldData -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum)
    $dataSize = if ($dataBytes -ge 1GB) { '{0:N1} GB' -f ($dataBytes / 1GB) } elseif ($dataBytes -ge 1MB) { '{0:N0} MB' -f ($dataBytes / 1MB) } else { '{0:N0} KB' -f [math]::Ceiling($dataBytes / 1KB) }
    Write-Host "   Your earlier saved data is in $oldData ($dataSize). The first time you run sandbox (in a normal terminal) it offers to move it to $machineData\users\<your name> - nothing is moved without asking." -ForegroundColor Cyan
  }

  # 11. Settings and check ---------------------------------------------------------------------------------------------
  if ($machine) {
    # This window runs as administrator: folders it made would belong to Administrators, not to you.
    Write-Host ''
    Write-Host 'Open a normal terminal and run sandbox doctor: the first run sets up your saved settings.'
  } else {
    Step 'Bringing your saved settings up to date'
    & $cli migrate
    if ($LASTEXITCODE -ne 0 -and $oldVersion -and $oldVersion -ne $newVersion) {
      # The new version cannot read your settings: undo the upgrade (your saved data is untouched).
      Problem "Version $newVersion could not bring your saved settings up to date (exit code $LASTEXITCODE)."
      if (Restore-Previous $bins $true $true) {
        Write-Host "   The install was undone: you are on version $oldVersion again." -ForegroundColor Yellow
        Remove-Inside (Join-Path $toolFolder "versions\$newVersion") (Join-Path $toolFolder 'versions')
      } else { Warn "Could not put version $oldVersion back by itself. Run this installer again to repair the install." }
      Disable-AutoUpdate 'the install failed'
      return
    }
    Step 'Checking everything with sandbox doctor'
    & $cli doctor
  }

  # The new copy of a reinstalled version works: the old one kept aside can go.
  if ($asideDir -and (Test-Path -LiteralPath $asideDir)) { Remove-Inside $asideDir (Join-Path $toolFolder 'versions') }

  # Summary ------------------------------------------------------------------------------------------------------
  Write-Host ''
  if ($problems.Count) {
    Write-Host 'Installed, but some things need fixing before a sandbox can start:' -ForegroundColor Yellow
    foreach ($item in $problems) { Write-Host "  - $item" }
  }
  if ($rebootNeeded) { Write-Host 'Restart Windows to finish turning on Windows Sandbox.' -ForegroundColor Yellow }
  Write-Host ''
  Write-Host 'What next:' -ForegroundColor Cyan
  Write-Host '  1. Open a new terminal and cd into a project folder.'
  Write-Host '  2. Run sandbox for the menu, claude-sbx for Claude Code, or sandbox start for a sandbox with no agent.'
  Write-Host '  3. Run sandbox setup or sandbox doctor any time to check this PC again; sandbox update to get a newer version.'
}
