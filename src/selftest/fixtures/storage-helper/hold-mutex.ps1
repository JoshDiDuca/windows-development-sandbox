#Requires -Version 5.1
# Self-test aid for the storage helper: makes a named lock owned by this user (not by Administrators), as a normal user
# who got there first would, prints "held" and keeps it until its input ends.
param(
    [Parameter(Mandatory = $true)][string]$Name
)
$ErrorActionPreference = 'Stop'
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$security = New-Object Security.AccessControl.MutexSecurity
$security.SetOwner($me)
$security.AddAccessRule((New-Object Security.AccessControl.MutexAccessRule($me, 'FullControl', 'Allow')))
$created = $false
$lock = New-Object Threading.Mutex($false, $Name, [ref]$created, $security)
[Console]::Out.WriteLine('held')
[Console]::Out.Flush()
[void][Console]::In.ReadToEnd()
$lock.Dispose()
