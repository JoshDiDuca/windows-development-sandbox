// The Epic Games Launcher in the sandbox: installed every boot from its MSI (downloaded once into tools\unreal, run
// only when Epic's signature checks out; a sandbox loses Program Files), pointed at the data disk for engines
// (GameUserSettings.ini [Launcher] DefaultAppInstallLocation, in the encoding the file has), and given back what it
// knew about the engines it installed there: their .item manifests and LauncherInstalled.dat entries are saved on the
// data disk while the sandbox runs (the daemon calls saveLauncherState) and put back at the next boot.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readBoundedFile } from '../../../shared/io/bounded.js';
import { readValid, writeJsonAtomic } from '../../../shared/io/json.js';
import { SYSTEM } from '../../../shared/system.js';
import {
  enginePlaceProblem,
  ENGINE_NEED_BYTES,
  entriesUnder,
  launcherInstalledFile,
  launcherManifestsDir,
  launcherSettingsFiles,
  MAX_LAUNCHER_FILE_BYTES,
  mergeLauncherInstalled,
  restoreItems,
  saveItems,
  setLauncherInstallLocation,
  type LauncherEntry,
} from '../../../shared/unreal/index.js';
import { errMsg } from '../../../core/util/errors.js';
import { runInstaller } from '../../runtime/pools.js';
import { exists, mkdirp } from '../../runtime/fs.js';
import { log } from '../../runtime/log.js';
import { SIGNERS, signedInstaller } from '../installers.js';
import { ENGINES_DIR, SAVED_DIR, UNREAL_DIR } from './unreal-status.js';

const MSI_URL =
  'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncherInstaller.msi';
const MSI_FILE = path.join(UNREAL_DIR, 'EpicGamesLauncherInstaller.msi');
const SAVED_MANIFESTS = path.join(SAVED_DIR, 'Manifests');
const SAVED_ENTRIES = path.join(SAVED_DIR, 'LauncherInstalled.json');

const programData = (): string => process.env.ProgramData ?? 'C:\\ProgramData';
const localAppData = (): string => process.env.LOCALAPPDATA ?? '';

/** The launcher's program (launcher 17+ is 64-bit; older ones were in Win32). */
export function launcherExe(): string | null {
  const root = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Epic Games', 'Launcher');
  for (const arch of ['Win64', 'Win32']) {
    const exe = path.join(root, 'Portal', 'Binaries', arch, 'EpicGamesLauncher.exe');
    if (exists(exe)) return exe;
  }
  return null;
}

/** Downloads the launcher's MSI ahead of the install (once). */
export async function fetchLauncher(): Promise<void> {
  if (!launcherExe()) await launcherMsi();
}

const launcherMsi = (): Promise<string> =>
  signedInstaller(MSI_URL, MSI_FILE, 'the Epic Games Launcher (~250 MB once)', SIGNERS.epic);

/** Installs the launcher when this sandbox does not have it yet (the MSI, quietly). Returns its program. */
export async function ensureLauncher(): Promise<string> {
  const have = launcherExe();
  if (have) return have;
  const msi = await launcherMsi();
  log('Installing the Epic Games Launcher ...');
  const code = await runInstaller(SYSTEM.msiexec(), ['/i', msi, '/qn', '/norestart']);
  const exe = launcherExe();
  if ((code !== 0 && code !== 3010) || !exe)
    throw new Error('the Epic Games Launcher installer failed (msiexec exit ' + code + ')');
  return exe;
}

export interface LauncherPlaceResult {
  readonly installLocation: string | null;
  readonly problem: string | null;
  readonly freeBytes: number | null;
  readonly needBytes: number;
}

/** Points the launcher's default install folder at tools\unreal\engines (every settings file it may read). */
export function placeEngines(persist: boolean): LauncherPlaceResult {
  let error: string | undefined;
  if (persist)
    try {
      mkdirp(ENGINES_DIR);
      for (const file of launcherSettingsFiles(localAppData())) setLauncherInstallLocation(file, ENGINES_DIR);
    } catch (e) {
      error = "could not write the launcher's settings (" + errMsg(e) + ')';
    }
  else error = 'toolchains.unreal.persistEngines is off';
  const set = persist && !error;
  const { problem, freeBytes } = enginePlaceProblem(set ? { set } : { set, error: error! }, ENGINES_DIR);
  return { installLocation: set ? ENGINES_DIR : null, problem, freeBytes, needBytes: ENGINE_NEED_BYTES };
}

const SavedEntriesSchema = z.object({
  entries: z
    .array(
      z.object({
        InstallLocation: z.string().max(1024),
        NamespaceId: z.string().max(200),
        ItemId: z.string().max(200),
        ArtifactId: z.string().max(200),
        AppVersion: z.string().max(200),
        AppName: z.string().max(200),
      }),
    )
    .max(64),
});

/** The saved LauncherInstalled.dat entries of engines in tools\unreal\engines whose folder is still there. */
export function savedEntries(): LauncherEntry[] {
  return (readValid(SavedEntriesSchema, SAVED_ENTRIES)?.entries ?? []).filter(
    (e) => e.InstallLocation.toLowerCase().startsWith(ENGINES_DIR.toLowerCase() + '\\') && exists(e.InstallLocation),
  );
}

/** Puts the saved manifests back where the launcher reads them; the engine folders they name. */
export function restoreLauncherItems(): string[] {
  return restoreItems(SAVED_MANIFESTS, launcherManifestsDir(programData()), ENGINES_DIR, exists);
}

/** Merges these entries into the launcher's LauncherInstalled.dat (foreign entries kept). */
export function writeLauncherEntries(entries: readonly LauncherEntry[]): void {
  if (!entries.length) return;
  const file = launcherInstalledFile(programData());
  const bytes = readBoundedFile(file, MAX_LAUNCHER_FILE_BYTES);
  if (!bytes && fs.existsSync(file)) throw new Error(file + ' is too big to read');
  const next = mergeLauncherInstalled(bytes ? bytes.toString('utf8') : null, entries);
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, next, 'utf8');
}

/**
 * Saves what the launcher knows about engines it installed into tools\unreal\engines (new or changed manifests, its
 * LauncherInstalled.dat entries). Cheap: a few small files. Returns whether something new was saved.
 */
export function saveLauncherState(): boolean {
  if (!exists(ENGINES_DIR)) return false;
  const items = saveItems(launcherManifestsDir(programData()), SAVED_MANIFESTS, ENGINES_DIR);
  const bytes = readBoundedFile(launcherInstalledFile(programData()), MAX_LAUNCHER_FILE_BYTES);
  const live = bytes ? entriesUnder(bytes.toString('utf8'), ENGINES_DIR) : [];
  const old = readValid(SavedEntriesSchema, SAVED_ENTRIES)?.entries ?? [];
  const merged = [
    ...old.filter((o) => !live.some((l) => l.InstallLocation.toLowerCase() === o.InstallLocation.toLowerCase())),
    ...live,
  ].filter((e) => exists(e.InstallLocation));
  const changed = JSON.stringify(merged) !== JSON.stringify(old);
  if (changed) {
    mkdirp(SAVED_DIR);
    writeJsonAtomic(SAVED_ENTRIES, { entries: merged.slice(0, 64) });
  }
  if (items.length || changed)
    log('Unreal: saved what the Epic Games Launcher knows about its engines on the data disk');
  return items.length > 0 || changed;
}
