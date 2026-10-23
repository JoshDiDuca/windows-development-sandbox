#Requires -Version 5.1
# Live folders (opt-in alpha, docs/design/hcs-live-folders.md): adds or removes one folder share on the running Windows
# Sandbox through HcsHost.exe wsb-share. Run elevated (host/engines/hcs/live-folders.ts starts it through
# run-elevated.ps1: one Windows permission prompt per add or remove). The request is a JSON file in a private temp
# folder: { action, id, name, path, readOnly, storageRoot, dataPath, userSid, exe, exeSha256 }; its SHA-256 is on the
# command line, and HcsHost hashes the exact bytes it parses again.
# Safety, all checked here again: the temp folder is the user's and not a link; HcsHost.exe is copied into a fresh
# folder under %ProgramData%\AgentSandboxLiveFolders (only administrators and SYSTEM may change it; checked every run)
# and its copy must have the SHA-256 the request names before it runs; one add or remove at a time (a machine-wide
# lock). HcsHost does the rest (which compute system, which folder, the canary). -DryRun checks the request and prints
# what it would do, and does nothing else. The result goes to result.json next to the request file.
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
    foreach ($name in @('action', 'name', 'userSid', 'exe', 'exeSha256')) {
        if (-not ($Req.PSObject.Properties.Name -contains $name) -or -not $Req.$name) { throw "The request has no $name." }
    }
    if (@('add', 'remove') -notcontains [string]$Req.action) { throw 'The action must be add or remove.' }
    if ([string]$Req.name -cnotmatch '^agentsbx-[0-9a-f]{8,32}$') { throw "Not one of this tool's share names: $($Req.name)" }
    if ([string]$Req.userSid -notmatch '^S-1-[0-9-]{3,120}$') { throw 'The request has no valid user.' }
    if ([string]$Req.exeSha256 -notmatch '^[0-9A-Fa-f]{64}$') { throw 'The request has no valid checksum for HcsHost.exe.' }
    if (-not (Test-PlainAbsolute $Req.exe) -or -not ([string]$Req.exe).EndsWith('\HcsHost.exe', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Not a plain full path to HcsHost.exe: $($Req.exe)"
    }
    if ($Req.PSObject.Properties.Name -contains 'id' -and $Req.id -and ([string]$Req.id -notmatch '^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$')) {
        throw 'The sandbox id must be a GUID.'
    }
    if ($Req.action -eq 'remove' -and -not $Req.id) { throw 'A remove needs the id of the sandbox the folder was added to.' }
    if ($Req.action -eq 'add') {
        if (-not ($Req.PSObject.Properties.Name -contains 'path') -or -not (Test-PlainAbsolute $Req.path)) { throw 'The request has no plain full path to share.' }
        if (-not ($Req.PSObject.Properties.Name -contains 'readOnly') -or -not ($Req.readOnly -is [bool])) { throw 'readOnly must be true or false.' }
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

# %ProgramData%\AgentSandboxLiveFolders: made once with an administrator-only DACL; checked on every run (a folder
# someone else made first is refused, never used).
function Get-AdminParent {
    $base = $(if ($env:ProgramData) { $env:ProgramData } else { 'C:\ProgramData' })
    $parent = Join-Path $base 'AgentSandboxLiveFolders'
    if (Test-ReparsePoint $base) { throw "Refusing a link: $base" }
    if (-not (Test-Path -LiteralPath $parent)) {
        [void][IO.Directory]::CreateDirectory($parent, (New-AdminSecurity))
    }
    if (Test-ReparsePoint $parent) { throw "Refusing a link: $parent" }
    $acl = Get-Acl -LiteralPath $parent
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($AdminSids -notcontains $owner) { throw "$parent belongs to $owner, not to administrators; delete it as an administrator and try again." }
    if (-not $acl.AreAccessRulesProtected) { throw "$parent inherits permissions; delete it as an administrator and try again." }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $AdminSids -notcontains $rule.IdentityReference.Value) {
            throw "$($rule.IdentityReference.Value) may use $parent; delete it as an administrator and try again."
        }
    }
    return $parent
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

function Get-FileSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        return [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
    }
}

function Invoke-Live($Req, [string]$JsonPath, [string]$Checksum) {
    if (-not (Test-Path -LiteralPath $Req.exe -PathType Leaf) -or (Test-ReparsePoint $Req.exe)) { throw "HcsHost.exe is missing or a link: $($Req.exe)" }
    $parent = Get-AdminParent
    $work = Join-Path $parent ([Guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $work) { throw "The work folder exists already: $work" }
    [void][IO.Directory]::CreateDirectory($work, (New-AdminSecurity))
    try {
        $exe = Join-Path $work 'HcsHost.exe'
        [IO.File]::Copy($Req.exe, $exe, $false)
        if ((Get-FileSha256 $exe) -ne ([string]$Req.exeSha256).ToLowerInvariant()) { throw 'HcsHost.exe is not the file the request names (its checksum differs); nothing was done.' }
        $out = Join-Path $work 'reply.json'
        & $exe 'wsb-share' $JsonPath '--sha256' $Checksum '--out' $out | Out-Null
        if (-not (Test-Path -LiteralPath $out)) { throw 'HcsHost.exe gave no answer.' }
        $bytes = [IO.File]::ReadAllBytes($out)
        if ($bytes.Length -gt 65536) { throw 'HcsHost.exe answered with too much text.' }
        $reply = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
        $script:result.ok = [bool]$reply.ok
        $script:result.message = [string]$reply.message
        if ($reply.values.PSObject.Properties.Name -contains 'id') { $script:result.id = [string]$reply.values.id }
        if ($reply.values.PSObject.Properties.Name -contains 'canary') { $script:result.canary = [string]$reply.values.canary }
    } finally {
        if (-not (Test-ReparsePoint $work)) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    }
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
        if (-not $owned) { throw 'Another live folder is being added or removed. Try again in a minute.' }
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
Write-ContainedResult $result $Json $DryRun.IsPresent
if ($result.ok) { exit 0 }
if ($DryRun) { [Console]::Error.WriteLine($result.message) }
exit 1
