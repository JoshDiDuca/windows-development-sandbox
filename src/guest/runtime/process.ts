import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';
import { moveIntoPlace, spawnAsync, stagingFolder } from '../../shared/download/index.js';
import { safeRemove } from '../../shared/io/safe-remove.js';
import { robocopyErrors, robocopyFailed, robocopyMeaning } from '../../shared/io/robocopy-result.js';
import { SYSTEM } from '../../shared/system.js';
import { scriptArgs } from '../../shared/scripts.js';
import { isWin } from './paths.js';

/** Runs a program, streaming output, and throws with a readable message when it fails. */
export function exec(file: string, args: string[], options: SpawnSyncOptions = {}): void {
  const result = spawnSync(file, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(path.basename(file) + ' ' + args.slice(0, 3).join(' ') + ' failed with exit code ' + result.status);
}

/** exec without blocking: other toolchains keep downloading while this one runs an installer. */
export async function execAsync(file: string, args: string[], options: SpawnOptions = {}): Promise<void> {
  const code = await spawnAsync(file, args, { stdio: 'inherit', ...options });
  if (code !== 0)
    throw new Error(path.basename(file) + ' ' + args.slice(0, 3).join(' ') + ' failed with exit code ' + code);
}

export function execOutput(file: string, args: string[], options: SpawnSyncOptions = {}): string {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, ...options });
  return result.status === 0 ? String(result.stdout ?? '').trim() : '';
}

/** Runs sandbox\scripts\<name> (a .ps1 in the launch folder) with `args`; throws when it fails. */
export function runScript(name: string, args: readonly string[] = []): void {
  const result = spawnSync(SYSTEM.powershell(), scriptArgs(name, args), {
    stdio: ['inherit', 'inherit', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const errors = String(result.stderr ?? '').trim();
  if (errors) process.stderr.write(errors + '\n');
  if (result.status !== 0)
    throw new Error(name + ' failed with exit code ' + result.status + (errors ? ': ' + errors.slice(0, 400) : ''));
}

/** runScript for what it prints ('' when it fails). */
export function scriptOutput(name: string, args: readonly string[] = [], options: SpawnSyncOptions = {}): string {
  return execOutput(SYSTEM.powershell(), scriptArgs(name, args), options);
}

/** Runs sandbox\scripts\<name> with a JSON file (-<param> path) holding `data`, removed afterwards. */
export function runScriptWithJson(name: string, param: string, data: unknown, args: readonly string[] = []): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  const file = path.join(dir, 'input.json');
  try {
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    runScript(name, ['-' + param, file, ...args]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copies a folder with robocopy (fast, restartable), or just the named files in it; exit codes below 8 mean success.
 */
export function robocopy(from: string, to: string, files: string[] = []): void {
  if (!isWin) {
    if (!files.length) {
      fs.cpSync(from, to, { recursive: true });
      return;
    }
    fs.mkdirSync(to, { recursive: true });
    for (const f of files.filter((f) => fs.existsSync(path.join(from, f))))
      fs.copyFileSync(path.join(from, f), path.join(to, f));
    return;
  }
  const what = files.length ? files : ['/E'];
  // A second pass for what the first could not copy (a file another program holds open for a moment, a busy mapped
  // folder): one thread and more patience; robocopy skips what is already in place.
  const passes = [
    ['/MT:16', '/R:1', '/W:1'],
    ['/MT:1', '/R:4', '/W:3'],
  ];
  let code: number | null = null;
  let output = '';
  for (const pass of passes) {
    const result = spawnSync(
      SYSTEM.robocopy(),
      [
        from,
        to,
        ...what,
        ...(files.length ? [] : [pass[0]]),
        pass[1],
        pass[2],
        '/NFL',
        '/NDL',
        '/NJH',
        '/NJS',
        '/NP',
        '/XJ',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    code = result.status;
    output = String(result.stdout ?? '') + String(result.stderr ?? '');
    if (!robocopyFailed(code)) return;
  }
  const why = robocopyErrors(output);
  throw new Error(
    'robocopy ' +
      from +
      ' -> ' +
      to +
      ' failed (exit ' +
      code +
      ': ' +
      robocopyMeaning(code) +
      ')' +
      (why.length ? ': ' + why.join(' | ') : ''),
  );
}

/**
 * A Node install without its global packages (nvm keeps those per version: often tens of thousands of small files,
 * which is what made copying from this PC slow). Same file list as Copy-NodeFromHost in sandbox/boot/bootstrap.ps1.
 * Copied into a staging folder and renamed into place: node.exe alone (an interrupted copy) must not look like a full
 * install.
 */
export function copyNode(from: string, to: string): void {
  const work = stagingFolder(to);
  try {
    robocopy(from, work, ['node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd']);
    robocopy(path.join(from, 'node_modules', 'npm'), path.join(work, 'node_modules', 'npm'));
    moveIntoPlace(work, to);
  } finally {
    safeRemove(work, path.dirname(work));
  }
}
