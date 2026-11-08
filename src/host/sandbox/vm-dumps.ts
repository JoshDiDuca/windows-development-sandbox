// A crash dump of the program that runs the sandbox's VM (vmwp.exe). Windows Error Reporting writes one when
// HKLM\...\LocalDumps\vmwp.exe is set; native\scripts\set-vm-crash-dumps.ps1 sets or removes that (administrator
// rights: run through run-elevated.ps1, so Windows asks for permission) and reads whether it is set. The dump folder is
// machine-wide (%ProgramData%\AgentSandbox\vm-dumps) because vmwp.exe runs as NT VIRTUAL MACHINE\<id>, not as you.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { machineRoot } from '../../core/config/index.js';
import { fail, isWin } from '../../core/util/index.js';
import { SYSTEM } from '../../shared/system.js';
import { nativeFile, nativeScript } from '../native.js';
import { refuseInSelfTest, selfTestRunning } from '../test-guard.js';

const STATUS_TIMEOUT_MS = 20000;
const ELEVATED_TIMEOUT_MS = 120000;
/** What a folder path may hold when it is handed to the elevated PowerShell (no quotes, no variables). */
const SAFE_FOLDER = /^[A-Za-z]:\\[A-Za-z0-9 _.\-()\\]{1,240}$/;

const VmDumpStateSchema = z.object({ on: z.boolean(), folder: z.string().max(520) });
export type VmDumpState = z.output<typeof VmDumpStateSchema>;

/** Where the dumps go: <machine folder>\vm-dumps (C:\ProgramData\AgentSandbox\vm-dumps). */
export function vmDumpFolder(): string {
  return path.join(machineRoot(), 'vm-dumps');
}

/** The state the script printed (its last line of JSON), or null (pure). */
export function parseVmDumpState(text: string): VmDumpState | null {
  const last = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .pop();
  try {
    const parsed = VmDumpStateSchema.safeParse(JSON.parse(last ?? ''));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The -Command that runs the script elevated (pure): script and folder quoted; scripts may run in this process. */
export function vmDumpCommand(script: string, action: 'on' | 'off', folder: string): string {
  if (!SAFE_FOLDER.test(folder)) fail('The dump folder "' + folder + '" has characters that are not allowed.');
  const quote = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
  return (
    'Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; & ' +
    quote(script) +
    ' -Action ' +
    action +
    ' -Folder ' +
    quote(folder)
  );
}

/** Whether crash dumps of vmwp.exe are kept now, or null (not Windows, unreadable, or during the self-test). */
export function readVmDumps(): VmDumpState | null {
  if (!isWin || selfTestRunning()) return null;
  const result = spawnSync(
    SYSTEM.powershell(),
    nativeScript('set-vm-crash-dumps.ps1', ['-Action', 'status', '-Folder', vmDumpFolder()]),
    { encoding: 'utf8', windowsHide: true, timeout: STATUS_TIMEOUT_MS },
  );
  return result.status === 0 ? parseVmDumpState(result.stdout ?? '') : null;
}

/**
 * Turns the dump capture on or off in an elevated PowerShell (Windows asks for administrator permission) and returns
 * the state afterwards, read again without elevation: null when it could not be read.
 */
export function setVmDumps(action: 'on' | 'off'): VmDumpState | null {
  refuseInSelfTest('change the crash dump settings of this PC');
  const command = vmDumpCommand(nativeFile('scripts', 'set-vm-crash-dumps.ps1'), action, vmDumpFolder());
  spawnSync(SYSTEM.powershell(), nativeScript('run-elevated.ps1', ['-Command', command]), {
    windowsHide: true,
    timeout: ELEVATED_TIMEOUT_MS,
  });
  return readVmDumps();
}
