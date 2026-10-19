#Requires -Version 5.1
# The network an address of this PC is on, for the web UI's LAN mode: its category (Private, Public, DomainAuthenticated)
# and name, as one line of JSON. LAN mode starts only on a Private network, and only the one it was turned on for.
param(
    [Parameter(Mandatory = $true)][string]$Address
)
$ErrorActionPreference = 'Stop'
if ($Address -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw 'An IPv4 address, please.' }
$ip = Get-NetIPAddress -IPAddress $Address -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $ip) {
    @{ found = $false; category = ''; name = '' } | ConvertTo-Json -Compress
    exit 0
}
$conn = Get-NetConnectionProfile -InterfaceIndex $ip.InterfaceIndex -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) {
    @{ found = $true; category = ''; name = '' } | ConvertTo-Json -Compress
    exit 0
}
@{ found = $true; category = [string]$conn.NetworkCategory; name = [string]$conn.Name } | ConvertTo-Json -Compress
