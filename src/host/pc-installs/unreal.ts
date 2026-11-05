// Unreal Engine versions of this PC (pcInstalls.unrealEngines): the launcher's LauncherInstalled.dat (engines it
// installed, with its own ids) and folders named UE_x.y in the launcher's default places on every drive
// (<drive>\Program Files\Epic Games, <drive>\Epic Games) and next to what it lists (an install whose entry is gone).
// Each must hold Engine\Build\Build.version; it is mapped read-only at
// C:\PcInstalls\unreal\UE_5.4. Source builds (HKCU\Software\Epic Games\Unreal Engine\Builds) are NOT mapped by
// themselves, as UBT writes inside an engine. pcInstalls.unrealEngineFolders: folders you registered, mapped writable
// (dir-<name>; a source build of this PC keeps its build id). Every file is read bounded.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile } from '../../shared/io/index.js';
import type { PcInstall } from '../../shared/paths/index.js';
import { SYSTEM } from '../../shared/system.js';
import {
  BUILDS_KEY,
  itemInstallLocation,
  ITEM_NAME,
  launcherInstallations,
  launcherInstalledFile,
  launcherManifestsDir,
  MAX_LAUNCHER_FILE_BYTES,
  parseBuildVersion,
  versionText,
  type BuildVersion,
} from '../../shared/unreal/index.js';
import type { PcEnv } from '../accounts/index.js';
import type { PcInstallSource } from './source.js';

const win = path.win32;
/** At most this many engines of this PC are mapped. */
export const MAX_PC_ENGINES = 8;
const APP_NAME = /^UE_(\d{1,2}\.\d{1,2})$/;

/** What discovery reads on this PC (the self-test passes fixtures). */
export interface UnrealPcFiles {
  /** LauncherInstalled.dat's text, or null. */
  readonly launcherInstalled: string | null;
  /** `reg query HKCU\Software\Epic Games\Unreal Engine\Builds` output ('' when the key is missing). */
  readonly builds: string;
  /** The launcher's default engines folder (<Program Files>\Epic Games). */
  readonly defaultRoot: string;
  /** More folders that may hold UE_x.y folders: the same places on every drive (D:\Program Files\Epic Games ...). */
  readonly otherRoots?: readonly string[];
  /** The launcher's Data\Manifests folder (its .item files), or none. */
  readonly manifests?: string;
  readonly list: (dir: string) => string[];
  readonly read: (file: string, max: number) => Buffer | null;
}

/** The values of `reg query <key>` output: the name and string of each REG_SZ / REG_EXPAND_SZ line. */
export function regValues(text: string): { name: string; value: string }[] {
  return text
    .split(/\r?\n/)
    .slice(0, 500)
    .flatMap((line) => {
      const m = /^\s{2,}(\S(?:.{0,200}?\S)?)\s{2,}REG_(?:EXPAND_)?SZ\s{2,}(.{1,1000})$/.exec(line);
      return m ? [{ name: m[1], value: m[2].trim() }] : [];
    });
}

const versionOf = (dir: string, files: Pick<UnrealPcFiles, 'read'>): BuildVersion | null => {
  const bytes = files.read(win.join(dir, 'Engine', 'Build', 'Build.version'), 64 * 1024);
  return bytes ? parseBuildVersion(bytes.toString('utf8')) : null;
};

/** At most this much of a manifest goes into session.json (an engine's is a few KB). */
const MAX_ITEM_BYTES = 64 * 1024;

/** The launcher's manifest of the app in `dir` (with this PC's paths), or nothing. */
function launcherItemOf(
  dir: string,
  files: Pick<UnrealPcFiles, 'manifests' | 'list' | 'read'>,
): { launcherItem?: PcInstall['launcherItem'] } {
  if (!files.manifests) return {};
  const want = win.resolve(dir).toLowerCase();
  for (const name of files.list(files.manifests).filter((n) => ITEM_NAME.test(n))) {
    const bytes = files.read(win.join(files.manifests, name), MAX_ITEM_BYTES);
    const at = bytes ? itemInstallLocation(bytes.toString('utf8')) : null;
    if (bytes && at && win.resolve(at).toLowerCase() === want)
      return { launcherItem: { name, text: bytes.toString('utf8') } };
  }
  return {};
}

/** The launcher's ids for the app in `dir` (from LauncherInstalled.dat), or nothing. */
function launcherIdsOf(
  dir: string,
  files: Pick<UnrealPcFiles, 'launcherInstalled'>,
): { launcher?: PcInstall['launcher'] } {
  const want = win.resolve(dir).toLowerCase();
  const entry = (files.launcherInstalled ? launcherInstallations(files.launcherInstalled) : []).find(
    (i) => APP_NAME.test(i.appName) && i.ids && win.resolve(i.installLocation).toLowerCase() === want,
  );
  return entry?.ids ? { launcher: entry.ids } : {};
}

const isWanted = (wanted: true | readonly (string | number)[], v: BuildVersion): boolean =>
  wanted === true || wanted.map((w) => String(w).replace(/^UE_/i, '')).includes(v.major + '.' + v.minor);

/** The engines of this PC that `wanted` maps, each folder once, at most MAX_PC_ENGINES. */
export function findUnrealInstalls(files: UnrealPcFiles, wanted: true | readonly (string | number)[]): PcInstall[] {
  const found: PcInstall[] = [];
  const add = (install: PcInstall): void => {
    const key = win.resolve(install.host).toLowerCase();
    if (found.length >= MAX_PC_ENGINES) return;
    if (found.some((f) => f.id === install.id || win.resolve(f.host).toLowerCase() === key)) return;
    found.push(install);
  };
  const installed = (dir: string, ids?: PcInstall['launcher']): void => {
    const v = versionOf(dir, files);
    if (!v || !isWanted(wanted, v)) return;
    add({
      kind: 'unreal',
      id: 'UE_' + v.major + '.' + v.minor,
      name: 'Unreal Engine ' + versionText(v),
      version: versionText(v),
      host: win.normalize(dir),
      guest: '',
      ...(ids ? { launcher: ids } : {}),
      ...launcherItemOf(dir, files),
    });
  };
  const listed = files.launcherInstalled ? launcherInstallations(files.launcherInstalled) : [];
  for (const i of listed) if (APP_NAME.test(i.appName)) installed(i.installLocation, i.ids ?? undefined);
  // Folders named like an engine: the default places, and the folders that hold what the launcher installed (an
  // engine whose entry is gone often sits next to one that is listed, or next to a game).
  const roots = [files.defaultRoot, ...(files.otherRoots ?? []), ...listed.map((i) => win.dirname(i.installLocation))];
  const seen = new Set<string>();
  for (const root of roots) {
    const key = win.resolve(root).toLowerCase();
    if (seen.has(key) || seen.size >= 32) continue;
    seen.add(key);
    for (const name of files
      .list(root)
      .filter((n) => APP_NAME.test(n))
      .sort())
      installed(win.join(root, name));
  }
  return found;
}

/** A source build of this PC's Builds key. */
export interface PcSourceBuild {
  readonly buildId: string;
  readonly version: string;
  readonly host: string;
}

/** Source builds this PC registered (the Builds key). They are not mapped by themselves: UBT writes inside them. */
export function pcSourceBuilds(files: Pick<UnrealPcFiles, 'read' | 'builds'>): PcSourceBuild[] {
  const found: PcSourceBuild[] = [];
  for (const { name, value } of regValues(files.builds)) {
    const dir = value.replace(/\//g, '\\');
    if (!win.isAbsolute(dir) || found.length >= MAX_PC_ENGINES) continue;
    const v = versionOf(dir, files);
    if (v) found.push({ buildId: name.slice(0, 64), version: versionText(v), host: win.normalize(dir) });
  }
  return found;
}

/** The engine folders you registered (pcInstalls.unrealEngineFolders), mapped writable. A folder that is a source
 * build of this PC keeps the PC's build id. */
export function findEngineFolders(
  files: Pick<UnrealPcFiles, 'read' | 'builds'> &
    Partial<Pick<UnrealPcFiles, 'launcherInstalled' | 'manifests' | 'list'>>,
  folders: readonly (string | number)[],
): PcInstall[] {
  const found: PcInstall[] = [];
  const sources = pcSourceBuilds(files);
  for (const raw of folders.map(String)) {
    const dir = win.normalize(raw);
    if (!win.isAbsolute(dir) || found.some((f) => f.host.toLowerCase() === dir.toLowerCase())) continue;
    const v = versionOf(dir, files);
    if (!v) continue;
    const base =
      win
        .basename(dir)
        .replace(/[^A-Za-z0-9._-]/g, '')
        .replace(/^\.+/, '')
        .slice(0, 40) || 'engine';
    const id = 'dir-' + base;
    const source = sources.find((b) => b.host.toLowerCase() === dir.toLowerCase());
    found.push({
      kind: 'unreal',
      id: found.some((f) => f.id === id) ? id + '-' + (found.length + 1) : id,
      name: 'Unreal Engine ' + versionText(v) + ' (' + win.basename(dir).slice(0, 60) + ')',
      version: versionText(v),
      host: dir,
      guest: '',
      writable: true,
      ...(source ? { buildId: source.buildId } : {}),
      // An engine the launcher installed keeps its ids and manifest, so the sandbox's launcher lists it too.
      ...launcherIdsOf(dir, { launcherInstalled: files.launcherInstalled ?? null }),
      ...(files.list ? launcherItemOf(dir, { manifests: files.manifests, list: files.list, read: files.read }) : {}),
    });
  }
  return found;
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).slice(0, 500);
  } catch {
    return []; // Not there: nothing in it.
  }
}

/** This PC's files (reg.exe through system32, bounded reads). */
export function unrealPcFiles(pc: PcEnv): UnrealPcFiles {
  const query = spawnSync(SYSTEM.reg(), ['query', 'HKCU\\' + BUILDS_KEY], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
  const dat = readBoundedFile(launcherInstalledFile(pc.programData), MAX_LAUNCHER_FILE_BYTES);
  return {
    launcherInstalled: dat ? dat.toString('utf8') : null,
    builds: query.status === 0 ? String(query.stdout ?? '') : '',
    defaultRoot: win.join(pc.programFiles ?? 'C:\\Program Files', 'Epic Games'),
    otherRoots: (pc.drives?.() ?? []).flatMap((d) => [
      win.join(d, 'Program Files', 'Epic Games'),
      win.join(d, 'Epic Games'),
    ]),
    manifests: launcherManifestsDir(pc.programData),
    list: listDir,
    read: readBoundedFile,
  };
}

export const unrealInstalls: PcInstallSource = {
  kind: 'unreal',
  setting: 'unrealEngines',
  find(wanted: true | readonly (string | number)[], pc: PcEnv): PcInstall[] {
    return findUnrealInstalls(unrealPcFiles(pc), wanted);
  },
};

export const unrealFolders: PcInstallSource = {
  kind: 'unreal',
  setting: 'unrealEngineFolders',
  find(wanted: true | readonly (string | number)[], pc: PcEnv): PcInstall[] {
    return wanted === true ? [] : findEngineFolders(unrealPcFiles(pc), wanted);
  },
};
