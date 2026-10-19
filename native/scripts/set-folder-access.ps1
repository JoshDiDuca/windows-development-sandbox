#Requires -Version 5.1
# Adds or removes folder access entries listed in a JSON file (host/sharing/acl.ts writes it): { "changes": [ { path,
# sid, rights (Read | Traverse | Modify), scope (this-folder | inherit), add } or { op: "private", path } ] }. Entries
# are applied in order. A link (junction or symbolic link) is refused, so an entry can never land on another folder.
# Nothing is written when the permissions would not change. A this-folder entry (and "private" on an empty folder) is
# written to that folder only, never over its children (FolderSecurity.cs); an inherit entry reaches the children.
# Exit 0 when all are applied; exit 1 with the reason on stderr otherwise.
param(
    [Parameter(Mandatory = $true)][string]$Json
)
$ErrorActionPreference = 'Stop'

$loaded = $false
function Set-OwnDacl([string]$Path, $Acl) {
    if (-not $script:loaded) {
        Add-Type -Path (Join-Path $PSScriptRoot '..\csharp\FolderSecurity.cs')
        $script:loaded = $true
    }
    # Keep "auto-inherited" (D:AI) as Set-Acl does: without it Windows treats the inherited entries as the folder's own
    # the next time the parent changes. SetFileSecurity keeps that flag only when the descriptor also requests it.
    $raw = New-Object System.Security.AccessControl.RawSecurityDescriptor -ArgumentList $Acl.GetSecurityDescriptorBinaryForm(), 0
    if (-not $Acl.AreAccessRulesProtected) {
        $auto = [System.Security.AccessControl.ControlFlags]'DiscretionaryAclAutoInherited, DiscretionaryAclAutoInheritRequired'
        $raw.SetFlags($raw.ControlFlags -bor $auto)
    }
    $bytes = New-Object byte[] $raw.BinaryLength
    $raw.GetBinaryForm($bytes, 0)
    [AgentSandbox.FolderSecurity]::SetDacl($Path, $bytes)
}

function Get-Folder([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) { throw "Not a folder: $Path" }
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Refusing a link: $Path" }
}

try {
    # The entries sit in a property: piping a bare JSON array into ConvertFrom-Json gives one array object on 5.1.
    $doc = Get-Content -LiteralPath $Json -Raw -Encoding UTF8 | ConvertFrom-Json
    $entries = @($doc.changes)
    foreach ($e in $entries) {
        Get-Folder $e.path
        if ($e.op -eq 'private') {
            # Only you, SYSTEM and Administrators; inheritance from the parent off; children inherit this.
            $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
            $want = New-Object System.Security.AccessControl.DirectorySecurity
            $want.SetAccessRuleProtection($true, $false)
            foreach ($who in @($me, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
                $want.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                    $who, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
            }
            $have = Get-Acl -LiteralPath $e.path
            # A folder someone else owns is never made "private" for you: under an all-users install another member of
            # the group could have made %ProgramData%\AgentSandbox\users\<you> first, and as its owner can give
            # themselves access to every file you write later. Administrators own what an elevated you creates.
            $owner = $have.GetOwner([System.Security.Principal.SecurityIdentifier])
            $adminsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
            $elevated = (New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole($adminsSid)
            if (-not ($owner -eq $me -or ($owner -eq $adminsSid -and $elevated))) {
                $ownerName = $owner.Value
                try { $ownerName = $owner.Translate([System.Security.Principal.NTAccount]).Value } catch { $ownerName = $owner.Value }
                throw "$($e.path) belongs to $ownerName, not to you (someone else may have created it). An administrator must delete it before you use it."
            }
            if ($have.GetSecurityDescriptorSddlForm('Access') -eq $want.GetSecurityDescriptorSddlForm('Access')) { continue }
            $children = @(Get-ChildItem -LiteralPath $e.path -Force | Select-Object -First 1)
            if ($children.Count -eq 0) { Set-OwnDacl $e.path $want } else { Set-Acl -LiteralPath $e.path -AclObject $want }
            continue
        }
        if ($e.rights -notin @('Read', 'Traverse', 'Modify')) { throw "Unknown rights: $($e.rights)" }
        if ($e.scope -notin @('this-folder', 'inherit')) { throw "Unknown scope: $($e.scope)" }

        $sid = New-Object System.Security.Principal.SecurityIdentifier($e.sid)
        $rights = [System.Security.AccessControl.FileSystemRights]$e.rights
        if ($e.scope -eq 'inherit') {
            $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        } else {
            $inherit = [System.Security.AccessControl.InheritanceFlags]'None'
        }
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $sid, $rights, $inherit, [System.Security.AccessControl.PropagationFlags]'None', [System.Security.AccessControl.AccessControlType]'Allow')

        $acl = Get-Acl -LiteralPath $e.path
        $before = $acl.GetSecurityDescriptorSddlForm('Access')
        if ($e.add) {
            $acl.AddAccessRule($rule)
        } else {
            [void]$acl.RemoveAccessRuleSpecific($rule)
        }
        # Nothing changed (removing an absent entry, adding a present one): do not write, a write walks the subtree.
        if ($acl.GetSecurityDescriptorSddlForm('Access') -eq $before) { continue }
        if ($e.scope -eq 'inherit') { Set-Acl -LiteralPath $e.path -AclObject $acl } else { Set-OwnDacl $e.path $acl }
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
