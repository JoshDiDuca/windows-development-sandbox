#Requires -Version 5.1
# Windows Sandbox keeps the WMI class Win32_TerminalService but not the provider DLL behind it, so every query of
# Win32_Service (which includes its subclasses) fails with "Provider load failure". Installers that check a service
# that way (OpenVPN's MSI does) then fail with 1603. This removes that one class, and only when its provider is not
# registered: the sandbox is thrown away when it closes, and nothing else is changed. Prints what it did.
param()
$ErrorActionPreference = 'Stop'

$className = 'Win32_TerminalService'
$providerName = 'Win32_WIN32_TERMINALSERVICE_Prov'

$class = Get-WmiObject -Namespace 'root\cimv2' -List -Class $className -ErrorAction SilentlyContinue
if (-not $class) {
  Write-Output 'absent'
  exit 0
}
$provider = Get-WmiObject -Namespace 'root\cimv2' -Class '__Win32Provider' -Filter ("Name='" + $providerName + "'") -ErrorAction SilentlyContinue
if ($provider -and $provider.CLSID -match '^\{[0-9A-Fa-f-]{36}\}$') {
  $registered = Test-Path -LiteralPath ('Registry::HKEY_CLASSES_ROOT\CLSID\' + $provider.CLSID + '\InprocServer32')
  if ($registered) {
    Write-Output 'kept'
    exit 0
  }
}
([wmiclass]('root\cimv2:' + $className)).Delete()
Write-Output 'removed'
