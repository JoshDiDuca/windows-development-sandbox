// User hook scripts (.ps1 / .mjs / .js / .cmd / .bat) from hooks\<stage>, run in name order in the workspace.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { spawnAsync } from '../../shared/download/index.js';
import { exists } from '../runtime/fs.js';
import { isWin, launchDir } from '../runtime/paths.js';
import { log, warn } from '../runtime/log.js';
import { session, workspace } from '../runtime/session.js';

const commandFor = (file: string): [string, string[]] | null => {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mjs' || ext === '.js') return [process.execPath, [file]];
  if (!isWin) return null;
  if (ext === '.ps1')
    return [SYSTEM.powershell(), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file]];
  if (ext === '.cmd' || ext === '.bat') return [SYSTEM.cmd(), ['/d', '/c', file]];
  return null;
};

/** Hooks of the launch folder (C:\AgentLaunch\hooks), or of a project registered later (...\projects\<name>\hooks). */
export interface HookTarget {
  root: string;
  cwd: string;
}
const BOOT: HookTarget = { root: path.join(launchDir, 'hooks'), cwd: workspace };
export function projectHooks(name: string, cwd: string): HookTarget {
  return {
    root: path.join(launchDir, 'projects', name, 'hooks'),
    cwd,
  };
}

const hooksOf = (stage: string, target: HookTarget): { name: string; command: [string, string[]] }[] => {
  const dir = path.join(target.root, stage);
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const command = commandFor(path.join(dir, name));
      return command ? [{ name, command }] : [];
    });
};

const failed = (stage: string, name: string, status: number | null): void => {
  const message = 'Hook failed (' + stage + '/' + name + ', exit ' + status + ')';
  if (session.hooks.failFast) throw new Error(message);
  warn(message);
};

/** Whether `stage` has hooks to run (they write to the terminal themselves). */
export function hasHooks(stage: string, target: HookTarget = BOOT): boolean {
  return hooksOf(stage, target).length > 0;
}

export function runHooks(stage: string, env: NodeJS.ProcessEnv, target: HookTarget = BOOT): void {
  for (const { name, command } of hooksOf(stage, target)) {
    log('Hook [' + stage + ']: ' + name);
    const result = spawnSync(command[0], command[1], { stdio: 'inherit', cwd: target.cwd, env });
    if (result.status !== 0) failed(stage, name, result.status);
  }
}

/** The same without blocking: the session daemon keeps answering other requests while a project's hooks run. */
export async function runHooksAsync(stage: string, env: NodeJS.ProcessEnv, target: HookTarget): Promise<void> {
  for (const { name, command } of hooksOf(stage, target)) {
    log('Hook [' + stage + ']: ' + name);
    const status = await spawnAsync(command[0], command[1], {
      stdio: 'ignore',
      cwd: target.cwd,
      env,
      windowsHide: true,
    });
    if (status !== 0) failed(stage, name, status);
  }
}
