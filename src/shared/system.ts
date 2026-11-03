// Absolute paths for the Windows programs agent-sandbox runs. Never spawn them by bare name: Windows looks in the
// current folder before PATH, and the current folder is often the workspace, which the sandbox can write.
import path from 'node:path';

const systemRoot = (): string => process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';

export function system32(exe: string): string {
  return path.join(systemRoot(), 'System32', exe);
}

export const SYSTEM = {
  cmd: (): string => system32('cmd.exe'),
  powershell: (): string => system32('WindowsPowerShell\\v1.0\\powershell.exe'),
  tasklist: (): string => system32('tasklist.exe'),
  taskkill: (): string => system32('taskkill.exe'),
  whoami: (): string => system32('whoami.exe'),
  icacls: (): string => system32('icacls.exe'),
  tar: (): string => system32('tar.exe'),
  reg: (): string => system32('reg.exe'),
  netsh: (): string => system32('netsh.exe'),
  netstat: (): string => system32('NETSTAT.EXE'),
  route: (): string => system32('ROUTE.EXE'),
  ipconfig: (): string => system32('ipconfig.exe'),
  robocopy: (): string => system32('Robocopy.exe'),
  shutdown: (): string => system32('shutdown.exe'),
  dism: (): string => system32('Dism.exe'),
  msiexec: (): string => system32('msiexec.exe'),
  sc: (): string => system32('sc.exe'),
  /** The .NET Framework C# compiler that ships with Windows (C# 5). */
  csc: (): string => path.join(systemRoot(), 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
} as const;

/**
 * Started from a PowerShell 7 terminal, this process inherits PowerShell 7's PSModulePath, and every Windows PowerShell
 * 5.1 it runs then fails to load its own modules (Get-Acl, Get-ScheduledTask ...). Without the variable each PowerShell
 * builds its usual one, so entry points that a user starts from a terminal drop it once.
 */
export function dropInheritedModulePath(env: NodeJS.ProcessEnv = process.env): void {
  delete env.PSModulePath;
}
