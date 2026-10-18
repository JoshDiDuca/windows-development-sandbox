#Requires -Version 5.1
# Prints this PC's memory as JSON: { totalMb, availableMb, commitLimitMb, commitAvailableMb }. Read-only. The fallback
# for HostTools.exe memory-status (host/life/host-memory.ts).
param()
$ErrorActionPreference = 'Stop'

$os = Get-CimInstance -ClassName Win32_OperatingSystem
# The paging file setup from the registry: auto (Windows manages it), fixed (with its maximum sizes) or none.
$pageFile = 'auto'
$pageFileMax = 0
try {
    $entries = @((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management' -ErrorAction Stop).PagingFiles | Where-Object { $_ -and $_.Trim() })
    $pageFile = 'none'
    foreach ($entry in $entries) {
        $parts = $entry.Trim() -split ' '
        $initial = 0; $max = 0
        if ($parts.Count -ge 3) { $initial = [int64]$parts[-2]; $max = [int64]$parts[-1] }
        if ($entry.StartsWith('?:') -or ($initial -eq 0 -and $max -eq 0)) { $pageFile = 'auto'; $pageFileMax = 0; break }
        $pageFile = 'fixed'
        $pageFileMax += $max
    }
} catch {
    # Not readable: treated as automatic (no warning).
}

# Win32_OperatingSystem counts in KB.
$result = [ordered]@{
    totalMb           = [int64][math]::Floor($os.TotalVisibleMemorySize / 1024)
    availableMb       = [int64][math]::Floor($os.FreePhysicalMemory / 1024)
    commitLimitMb     = [int64][math]::Floor($os.TotalVirtualMemorySize / 1024)
    commitAvailableMb = [int64][math]::Floor($os.FreeVirtualMemory / 1024)
    pageFile          = $pageFile
    pageFileMaxMb     = [int64]$pageFileMax
}
# The disks' queue length now (all together); left out when the counter is not there.
try {
    $disk = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'" -ErrorAction Stop
    if ($disk) { $result['diskQueue'] = [int64]$disk.CurrentDiskQueueLength }
} catch {
    # No counter: memory and CPU only.
}
ConvertTo-Json -Compress -InputObject $result
