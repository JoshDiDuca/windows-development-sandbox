// Every copy of the sandbox commands on the PATH (sandbox), in the order Windows finds them:
// the machine PATH, then yours, and in each folder PATHEXT order. Read only: nothing is run, and a file is only checked
// for existing. Used by doctor to say which copy runs and how to remove each of the others.
import fs from 'node:fs';
import path from 'node:path';
import { expandVariables } from '../../core/util/index.js';

export const COMMAND_NAMES = ['sandbox'] as const;

export type CopyKind = 'managed-machine' | 'managed-user' | 'npm' | 'old-scripts' | 'other';

/** One folder on the PATH that holds the commands. */
export interface CommandCopy {
  readonly dir: string;
  /** The commands found in it, as the file Windows would run for each (sandbox.cmd, ...). */
  readonly files: readonly string[];
  readonly kind: CopyKind;
  /** Position among the PATH folders that hold a copy (0 = the first one, the one that runs). */
  readonly order: number;
}

export interface PathCopyEnv {
  /** Machine PATH, then user PATH (raw registry values; null when unreadable). */
  readonly machinePath: string | null;
  readonly userPath: string | null;
  /** PATHEXT, e.g. ".COM;.EXE;.BAT;.CMD". */
  readonly pathext: string;
  /** %ProgramFiles% and %LOCALAPPDATA% (where the managed installs live). */
  readonly programFiles: string | null;
  readonly localAppData: string | null;
  readonly exists: (file: string) => boolean;
}

const normal = (p: string): string =>
  path
    .normalize(expandVariables(p.trim().replace(/^"|"$/g, '')))
    .replace(/[\\/]+$/, '')
    .toLowerCase();

/** The PATH folders in the order Windows searches them (machine, then user), each once, variables expanded. */
export function pathFolders(machinePath: string | null, userPath: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [machinePath, userPath])
    for (const raw of (value ?? '').split(';')) {
      if (raw.trim() === '') continue;
      const dir = path.normalize(expandVariables(raw.trim().replace(/^"|"$/g, '')));
      const key = normal(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(dir);
    }
  return out;
}

function classify(dir: string, env: PathCopyEnv): CopyKind {
  const here = normal(dir);
  const managed = (base: string | null): string | null =>
    base ? normal(path.join(base, 'WindowsDevelopmentSandbox', 'bin')) : null;
  if (here === managed(env.programFiles)) return 'managed-machine';
  if (here === managed(env.localAppData)) return 'managed-user';
  for (const pkg of ['windows-development-sandbox', 'agent-sandbox'])
    if (env.exists(path.join(dir, 'node_modules', pkg, 'package.json'))) return 'npm';
  if (/[\\/]scripts[\\/]agent-sandbox([\\/]bin)?$/i.test(here)) return 'old-scripts';
  return 'other';
}

/** The folders that hold at least one of the commands, in search order. */
export function findCommandCopies(env: PathCopyEnv): CommandCopy[] {
  const exts = env.pathext
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith('.'));
  const copies: CommandCopy[] = [];
  for (const dir of pathFolders(env.machinePath, env.userPath)) {
    const files: string[] = [];
    for (const name of COMMAND_NAMES) {
      const hit = exts.map((ext) => name + ext).find((file) => env.exists(path.join(dir, file)));
      if (hit) files.push(hit);
    }
    if (files.length) copies.push({ dir, files, kind: classify(dir, env), order: copies.length });
  }
  return copies;
}

/** The folder a program runs from as a bin folder: the managed bin, or the npm global folder holding the package. */
export function ownBinDir(packageRoot: string, managedBin: string | null): string | null {
  if (managedBin) return managedBin;
  const resolved = path.resolve(packageRoot);
  const nodeModules = path.dirname(resolved);
  return path.basename(nodeModules).toLowerCase() === 'node_modules' ? path.dirname(nodeModules) : null;
}

export const sameFolder = (a: string, b: string): boolean => normal(a) === normal(b);

/** PATHEXT from the process, or the Windows default. */
export function currentPathext(): string {
  return process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';
}

export const fileOnDisk = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
