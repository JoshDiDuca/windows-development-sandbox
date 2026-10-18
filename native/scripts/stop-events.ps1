#Requires -Version 5.1
# Prints, as JSON, the Windows events since -Since that can end a sandbox: restarts and shutdowns, power loss, sleep,
# low memory, this PC's blue screens, and Windows inside the sandbox crashing. Read-only. The fallback for HostTools.exe stop-events (host/life/stop-events.ts).
param([Parameter(Mandatory = $true)][datetime]$Since)
$ErrorActionPreference = 'Stop'

$filters = @(
    @{ LogName = 'System'; Id = 1074, 6008, 41, 42, 2004; StartTime = $Since },
    @{ LogName = 'System'; Id = 1001; ProviderName = 'Microsoft-Windows-WER-SystemErrorReporting'; StartTime = $Since },
    @{ LogName = 'Microsoft-Windows-Hyper-V-Worker-Admin'; Id = 18590, 40001; StartTime = $Since },
    # Hardware errors Windows reported (WHEA: CPU, memory, bus, disk).
    @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WHEA-Logger'; Id = 17, 18, 19, 47; StartTime = $Since },
    # Any error or critical event of the Hyper-V worker and compute services (the VM's memory, start and stop).
    @{ LogName = 'Microsoft-Windows-Hyper-V-Worker-Admin'; Level = 1, 2; StartTime = $Since },
    @{ LogName = 'Microsoft-Windows-Hyper-V-Compute-Admin'; Level = 1, 2; StartTime = $Since },
    # A crash report of the programs that hold the VM (kept only when it names one of them).
    @{ LogName = 'Application'; Id = 1000, 1001; StartTime = $Since; OnlyVmPrograms = $true }
)
$maxMessage = 390
$maxResourceMessage = 1500

# What each event says beyond its id: the program that asked for a restart (1074), else the start of the message.
function Get-EventDetail($record) {
    if ($record.Id -eq 1074) { return [string]$record.Properties[0].Value }
    # The plain power events say nothing more; the resource-exhaustion event (2004) lists the biggest memory users.
    # Kernel-Power 41 carries the stop code of a blue screen (0 when there was none: a freeze or power loss).
    if ($record.Id -eq 41) { return 'BugcheckCode ' + [string]$record.Properties[0].Value }
    if ($record.Id -in 42, 6008) { return '' }
    $message = [string]$record.Message
    $max = if ($record.Id -eq 2004) { $maxResourceMessage } else { $maxMessage }
    return $message.Substring(0, [math]::Min($max, $message.Length))
}

$events = foreach ($filter in $filters) {
    try {
        $onlyVm = $filter.ContainsKey('OnlyVmPrograms')
        $query = @{} + $filter
        $query.Remove('OnlyVmPrograms')
        Get-WinEvent -FilterHashtable $query -MaxEvents 100 | ForEach-Object {
            $detail = Get-EventDetail $_
            if ($onlyVm -and $detail -notmatch 'vmwp\.exe|vmmem|vmcompute|windowssandbox') { return }
            [pscustomobject]@{
                at       = $_.TimeCreated.ToUniversalTime().ToString('o')
                id       = $_.Id
                provider = $_.ProviderName
                process  = $detail
            }
        }
    } catch {
        # No matching events, or a log this PC does not have: nothing to add.
    }
}
ConvertTo-Json -Compress -InputObject @($events)
