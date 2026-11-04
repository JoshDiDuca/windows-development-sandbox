// The pure half of the Unreal engine set-up: what the Epic Games Launcher keeps (LauncherInstalled.dat, the .item
// manifests, GameUserSettings.ini), how engines are registered for UnrealBuildTool and the editor (registry plan),
// how a project's EngineAssociation picks an engine, and the PATH, environment and guide line an agent builds with.
// No runtime imports (no session, no log): the self-test loads this file with temp folders.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readBoundedFile } from '../../../shared/io/bounded.js';
import { decodeText, encodeText } from '../../../shared/io/text.js';

const win = path.win32;
const GB = 1024 ** 3;
/** What one engine takes (the launcher's download is 40-60 GB): checked on the data disk before the launcher installs. */
export const ENGINE_NEED_BYTES = 60 * GB;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ITEM_BYTES = 1024 * 1024;

export type EngineKind = 'launcher' | 'pc' | 'source';

/** One engine the sandbox knows. */
export interface UnrealEngine {
  readonly kind: EngineKind;
  /** UE_5.4 for a launcher build; the registered name (a GUID or a plain name) for a source build. */
  readonly id: string;
  /** The engine's folder (holds Engine\ and Engine\Build\Build.version). */
  readonly dir: string;
  readonly version: BuildVersion;
}

export interface BuildVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly changelist: number;
  readonly branch: string;
}

const BuildVersionSchema = z.object({
  MajorVersion: z.number().int().min(0).max(99),
  MinorVersion: z.number().int().min(0).max(99),
  PatchVersion: z.number().int().min(0).max(999),
  Changelist: z.number().int().optional(),
  BranchName: z.string().optional(),
});

/** Engine\Build\Build.version: the version of an engine folder, or null when the text is not one. */
export function parseBuildVersion(text: string): BuildVersion | null {
  try {
    const v = BuildVersionSchema.parse(JSON.parse(text.replace(/^﻿/, '')));
    return {
      major: v.MajorVersion,
      minor: v.MinorVersion,
      patch: v.PatchVersion,
      changelist: v.Changelist ?? 0,
      branch: (v.BranchName ?? '').slice(0, 100),
    };
  } catch {
    return null; // Not JSON, or not a Build.version.
  }
}

/** Reads Engine\Build\Build.version of a folder (bounded), or null when it is not an engine. */
export function readEngineVersion(dir: string): BuildVersion | null {
  const bytes = readBoundedFile(win.join(dir, 'Engine', 'Build', 'Build.version'), 64 * 1024);
  return bytes ? parseBuildVersion(bytes.toString('utf8')) : null;
}

/** "5.4": the name the launcher and the registry give an engine version. */
export const majorMinor = (v: BuildVersion): string => v.major + '.' + v.minor;
/** "UE_5.4": the launcher's app name. */
export const launcherAppName = (v: BuildVersion): string => 'UE_' + majorMinor(v);
/** "5.4.4-33043543+++UE5+Release-5.4": the launcher's AppVersion. */
export function appVersionString(v: BuildVersion): string {
  const branch = v.branch.replace(/^\+*/, '++');
  return v.major + '.' + v.minor + '.' + v.patch + '-' + v.changelist + '+' + branch;
}

// ---- LauncherInstalled.dat ------------------------------------------------------------------------------------

/** One entry of the launcher's InstallationList (only the fields we write; others pass through untouched). */
export interface LauncherEntry {
  readonly InstallLocation: string;
  readonly NamespaceId: string;
  readonly ItemId: string;
  readonly ArtifactId: string;
  readonly AppVersion: string;
  readonly AppName: string;
}

const ForeignEntrySchema = z.record(z.string(), z.unknown());
const InstalledFileSchema = z.object({ InstallationList: z.array(z.unknown()) }).passthrough();

/** The entry that tells the launcher an engine folder is an installed engine. */
export function launcherEntry(engine: UnrealEngine): LauncherEntry {
  const name = launcherAppName(engine.version);
  return {
    InstallLocation: engine.dir,
    NamespaceId: 'ue',
    ItemId: name,
    ArtifactId: name,
    AppVersion: appVersionString(engine.version),
    AppName: name,
  };
}

/**
 * LauncherInstalled.dat with the given engines in it. Every entry that is not ours (another game, an engine at another
 * place) stays exactly as it was; an entry of ours (same AppName, same InstallLocation) is replaced; a file that cannot
 * be read is not touched but replaced by a new list only when it is empty or missing.
 */
export function mergeLauncherInstalled(existing: string | null, engines: readonly UnrealEngine[]): string {
  let list: unknown[] = [];
  let rest: Record<string, unknown> = {};
  if (existing && existing.trim()) {
    const parsed = InstalledFileSchema.parse(JSON.parse(existing.replace(/^﻿/, '')));
    const { InstallationList, ...others } = parsed;
    list = InstallationList;
    rest = others;
  }
  const ours = engines.map(launcherEntry);
  const sameAs = (e: unknown, mine: LauncherEntry): boolean => {
    const entry = ForeignEntrySchema.safeParse(e);
    return (
      entry.success &&
      entry.data.AppName === mine.AppName &&
      String(entry.data.InstallLocation ?? '').toLowerCase() === mine.InstallLocation.toLowerCase()
    );
  };
  const kept = list.filter((e) => !ours.some((mine) => sameAs(e, mine)));
  return JSON.stringify({ ...rest, InstallationList: [...kept, ...ours] }, null, '\t') + '\n';
}

// ---- .item manifests ------------------------------------------------------------------------------------------

const ItemSchema = z.object({ InstallLocation: z.string().optional(), AppName: z.string().optional() }).passthrough();

/** Whether `child` is `parent` or inside it (case-insensitive, Windows paths). */
export function isWithin(parent: string, child: string): boolean {
  const rel = win.relative(win.resolve(parent).toLowerCase(), win.resolve(child).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !win.isAbsolute(rel));
}

/** Whether the text is a launcher manifest of an engine installed under `root`. */
export function isEngineItem(text: string, root: string): boolean {
  try {
    const item = ItemSchema.parse(JSON.parse(text.replace(/^﻿/, '')));
    return Boolean(item.InstallLocation && win.isAbsolute(item.InstallLocation) && isWithin(root, item.InstallLocation));
  } catch {
    return false; // Not a manifest we can read: left alone.
  }
}

function itemFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => /^[A-Za-z0-9_-]{1,80}\.item$/.test(f));
  } catch {
    return [];
  }
}

/** Copies the launcher's manifests of engines under `root` into `saved` (changed ones only). Returns the file names. */
export function saveItems(manifests: string, saved: string, root: string): string[] {
  const done: string[] = [];
  for (const name of itemFiles(manifests)) {
    const bytes = readBoundedFile(win.join(manifests, name), MAX_ITEM_BYTES);
    if (!bytes || !isEngineItem(bytes.toString('utf8'), root)) continue;
    const old = readBoundedFile(win.join(saved, name), MAX_ITEM_BYTES);
    if (old && old.equals(bytes)) continue;
    fs.mkdirSync(saved, { recursive: true });
    fs.writeFileSync(win.join(saved, name), bytes);
    done.push(name);
  }
  return done;
}

/** Puts saved manifests back where the launcher reads them. A manifest the launcher already has is never replaced. */
export function restoreItems(saved: string, manifests: string, root: string): string[] {
  const done: string[] = [];
  for (const name of itemFiles(saved)) {
    if (fs.existsSync(win.join(manifests, name))) continue;
    const bytes = readBoundedFile(win.join(saved, name), MAX_ITEM_BYTES);
    if (!bytes || !isEngineItem(bytes.toString('utf8'), root)) continue;
    fs.mkdirSync(manifests, { recursive: true });
    fs.writeFileSync(win.join(manifests, name), bytes);
    done.push(name);
  }
  return done;
}

// ---- GameUserSettings.ini -------------------------------------------------------------------------------------

/** %LOCALAPPDATA%\EpicGamesLauncher\Saved\Config\Windows\GameUserSettings.ini */
export function launcherSettingsFile(localAppData: string): string {
  return win.join(localAppData, 'EpicGamesLauncher', 'Saved', 'Config', 'Windows', 'GameUserSettings.ini');
}

/** %ProgramData%\Epic\UnrealEngineLauncher\LauncherInstalled.dat */
export function launcherInstalledFile(programData: string): string {
  return win.join(programData, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
}

/** %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests */
export function launcherManifestsDir(programData: string): string {
  return win.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
}

/** The ini text with [Launcher] DefaultAppInstallLocation set (other lines, comments and line ends untouched). */
export function withInstallLocation(ini: string, dir: string): string {
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

/** Sets the launcher's default install folder in its settings file, keeping the file's encoding. Returns whether it changed. */
export function setLauncherInstallLocation(file: string, dir: string): boolean {
  const bytes = readBoundedFile(file, MAX_FILE_BYTES);
  if (!bytes && fs.existsSync(file)) throw new Error('could not read ' + file + ' (too big or not a file)');
  const decoded = bytes ? decodeText(bytes) : { text: '', encoding: 'utf8' as const };
  const next = withInstallLocation(decoded.text, dir);
  if (bytes && next === decoded.text) return false;
  fs.mkdirSync(win.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeText(next, decoded.encoding));
  return true;
}

// ---- Registration for UnrealBuildTool and the editor ----------------------------------------------------------

export interface RegistryWrite {
  readonly key: string;
  readonly name: string;
  readonly value: string;
}

const BUILD_ID = /^(\{[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}\}|[A-Za-z0-9][A-Za-z0-9._ -]{0,63})$/;

export const BUILDS_KEY = 'HKCU\\Software\\Epic Games\\Unreal Engine\\Builds';
export const INSTALLED_KEY = 'HKLM\\SOFTWARE\\EpicGames\\Unreal Engine';

/**
 * The registry values that make Unreal find the engines: launcher and PC builds as HKLM\SOFTWARE\EpicGames\Unreal
 * Engine\<5.4> InstalledDirectory (what a launcher install writes), source builds as a named value under
 * HKCU\Software\Epic Games\Unreal Engine\Builds (what a project's GUID EngineAssociation looks up).
 */
export function registryPlan(engines: readonly UnrealEngine[]): RegistryWrite[] {
  const writes: RegistryWrite[] = [];
  for (const e of engines) {
    if (!win.isAbsolute(e.dir) || /["\r\n]/.test(e.dir)) throw new Error('not an engine folder: ' + e.dir);
    if (e.kind === 'source') {
      if (!BUILD_ID.test(e.id)) throw new Error('not a usable engine id: ' + e.id);
      writes.push({ key: BUILDS_KEY, name: e.id, value: e.dir });
    } else
      writes.push({ key: INSTALLED_KEY + '\\' + majorMinor(e.version), name: 'InstalledDirectory', value: e.dir });
  }
  return writes;
}

/** The reg.exe arguments of one write (64-bit view, no prompt). */
export function regAddArgs(w: RegistryWrite): string[] {
  return ['add', w.key, '/v', w.name, '/t', 'REG_SZ', '/d', w.value, '/f', '/reg:64'];
}

// ---- A project's engine -----------------------------------------------------------------------------------------

export type EngineAssociation =
  | { readonly kind: 'none' }
  | { readonly kind: 'version'; readonly version: string }
  | { readonly kind: 'build'; readonly id: string };

/** What a .uproject's EngineAssociation names: "5.4" (a launcher build), "{GUID}" or a plain name (a registered build). */
export function parseEngineAssociation(value: unknown): EngineAssociation {
  if (typeof value !== 'string' || !value.trim()) return { kind: 'none' };
  const text = value.trim();
  const version = /^(\d{1,2}\.\d{1,2})(?:\.\d{1,3})?$/.exec(text);
  if (version) return { kind: 'version', version: version[1] };
  return BUILD_ID.test(text) ? { kind: 'build', id: text } : { kind: 'none' };
}

/** The EngineAssociation of the text of a .uproject (null when it is not JSON). */
export function uprojectAssociation(text: string): EngineAssociation | null {
  try {
    const json: unknown = JSON.parse(text.replace(/^﻿/, ''));
    return json && typeof json === 'object' ? parseEngineAssociation((json as Record<string, unknown>).EngineAssociation) : null;
  } catch {
    return null;
  }
}

/** The engine a project builds with: the one it names, else the only engine there is, else null. */
export function pickEngine(engines: readonly UnrealEngine[], association: EngineAssociation): UnrealEngine | null {
  if (association.kind === 'version')
    return (
      engines.find((e) => e.kind !== 'source' && majorMinor(e.version) === association.version) ??
      engines.find((e) => majorMinor(e.version) === association.version) ??
      null
    );
  if (association.kind === 'build')
    return engines.find((e) => e.kind === 'source' && e.id.toLowerCase() === association.id.toLowerCase()) ?? null;
  return engines.length === 1 ? engines[0] : null;
}

// ---- Environment, PATH, derived data cache ---------------------------------------------------------------------

/** The folders of an engine an agent runs tools from (only those that exist), in PATH order. */
export function engineToolDirs(dir: string, exists: (p: string) => boolean): string[] {
  return [
    win.join(dir, 'Engine', 'Build', 'BatchFiles'),
    win.join(dir, 'Engine', 'Binaries', 'Win64'),
    win.join(dir, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool'),
  ].filter(exists);
}

/** Environment variables for the engine an agent uses: UE_ROOT (what editor integrations and scripts read). */
export function engineVars(engine: UnrealEngine): Record<string, string> {
  return { UE_ROOT: engine.dir, UE_ENGINE_DIR: win.join(engine.dir, 'Engine') };
}

/**
 * The derived data cache settings: UE-LocalDataCachePath is the local cache folder the engine reads before its ini
 * files. "local" leaves Unreal's own place (on the sandbox disk).
 */
export function ddcVars(mode: 'persisted' | 'local', ddcDir: string): Record<string, string> {
  return mode === 'persisted' ? { 'UE-LocalDataCachePath': ddcDir } : {};
}

export interface GuideInput {
  readonly engine: UnrealEngine | null;
  readonly engineCount: number;
  readonly sdk: 'autosdk' | 'buildtools' | 'full';
  readonly cdb: boolean;
  readonly enginesRoot: string;
}

/** The unreal line of the sandbox guide: the plain engine commands an agent builds, tests, cooks and debugs with. */
export function guideLine(g: GuideInput): string {
  const where = g.engine
    ? 'engine ' + g.engine.id + ' (' + majorMinor(g.engine.version) + ') at ' + g.engine.dir + ', UE_ROOT is set and its Build.bat, RunUAT.bat, UnrealEditor-Cmd.exe and UnrealBuildTool are on PATH'
    : g.engineCount
      ? g.engineCount + ' engines are registered; none matches this project\'s EngineAssociation'
      : 'no engine yet: install one with the Epic Games Launcher (it installs into ' + g.enginesRoot + ', kept between sandboxes), map one from this PC (pcInstalls.unrealEngines) or list a source build (toolchains.unreal.engineFolders)';
  return (
    'unreal: ' +
    where +
    '; compiler: ' +
    (g.sdk === 'autosdk' ? 'AutoSDK (UE_SDKS_ROOT, no Visual Studio)' : 'Visual Studio ' + (g.sdk === 'full' ? 'Community' : 'Build Tools')) +
    '. Build: Build.bat <Target>Editor Win64 Development -Project="<path>.uproject" -WaitMutex; ' +
    'project files: GenerateProjectFiles.bat -project="<path>.uproject" -game; ' +
    'test: UnrealEditor-Cmd.exe "<uproject>" -ExecCmds="Automation RunTests <filter>;Quit" -unattended -nullrhi -nosplash -log; ' +
    'commandlet: UnrealEditor-Cmd.exe "<uproject>" -run=<Commandlet> -unattended -nullrhi; ' +
    'cook and package: RunUAT.bat BuildCookRun -project="<uproject>" -platform=Win64 -clientconfig=Development -build -cook -stage -pak -archive -archivedirectory=<dir> -noP4; ' +
    'logs: <project>\\Saved\\Logs, crash dumps: <project>\\Saved\\Crashes' +
    (g.cdb ? '; debug a crash: cdb -z <UEMinidump.dmp> -c "!analyze -v;q"' : '') +
    '. The editor needs a GPU (vGPU); builds, tests with -nullrhi and cooking do not'
  );
}
