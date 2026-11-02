// Steam games of this PC: SteamPath from the registry (reg.exe through system32), libraryfolders.vdf and the app
// manifests. true maps each library's steamapps (C:\PcInstalls\steam\library<N>), a list of app IDs only those games
// (C:\PcInstalls\steam\<appid>). Every file is read bounded; names from them never carry a path of this PC.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile } from '../../shared/io/index.js';
import type { PcInstall } from '../../shared/paths/index.js';
import { SYSTEM } from '../../shared/system.js';
import { parseVdf, vdfObject, vdfText } from '../../shared/vdf.js';
import type { PcEnv } from '../accounts/index.js';
import type { PcInstallSource } from './source.js';

const MAX_LIBRARIES = 32;
const MAX_VDF_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const APP_ID = /^[1-9]\d{0,9}$/;

/** Where Steam is installed on this PC (HKCU SteamPath, else HKLM InstallPath), or null. */
export function steamRootFromRegistry(): string | null {
  const queries: readonly [string, string][] = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
  ];
  for (const [key, name] of queries) {
    const result = spawnSync(SYSTEM.reg(), ['query', key, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.status !== 0) continue;
    const line = String(result.stdout ?? '')
      .split(/\r?\n/)
      .slice(0, 50)
      .find((l) =>
        l
          .trim()
          .toLowerCase()
          .startsWith(name.toLowerCase() + ' '),
      );
    const value = line
      ?.trim()
      .split(/\s+REG_(?:EXPAND_)?SZ\s+/)[1]
      ?.trim();
    if (value && path.isAbsolute(value)) return path.normalize(value.replace(/\//g, '\\'));
  }
  return null;
}

export interface SteamLibrary {
  readonly path: string;
  /** The app IDs the library lists (empty in the old format: the manifests tell). */
  readonly apps: readonly string[];
}

/** The libraries a libraryfolders.vdf lists (both the current and the old format), in order. */
export function steamLibraries(text: string): SteamLibrary[] {
  const root = parseVdf(text, { maxBytes: MAX_VDF_BYTES });
  const folders = vdfObject(root, 'libraryfolders');
  if (!folders) return [];
  const found: SteamLibrary[] = [];
  for (const [key, value] of Object.entries(folders)) {
    if (!/^\d{1,3}$/.test(key)) continue;
    const at = typeof value === 'string' ? value : vdfText(value, 'path');
    if (!at || !path.win32.isAbsolute(at)) continue;
    const apps =
      typeof value === 'string' ? [] : Object.keys(vdfObject(value, 'apps') ?? {}).filter((a) => APP_ID.test(a));
    if (!found.some((l) => l.path.toLowerCase() === at.toLowerCase())) found.push({ path: at, apps });
    if (found.length >= MAX_LIBRARIES) break;
  }
  return found;
}

/** The libraries of a Steam install: its own folder first, then the ones libraryfolders.vdf lists. */
export function librariesOf(steamRoot: string): SteamLibrary[] {
  const bytes = readBoundedFile(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), MAX_VDF_BYTES);
  const listed = bytes ? steamLibraries(bytes.toString('utf8')) : [];
  const own = listed.find((l) => path.resolve(l.path).toLowerCase() === path.resolve(steamRoot).toLowerCase());
  return [own ?? { path: steamRoot, apps: [] }, ...listed.filter((l) => l !== own)];
}

interface Manifest {
  readonly appId: string;
  readonly name: string;
  readonly installDir: string;
  readonly buildId?: string;
}

function readManifest(file: string): Manifest | null {
  const bytes = readBoundedFile(file, MAX_MANIFEST_BYTES);
  const root = bytes ? parseVdf(bytes.toString('utf8'), { maxBytes: MAX_MANIFEST_BYTES }) : null;
  const appId = vdfText(root, 'AppState', 'appid');
  const installDir = vdfText(root, 'AppState', 'installdir');
  if (!appId || !APP_ID.test(appId) || !installDir) return null;
  // One folder name under steamapps\common: never a path that climbs out of it.
  if (/[\\/:]/.test(installDir) || /^\.+$/.test(installDir.trim())) return null;
  const buildId = vdfText(root, 'AppState', 'buildid');
  const name = (vdfText(root, 'AppState', 'name') ?? '').replace(/[^\x20-\x7e\u00a0-\uffff]/g, '').slice(0, 100);
  return {
    appId,
    name: name || 'Steam app ' + appId,
    installDir,
    ...(buildId && /^\d{1,20}$/.test(buildId) ? { buildId } : {}),
  };
}

/** What `wanted` maps from a Steam install: every library's steamapps (true), or the listed games. */
export function findSteamInstalls(steamRoot: string, wanted: true | readonly (string | number)[]): PcInstall[] {
  const libraries = librariesOf(steamRoot);
  if (wanted === true)
    return libraries.flatMap((lib, i) => {
      const steamapps = path.join(lib.path, 'steamapps');
      try {
        if (!fs.lstatSync(steamapps).isDirectory()) return [];
      } catch {
        return [];
      }
      return [
        {
          kind: 'steam-library',
          id: 'library' + (i + 1),
          name: 'Steam library ' + (i + 1),
          host: steamapps,
          guest: '',
        },
      ];
    });
  const found: PcInstall[] = [];
  for (const id of new Set(wanted.map(String).filter((w) => APP_ID.test(w)))) {
    for (const lib of libraries) {
      const manifest = readManifest(path.join(lib.path, 'steamapps', 'appmanifest_' + id + '.acf'));
      if (!manifest || manifest.appId !== id) continue;
      found.push({
        kind: 'steam-game',
        id,
        name: manifest.name,
        ...(manifest.buildId ? { version: manifest.buildId } : {}),
        host: path.join(lib.path, 'steamapps', 'common', manifest.installDir),
        guest: '',
      });
      break;
    }
  }
  return found;
}

export const steamInstalls: PcInstallSource = {
  kind: 'steam-game',
  setting: 'steamGames',
  find(wanted: true | readonly (string | number)[], _pc: PcEnv): PcInstall[] {
    const root = steamRootFromRegistry();
    if (!root) throw new Error('Steam is not installed (the registry has no SteamPath)');
    return findSteamInstalls(root, wanted);
  },
};
