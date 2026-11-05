// tools\unity\status.json: what the sandbox found for Unity, for the guide and the Unity page on the PC. The boot's
// project step writes its editor choice, the licence step the licence, the daemon the editors; every write keeps what
// the other parts wrote.
import path from 'node:path';
import { readValid, writeJsonAtomic } from '../../../shared/io/json.js';
import { UNITY_STATUS_FILE, UnityStatusSchema, type UnityStatus } from '../../../shared/unity/index.js';
import { mkdirp } from '../../runtime/fs.js';
import { tool } from '../tool-env.js';

export const UNITY_DIR = tool('unity');
/** The Unity CLI, one folder per version (unity.exe). */
export const CLI_DIR = path.join(UNITY_DIR, 'cli');
/** The editors on the data disk: one folder per version (Editor\Unity.exe). */
export const EDITORS_DIR = path.join(UNITY_DIR, 'editors');
/** Asset Store downloads made in the sandbox (assetCache "persisted"). */
export const ASSET_DIR = path.join(UNITY_DIR, 'asset-store');
const FILE = path.join(UNITY_DIR, UNITY_STATUS_FILE);

const EMPTY: UnityStatus = {
  updatedAt: '',
  cli: null,
  editors: [],
  projects: [],
  licence: { state: 'unknown', kind: '', detail: 'not checked', user: null },
  assetCache: { mode: 'local', dir: null },
  pcAssets: [],
  hub: { installed: false, path: null },
  mcp: null,
  skills: false,
  problem: null,
};

export function readUnityStatus(): UnityStatus {
  return readValid(UnityStatusSchema, FILE) ?? EMPTY;
}

/** Changes the status with `change` and writes it (whole, atomically). */
export function updateUnityStatus(change: (s: UnityStatus) => UnityStatus): UnityStatus {
  const next = { ...change(readUnityStatus()), updatedAt: new Date().toISOString() };
  mkdirp(UNITY_DIR);
  writeJsonAtomic(FILE, next);
  return next;
}
