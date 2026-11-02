// Games and dedicated servers that sbx-steam app downloads into tools\steam-apps\<appid> (kept between sandboxes):
// the room check before, the size afterwards in tools\installs.json (so `sandbox data` shows it without walking the
// folder), and what is there. No runtime imports: the self-test loads this file with its own folders.
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_RECORDS_FILE } from '../../../shared/installs.js';
import { readBoundedFile } from '../../../shared/io/bounded.js';
import { writeJsonAtomic } from '../../../shared/io/json.js';
import { parseVdf, vdfText } from '../../../shared/vdf.js';
import { toolsDir } from '../../runtime/paths.js';
import { assertRoom, installRecords, type PersistedDeps } from '../persisted.js';
import { checkAppId, steamAppsRoot } from './commands.js';

const GB = 1024 ** 3;
/** The room sbx-steam app wants free when you do not say (--need-gb). */
export const DEFAULT_APP_NEED_BYTES = 5 * GB;
/** The name apps are recorded under in tools\installs.json (the version is the app ID). */
export const STEAM_APPS_RECORD = 'steam-apps';
const MAX_WALK = 2_000_000;
const MAX_MANIFEST_BYTES = 256 * 1024;

const toolsOf = (deps: PersistedDeps): string => deps.toolsDir ?? toolsDir;

/** Throws (with the fix) when the disk that gets the app has less than `needBytes` free. */
export function assertAppRoom(dir: string, needBytes: number, what: string, deps: PersistedDeps = {}): void {
  let probe = dir;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  assertRoom(
    probe,
    needBytes,
    what,
    'Free room on that disk (with contained storage: raise storage.containedMaxGb), or ask for less with --need-gb.',
    deps,
  );
}

/** The bytes under a folder (links not followed), or null when there are too many files to count. */
export function folderSize(dir: string): number | null {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > MAX_WALK) return null;
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile())
        try {
          total += fs.lstatSync(full).size;
        } catch {
          // Gone while counting: not counted.
        }
    }
  }
  return total;
}

/** Records an app's size (and that it was used now) in tools\installs.json. */
export function recordApp(appId: string, sizeBytes: number | null, deps: PersistedDeps = {}): void {
  checkAppId(appId);
  const now = new Date().toISOString();
  const all = installRecords(deps);
  const known = all.find((r) => r.name === STEAM_APPS_RECORD && r.version === appId);
  const record = {
    name: STEAM_APPS_RECORD,
    version: appId,
    sizeBytes,
    installedAt: known?.installedAt ?? now,
    usedAt: now,
  };
  const installs = [...all.filter((r) => r !== known), record];
  fs.mkdirSync(toolsOf(deps), { recursive: true });
  writeJsonAtomic(path.join(toolsOf(deps), INSTALL_RECORDS_FILE), { installs });
}

export interface AppManifest {
  readonly appId: string;
  readonly name: string;
  readonly installDir: string;
  readonly buildId?: string;
}

/** An appmanifest_<id>.acf (bounded), or null. */
export function readAppManifest(file: string): AppManifest | null {
  const bytes = readBoundedFile(file, MAX_MANIFEST_BYTES);
  const root = bytes ? parseVdf(bytes.toString('utf8'), { maxBytes: MAX_MANIFEST_BYTES }) : null;
  const appId = vdfText(root, 'AppState', 'appid');
  const installDir = vdfText(root, 'AppState', 'installdir');
  if (!appId || !/^\d{1,10}$/.test(appId) || !installDir) return null;
  const buildId = vdfText(root, 'AppState', 'buildid');
  return {
    appId,
    name: (vdfText(root, 'AppState', 'name') ?? appId).slice(0, 200),
    installDir,
    ...(buildId && /^\d{1,20}$/.test(buildId) ? { buildId } : {}),
  };
}

export interface InstalledApp {
  readonly appId: string;
  readonly name: string;
  readonly dir: string;
  readonly sizeBytes: number | null;
}

/** The apps in tools\steam-apps, with their names (from SteamCMD's manifest) and recorded sizes. */
export function installedApps(deps: PersistedDeps = {}): InstalledApp[] {
  const root = steamAppsRoot(toolsOf(deps));
  let ids: string[];
  try {
    ids = fs
      .readdirSync(root)
      .filter((n) => /^[1-9]\d{0,9}$/.test(n))
      .slice(0, 1000);
  } catch {
    return [];
  }
  const records = installRecords(deps);
  return ids.map((appId) => {
    const dir = path.join(root, appId);
    const manifest = readAppManifest(path.join(dir, 'steamapps', 'appmanifest_' + appId + '.acf'));
    const record = records.find((r) => r.name === STEAM_APPS_RECORD && r.version === appId);
    return { appId, name: manifest?.name ?? '(not downloaded yet)', dir, sizeBytes: record?.sizeBytes ?? null };
  });
}
