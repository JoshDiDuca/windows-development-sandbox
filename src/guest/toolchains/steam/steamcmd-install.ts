// Getting SteamCMD ready, with every outside effect passed in (the self-test runs it with its own folders, download,
// signer check and runner): steamcmd.zip once into tools\steamcmd (Valve publishes no checksum, so steamcmd.exe in it
// must be Valve-signed before the zip is kept), a working copy in C:\SteamCMD every boot (config\ and the sentry
// files never leave the sandbox's own disk), its first-run self-update with a time limit, and the updated binaries
// kept for the next boot. No runtime imports.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { extractArchive, moveIntoPlace, stagingFolder } from '../../../shared/download/archive.js';
import { downloader } from '../../../shared/download/downloader.js';
import { safeRemove } from '../../../shared/io/safe-remove.js';
import { assertRoom, type PersistedDeps } from '../persisted.js';
import { STEAMCMD_DIR, STEAMCMD_URL, steamCmdStore } from './commands.js';

const MB = 1024 ** 2;
/** Room SteamCMD needs: the zip is small, its first run fetches ~300 MB. */
export const STEAMCMD_NEED_BYTES = 600 * MB;
export const STEAMCMD_UPDATE_TIMEOUT_MS = 15 * 60 * 1000;

/** What a SteamCMD folder keeps that is the sign-in or this sandbox's own: never copied to the data disk. */
const PRIVATE_DIRS = new Set(['config', 'logs', 'dumps', 'userdata', 'steamapps', 'appcache', 'depotcache']);
const isPrivate = (name: string): boolean => PRIVATE_DIRS.has(name.toLowerCase()) || /^ssfn/i.test(name);
/** Files that show SteamCMD has finished its first run (it fetches these itself). */
const BOOTSTRAPPED = ['steamclient.dll', 'steamclient64.dll'];

export interface RunResult {
  readonly code: number;
  readonly timedOut: boolean;
}

export interface SteamCmdDeps extends PersistedDeps {
  /** Whether a file is Valve-signed (required: the default needs the guest runtime). */
  readonly signed: (file: string) => boolean;
  /** tools\steamcmd. */
  readonly storeDir?: string;
  /** C:\SteamCMD. */
  readonly workDir?: string;
  readonly download?: (url: string, file: string, verify: (part: string) => Promise<void>) => Promise<void>;
  readonly extract?: (archive: string, destination: string) => Promise<void>;
  readonly run?: (exe: string, args: string[], cwd: string, timeoutMs: number) => Promise<RunResult>;
  readonly updateTimeoutMs?: number;
}

/** Runs a program with its output hidden; it is stopped after `timeoutMs`. */
export function runWithTimeout(exe: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, stdio: 'ignore', windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, timedOut });
    });
  });
}

const notSigned = (file: string): Error =>
  new Error(path.basename(file) + ' is not signed by Valve: not running it (it is downloaded again next boot)');

/** steamcmd.zip into `store`: kept only when steamcmd.exe in it is Valve-signed. */
export async function fetchSteamCmd(store: string, deps: SteamCmdDeps): Promise<void> {
  fs.mkdirSync(path.dirname(store), { recursive: true });
  assertRoom(path.dirname(store), STEAMCMD_NEED_BYTES, 'SteamCMD', 'Free room on the data disk.', deps);
  const work = stagingFolder(store);
  const unpacked = path.join(work, 'x');
  const extract = deps.extract ?? extractArchive;
  try {
    fs.mkdirSync(work, { recursive: true });
    const verify = async (part: string): Promise<void> => {
      await extract(part, unpacked);
      const exe = path.join(unpacked, 'steamcmd.exe');
      if (!fs.existsSync(exe)) throw new Error('steamcmd.zip has no steamcmd.exe');
      if (!deps.signed(exe)) throw notSigned(exe);
    };
    const zip = path.join(work, 'steamcmd.zip');
    if (deps.download) await deps.download(STEAMCMD_URL, zip, verify);
    else await downloader.file(STEAMCMD_URL, zip, { verify });
    moveIntoPlace(unpacked, store);
  } finally {
    if (fs.existsSync(work)) safeRemove(work, path.dirname(work));
  }
}

/** Copies a SteamCMD folder, leaving out the sign-in and this sandbox's own files at its top. */
async function copyBinaries(from: string, to: string): Promise<void> {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (isPrivate(entry.name) || entry.isSymbolicLink()) continue;
    if (!entry.isFile() && !entry.isDirectory()) continue;
    await fs.promises.cp(path.join(from, entry.name), path.join(to, entry.name), {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
      filter: (source) => {
        try {
          return !fs.lstatSync(source).isSymbolicLink();
        } catch {
          return false;
        }
      },
    });
  }
}

/** Size and time of SteamCMD's own top-level files: what changes when it updates itself. */
function snapshot(dir: string): string {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !isPrivate(e.name) && /\.(exe|dll)$/i.test(e.name))
      .map((e) => {
        const s = fs.statSync(path.join(dir, e.name));
        return e.name.toLowerCase() + ':' + s.size + ':' + Math.floor(s.mtimeMs / 1000);
      })
      .sort()
      .join('|');
  } catch {
    return '';
  }
}

const bootstrapped = (dir: string): boolean => BOOTSTRAPPED.some((f) => fs.existsSync(path.join(dir, f)));

/** Removes anything private that ended up in the kept copy (it must hold only binaries). */
function scrubStore(store: string): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(store);
  } catch {
    return;
  }
  for (const name of names.filter(isPrivate)) safeRemove(path.join(store, name), store);
}

/**
 * steamcmd.exe in the working folder, ready to run: downloaded once, copied in, updated by its own first run (with a
 * time limit), and its updated binaries kept for the next boot.
 */
export async function prepareSteamCmd(deps: SteamCmdDeps): Promise<string> {
  const store = deps.storeDir ?? steamCmdStore(deps.toolsDir);
  const work = deps.workDir ?? STEAMCMD_DIR;
  const log = deps.log ?? ((): void => undefined);
  const exe = path.join(work, 'steamcmd.exe');
  // Set up already in this sandbox (a project that joins later): its files may be in use, so they are left alone.
  if (fs.existsSync(exe) && bootstrapped(work)) {
    if (!deps.signed(exe)) throw notSigned(exe);
    return exe;
  }
  if (!fs.existsSync(path.join(store, 'steamcmd.exe'))) {
    log('Downloading SteamCMD (~3 MB once; it fetches ~300 MB on its first run) ...');
    await fetchSteamCmd(store, deps);
  }
  scrubStore(store);
  await copyBinaries(store, work);
  if (!deps.signed(exe)) {
    safeRemove(store, path.dirname(store));
    throw notSigned(exe);
  }
  const before = snapshot(work);
  const run = deps.run ?? runWithTimeout;
  const limit = deps.updateTimeoutMs ?? STEAMCMD_UPDATE_TIMEOUT_MS;
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(attempt === 1 ? 'SteamCMD: checking for updates ...' : 'SteamCMD: trying its update once more ...');
    const result = await run(exe, ['+quit'], work, limit);
    if (result.timedOut)
      throw new Error('SteamCMD did not finish updating itself in ' + Math.round(limit / 60000) + ' minutes');
    if (bootstrapped(work)) break;
    if (attempt === 2) throw new Error('SteamCMD did not finish its first run (exit code ' + result.code + ')');
  }
  if (!deps.signed(exe)) throw notSigned(exe);
  if (snapshot(work) !== before || !bootstrapped(store)) {
    const staging = stagingFolder(store);
    try {
      await copyBinaries(work, staging);
      moveIntoPlace(staging, store);
    } finally {
      if (fs.existsSync(staging)) safeRemove(staging, path.dirname(staging));
    }
  }
  return exe;
}
