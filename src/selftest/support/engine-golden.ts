// The .wsb text written before the engine layer existed (captured from the old buildWsb); never regenerate it.
export const ENGINE_GOLDEN: Readonly<Record<string, string>> = {
  default:
    '<Configuration><MemoryInMB>8192</MemoryInMB><vGPU>Disable</vGPU><Networking>Enable</Networking><ClipboardRedirection>Enable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><ProtectedClient>Enable</ProtectedClient><MappedFolders><MappedFolder><HostFolder>C:\\L\\launches\\1</HostFolder><SandboxFolder>C:\\AgentLaunch</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\S\\data\\default</HostFolder><SandboxFolder>C:\\AgentData</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\Work\\app</HostFolder><SandboxFolder>C:\\Workspace\\app</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>C:\\AgentLaunch\\sandbox\\boot\\logon.cmd</Command></LogonCommand></Configuration>',
  'vGpu on':
    '<Configuration><MemoryInMB>8192</MemoryInMB><vGPU>Enable</vGPU><Networking>Enable</Networking><ClipboardRedirection>Enable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><ProtectedClient>Enable</ProtectedClient><MappedFolders><MappedFolder><HostFolder>C:\\L\\launches\\1</HostFolder><SandboxFolder>C:\\AgentLaunch</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\S\\data\\default</HostFolder><SandboxFolder>C:\\AgentData</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\Work\\app</HostFolder><SandboxFolder>C:\\Workspace\\app</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>C:\\AgentLaunch\\sandbox\\boot\\logon.cmd</Command></LogonCommand></Configuration>',
  'networking off':
    '<Configuration><MemoryInMB>4096</MemoryInMB><vGPU>Disable</vGPU><Networking>Disable</Networking><ClipboardRedirection>Enable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><ProtectedClient>Enable</ProtectedClient><MappedFolders><MappedFolder><HostFolder>C:\\L\\launches\\1</HostFolder><SandboxFolder>C:\\AgentLaunch</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\S\\data\\default</HostFolder><SandboxFolder>C:\\AgentData</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\Work\\app</HostFolder><SandboxFolder>C:\\Workspace\\app</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>C:\\AgentLaunch\\sandbox\\boot\\logon.cmd</Command></LogonCommand></Configuration>',
  'several projects and roots':
    '<Configuration><MemoryInMB>16384</MemoryInMB><vGPU>Disable</vGPU><Networking>Enable</Networking><ClipboardRedirection>Enable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><ProtectedClient>Enable</ProtectedClient><MappedFolders><MappedFolder><HostFolder>C:\\L\\launches\\1</HostFolder><SandboxFolder>C:\\AgentLaunch</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\S\\data\\default</HostFolder><SandboxFolder>C:\\AgentData</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\Work\\app</HostFolder><SandboxFolder>C:\\Workspace\\app</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\Work\\one</HostFolder><SandboxFolder>C:\\Projects\\Work\\one</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\Work\\two</HostFolder><SandboxFolder>C:\\Projects\\Work\\two</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder><MappedFolder><HostFolder>D:\\Roots\\r</HostFolder><SandboxFolder>C:\\Projects\\r</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>C:\\AgentLaunch\\sandbox\\boot\\logon.cmd</Command></LogonCommand></Configuration>',
  'read-only workspace and extra folders':
    '<Configuration><MemoryInMB>8192</MemoryInMB><vGPU>Disable</vGPU><Networking>Enable</Networking><ClipboardRedirection>Enable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><ProtectedClient>Enable</ProtectedClient><MappedFolders><MappedFolder><HostFolder>C:\\L\\launches\\1</HostFolder><SandboxFolder>C:\\AgentLaunch</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\S\\data\\default</HostFolder><SandboxFolder>C:\\AgentData</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\Work\\app</HostFolder><SandboxFolder>C:\\Workspace\\app</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\Data</HostFolder><SandboxFolder>C:\\Assets</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>C:\\AgentLaunch\\sandbox\\boot\\logon.cmd</Command></LogonCommand></Configuration>',
  'mirror paths on another drive and escaped characters':
    '<Configuration><MemoryInMB>6144</MemoryInMB><vGPU>Disable</vGPU><Networking>Enable</Networking><ClipboardRedirection>Enable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><ProtectedClient>Enable</ProtectedClient><MappedFolders><MappedFolder><HostFolder>C:\\L\\launches\\1</HostFolder><SandboxFolder>C:\\AgentLaunch</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\S\\data\\default</HostFolder><SandboxFolder>C:\\AgentData</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\Work\\app</HostFolder><SandboxFolder>C:\\Workspace\\app</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder><MappedFolder><HostFolder>F:\\Games\\a&amp;b &lt;x&gt;</HostFolder><SandboxFolder>C:\\Mirror\\F\\SteamLibrary\\steamapps\\common\\Game</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>C:\\AgentLaunch\\sandbox\\boot\\logon.cmd</Command></LogonCommand></Configuration>',
  'memory 2048 and protectedClient off':
    '<Configuration><MemoryInMB>2048</MemoryInMB><vGPU>Disable</vGPU><Networking>Enable</Networking><ClipboardRedirection>Enable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><ProtectedClient>Disable</ProtectedClient><MappedFolders><MappedFolder><HostFolder>C:\\L\\launches\\1</HostFolder><SandboxFolder>C:\\AgentLaunch</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\S\\data\\default</HostFolder><SandboxFolder>C:\\AgentData</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\Work\\app</HostFolder><SandboxFolder>C:\\Workspace\\app</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>C:\\AgentLaunch\\sandbox\\boot\\logon.cmd</Command></LogonCommand></Configuration>',
  'every device on':
    '<Configuration><MemoryInMB>12288</MemoryInMB><vGPU>Enable</vGPU><Networking>Enable</Networking><ClipboardRedirection>Enable</ClipboardRedirection><AudioInput>Enable</AudioInput><VideoInput>Enable</VideoInput><PrinterRedirection>Enable</PrinterRedirection><ProtectedClient>Enable</ProtectedClient><MappedFolders><MappedFolder><HostFolder>C:\\L\\launches\\1</HostFolder><SandboxFolder>C:\\AgentLaunch</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\S\\data\\default</HostFolder><SandboxFolder>C:\\AgentData</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\Work\\app</HostFolder><SandboxFolder>C:\\Workspace\\app</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>C:\\AgentLaunch\\sandbox\\boot\\logon.cmd</Command></LogonCommand></Configuration>',
  'every device off':
    '<Configuration><MemoryInMB>8192</MemoryInMB><vGPU>Disable</vGPU><Networking>Disable</Networking><ClipboardRedirection>Disable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><ProtectedClient>Disable</ProtectedClient><MappedFolders><MappedFolder><HostFolder>C:\\L\\launches\\1</HostFolder><SandboxFolder>C:\\AgentLaunch</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>C:\\S\\data\\default</HostFolder><SandboxFolder>C:\\AgentData</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>C:\\AgentLaunch\\sandbox\\boot\\logon.cmd</Command></LogonCommand></Configuration>',
};

/** The files of a default launch folder (the fixtures' default launch) before the engine layer existed. */
export const LAUNCH_FILES_GOLDEN: readonly string[] = [
  'agent.wsb',
  'claude-profile/.claude.json',
  'claude-profile/CLAUDE.md',
  'claude-profile/commands/review.md',
  'claude-profile/plugins/installed_plugins.json',
  'claude-profile/settings.json',
  'env.cmd',
  'home/.gitconfig',
  'hooks/post-agent/README.txt',
  'hooks/pre-provision/README.txt',
  'package.json',
  'runtime/agent.js',
  'runtime/daemon.js',
  'runtime/db.js',
  'runtime/gitguard.js',
  'runtime/main.js',
  'runtime/netproxy.js',
  'runtime/view.js',
  'sandbox/boot/bootstrap.ps1',
  'sandbox/boot/bootstrap/drives.ps1',
  'sandbox/boot/bootstrap/files.ps1',
  'sandbox/boot/bootstrap/runner.ps1',
  'sandbox/boot/bootstrap/status.ps1',
  'sandbox/boot/logon.cmd',
  'sandbox/boot/trust.cmd',
  'sandbox/csharp/CargoShim.cs',
  'sandbox/csharp/Desktop.cs',
  'sandbox/csharp/EnvBroadcast.cs',
  'sandbox/csharp/GitShim.cs',
  'sandbox/csharp/LinkGate.cs',
  'sandbox/csharp/MemGov.cs',
  'sandbox/csharp/OpenSsl.cs',
  'sandbox/csharp/PathSync.cs',
  'sandbox/csharp/PtyHost.cs',
  'sandbox/csharp/SandboxTools/CpuCap.cs',
  'sandbox/csharp/SandboxTools/MemoryLog.cs',
  'sandbox/csharp/SandboxTools/PageFile.cs',
  'sandbox/csharp/SandboxTools/Program.cs',
  'sandbox/csharp/VsWhere.cs',
  'sandbox/csharp/VtInput.cs',
  'sandbox/scripts/enable-vt-input.ps1',
  'sandbox/scripts/expand-archive.ps1',
  'sandbox/scripts/get-gpu-names.ps1',
  'sandbox/scripts/get-signer.ps1',
  'sandbox/scripts/install-shell-path.ps1',
  'sandbox/scripts/link-profile-dirs.ps1',
  'sandbox/scripts/new-shortcuts.ps1',
  'sandbox/scripts/repair-wmi-services.ps1',
  'sandbox/scripts/set-desktop.ps1',
  'sandbox/scripts/set-dns-servers.ps1',
  'sandbox/scripts/set-machine-environment.ps1',
  'session.json',
];
