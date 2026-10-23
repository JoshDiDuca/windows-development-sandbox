#Requires -Version 5.1
# Installs (or, with -Remove, removes) the storage helper: the Windows service AgentSandboxStorage, which mounts and
# dismounts a user's contained-storage disk image without a Windows permission prompt (native\csharp\StorageHelper).
# Run by scripts\install.ps1 for an install for everyone only, in its admin PowerShell.
#   -Install -GroupSid <sid> -InstallRoot <Program Files install folder> -Sources <...\native\csharp\StorageHelper>
#     builds AgentSandboxStorage.exe with the csc that ships with Windows, from sources inside the install folder, into
#     <InstallRoot>\helper (nothing a normal user can write is used), makes the machine folders logs\ and storage-helper\
#     (administrators only), and creates or updates the service: LocalSystem, automatic start (it must own its pipe before
#     anyone signs in), restart on failure, only the privileges it needs. The service is stopped while its file changes.
#   -Remove [-InstallRoot <...>]
#     stops the service, dismounts every image it mounted (AgentSandboxStorage.exe release-all), deletes the service and
#     <InstallRoot>\helper. The log stays (it goes with the machine folder when saved data is removed).
#   -DryRun prints what it would do (STEP: lines) after checking the arguments, and changes nothing (no admin needed).
# Exit 0 when done, 2 when not admin, 1 with the reason on stderr otherwise.
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Install')][switch]$Install,
    [Parameter(Mandatory = $true, ParameterSetName = 'Remove')][switch]$Remove,
    [Parameter(ParameterSetName = 'Install')][string]$GroupSid,
    [Parameter(ParameterSetName = 'Install')][string]$Sources,
    [string]$InstallRoot,
    [ValidatePattern('^[A-Za-z][A-Za-z0-9-]{2,63}$')][string]$ServiceName = 'AgentSandboxStorage',
    [string]$MachineData,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$exeName = 'AgentSandboxStorage.exe'
$privileges = 'SeChangeNotifyPrivilege/SeManageVolumePrivilege/SeBackupPrivilege/SeRestorePrivilege/SeImpersonatePrivilege'
$sc = Join-Path $env:SystemRoot 'System32\sc.exe'
$csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

function Write-Step([string]$Text) {
    if ($DryRun) { Write-Output ('STEP: ' + $Text) }
}

function Test-Inside([string]$Path, [string]$Root) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    return $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NotLink([string]$Path) {
    if ((Test-Path -LiteralPath $Path) -and ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing a link: $Path"
    }
}

# A machine folder only administrators may change: made when missing, its owner and permissions written whole.
function Set-AdminFolder([string]$Path) {
    Write-Step "admin-only folder $Path"
    if ($DryRun) { return }
    Assert-NotLink (Split-Path -Parent $Path)
    Assert-NotLink $Path
    New-Item -ItemType Directory -Force $Path | Out-Null
    Assert-NotLink $Path
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $who = New-Object Security.Principal.SecurityIdentifier($sid)
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($who, 'FullControl', $inherit, 'None', 'Allow')))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Wait-Stopped([string]$Name) {
    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $service -or $service.Status -eq 'Stopped') { return }
    Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
    $service.WaitForStatus('Stopped', (New-TimeSpan -Seconds 60))
}

function Invoke-Sc([string[]]$Arguments) {
    $output = & $sc @Arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "sc.exe $($Arguments[0]) failed (exit $LASTEXITCODE): $($output.Trim())" }
}

try {
    if (-not $DryRun) {
        $principalCheck = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            [Console]::Error.WriteLine('This needs admin rights. Run it in an admin PowerShell (right-click Start > Terminal (Admin)).')
            exit 2
        }
    }
    if (-not $MachineData) { $MachineData = Join-Path $(if ($env:ProgramData) { $env:ProgramData } else { 'C:\ProgramData' }) 'AgentSandbox' }
    if (-not $InstallRoot) { $InstallRoot = Join-Path $env:ProgramFiles 'WindowsDevelopmentSandbox' }
    # A dry run (the self-test) may name a temp folder; a real run only the Program Files install folder.
    if (-not [IO.Path]::IsPathRooted($InstallRoot) -or (-not $DryRun -and -not (Test-Inside $InstallRoot $env:ProgramFiles))) {
        throw "-InstallRoot must be a folder inside $env:ProgramFiles (normal users cannot write there): $InstallRoot"
    }
    $helperDir = Join-Path $InstallRoot 'helper'
    $exe = Join-Path $helperDir $exeName

    if ($Remove) {
        $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($service) {
            Write-Step "stop the service $ServiceName"
            if (-not $DryRun) { Wait-Stopped $ServiceName }
            if (Test-Path -LiteralPath $exe) {
                Write-Step 'dismount every image the helper mounted (release-all)'
                if (-not $DryRun) {
                    $released = & $exe release-all 2>&1 | Out-String
                    if ($released.Trim()) { Write-Output $released.Trim() }
                    if ($LASTEXITCODE -ne 0) {
                        Write-Output 'WARNING: some images are still mounted (a sandbox may be running). Close it and run sandbox repair, which dismounts them (Windows asks for permission).'
                    }
                }
            }
            Write-Step "delete the service $ServiceName"
            if (-not $DryRun) { Invoke-Sc @('delete', $ServiceName) }
        }
        Write-Step "remove $helperDir"
        if (-not $DryRun -and (Test-Path -LiteralPath $helperDir)) {
            Assert-NotLink $helperDir
            Remove-Item -LiteralPath $helperDir -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $helperDir) { Write-Output "WARNING: $helperDir is still there (the service may still be ending); delete it later." }
        }
        exit 0
    }

    if ($GroupSid -notmatch '^S-1-5-21(-\d{1,10}){4}$') { throw "-GroupSid must be the SID of the local group Agent Sandbox Users (got '$GroupSid')." }
    if (-not $Sources -or -not (Test-Path -LiteralPath $Sources -PathType Container) -or -not (Test-Inside $Sources $InstallRoot)) {
        throw "-Sources must be the StorageHelper source folder inside $InstallRoot (got '$Sources')."
    }
    $files = @(Get-ChildItem -LiteralPath $Sources -Filter '*.cs' -File | Sort-Object Name | ForEach-Object { $_.FullName })
    if ($files.Count -eq 0) { throw "No sources in $Sources." }
    if (-not (Test-Path -LiteralPath $csc)) { throw "The C# compiler that ships with Windows is missing: $csc" }
    foreach ($p in @($InstallRoot, $helperDir, $Sources)) { Assert-NotLink $p }

    $build = Join-Path $InstallRoot ('helper-build-' + [guid]::NewGuid().ToString('N'))
    Write-Step "build $exeName from $($files.Count) sources in $build"
    if (-not $DryRun) {
        New-Item -ItemType Directory -Force $build | Out-Null
        try {
            $built = Join-Path $build $exeName
            $compiled = & $csc /nologo /optimize /target:exe /r:System.Web.Extensions.dll /r:System.ServiceProcess.dll "/out:$built" @files 2>&1 | Out-String
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $built)) { throw "The storage helper did not build: $($compiled.Trim())" }
            Write-Step "stop the service $ServiceName while its file is replaced"
            Wait-Stopped $ServiceName
            New-Item -ItemType Directory -Force $helperDir | Out-Null
            Assert-NotLink $helperDir
            Move-Item -LiteralPath $built -Destination $exe -Force
        } finally {
            if (Test-Inside $build $InstallRoot) { Remove-Item -LiteralPath $build -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    Set-AdminFolder (Join-Path $MachineData 'logs')
    Set-AdminFolder (Join-Path $MachineData 'storage-helper')

    $binaryPath = '"' + $exe + '" service --group ' + $GroupSid
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Step "update the service $ServiceName to run $binaryPath"
        if (-not $DryRun) {
            Set-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName" -Name ImagePath -Value $binaryPath
            Invoke-Sc @('config', $ServiceName, 'start=', 'auto', 'obj=', 'LocalSystem')
        }
    } else {
        Write-Step "create the service $ServiceName (LocalSystem, automatic start) running $binaryPath"
        if (-not $DryRun) {
            New-Service -Name $ServiceName -BinaryPathName $binaryPath -DisplayName 'Agent Sandbox storage helper' -Description 'Mounts the contained-storage disk image of Windows Development Sandbox users without a permission prompt. Removed by uninstalling Windows Development Sandbox.' -StartupType Automatic | Out-Null
        }
    }
    Write-Step "restart on failure, privileges $privileges, unrestricted service SID"
    if (-not $DryRun) {
        Invoke-Sc @('failure', $ServiceName, 'reset=', '86400', 'actions=', 'restart/5000/restart/60000//')
        Invoke-Sc @('privs', $ServiceName, $privileges)
        Invoke-Sc @('sidtype', $ServiceName, 'unrestricted')
    }
    Write-Step "start the service $ServiceName"
    if (-not $DryRun) {
        Start-Service -Name $ServiceName
        (Get-Service -Name $ServiceName).WaitForStatus('Running', (New-TimeSpan -Seconds 30))
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
