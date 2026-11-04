import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';
import { moveIntoPlace, spawnAsync, stagingFolder } from '../../shared/download/index.js';
import { safeRemove } from '../../shared/io/safe-remove.js';
import { robocopyErrors, robocopyFailed, robocopyMeaning } from '../../shared/io/robocopy-result.js';
import { SYSTEM } from '../../shared/system.js';
import { scriptArgs } from '../../shared/scripts.js';
import { isWin } from './paths.js';

/** Takes the output of the programs started while the boot draws its progress (boot/boot-console.ts). */
export interface OutputSink {
  /** Whether programs started now hand their output over instead of writing to the console. */
  capturing(): boolean;
  /** One line of a program's output (to the log). */
  line(text: string): void;
}

// Set by the boot only: this module stays free of the log (pure helpers such as tool-env import it).
let outputSink: OutputSink | null = null;

/** Hands the output of programs started from now on to `sink` while it is capturing (null: the console again). */
export function routeOutput(sink: OutputSink | null): void {
  outputSink = sink;
}

const captureOutput = (): boolean => outputSink?.capturing() ?? false;

/** A program's captured output, line by line (its blank lines dropped). */
function logOutput(text: string): void {
  for (const line of text.split(/\r?\n/)) if (line.trim()) outputSink?.line(line.trimEnd());
}

/** What a program may print while the boot holds its output for the log (a larger output stops it). */
const CAPTURE_BYTES = 64 * 1024 * 1024;
/** A captured line longer than this is cut (an installer's progress bar without line ends). */
const LINE_CHARS = 2000;

/** Feeds a stream to the log line by line as it arrives. */
function logLines(stream: NodeJS.ReadableStream | null): void {
  if (!stream) return;
  let partial = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const lines = (partial + chunk).split(/\r?\n/);
    partial = lines.pop()!.slice(0, LINE_CHARS);
    logOutput(lines.map((l) => l.slice(0, LINE_CHARS)).join('\n'));
  });
  stream.on('end', () => logOutput(partial));
}

/** Runs a program, streaming output, and throws with a readable message when it fails. */
export function exec(file: string, args: string[], options: SpawnSyncOptions = {}): void {
  // While the boot draws its progress, the program's output goes to the log (it would break the drawing).
  const capture = captureOutput();
  const result = spawnSync(file, args, {
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
    ...(capture ? { maxBuffer: CAPTURE_BYTES } : {}),
    ...options,
  });
  if (capture) logOutput(String(result.stdout ?? '') + '\n' + String(result.stderr ?? ''));
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(path.basename(file) + ' ' + args.slice(0, 3).join(' ') + ' failed with exit code ' + result.status);
}

/** exec without blocking: other toolchains keep downloading while this one runs an installer. */
export async function execAsync(file: string, args: string[], options: SpawnOptions = {}): Promise<void> {
  const code = captureOutput()
    ? await new Promise<number>((resolve, reject) => {
        const child = spawn(file, args, { stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true, ...options });
        logLines(child.stdout);
        logLines(child.stderr);
        child.once('error', reject);
        child.once('close', (c) => resolve(c ?? -1));
      })
    : await spawnAsync(file, args, { stdio: 'inherit', ...options });
  if (code !== 0)
    throw new Error(path.basename(file) + ' ' + args.slice(0, 3).join(' ') + ' failed with exit code ' + code);
}

/** A script's error output: to the log while the boot holds the console, else to the console's error stream. */
function scriptErrors(errors: string): void {
  if (!errors) return;
  if (captureOutput()) logOutput(errors);
  else process.stderr.write(errors + '\n');
}

export function execOutput(file: string, args: string[], options: SpawnSyncOptions = {}): string {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, ...options });
  return result.status === 0 ? String(result.stdout ?? '').trim() : '';
}

/** Runs sandbox\scripts\<name> (a .ps1 in the launch folder) with `args`; throws when it fails. */
export function runScript(name: string, args: readonly string[] = []): void {
  const capture = captureOutput();
  const result = spawnSync(SYSTEM.powershell(), scriptArgs(name, args), {
    stdio: ['inherit', capture ? 'pipe' : 'inherit', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
    ...(capture ? { maxBuffer: CAPTURE_BYTES } : {}),
  });
  if (capture) logOutput(String(result.stdout ?? ''));
  if (result.error) throw result.error;
  const errors = String(result.stderr ?? '').trim();
  scriptErrors(errors);
  if (result.status !== 0)
    throw new Error(name + ' failed with exit code ' + result.status + (errors ? ': ' + errors.slice(0, 400) : ''));
}

/** runScript without blocking the event loop (other boot tasks keep going while the script runs). */
export function runScriptAsync(name: string, args: readonly string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const capture = captureOutput();
    const child = spawn(SYSTEM.powershell(), scriptArgs(name, args), {
      stdio: ['inherit', capture ? 'pipe' : 'inherit', 'pipe'],
      windowsHide: true,
    });
    if (capture) logLines(child.stdout);
    let errors = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (errors.length < 4096) errors += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      errors = errors.trim();
      scriptErrors(errors);
      if (code !== 0)
        reject(new Error(name + ' failed with exit code ' + code + (errors ? ': ' + errors.slice(0, 400) : '')));
      else resolve();
    });
  });
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

/** runScriptWithJson without blocking the event loop. */
export async function runScriptWithJsonAsync(
  name: string,
  param: string,
  data: unknown,
  args: readonly string[] = [],
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  const file = path.join(dir, 'input.json');
  try {
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    await runScriptAsync(name, ['-' + param, file, ...args]);
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
