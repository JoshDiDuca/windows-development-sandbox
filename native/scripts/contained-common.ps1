#Requires -Version 5.1
# Shared by mount-contained.ps1, dismount-contained.ps1 and check-contained.ps1 (dot-sourced; defines functions only).
# Everything a request says is checked again here, because mounting a disk image needs administrator rights and the
# request file was written by a program that is not elevated: the image and the mount folder must be exactly
# <storage>\images\<name>.vhdx and <storage>\mounts\<name>, none of the folders on the way may be a link, and what is
# there must be yours. Nothing in this file changes anything.
Set-StrictMode -Version 2.0

$script:NameRule = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
$script:PathRule = '^[^"<>|*?\x00-\x1f]+$'
$script:AdministratorsSid = 'S-1-5-32-544'
$script:Lines = New-Object System.Collections.Generic.List[string]

function Add-Note([string]$Text) {
    $script:Lines.Add($Text)
}

function Get-Notes {
    return @($script:Lines)
}

function Test-PlainAbsolute([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if ($Path -notmatch $script:PathRule) { return $false }
    # A drive letter and plain folder names: no UNC or \\?\ form, no . or .. part, no stream (a colon), no slash.
    # (GetFullPath is not used: it turns a short 8.3 name such as WDAGUT~1 into a long one, and those are fine.)
    if ($Path -notmatch '^[A-Za-z]:\\') { return $false }
    if ($Path.IndexOf(':', 2) -ge 0 -or $Path.Contains('/')) { return $false }
    foreach ($part in $Path.Substring(3).TrimEnd('\').Split('\')) {
        if ($part -eq '' -or $part -eq '.' -or $part -eq '..' -or $part.EndsWith(' ') -or $part.EndsWith('.')) { return $false }
    }
    return $true
}

function Test-ReparsePoint([string]$Path) {
    return [bool]([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint)
}

function Test-IsMe([string]$Sid) {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ($me.User.Value -ieq $Sid)
}

function Test-IsAdministrator {
    $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    return $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Read-ContainedRequest([string]$JsonPath, [string]$Sha256, [bool]$Dry) {
    if (-not (Test-Path -LiteralPath $JsonPath -PathType Leaf)) { throw "The request file is missing: $JsonPath" }
    $bytes = [IO.File]::ReadAllBytes($JsonPath)
    if ($bytes.Length -gt 65536) { throw 'The request file is too large.' }
    if ($Sha256) {
        $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-', '')
        if ($hash -ine $Sha256) { throw 'The request file changed after it was written; nothing was done.' }
    } elseif (-not $Dry) {
        throw 'No checksum was given for the request file.'
    }
    $text = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF)
    return ($text | ConvertFrom-Json)
}

function Assert-ContainedRequest($Req) {
    foreach ($name in @('storageRoot', 'image', 'mount', 'userSid', 'set')) {
        if (-not ($Req.PSObject.Properties.Name -contains $name) -or -not $Req.$name) { throw "The request has no $name." }
    }
    if ($Req.userSid -notmatch '^S-1-[0-9-]{3,120}$') { throw 'The request has no valid user.' }
    if ($Req.set -notmatch $script:NameRule) { throw "The data set name is not allowed: $($Req.set)" }
    foreach ($p in @($Req.storageRoot, $Req.image, $Req.mount)) {
        if (-not (Test-PlainAbsolute $p)) { throw "Not a plain full path (no .., no network path): $p" }
    }
    $root = $Req.storageRoot.TrimEnd('\')
    $wantImage = Join-Path (Join-Path $root 'images') ($Req.set + '.vhdx')
    $wantMount = Join-Path (Join-Path $root 'mounts') $Req.set
    if ($Req.image.TrimEnd('\') -ine $wantImage) { throw "The image must be $wantImage, not $($Req.image)." }
    if ($Req.mount.TrimEnd('\') -ine $wantMount) { throw "The mount folder must be $wantMount, not $($Req.mount)." }
    if ($root.Length -le 3) { throw 'The storage folder cannot be a drive root.' }
}

function Assert-NoLinksOnTheWay($Req, [bool]$MountMayBeLink) {
    $root = $Req.storageRoot.TrimEnd('\')
    foreach ($p in @($root, (Join-Path $root 'images'), (Join-Path $root 'mounts'))) {
        if (-not (Test-Path -LiteralPath $p -PathType Container)) { throw "A folder is missing: $p" }
        if (Test-ReparsePoint $p) { throw "Refusing a link: $p" }
    }
    # Everything above the storage folder must not be a link either (a link there would move the whole tree).
    $parent = Split-Path -Parent $root
    while ($parent) {
        if ((Test-Path -LiteralPath $parent) -and (Test-ReparsePoint $parent)) { throw "Refusing a link above the storage folder: $parent" }
        $next = Split-Path -Parent $parent
        if ($next -eq $parent) { break }
        $parent = $next
    }
    if (Test-Path -LiteralPath $Req.image) {
        if (Test-ReparsePoint $Req.image) { throw "Refusing a link: $($Req.image)" }
        if (-not (Test-Path -LiteralPath $Req.image -PathType Leaf)) { throw "The image is not a file: $($Req.image)" }
    }
    if (-not (Test-Path -LiteralPath $Req.mount -PathType Container)) { throw "The mount folder is missing: $($Req.mount)" }
    if ((-not $MountMayBeLink) -and (Test-ReparsePoint $Req.mount)) { throw "Refusing a link: $($Req.mount)" }
}

function Get-OwnerSid([string]$Path) {
    return (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier]).Value
}

function Assert-OwnedByUser($Req, [string[]]$Paths) {
    # An object made by an elevated process of your own account is owned by Administrators, not by you.
    $allowed = @($Req.userSid)
    if ((Test-IsMe $Req.userSid) -and (Test-IsAdministrator)) { $allowed += $script:AdministratorsSid }
    foreach ($p in $Paths) {
        $owner = Get-OwnerSid $p
        if ($allowed -inotcontains $owner) { throw "Not yours (owner $owner): $p" }
    }
}

function Read-ExactBytes([IO.FileStream]$Stream, [long]$Offset, [int]$Count) {
    if ($Offset -lt 0 -or ($Offset + $Count) -gt $Stream.Length) { throw 'The image is not a valid VHDX file (a part is missing).' }
    [void]$Stream.Seek($Offset, [IO.SeekOrigin]::Begin)
    $buffer = New-Object byte[] $Count
    $done = 0
    while ($done -lt $Count) {
        $n = $Stream.Read($buffer, $done, $Count - $done)
        if ($n -le 0) { throw 'The image could not be read.' }
        $done += $n
    }
    return , $buffer
}

function New-GuidFrom([byte[]]$Bytes, [int]$Offset) {
    $part = New-Object byte[] 16
    [Array]::Copy($Bytes, $Offset, $part, 0, 16)
    return (New-Object System.Guid -ArgumentList (, $part))
}

# Reads the VHDX header of a file that is not attached (the layout is in the VHDX specification): is it a VHDX, how
# big may it grow, does it have a parent (a differencing disk would reach into another file)?
function Read-VhdxInfo([string]$Path) {
    $metadataRegion = New-Object System.Guid '8b7ca206-4790-4b9a-b8fe-575f050f886e'
    $virtualSizeItem = New-Object System.Guid '2fa54224-cd1b-4876-b211-5dbed83bf4b8'
    $parentItem = New-Object System.Guid 'a8d35f2d-b30b-454d-abf7-d3d84834ab0c'
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $id = [Text.Encoding]::ASCII.GetString((Read-ExactBytes $stream 0 8))
        if ($id -ne 'vhdxfile') { throw 'The file is not a VHDX image.' }
        $table = Read-ExactBytes $stream 196608 65536
        if ([Text.Encoding]::ASCII.GetString($table, 0, 4) -ne 'regi') { throw 'The image has no region table.' }
        $count = [BitConverter]::ToUInt32($table, 8)
        if ($count -gt 64) { throw 'The image has too many regions.' }
        $metadataOffset = -1L
        for ($i = 0; $i -lt $count; $i++) {
            $at = 16 + 32 * $i
            if ((New-GuidFrom $table $at) -eq $metadataRegion) { $metadataOffset = [long][BitConverter]::ToUInt64($table, $at + 16) }
        }
        if ($metadataOffset -lt 0) { throw 'The image has no metadata region.' }
        $meta = Read-ExactBytes $stream $metadataOffset 65536
        if ([Text.Encoding]::ASCII.GetString($meta, 0, 8) -ne 'metadata') { throw 'The image has no metadata table.' }
        $items = [BitConverter]::ToUInt16($meta, 10)
        if ($items -gt 2047) { throw 'The image has too many metadata items.' }
        $size = [uint64]0
        $hasParent = $false
        for ($i = 0; $i -lt $items; $i++) {
            $at = 32 + 32 * $i
            $guid = New-GuidFrom $meta $at
            if ($guid -eq $parentItem) { $hasParent = $true }
            if ($guid -eq $virtualSizeItem) {
                $itemOffset = [long][BitConverter]::ToUInt32($meta, $at + 16)
                $size = [BitConverter]::ToUInt64((Read-ExactBytes $stream ($metadataOffset + $itemOffset) 8), 0)
            }
        }
        return @{ VirtualSize = $size; HasParent = $hasParent }
    } finally {
        $stream.Dispose()
    }
}

function Assert-PlainImage($Req, [bool]$Dry) {
    $info = Read-VhdxInfo $Req.image
    if ($info.HasParent) { throw 'The image is a differencing disk (it has a parent file); refusing it.' }
    $cap = [uint64]$Req.maxGb * 1GB
    if ($info.VirtualSize -eq 0) { throw 'The image size could not be read.' }
    if ($info.VirtualSize -gt $cap) { throw "The image is bigger than the limit of $($Req.maxGb) GB." }
    return $info
}

# Is this very image attached, and where? Null as the second answer when Windows will not say.
function Get-ImageState([string]$Image, [bool]$Dry) {
    try {
        $di = Get-DiskImage -ImagePath $Image -ErrorAction Stop
        if (-not $di.Attached) { return @{ Attached = $false; Paths = @() } }
        $disk = $di | Get-Disk -ErrorAction Stop
        $paths = @()
        foreach ($part in @(Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue)) {
            foreach ($a in @($part.AccessPaths)) { if ($a) { $paths += $a } }
        }
        return @{ Attached = $true; Paths = $paths }
    } catch {
        if ($Dry) { return @{ Attached = $false; Paths = @() } }
        throw "Windows could not tell whether the image is attached: $($_.Exception.Message)"
    }
}

function Test-MountedAt($State, [string]$Mount) {
    $want = $Mount.TrimEnd('\') + '\'
    foreach ($p in $State.Paths) { if ($p -ieq $want) { return $true } }
    return $false
}

function Invoke-DiskPart([string[]]$DiskPartLines, [string]$TempDir, [bool]$Dry) {
    foreach ($line in $DiskPartLines) {
        if ($line -match '[\r\n]') { throw 'A diskpart line has a line break.' }
    }
    if ($Dry) {
        foreach ($line in $DiskPartLines) { Add-Note ('DISKPART: ' + $line) }
        return ''
    }
    $diskpart = Join-Path $env:SystemRoot 'System32\diskpart.exe'
    if (-not (Test-Path -LiteralPath $diskpart)) { throw 'diskpart.exe was not found.' }
    $file = Join-Path $TempDir ('diskpart-' + [guid]::NewGuid().ToString('N') + '.txt')
    [IO.File]::WriteAllLines($file, $DiskPartLines, [Text.Encoding]::ASCII)
    try {
        # /s stops at the first command that fails.
        $output = & $diskpart /s $file 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw "diskpart failed (exit $LASTEXITCODE): $output" }
        return $output
    } finally {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
}

function Write-ContainedResult([hashtable]$Result, [string]$JsonPath, [bool]$Dry) {
    if ($Dry) {
        foreach ($line in $script:Lines) { Write-Output $line }
        if ($Result.ok) { Write-Output 'RESULT: ok' } else { Write-Output ('RESULT: refused: ' + $Result.message) }
        return
    }
    $Result.notes = @($script:Lines)
    $file = Join-Path (Split-Path -Parent $JsonPath) 'result.json'
    [IO.File]::WriteAllText($file, ($Result | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
}

function Enter-ContainedLock {
    $mutex = New-Object System.Threading.Mutex($false, 'Global\AgentSandboxContainedStorage')
    if (-not $mutex.WaitOne(30000)) { throw 'Another mount or dismount is running. Try again in a minute.' }
    return $mutex
}
