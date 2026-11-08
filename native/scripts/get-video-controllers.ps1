#Requires -Version 5.1
# The graphics adapters of this PC as one line of JSON: [ { name, driverVersion, driverDate } ]. Read-only. The crash
# report names the adapter and driver when the sandbox ran with vGPU.
param()
$ErrorActionPreference = 'Stop'
$adapters = @(Get-CimInstance -ClassName Win32_VideoController | ForEach-Object {
        $date = $null
        if ($_.DriverDate) { $date = $_.DriverDate.ToString('yyyy-MM-dd') }
        [ordered]@{ name = [string]$_.Name; driverVersion = [string]$_.DriverVersion; driverDate = $date }
    })
ConvertTo-Json -InputObject $adapters -Compress
