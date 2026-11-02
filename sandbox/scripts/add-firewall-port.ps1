#Requires -Version 5.1
# Opens an inbound TCP/UDP port in the sandbox's own firewall (sbx-fivem serve: 30120 and txAdmin's 40120), so the PC
# can reach a server running in the sandbox. Not available yet: changes nothing.
# Exit code: 0 = done, 1 = not available yet.
param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$Port,
    [ValidateSet('TCP', 'UDP', 'Both')][string]$Protocol = 'Both',
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9 ._-]{1,80}$')][string]$Name
)
$ErrorActionPreference = 'Stop'

Write-Output ('add-firewall-port: not available yet (port ' + $Port + ', ' + $Name + ')')
exit 1
