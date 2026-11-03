#Requires -Version 5.1
# Opens an inbound TCP/UDP port in the sandbox's own firewall (sbx-fivem serve: 30120 and txAdmin's 40120), so the PC
# can reach a server running in the sandbox. Only from the sandbox's own subnet (the PC's Hyper-V network), never from
# anywhere else. Running it again replaces the rule. Uses netsh: the NetSecurity cmdlets fail in Windows Sandbox
# ("Invalid class"), like guest/network/firewall.ts.
# Exit code: 0 = done, 1 = the rule could not be added.
param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$Port,
    [ValidateSet('TCP', 'UDP', 'Both')][string]$Protocol = 'Both',
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9 ._-]{1,80}$')][string]$Name
)
$ErrorActionPreference = 'Stop'

$netsh = Join-Path $env:SystemRoot 'System32\netsh.exe'
$protocols = if ($Protocol -eq 'Both') { @('TCP', 'UDP') } else { @($Protocol) }
foreach ($p in $protocols) {
    $rule = 'AgentSandbox ' + $Name + ' (' + $p + ' ' + $Port + ')'
    & $netsh advfirewall firewall delete rule ('name=' + $rule) | Out-Null
    $out = & $netsh advfirewall firewall add rule ('name=' + $rule) dir=in action=allow enable=yes profile=any `
        ('protocol=' + $p) ('localport=' + $Port) remoteip=LocalSubnet
    if ($LASTEXITCODE -ne 0) {
        Write-Error ('Could not open ' + $p + ' ' + $Port + ': ' + ($out -join ' ')) -ErrorAction Continue
        exit 1
    }
    Write-Output ('Opened ' + $p + ' ' + $Port + ' for ' + $Name + ' (from the PC only)')
}
exit 0
