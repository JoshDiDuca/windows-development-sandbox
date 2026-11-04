#Requires -Version 5.1
# Looks for Visual Studio the way UnrealBuildTool does (guest/toolchains/engines/unreal-engines.ts runs it; the
# verdict is decided in vs-check.ts): every instance the Setup Configuration API lists (csharp\VsSetup.cs), the MSVC
# toolchains under each one's VC\Tools\MSVC that have the x64 compiler, and the Windows SDKs under each KitsRoot10 the
# registry names (HKLM in both views, HKCU) that have windows.h and the x64 kernel32.lib. Writes JSON to -ResultFile.
param([Parameter(Mandatory = $true)][string]$ResultFile)
$ErrorActionPreference = 'Stop'

Add-Type -Path (Join-Path $PSScriptRoot '..\csharp\VsSetup.cs')

$instances = New-Object System.Collections.ArrayList
$setupError = ''
try {
    foreach ($i in [AgentSandbox.VsSetup]::AllInstances()) {
        $toolchains = New-Object System.Collections.ArrayList
        $msvc = Join-Path $i.InstallationPath 'VC\Tools\MSVC'
        if (Test-Path -LiteralPath $msvc -PathType Container) {
            foreach ($dir in Get-ChildItem -LiteralPath $msvc -Directory) {
                $cl = Join-Path $dir.FullName 'bin\Hostx64\x64\cl.exe'
                $link = Join-Path $dir.FullName 'bin\Hostx64\x64\link.exe'
                [void]$toolchains.Add([ordered]@{
                        version = $dir.Name
                        cl      = (Test-Path -LiteralPath $cl -PathType Leaf)
                        link    = (Test-Path -LiteralPath $link -PathType Leaf)
                    })
            }
        }
        $wanted = @('Microsoft.VisualStudio.Component.VC.Tools.x86.x64', 'Microsoft.VisualStudio.Workload.NativeGame',
            'Microsoft.VisualStudio.Workload.VCTools', 'Component.Unreal', 'Component.Unreal.Ide')
        [void]$instances.Add([ordered]@{
                instanceId          = $i.InstanceId
                installationPath    = $i.InstallationPath
                installationVersion = $i.InstallationVersion
                productId           = $i.ProductId
                state               = [int64]$i.State
                isComplete          = $i.IsComplete
                isLaunchable        = $i.IsLaunchable
                packages            = @($i.Packages | Where-Object { $wanted -contains $_ })
                packageCount        = @($i.Packages).Count
                toolchains          = @($toolchains)
            })
    }
} catch {
    $setupError = $_.Exception.Message
}

$roots = New-Object System.Collections.ArrayList
$places = @(
    @{ hive = [Microsoft.Win32.RegistryHive]::LocalMachine; view = [Microsoft.Win32.RegistryView]::Registry64; name = 'HKLM (64-bit)' },
    @{ hive = [Microsoft.Win32.RegistryHive]::LocalMachine; view = [Microsoft.Win32.RegistryView]::Registry32; name = 'HKLM (32-bit)' },
    @{ hive = [Microsoft.Win32.RegistryHive]::CurrentUser; view = [Microsoft.Win32.RegistryView]::Registry64; name = 'HKCU' }
)
foreach ($place in $places) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($place.hive, $place.view)
    try {
        $key = $base.OpenSubKey('SOFTWARE\Microsoft\Windows Kits\Installed Roots')
        if ($key) {
            $value = [string]$key.GetValue('KitsRoot10')
            $key.Close()
            if ($value) { [void]$roots.Add([ordered]@{ where = $place.name; path = $value }) }
        }
    } finally {
        $base.Close()
    }
}

$sdks = New-Object System.Collections.ArrayList
$seen = @{}
foreach ($root in $roots) {
    $include = Join-Path $root.path 'Include'
    if ($seen.ContainsKey($include.ToLowerInvariant())) { continue }
    $seen[$include.ToLowerInvariant()] = $true
    if (-not (Test-Path -LiteralPath $include -PathType Container)) { continue }
    foreach ($dir in Get-ChildItem -LiteralPath $include -Directory) {
        if ($dir.Name -notmatch '^10\.\d+\.\d+\.\d+$') { continue }
        [void]$sdks.Add([ordered]@{
                version  = $dir.Name
                root     = $root.path
                windowsH = (Test-Path -LiteralPath (Join-Path $dir.FullName 'um\windows.h') -PathType Leaf)
                kernel32 = (Test-Path -LiteralPath (Join-Path $root.path ('Lib\' + $dir.Name + '\um\x64\kernel32.lib')) -PathType Leaf)
                ucrt     = (Test-Path -LiteralPath (Join-Path $root.path ('Lib\' + $dir.Name + '\ucrt\x64\ucrt.lib')) -PathType Leaf)
            })
    }
}

$result = [ordered]@{
    setupError = $setupError
    instances  = @($instances)
    kitsRoots  = @($roots)
    sdks       = @($sdks)
}
$json = ConvertTo-Json -InputObject $result -Depth 6
[System.IO.File]::WriteAllText($ResultFile, $json, (New-Object System.Text.UTF8Encoding($false)))
