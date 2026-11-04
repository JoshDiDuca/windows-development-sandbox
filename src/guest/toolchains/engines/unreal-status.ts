// tools\unreal\status.json: what the sandbox found for Unreal, for the guide and the Unreal page on the PC. The boot's
// machine-wide step writes the launcher, Visual Studio and debugger parts, each project's step its engine; every write
// keeps what the other parts wrote.
import path from 'node:path';
import { readValid, writeJsonAtomic } from '../../../shared/io/json.js';
import { UNREAL_STATUS_FILE, UnrealStatusSchema, type UnrealStatus } from '../../../shared/unreal/index.js';
import { mkdirp } from '../../runtime/fs.js';
import { tool } from '../tool-env.js';

export const UNREAL_DIR = tool('unreal');
/** Where the Epic Games Launcher installs engines (persistEngines). */
export const ENGINES_DIR = path.join(UNREAL_DIR, 'engines');
/** The engines' local derived data cache (derivedDataCache "persisted"). */
export const DDC_DIR = path.join(UNREAL_DIR, 'ddc');
/** The launcher's manifests and entries of the engines in ENGINES_DIR, kept for later boots. */
export const SAVED_DIR = path.join(UNREAL_DIR, 'launcher');
const FILE = path.join(UNREAL_DIR, UNREAL_STATUS_FILE);

const EMPTY: UnrealStatus = {
  updatedAt: '',
  engines: [],
  projects: [],
  launcher: { installed: false, installLocation: null, problem: null, freeBytes: null, needBytes: 0 },
  visualStudio: { version: '', path: '', how: '', check: '', ok: false },
  debugger: null,
  ddc: { mode: 'local', dir: null },
  mcpUrl: null,
};

export function readUnrealStatus(): UnrealStatus {
  return readValid(UnrealStatusSchema, FILE) ?? EMPTY;
}

/** Changes the status with `change` and writes it (whole, atomically). */
export function updateUnrealStatus(change: (s: UnrealStatus) => UnrealStatus): UnrealStatus {
  const next = { ...change(readUnrealStatus()), updatedAt: new Date().toISOString() };
  mkdirp(UNREAL_DIR);
  writeJsonAtomic(FILE, next);
  return next;
}

/** A fresh status at boot: the machine parts start over, the engines and projects are found again. */
export function resetUnrealStatus(): void {
  updateUnrealStatus(() => EMPTY);
}
