import { spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { refuseInSelfTest } from '../test-guard.js';
import { hostToolsExe, nativeScript } from '../native.js';

/** Exit code of HostTools user-path / edit-user-path.ps1 when PATH would pass 32000 characters. */
const TOO_LONG = 3;

/**
 * Edits YOUR PATH (HKCU\Environment) unexpanded, then tells Windows it changed: HostTools.exe user-path (built in
 * <storageRoot>\bin), else native\scripts\edit-user-path.ps1.
 */
export function editUserPath(dir: string, add: boolean, storageRoot: string): void {
  refuseInSelfTest('change your PATH');
  const tools = hostToolsExe(storageRoot);
  const options = { encoding: 'utf8' as const, windowsHide: true };
  const result = tools
    ? spawnSync(tools, ['user-path', add ? '--add' : '--remove', dir], options)
    : spawnSync(
        SYSTEM.powershell(),
        nativeScript('edit-user-path.ps1', ['-Dir', dir, ...(add ? ['-Add'] : [])]),
        options,
      );
  if (result.status === TOO_LONG) throw new Error('Your PATH is too long to add ' + dir + '.');
  if (result.status !== 0)
    throw new Error(
      'Could not ' +
        (add ? 'add ' + dir + ' to' : 'remove ' + dir + ' from') +
        ' your PATH: ' +
        (result.stderr || result.error?.message || 'exit ' + result.status).trim(),
    );
}

/**
 * Whether dir is on YOUR PATH as stored in the registry (not this process's copy, which an older terminal keeps stale).
 * False when it cannot be told: the caller then edits the PATH again, which is harmless.
 */
export function userPathHas(dir: string, storageRoot: string): boolean {
  refuseInSelfTest('read your PATH');
  const tools = hostToolsExe(storageRoot);
  const options = { encoding: 'utf8' as const, windowsHide: true };
  const result = tools
    ? spawnSync(tools, ['user-path', '--has', dir], options)
    : spawnSync(SYSTEM.powershell(), nativeScript('edit-user-path.ps1', ['-Dir', dir, '-Query']), options);
  return result.status === 0;
}
