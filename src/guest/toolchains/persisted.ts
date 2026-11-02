// Large installs kept between sandboxes in C:\AgentData\tools (engines, editors, SDKs: 1-60 GB each). One version is
// a folder tools\<name>\<version>; it counts as installed only with its .complete.json and its marker file. A new one
// is checked for room first, built in a staging folder next to it (with TEMP inside it: moving from the sandbox's own
// disk into a mapped folder fails silently) and moved into place when done. Every install's size and last use go in
// tools\installs.json, so `sandbox data` shows them without walking 60 GB, and versions beyond keepVersions go (the
// least recently used first). No runtime imports: the self-test loads this file with its own folders.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readValid, writeJsonAtomic } from '../../shared/io/json.js';
import { safeRemove } from '../../shared/io/safe-remove.js';
import { dataDir } from '../runtime/paths.js';
import { INSTALL_RECORDS_FILE, InstallRecordsSchema, type InstallRecord } from '../../shared/installs.js';

const GB = 1024 ** 3;
/** What stays free on the sandbox's own disk after a real installer: the paging file and every build need it. */
export const LOCAL_RESERVE_BYTES = 13 * GB;
const MARKER = '.complete.json';
const MAX_WALK = 2_000_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface InstallSpec {
  /** The tools\ folder of the tool: unity, godot, fivem\artifacts ... (letters, digits, . _ - and one /). */
  readonly name: string;
  readonly version: string;
  /** Room it needs while installing (download, unpacked copy). */
  readonly needBytes: number;
  /** A file (relative to the version folder) that only a finished install has: Editor\Unity.exe. */
  readonly marker: string;
  /** What it is, for messages: "Unity 6000.0.32f1". */
  readonly what: string;
  /** How many versions of this tool to keep (default: all). */
  readonly keepVersions?: number;
}

export interface Installed {
  readonly dir: string;
  /** Installed now (false: it was there). */
  readonly fresh: boolean;
  readonly sizeBytes: number | null;
}

export { InstallRecordsSchema, type InstallRecord } from '../../shared/installs.js';

export interface PersistedDeps {
  /** C:\AgentData\tools (the self-test passes its own folder). */
  readonly toolsDir?: string;
  /** The sandbox's own disk, for real installers. */
  readonly localDir?: string;
  readonly statfs?: (dir: string) => { bavail: number; bsize: number };
  readonly log?: (line: string) => void;
}

const toolsOf = (deps: PersistedDeps): string => deps.toolsDir ?? path.join(dataDir, 'tools');
const recordsFile = (deps: PersistedDeps): string => path.join(toolsOf(deps), INSTALL_RECORDS_FILE);

function checkSpec(spec: InstallSpec): void {
  const parts = spec.name.split('/');
  if (parts.length > 2 || !parts.every((p) => NAME.test(p)) || !NAME.test(spec.version))
    throw new Error('not a usable install name: ' + spec.name + ' ' + spec.version);
}

/** Free bytes for this user on the disk holding `dir` (0 when it cannot be told). */
export function freeBytes(dir: string, deps: PersistedDeps = {}): number {
  try {
    const s = (deps.statfs ?? fs.statfsSync)(dir);
    return s.bavail * s.bsize;
  } catch {
    return 0;
  }
}

const gb = (bytes: number): string => (bytes / GB).toFixed(1) + ' GB';

/** Throws (with the fix) when the disk holding `dir` has less than `needBytes` free. */
export function assertRoom(dir: string, needBytes: number, what: string, fix: string, deps: PersistedDeps = {}): void {
  const free = freeBytes(dir, deps);
  if (free < needBytes)
    throw new Error(
      'not installing ' + what + ': ' + gb(free) + ' free where it goes, it needs ' + gb(needBytes) + '. ' + fix,
    );
}

/** A real installer on the sandbox's own disk (C:): its size plus 13 GB must stay free (paging file, builds). */
export function assertLocalRoom(needBytes: number, what: string, deps: PersistedDeps = {}): void {
  const drive = deps.localDir ?? (process.env.SystemDrive ?? 'C:') + '\\';
  assertRoom(
    drive,
    needBytes + LOCAL_RESERVE_BYTES,
    what,
    "The sandbox's own disk also holds the paging file and every build: give the sandbox less to install, or a smaller sandbox.pageFileMb.",
    deps,
  );
}

export function installRecords(deps: PersistedDeps = {}): readonly InstallRecord[] {
  return readValid(InstallRecordsSchema, recordsFile(deps))?.installs ?? [];
}

function writeRecords(records: readonly InstallRecord[], deps: PersistedDeps): void {
  fs.mkdirSync(toolsOf(deps), { recursive: true });
  writeJsonAtomic(recordsFile(deps), { installs: [...records] });
}

/** Notes that a version was used now (it is kept over ones used longer ago). */
export function recordUse(name: string, version: string, deps: PersistedDeps = {}): void {
  const now = new Date().toISOString();
  const all = installRecords(deps);
  const known = all.find((r) => r.name === name && r.version === version);
  writeRecords(
    known
      ? all.map((r) => (r === known ? { ...r, usedAt: now } : r))
      : [...all, { name, version, sizeBytes: null, installedAt: now, usedAt: now }],
    deps,
  );
}

/** The bytes under a folder (links not followed), or null when there are too many files to count. */
function folderSize(dir: string): number | null {
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
          total += fs.statSync(full).size;
        } catch {
          // Gone while counting: not counted.
        }
    }
  }
  return total;
}

function complete(dir: string, marker: string): boolean {
  return fs.existsSync(path.join(dir, MARKER)) && fs.existsSync(path.join(dir, marker));
}

/** Removes versions of a tool beyond `keep` (the least recently used first), never `current`. */
function prune(spec: InstallSpec, deps: PersistedDeps): void {
  if (!spec.keepVersions) return;
  const root = path.join(toolsOf(deps), ...spec.name.split('/'));
  const mine = installRecords(deps)
    .filter((r) => r.name === spec.name && r.version !== spec.version)
    .sort((a, b) => b.usedAt.localeCompare(a.usedAt));
  const gone = mine.slice(Math.max(0, spec.keepVersions - 1));
  for (const r of gone) {
    if (!NAME.test(r.version)) continue;
    safeRemove(path.join(root, r.version), root);
    deps.log?.('Removed ' + spec.name + ' ' + r.version + ' (keepVersions ' + spec.keepVersions + ')');
  }
  const isGone = (r: InstallRecord): boolean => r.name === spec.name && gone.some((g) => g.version === r.version);
  if (gone.length)
    writeRecords(
      installRecords(deps).filter((r) => !isGone(r)),
      deps,
    );
}

/**
 * The version's folder, installed by `install(staging, temp)` when it is not there yet. The installer puts the
 * version's files in `staging` and its temporary files in `temp` (inside staging); a failed install leaves nothing.
 */
export async function ensurePersisted(
  spec: InstallSpec,
  install: (staging: string, temp: string) => Promise<void>,
  deps: PersistedDeps = {},
): Promise<Installed> {
  checkSpec(spec);
  const root = path.join(toolsOf(deps), ...spec.name.split('/'));
  const dir = path.join(root, spec.version);
  if (complete(dir, spec.marker)) {
    recordUse(spec.name, spec.version, deps);
    const known = installRecords(deps).find((r) => r.name === spec.name && r.version === spec.version);
    return { dir, fresh: false, sizeBytes: known?.sizeBytes ?? null };
  }
  fs.mkdirSync(root, { recursive: true });
  assertRoom(
    root,
    spec.needBytes,
    spec.what,
    'Free room on that disk (with contained storage: raise storage.containedMaxGb), or keep fewer versions.',
    deps,
  );
  const staging = path.join(root, '.staging-' + spec.version + '-' + crypto.randomBytes(3).toString('hex'));
  const temp = path.join(staging, '.temp');
  fs.mkdirSync(temp, { recursive: true });
  try {
    await install(staging, temp);
    if (!fs.existsSync(path.join(staging, spec.marker)))
      throw new Error(spec.what + ': the install finished without ' + spec.marker);
    safeRemove(temp, staging);
    const sizeBytes = folderSize(staging);
    writeJsonAtomic(path.join(staging, MARKER), { name: spec.name, version: spec.version, sizeBytes });
    if (fs.existsSync(dir)) safeRemove(dir, root);
    fs.renameSync(staging, dir);
    const now = new Date().toISOString();
    writeRecords(
      [
        ...installRecords(deps).filter((r) => !(r.name === spec.name && r.version === spec.version)),
        { name: spec.name, version: spec.version, sizeBytes, installedAt: now, usedAt: now },
      ],
      deps,
    );
    prune(spec, deps);
    return { dir, fresh: true, sizeBytes };
  } finally {
    if (fs.existsSync(staging)) safeRemove(staging, root);
  }
}
