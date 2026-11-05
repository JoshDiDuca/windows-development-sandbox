// Unity editors of this PC (pcInstalls.unityEditors): Unity Hub's default folder (<Program Files>\Unity\Hub\Editor),
// the folder named by %APPDATA%\UnityHub\secondaryInstallPath.json and the editors in editors-v2.json. An editor counts
// only with Editor\Unity.exe; its folder is mapped read-only at C:\PcInstalls\unity\<version>. Every file is read
// bounded and every name is checked: what Hub wrote is data, never trusted.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readBoundedFile } from '../../shared/io/index.js';
import type { PcInstall } from '../../shared/paths/index.js';
import { assetStoreDir, pcAssetCacheDirs, UNITY_VERSION } from '../../shared/unity/index.js';
import type { PcEnv } from '../accounts/index.js';
import type { PcInstallSource } from './source.js';

const win = path.win32;
/** At most this many editors of this PC are mapped. */
export const MAX_PC_EDITORS = 12;
const MAX_SECONDARY_BYTES = 4 * 1024;
const MAX_EDITORS_FILE_BYTES = 1024 * 1024;
const MAX_EDITOR_ENTRIES = 200;
const MAX_LISTED = 500;

/** The files and folders of this PC the search reads (the self-test passes its own). */
export interface UnityPcFiles {
  read(file: string, max: number): Buffer | null;
  isDir(dir: string): boolean;
  list(dir: string): string[];
  readonly appData: string;
  readonly programFiles: string;
}

const EditorsFileSchema = z.union([
  z.array(z.unknown()).max(MAX_EDITOR_ENTRIES),
  z.object({ data: z.array(z.unknown()).max(MAX_EDITOR_ENTRIES) }).passthrough(),
]);
const EditorEntrySchema = z
  .object({
    version: z.string().max(40),
    location: z.union([z.string().max(1000), z.array(z.string().max(1000)).max(8)]),
  })
  .passthrough();

function jsonOf(files: UnityPcFiles, file: string, max: number): unknown {
  const bytes = files.read(file, max);
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null; // Not JSON: Hub's file is ignored.
  }
}

/** The folder in secondaryInstallPath.json (a JSON string, absolute only), or null. */
function secondaryRoot(files: UnityPcFiles): string | null {
  const json = jsonOf(files, win.join(files.appData, 'UnityHub', 'secondaryInstallPath.json'), MAX_SECONDARY_BYTES);
  return typeof json === 'string' && json.length < 1000 && win.isAbsolute(json) ? win.normalize(json) : null;
}

interface Candidate {
  readonly version: string;
  readonly root: string;
}

const hasEditorExe = (root: string, files: UnityPcFiles): boolean =>
  files.list(win.join(root, 'Editor')).some((n) => n.toLowerCase() === 'unity.exe');

/** The editors editors-v2.json lists: only `...\Editor\Unity.exe`, the root two levels up. */
function listedEditors(files: UnityPcFiles): Candidate[] {
  const parsed = EditorsFileSchema.safeParse(
    jsonOf(files, win.join(files.appData, 'UnityHub', 'editors-v2.json'), MAX_EDITORS_FILE_BYTES),
  );
  if (!parsed.success) return [];
  const entries = Array.isArray(parsed.data) ? parsed.data : parsed.data.data;
  const out: Candidate[] = [];
  for (const raw of entries) {
    const e = EditorEntrySchema.safeParse(raw);
    if (!e.success) continue;
    for (const location of [e.data.location].flat()) {
      const exe = win.normalize(location);
      if (!win.isAbsolute(exe) || win.basename(exe).toLowerCase() !== 'unity.exe') continue;
      const editorDir = win.dirname(exe);
      if (win.basename(editorDir).toLowerCase() !== 'editor') continue;
      out.push({ version: e.data.version, root: win.dirname(editorDir) });
    }
  }
  return out;
}

/** The editors of this PC: all of them (true) or the listed versions. Each version once, each folder once. */
export function findUnityEditorsOnPc(files: UnityPcFiles, wanted: true | readonly string[]): PcInstall[] {
  const candidates: Candidate[] = [];
  const hubFolders = [win.join(files.programFiles, 'Unity', 'Hub', 'Editor'), secondaryRoot(files)].filter(
    (d): d is string => d !== null,
  );
  for (const folder of hubFolders)
    for (const name of files.list(folder).slice(0, MAX_LISTED).sort())
      if (UNITY_VERSION.test(name)) candidates.push({ version: name, root: win.join(folder, name) });
  candidates.push(...listedEditors(files));
  const found: PcInstall[] = [];
  for (const c of candidates) {
    if (found.length >= MAX_PC_EDITORS) break;
    if (!UNITY_VERSION.test(c.version)) continue;
    if (wanted !== true && !wanted.includes(c.version)) continue;
    const key = c.root.toLowerCase();
    if (found.some((f) => f.id === c.version || f.host.toLowerCase() === key)) continue;
    if (!files.isDir(c.root) || !hasEditorExe(c.root, files)) continue;
    found.push({
      kind: 'unity',
      id: c.version,
      name: 'Unity ' + c.version,
      version: c.version,
      host: c.root,
      guest: '',
    });
  }
  return found;
}

/** The Asset Store-5.x folders of this PC (the environment's cache root first, then %APPDATA%\Unity), to map. */
export function unityAssetCacheDirs(files: UnityPcFiles, envValue: string | undefined): string[] {
  return pcAssetCacheDirs({ appData: files.appData, envValue }, files.isDir).map(assetStoreDir);
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).slice(0, MAX_LISTED);
  } catch {
    return []; // Not a folder: nothing in it.
  }
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** This PC's disk for the search. */
export function unityPcFiles(pc: PcEnv): UnityPcFiles {
  return {
    read: readBoundedFile,
    isDir,
    list: listDir,
    appData: pc.appData,
    programFiles: pc.programFiles ?? 'C:\\Program Files',
  };
}

/** The cache root the environment names: this terminal's variable, else the saved user one. */
export function assetCacheEnv(pc: PcEnv): string | undefined {
  return pc.env?.ASSETSTORE_CACHE_PATH ?? pc.userVariable?.('ASSETSTORE_CACHE_PATH') ?? undefined;
}

export const unityInstalls: PcInstallSource = {
  kind: 'unity',
  setting: 'unityEditors',
  find(wanted: true | readonly (string | number)[], pc: PcEnv): PcInstall[] {
    return findUnityEditorsOnPc(unityPcFiles(pc), wanted === true ? true : wanted.map(String));
  },
};
