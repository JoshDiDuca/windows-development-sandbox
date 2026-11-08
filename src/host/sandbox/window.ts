// Headless mode: Windows Sandbox always opens its client window, so we hide it (ShowWindow SW_HIDE) as soon as it
// appears. The VM and the logged-in session keep running; `sandbox show` brings the window back. The work is done by
// HostTools.exe (native\csharp\HostTools\Window.cs), else by native\scripts\*-window.ps1 with the same C#.
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { writeJsonAtomic } from '../../shared/io/index.js';
import { SYSTEM } from '../../shared/system.js';
import { refuseInSelfTest } from '../test-guard.js';
import { hostToolsExe, nativeScript } from '../native.js';
import { isWin, tryReadJson } from '../../core/util/index.js';

function stateFile(storageRoot: string): string {
  return path.join(storageRoot, 'run', 'hidden-windows.json');
}

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', () => resolve(out));
  });
}

/** Waits for the sandbox window and hides it; keeps watching briefly in case Windows re-shows it while connecting. */
export async function hideSandboxWindow(storageRoot: string, waitSeconds = 180): Promise<boolean> {
  refuseInSelfTest('hide windows');
  if (!isWin) return false;
  const wait = String(Math.trunc(waitSeconds));
  const tools = hostToolsExe(storageRoot);
  const stdout = tools
    ? await run(tools, ['hide-window', '--wait', wait])
    : await run(SYSTEM.powershell(), nativeScript('hide-window.ps1', ['-WaitSeconds', wait]));
  const handles = (JSON.parse(stdout.trim() || '[]') as unknown[]).filter((h): h is number => Number.isSafeInteger(h));
  writeJsonAtomic(stateFile(storageRoot), { handles });
  return handles.length > 0;
}

/** Shows the sandbox window again (the ones we hid, or any hidden Windows Sandbox window). */
export function showSandboxWindow(storageRoot: string): boolean {
  refuseInSelfTest('show windows');
  if (!isWin) return false;
  // Only integers go on the command line, whatever the file contains.
  const recorded = (tryReadJson<{ handles: unknown[] }>(stateFile(storageRoot))?.handles ?? []).filter(
    (h): h is number => Number.isSafeInteger(h),
  );
  const list = recorded.join(',');
  const tools = hostToolsExe(storageRoot);
  const options = { encoding: 'utf8' as const, windowsHide: true };
  const result = tools
    ? spawnSync(tools, ['show-window', ...(list ? ['--handles', list] : [])], options)
    : spawnSync(SYSTEM.powershell(), nativeScript('show-window.ps1', list ? ['-Handles', list] : []), options);
  writeJsonAtomic(stateFile(storageRoot), { handles: [] });
  return Number((result.stdout ?? '').trim()) > 0;
}
