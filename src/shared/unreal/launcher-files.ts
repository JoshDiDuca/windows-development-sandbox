// What the Epic Games Launcher keeps about installed apps, pure apart from the files it is pointed at:
// LauncherInstalled.dat (%ProgramData%\Epic\UnrealEngineLauncher: the InstallationList the editor and
// UnrealVersionSelector read), the .item manifests (%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests: what the
// launcher itself lists as installed) and GameUserSettings.ini (its DefaultAppInstallLocation). Entries and manifests
// that are not ours (other games, engines elsewhere) are never dropped or changed. Every file is read bounded.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readBoundedFile } from '../io/bounded.js';
import { decodeText, encodeText } from '../io/text.js';
import { launcherAppName, preferredInstalled, type BuildVersion, type UnrealEngine } from './engines.js';

const win = path.win32;

/** The launcher's own ids of an installed app (copied from this PC's LauncherInstalled.dat). */
export interface LauncherIds {
  readonly namespaceId: string;
  readonly itemId: string;
  readonly artifactId: string;
  readonly appVersion: string;
}

/** "5.4.4-33043543+++UE5+Release-5.4": the launcher's AppVersion of an engine version. */
export function appVersionText(v: BuildVersion): string {
  return v.major + '.' + v.minor + '.' + v.patch + '-' + v.changelist + '+' + v.branch.replace(/^\+*/, '++');
}
export const MAX_LAUNCHER_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ITEM_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000;

const stripBom = (text: string): string => text.replace(/^﻿/, '');

/** %ProgramData%\Epic\UnrealEngineLauncher\LauncherInstalled.dat */
export function launcherInstalledFile(programData: string): string {
  return win.join(programData, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
}

/** %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests */
export function launcherManifestsDir(programData: string): string {
  return win.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
}

/**
 * The launcher's settings files under %LOCALAPPDATA%\EpicGamesLauncher\Saved\Config: WindowsEditor\ (what launcher 17+
 * writes; 20.3 checked) and Windows\ (older launchers).
 */
export function launcherSettingsFiles(localAppData: string): string[] {
  const config = win.join(localAppData, 'EpicGamesLauncher', 'Saved', 'Config');
  return [
    win.join(config, 'WindowsEditor', 'GameUserSettings.ini'),
    win.join(config, 'Windows', 'GameUserSettings.ini'),
  ];
}

// ---- LauncherInstalled.dat ------------------------------------------------------------------------------------

/** One InstallationList entry as the launcher writes it (other fields pass through untouched). */
export interface LauncherEntry {
  readonly InstallLocation: string;
  readonly NamespaceId: string;
  readonly ItemId: string;
  readonly ArtifactId: string;
  readonly AppVersion: string;
  readonly AppName: string;
}

const EntrySchema = z.looseObject({
  InstallLocation: z.string().max(1024),
  AppName: z.string().max(200),
  NamespaceId: z.string().max(200).optional(),
  ItemId: z.string().max(200).optional(),
  ArtifactId: z.string().max(200).optional(),
  AppVersion: z.string().max(200).optional(),
});
const InstalledFileSchema = z.looseObject({ InstallationList: z.array(z.unknown()).max(MAX_ENTRIES) });

/** An installation the launcher lists (only entries with an absolute folder and a name). */
export interface Installation {
  readonly appName: string;
  readonly installLocation: string;
  readonly ids: LauncherIds | null;
}

/** The InstallationList of a LauncherInstalled.dat text ([] when it is empty or not one). */
export function launcherInstallations(text: string): Installation[] {
  let list: unknown[];
  try {
    list = InstalledFileSchema.parse(JSON.parse(stripBom(text))).InstallationList;
  } catch {
    return [];
  }
  return list.flatMap((raw) => {
    const e = EntrySchema.safeParse(raw);
    if (!e.success || !win.isAbsolute(e.data.InstallLocation) || /["\r\n]/.test(e.data.InstallLocation)) return [];
    const { NamespaceId, ItemId, ArtifactId, AppVersion } = e.data;
    return [
      {
        appName: e.data.AppName,
        installLocation: e.data.InstallLocation,
        ids:
          NamespaceId && ItemId && ArtifactId && AppVersion
            ? { namespaceId: NamespaceId, itemId: ItemId, artifactId: ArtifactId, appVersion: AppVersion }
            : null,
      },
    ];
  });
}

/** The entry that lists an engine folder as an installed engine (with the launcher's own ids when they are known). */
export function launcherEntry(engine: UnrealEngine, ids: LauncherIds | null = null): LauncherEntry {
  const name = launcherAppName(engine.version);
  return {
    InstallLocation: engine.dir,
    NamespaceId: ids?.namespaceId ?? 'ue',
    ItemId: ids?.itemId ?? name,
    ArtifactId: ids?.artifactId ?? name,
    AppVersion: ids?.appVersion ?? appVersionText(engine.version),
    AppName: name,
  };
}

/**
 * The LauncherInstalled.dat entries for the installed builds: only the one preferred for each version (Unreal keeps
 * the LAST entry per app name, so a second UE_5.4 would shadow the first), with the launcher's own saved entry when
 * there is one, else the ids copied from this PC, else made up.
 */
export function launcherEntriesFor(
  engines: readonly UnrealEngine[],
  saved: readonly LauncherEntry[],
  pcItems: readonly { readonly kind: string; readonly guest: string; readonly launcher?: LauncherIds | null }[],
): LauncherEntry[] {
  return preferredInstalled(engines).map((e) => {
    const own = saved.find((s) => s.InstallLocation.toLowerCase() === e.dir.toLowerCase());
    if (own) return own;
    const pc = pcItems.find((i) => i.kind === 'unreal' && i.guest.toLowerCase() === e.dir.toLowerCase());
    return launcherEntry(e, pc?.launcher ?? null);
  });
}

/**
 * LauncherInstalled.dat with these entries in it. Every entry that is not one of them (another game, an engine at
 * another place) stays as it was; an entry for the same folder is replaced. A file that is not a LauncherInstalled.dat
 * throws (it is never overwritten); a missing or empty one starts a new list.
 */
export function mergeLauncherInstalled(existing: string | null, entries: readonly LauncherEntry[]): string {
  let list: unknown[] = [];
  let rest: Record<string, unknown> = {};
  if (existing && existing.trim()) {
    const { InstallationList, ...others } = InstalledFileSchema.parse(JSON.parse(stripBom(existing)));
    list = InstallationList;
    rest = others;
  }
  const same = (raw: unknown, mine: LauncherEntry): boolean => {
    const e = EntrySchema.safeParse(raw);
    return (
      e.success &&
      win.normalize(e.data.InstallLocation).toLowerCase() === win.normalize(mine.InstallLocation).toLowerCase()
    );
  };
  const kept = list.filter((raw) => !entries.some((mine) => same(raw, mine)));
  return JSON.stringify({ ...rest, InstallationList: [...kept, ...entries] }, null, '\t') + '\n';
}

/** Whether `child` is `parent` or inside it (case-insensitive, Windows paths). */
export function isWithin(parent: string, child: string): boolean {
  const rel = win.relative(win.resolve(parent).toLowerCase(), win.resolve(child).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !win.isAbsolute(rel));
}

/** The entries of a LauncherInstalled.dat text whose folder is under `root` (the engines kept on the data disk). */
export function entriesUnder(text: string, root: string): LauncherEntry[] {
  return launcherInstallations(text)
    .filter((i) => i.ids && isWithin(root, i.installLocation) && win.resolve(i.installLocation) !== win.resolve(root))
    .map((i) => ({
      InstallLocation: i.installLocation,
      NamespaceId: i.ids!.namespaceId,
      ItemId: i.ids!.itemId,
      ArtifactId: i.ids!.artifactId,
      AppVersion: i.ids!.appVersion,
      AppName: i.appName,
    }));
}

// ---- .item manifests ------------------------------------------------------------------------------------------

const ItemSchema = z.looseObject({
  InstallLocation: z.string().max(1024).optional(),
  AppName: z.string().max(200).optional(),
  InstallSize: z.number().int().min(0).optional(),
  bIsIncompleteInstall: z.boolean().optional(),
});

/** The folder a launcher manifest says its app is installed in, or null. */
export function itemInstallLocation(text: string): string | null {
  return itemInfo(text)?.installLocation ?? null;
}

/** A launcher manifest's folder and size, or null when it is not one we can read. */
export function itemInfo(text: string): { installLocation: string; sizeBytes: number | null } | null {
  try {
    const item = ItemSchema.parse(JSON.parse(stripBom(text)));
    const at = item.InstallLocation;
    return at && win.isAbsolute(at) ? { installLocation: at, sizeBytes: item.InstallSize ?? null } : null;
  } catch {
    return null; // Not a manifest we can read: left alone.
  }
}

/**
 * The folders (lower-case, normalized) the manifests in these folders mark as a launcher install still in progress
 * (bIsIncompleteInstall): not engines yet.
 */
export function incompleteDirs(...manifestDirs: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const dir of manifestDirs)
    for (const name of itemFiles(dir)) {
      const bytes = readBoundedFile(win.join(dir, name), MAX_ITEM_BYTES);
      if (!bytes) continue;
      try {
        const item = ItemSchema.parse(JSON.parse(stripBom(bytes.toString('utf8'))));
        if (item.bIsIncompleteInstall === true && item.InstallLocation && win.isAbsolute(item.InstallLocation))
          dirs.add(win.normalize(item.InstallLocation).toLowerCase());
      } catch {
        // Not a manifest we can read: it marks nothing.
      }
    }
  return dirs;
}

/** The sizes the saved manifests give their engine folders (lower-case folder -> bytes). */
export function itemSizes(saved: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const name of itemFiles(saved)) {
    const bytes = readBoundedFile(win.join(saved, name), MAX_ITEM_BYTES);
    const info = bytes ? itemInfo(bytes.toString('utf8')) : null;
    if (info?.sizeBytes !== null && info?.sizeBytes !== undefined)
      sizes.set(win.normalize(info.installLocation).toLowerCase(), info.sizeBytes);
  }
  return sizes;
}

/** Whether the text is a launcher manifest of an app installed under `root`. */
export function isItemUnder(text: string, root: string): boolean {
  const at = itemInstallLocation(text);
  return at !== null && isWithin(root, at) && win.resolve(at) !== win.resolve(root);
}

function itemFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => /^[A-Za-z0-9_-]{1,80}\.item$/.test(f));
  } catch {
    return [];
  }
}

/** Copies the launcher's manifests of apps under `root` into `saved` (changed ones only). Returns the file names. */
export function saveItems(manifests: string, saved: string, root: string): string[] {
  const done: string[] = [];
  for (const name of itemFiles(manifests)) {
    const bytes = readBoundedFile(win.join(manifests, name), MAX_ITEM_BYTES);
    if (!bytes || !isItemUnder(bytes.toString('utf8'), root)) continue;
    const old = readBoundedFile(win.join(saved, name), MAX_ITEM_BYTES);
    if (old && old.equals(bytes)) continue;
    fs.mkdirSync(saved, { recursive: true });
    fs.writeFileSync(win.join(saved, name), bytes);
    done.push(name);
  }
  return done;
}

/**
 * Puts saved manifests back where the launcher reads them, for the apps whose folder is still there. A manifest the
 * launcher already has is never replaced. Returns the folders they name.
 */
export function restoreItems(
  saved: string,
  manifests: string,
  root: string,
  exists: (dir: string) => boolean,
): string[] {
  const dirs: string[] = [];
  for (const name of itemFiles(saved)) {
    const bytes = readBoundedFile(win.join(saved, name), MAX_ITEM_BYTES);
    const at = bytes ? itemInstallLocation(bytes.toString('utf8')) : null;
    if (!bytes || !at || !isItemUnder(bytes.toString('utf8'), root) || !exists(at)) continue;
    dirs.push(win.normalize(at));
    if (fs.existsSync(win.join(manifests, name))) continue;
    fs.mkdirSync(manifests, { recursive: true });
    fs.writeFileSync(win.join(manifests, name), bytes);
  }
  return dirs;
}

// ---- GameUserSettings.ini -------------------------------------------------------------------------------------

/** The ini text with [Launcher] DefaultAppInstallLocation set (other lines, comments and line ends untouched). */
export function withInstallLocation(ini: string, dir: string): string {
  if (/[\r\n]/.test(dir)) throw new Error('not a folder: ' + dir);
  const eol = ini.includes('\r\n') || !ini.includes('\n') ? '\r\n' : '\n';
  const lines = ini.length ? ini.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const entry = 'DefaultAppInstallLocation=' + dir;
  const start = lines.findIndex((l) => /^\s*\[Launcher\]\s*$/i.test(l));
  if (start < 0) return [...lines, ...(lines.length ? [''] : []), '[Launcher]', entry].join(eol) + eol;
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const at = lines.findIndex((l, i) => i > start && i < end && /^\s*DefaultAppInstallLocation\s*=/i.test(l));
  if (at >= 0) lines[at] = entry;
  else lines.splice(start + 1, 0, entry);
  return lines.join(eol) + eol;
}

/** The [Launcher] DefaultAppInstallLocation of an ini text, or null. */
export function installLocationOf(ini: string): string | null {
  let inLauncher = false;
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inLauncher = /^\[Launcher\]$/i.test(line);
      continue;
    }
    const m = inLauncher ? /^DefaultAppInstallLocation\s*=\s*(.*)$/i.exec(line) : null;
    if (m) return m[1].trim() || null;
  }
  return null;
}

/** Sets the launcher's default install folder in a settings file, keeping its encoding. Returns whether it changed. */
export function setLauncherInstallLocation(file: string, dir: string): boolean {
  const bytes = readBoundedFile(file, MAX_LAUNCHER_FILE_BYTES);
  if (!bytes && fs.existsSync(file)) throw new Error('could not read ' + file + ' (too big or not a file)');
  const decoded = bytes ? decodeText(bytes) : { text: '', encoding: 'utf8' as const };
  const next = withInstallLocation(decoded.text, dir);
  if (bytes && next === decoded.text) return false;
  fs.mkdirSync(win.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeText(next, decoded.encoding));
  return true;
}
