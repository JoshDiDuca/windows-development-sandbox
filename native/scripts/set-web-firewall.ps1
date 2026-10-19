#Requires -Version 5.1
# Adds or removes the one Windows Firewall rule of the web UI's LAN mode (docs/design/remote-access.md). Run elevated
# through run-elevated.ps1 (one Windows permission prompt). The request is a JSON file:
#   { action: "add" | "remove", ruleName, port, localAddress, program }
# Everything is checked again here, from the bytes whose SHA-256 was given: the rule name is exactly ours, the port is
# 1024-65535, the local address is a private IPv4 address (10/8, 172.16/12, 192.168/16), the program is an existing
# node.exe not in a temp folder. The rule only allows inbound TCP to that address and port, from the local subnet, on
# Private networks: never the internet. -DryRun checks and prints what it would run (as JSON) and changes nothing; a
# real run writes result.json next to the request file.
param(
    [Parameter(Mandatory = $true)][string]$Json,
    [string]$Sha256 = '',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$RuleName = 'Agent Sandbox web UI (LAN)'
$result = @{ ok = $false; message = ''; commands = @() }

function Test-PrivateIPv4([string]$Ip) {
    if ($Ip -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$') { return $false }
    $p = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4])
    foreach ($n in $p) { if ($n -gt 255) { return $false } }
    return ($p[0] -eq 10) -or ($p[0] -eq 172 -and $p[1] -ge 16 -and $p[1] -le 31) -or ($p[0] -eq 192 -and $p[1] -eq 168)
}

function Read-Request([string]$Path, [string]$Expected) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -gt 4096) { throw 'The request file is too big.' }
    if ($Expected) {
        $sha = [Security.Cryptography.SHA256]::Create()
        $hash = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
        if ($hash -ine $Expected) { throw 'The request file changed after it was written; nothing was done.' }
    }
    return ([Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json)
}

function Assert-Request($Req) {
    foreach ($name in @('action', 'ruleName')) {
        if (-not ($Req.PSObject.Properties.Name -contains $name)) { throw "The request has no $name." }
    }
    if ($Req.ruleName -cne $RuleName) { throw "Only the rule '$RuleName' is managed here." }
    if ($Req.action -ne 'add' -and $Req.action -ne 'remove') { throw 'The action must be add or remove.' }
    if ($Req.action -eq 'remove') { return }
    foreach ($name in @('port', 'localAddress', 'program')) {
        if (-not ($Req.PSObject.Properties.Name -contains $name)) { throw "The request has no $name." }
    }
    if (-not ($Req.port -is [int] -or $Req.port -is [long]) -or $Req.port -lt 1024 -or $Req.port -gt 65535) {
        throw 'The port must be a whole number from 1024 to 65535.'
    }
    if (-not (Test-PrivateIPv4 ([string]$Req.localAddress))) {
        throw 'The address must be a private IPv4 address (10.x, 172.16-31.x, 192.168.x): LAN mode is for your own network only.'
    }
    $program = [string]$Req.program
    if (-not [IO.Path]::IsPathRooted($program) -or $program.Contains('..')) { throw 'The program must be a full path.' }
    if ([IO.Path]::GetFileName($program) -ine 'node.exe') { throw 'The program must be node.exe.' }
    if (-not (Test-Path -LiteralPath $program -PathType Leaf)) { throw "The program does not exist: $program" }
    $full = [IO.Path]::GetFullPath($program)
    foreach ($temp in @($env:TEMP, $env:TMP, (Join-Path $env:SystemRoot 'Temp'))) {
        if ($temp -and $full.StartsWith([IO.Path]::GetFullPath($temp).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The program must not be in a temp folder.'
        }
    }
}

function Get-Commands($Req) {
    $remove = "Remove-NetFirewallRule -DisplayName '$RuleName'"
    if ($Req.action -eq 'remove') { return @($remove) }
    $add = "New-NetFirewallRule -DisplayName '$RuleName' -Direction Inbound -Action Allow -Protocol TCP " +
        "-LocalPort $($Req.port) -LocalAddress $($Req.localAddress) -RemoteAddress LocalSubnet -Profile Private " +
        "-Program '$([IO.Path]::GetFullPath([string]$Req.program))'"
    return @($remove, $add)
}

try {
    $request = Read-Request $Json $Sha256
    Assert-Request $request
    $result.commands = @(Get-Commands $request)
    if ($DryRun) {
        $result.ok = $true
        $result.message = 'Checked; nothing was changed.'
        $result | ConvertTo-Json -Compress
        exit 0
    }
    Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    if ($request.action -eq 'add') {
        New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow -Protocol TCP `
            -LocalPort ([int]$request.port) -LocalAddress ([string]$request.localAddress) -RemoteAddress LocalSubnet `
            -Profile Private -Program ([IO.Path]::GetFullPath([string]$request.program)) | Out-Null
        $result.message = 'The firewall rule is in place.'
    } else {
        $result.message = 'The firewall rule is removed.'
    }
    $result.ok = $true
} catch {
    $result.ok = $false
    $result.message = $_.Exception.Message
    if ($DryRun) {
        $result | ConvertTo-Json -Compress
        exit 2
    }
}
$result | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path (Split-Path -Parent $Json) 'result.json') -Encoding UTF8
if ($result.ok) { exit 0 } else { exit 2 }
