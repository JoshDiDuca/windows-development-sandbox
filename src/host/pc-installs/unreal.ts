// Unreal Engine versions of this PC (pcInstalls.unrealEngines): the launcher's LauncherInstalled.dat (engines it
// installed, with its own ids), HKCU\Software\Epic Games\Unreal Engine\Builds (source builds UnrealVersionSelector
// registered) and the launcher's default folders (<Program Files>\Epic Games\UE_*, for an install whose
// LauncherInstalled.dat is gone). Each must hold Engine\Build\Build.version; it is mapped read-only at
// C:\PcInstalls\unreal\UE_5.4 (src-<id> for a source build). pcInstalls.unrealEngineFolders: folders you registered,
// mapped writable (dir-<name>). Every file is read bounded.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile } from '../../shared/io/index.js';
import type { PcInstall } from '../../shared/paths/index.js';
import { SYSTEM } from '../../shared/system.js';
import {
  BUILDS_KEY,
  launcherInstallations,
  launcherInstalledFile,
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

const isWanted = (wanted: true | readonly (string | number)[], v: BuildVersion): boolean =>
  wanted === true || wanted.map((w) => String(w).replace(/^UE_/i, '')).includes(v.major + '.' + v.minor);

/** A source build's guest folder name: src-<its id, letters and digits only>. */
const sourceId = (buildId: string): string => 'src-' + (buildId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 60) || 'build');

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
    });
  };
  for (const i of files.launcherInstalled ? launcherInstallations(files.launcherInstalled) : [])
    if (APP_NAME.test(i.appName)) installed(i.installLocation, i.ids ?? undefined);
  for (const { name, value } of regValues(files.builds)) {
    const dir = value.replace(/\//g, '\\');
    if (!win.isAbsolute(dir)) continue;
    const v = versionOf(dir, files);
    if (!v || !isWanted(wanted, v)) continue;
    add({
      kind: 'unreal',
      id: sourceId(name),
      name: 'Unreal Engine ' + versionText(v) + ' (source build)',
      version: versionText(v),
      host: win.normalize(dir),
      guest: '',
      buildId: name.slice(0, 64),
    });
  }
  for (const name of files
    .list(files.defaultRoot)
    .filter((n) => APP_NAME.test(n))
    .sort())
    installed(win.join(files.defaultRoot, name));
  return found;
}

/** The engine folders you registered (pcInstalls.unrealEngineFolders), mapped writable. */
export function findEngineFolders(
  files: Pick<UnrealPcFiles, 'read'>,
  folders: readonly (string | number)[],
): PcInstall[] {
  const found: PcInstall[] = [];
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
    found.push({
      kind: 'unreal',
      id: found.some((f) => f.id === id) ? id + '-' + (found.length + 1) : id,
      name: 'Unreal Engine ' + versionText(v) + ' (' + win.basename(dir).slice(0, 60) + ')',
      version: versionText(v),
      host: dir,
      guest: '',
      writable: true,
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
  find(wanted: true | readonly (string | number)[], _pc: PcEnv): PcInstall[] {
    return wanted === true ? [] : findEngineFolders({ read: readBoundedFile }, wanted);
  },
};
