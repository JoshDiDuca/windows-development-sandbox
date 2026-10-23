#Requires -Version 5.1
# Live folders (opt-in alpha, docs/design/hcs-live-folders.md): adds or removes one folder share on the running Windows
# Sandbox through HcsHost.exe wsb-share. Run elevated (host/engines/hcs/live-folders.ts starts it through
# run-elevated.ps1: one Windows permission prompt per add or remove). The request is a JSON file in a private temp
# folder: { action, id, name, path, readOnly, storageRoot, dataPath, userSid }; its SHA-256 is on the command line, and
# HcsHost hashes the exact bytes it parses again.
# Safety, all checked here again: the temp folder is the user's and not a link; HcsHost.exe is compiled here, from the
# sources next to this script (copied first), into a fresh folder under %ProgramData%\AgentSandboxLiveFolders that only
# administrators and SYSTEM may use (checked, and repaired when someone else made it, on every run), never taken from
# the caller; one add or remove at a time (a machine-wide lock). HcsHost does the rest (the caller must be the account
# that answered the prompt, which compute system, which folder, the canary). Work folders left by an earlier run (a
# canary the sandbox kept busy) are swept. -DryRun checks the request and prints what it would do, and does nothing
# else. The result goes to result.json next to the request file.
param(
    [Parameter(Mandatory = $true)][string]$Json,
    [string]$Sha256 = '',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'contained-common.ps1')

$result = @{ ok = $false; message = ''; id = ''; canary = '' }
$AdminSids = @('S-1-5-18', 'S-1-5-32-544')

function Assert-LiveRequest($Req) {
    foreach ($name in @('action', 'name', 'userSid')) {
        if (-not ($Req.PSObject.Properties.Name -contains $name) -or -not $Req.$name) { throw "The request has no $name." }
    }
    if (@('add', 'remove') -notcontains [string]$Req.action) { throw 'The action must be add or remove.' }
    if ([string]$Req.name -cnotmatch '^agentsbx-[0-9a-f]{8,32}$') { throw "Not one of this tool's share names: $($Req.name)" }
    if ([string]$Req.userSid -notmatch '^S-1-[0-9-]{3,120}$') { throw 'The request has no valid user.' }
    if ($Req.PSObject.Properties.Name -contains 'id' -and $Req.id -and ([string]$Req.id -notmatch '^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$')) {
        throw 'The sandbox id must be a GUID.'
    }
    if ($Req.action -eq 'remove' -and -not $Req.id) { throw 'A remove needs the id of the sandbox the folder was added to.' }
    if ($Req.action -eq 'add') {
        if (-not ($Req.PSObject.Properties.Name -contains 'path') -or -not (Test-PlainAbsolute $Req.path)) { throw 'The request has no plain full path to share.' }
        if (-not ($Req.PSObject.Properties.Name -contains 'readOnly') -or -not ($Req.readOnly -is [bool])) { throw 'readOnly must be true or false.' }
        foreach ($name in @('storageRoot', 'dataPath')) {
            if (-not ($Req.PSObject.Properties.Name -contains $name) -or -not (Test-PlainAbsolute $Req.$name)) { throw "The request has no plain full $name." }
        }
    }
}

# The request's own folder: a private temp folder of the user who asked, not a link.
function Assert-PrivateTemp($Req, [string]$Dir) {
    if (Test-ReparsePoint $Dir) { throw "Refusing a link: $Dir" }
    $acl = Get-Acl -LiteralPath $Dir
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (@($Req.userSid, 'S-1-5-32-544') -notcontains $owner) { throw "The request folder is not yours (owner $owner)." }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne 'Allow') { continue }
        if (@('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545') -contains $rule.IdentityReference.Value) { throw 'The request folder is open to other users.' }
    }
}

function New-AdminSecurity {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($sid in $AdminSids) {
        $who = New-Object Security.Principal.SecurityIdentifier($sid)
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($who, 'FullControl', $inherit, 'None', 'Allow')))
    }
    return $acl
}

function Test-AdminOnly([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    if ($AdminSids -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { return $false }
    if (-not $acl.AreAccessRulesProtected) { return $false }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $AdminSids -notcontains $rule.IdentityReference.Value) { return $false }
    }
    return $true
}

# %ProgramData%\AgentSandboxLiveFolders: made with an administrator-only DACL. One that someone else made first (any
# user may create folders in ProgramData) is taken over: owner Administrators and the DACL written whole; its old
# content stays, unused (each run works in a new random folder made with its own DACL).
function Get-AdminParent {
    $base = [Environment]::GetFolderPath('CommonApplicationData')
    if (-not $base -or (Test-ReparsePoint $base)) { throw "ProgramData is missing or a link: $base" }
    $parent = Join-Path $base 'AgentSandboxLiveFolders'
    if (-not (Test-Path -LiteralPath $parent)) {
        [void][IO.Directory]::CreateDirectory($parent, (New-AdminSecurity))
    }
    if (Test-ReparsePoint $parent) { throw "Refusing a link: $parent" }
    if (-not (Test-AdminOnly $parent)) {
        Add-Note "taking over $parent (someone else made it or may use it)"
        Set-Acl -LiteralPath $parent -AclObject (New-AdminSecurity)
        if ((Test-ReparsePoint $parent) -or -not (Test-AdminOnly $parent)) { throw "$parent could not be made administrator-only." }
    }
    # Work folders an earlier run could not delete (the sandbox kept its canary busy): gone after an hour.
    foreach ($old in @(Get-ChildItem -LiteralPath $parent -Force -Directory -ErrorAction SilentlyContinue)) {
        if ($old.Name -match '^[0-9a-f]{32}$' -and -not ($old.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $old.CreationTimeUtc -lt [DateTime]::UtcNow.AddHours(-1)) {
            Remove-Item -LiteralPath $old.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    return $parent
}

# HcsHost.exe built here from this package's sources (copied into the admin-only work folder first), with the
# compiler that ships with Windows: nothing the caller names is ever run elevated.
function Build-HcsHost([string]$Work) {
    $sources = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\csharp\HcsHost'))
    if (-not (Test-Path -LiteralPath $sources -PathType Container) -or (Test-ReparsePoint $sources)) { throw "The HcsHost sources are missing or a link: $sources" }
    $copy = Join-Path $Work 'src'
    [void][IO.Directory]::CreateDirectory($copy)
    foreach ($file in @(Get-ChildItem -LiteralPath $sources -Filter '*.cs' -File)) {
        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing a link: $($file.FullName)" }
        [IO.File]::Copy($file.FullName, (Join-Path $copy $file.Name), $false)
    }
    $csc = Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $exe = Join-Path $Work 'HcsHost.exe'
    $files = @(Get-ChildItem -LiteralPath $copy -Filter '*.cs' -File | ForEach-Object { $_.FullName })
    if ($files.Count -eq 0) { throw 'No HcsHost sources were found.' }
    & $csc '/nologo' '/optimize' '/target:exe' '/r:System.Web.Extensions.dll' ('/out:' + $exe) @files | Out-Null
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'HcsHost.exe could not be built (the .NET Framework compiler that ships with Windows is needed).' }
    return $exe
}

function Invoke-Live($Req, [string]$JsonPath, [string]$Checksum) {
    $parent = Get-AdminParent
    $work = Join-Path $parent ([Guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $work) { throw "The work folder exists already: $work" }
    [void][IO.Directory]::CreateDirectory($work, (New-AdminSecurity))
    try {
        $exe = Build-HcsHost $work
        $out = Join-Path $work 'reply.json'
        & $exe 'wsb-share' $JsonPath '--sha256' $Checksum '--out' $out | Out-Null
        if (-not (Test-Path -LiteralPath $out)) { throw 'HcsHost.exe gave no answer.' }
        $bytes = [IO.File]::ReadAllBytes($out)
        if ($bytes.Length -gt 65536) { throw 'HcsHost.exe answered with too much text.' }
        $reply = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
        $script:result.ok = [bool]$reply.ok
        $script:result.message = [string]$reply.message
        $names = @($reply.values.PSObject.Properties | ForEach-Object { $_.Name })
        if ($names -contains 'id') { $script:result.id = [string]$reply.values.id }
        if ($names -contains 'canary') { $script:result.canary = [string]$reply.values.canary }
    } finally {
        if (-not (Test-ReparsePoint $work)) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

# result.json in the caller's folder: checked for a link right before, and only made as a new file.
function Write-LiveResult([hashtable]$Result, [string]$JsonPath) {
    $Result.notes = @($script:Lines)
    $dir = Split-Path -Parent $JsonPath
    if (Test-ReparsePoint $dir) { return }
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($Result | ConvertTo-Json -Compress))
    $stream = New-Object IO.FileStream((Join-Path $dir 'result.json'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}

$mutex = $null
$owned = $false
try {
    $request = Read-ContainedRequest -JsonPath $Json -Sha256 $Sha256 -Dry $DryRun.IsPresent
    Assert-LiveRequest $request
    if ($DryRun) {
        Add-Note ("would {0} the share {1}{2} on the running Windows Sandbox{3}" -f $request.action, $request.name, $(if ($request.action -eq 'add') { ' (' + $request.path + ', ' + $(if ($request.readOnly) { 'read-only' } else { 'writable' }) + ')' } else { '' }), $(if ($request.id) { ' ' + $request.id } else { '' }))
        $result.ok = $true
        $result.message = 'checked'
    } else {
        if (-not (Test-IsAdministrator)) { throw 'Adding a folder to the running sandbox needs administrator rights.' }
        Assert-PrivateTemp $request (Split-Path -Parent $Json)
        $mutex = New-Object System.Threading.Mutex($false, 'Global\AgentSandboxLiveFolders')
        try { $owned = $mutex.WaitOne(120000) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw 'Another live folder is being added or removed (maybe by another user of this PC). Try again in a few minutes.' }
        Invoke-Live $request $Json $Sha256
    }
} catch {
    $result.ok = $false
    $result.message = $_.Exception.Message
} finally {
    if ($mutex) {
        if ($owned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
if ($DryRun) {
    Write-ContainedResult $result $Json $true
} else {
    try { Write-LiveResult $result $Json } catch { [Console]::Error.WriteLine('The result could not be written: ' + $_.Exception.Message) }
}
if ($result.ok) { exit 0 }
if ($DryRun) { [Console]::Error.WriteLine($result.message) }
exit 1
