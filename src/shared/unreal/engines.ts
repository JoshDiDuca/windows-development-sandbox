// Unreal engines, pure: what an engine folder is (Engine\Build\Build.version; Engine\Build\InstalledBuild.txt makes it
// an installed build), where the sandbox finds them (this PC read-only, the Epic Games Launcher's folder on the data
// disk, source builds in a project root or registered by you), which one a project builds with (its .uproject's
// EngineAssociation, then a writable engine over a read-only one, then the newest), and what the sandbox writes so
// UnrealBuildTool, UnrealVersionSelector and the editor find them (registry plan) and an agent can run them (PATH,
// variables, the derived data cache). Every file is read through the EngineFs it is given (bounded): the guest passes
// the real disk, the self-test its fixtures.
import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

const win = path.win32;

/** Where an engine came from, which decides whether it is writable and how it is listed. */
export type EngineOrigin =
  /** Installed on this PC, mapped read-only under C:\PcInstalls\unreal (pcInstalls.unrealEngines). */
  | 'pc'
  /** A folder of this PC you registered (pcInstalls.unrealEngineFolders), mapped writable. */
  | 'pc-folder'
  /** Installed by the Epic Games Launcher in a sandbox, in tools\unreal\engines on the data disk. */
  | 'launcher'
  /** Another engine folder in tools\unreal\engines (a source build or a copy). */
  | 'data'
  /** A source build found in a project root (C:\Projects\<root>\<folder>). */
  | 'project';

export const ORIGIN_LABELS: Readonly<Record<EngineOrigin, string>> = {
  pc: 'from this PC (read-only)',
  'pc-folder': 'a folder of this PC you registered',
  launcher: 'installed with the Epic Games Launcher, on the data disk',
  data: 'on the data disk',
  project: 'a source build in a project folder',
};

export interface BuildVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly changelist: number;
  readonly branch: string;
}

/** One engine the sandbox knows. */
export interface UnrealEngine {
  /** UE_5.4 for an installed build; the source build's registered name (a GUID or a plain name). */
  readonly id: string;
  /** The engine's folder (holds Engine\Build\Build.version). */
  readonly dir: string;
  readonly version: BuildVersion;
  /** "installed": a launcher or installed build (InstalledBuild.txt); "source": built from the engine's source. */
  readonly build: 'installed' | 'source';
  readonly origin: EngineOrigin;
  readonly writable: boolean;
}

/** How engine files are read: bounded reads, folder lists, existence. */
export interface EngineFs {
  exists(file: string): boolean;
  /** At most `max` bytes, null when it is missing, too big or not a file. */
  read(file: string, max: number): Buffer | null;
  /** The names in a folder ([] when it is not one). */
  list(dir: string): string[];
}

const BuildVersionSchema = z.object({
  MajorVersion: z.number().int().min(4).max(99),
  MinorVersion: z.number().int().min(0).max(99),
  PatchVersion: z.number().int().min(0).max(999),
  Changelist: z.number().int().optional(),
  BranchName: z.string().optional(),
});

const stripBom = (text: string): string => text.replace(/^\uFEFF/, '');

/** Engine\Build\Build.version: the version of an engine folder, or null when the text is not one. */
export function parseBuildVersion(text: string): BuildVersion | null {
  try {
    const v = BuildVersionSchema.parse(JSON.parse(stripBom(text)));
    return {
      major: v.MajorVersion,
      minor: v.MinorVersion,
      patch: v.PatchVersion,
      changelist: v.Changelist ?? 0,
      branch: (v.BranchName ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 100),
    };
  } catch {
    return null; // Not JSON, or not a Build.version.
  }
}

/** "5.4": the name the launcher and the registry give an engine version. */
export const majorMinor = (v: BuildVersion): string => v.major + '.' + v.minor;
/** "5.4.4": the full version for people. */
export const versionText = (v: BuildVersion): string => v.major + '.' + v.minor + '.' + v.patch;
/** "UE_5.4": the launcher's app name (and the folder it installs into). */
export const launcherAppName = (v: BuildVersion): string => 'UE_' + majorMinor(v);

export function compareVersions(a: BuildVersion, b: BuildVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || a.changelist - b.changelist;
}

/** Engine\Build\Build.version of a folder, or null when it is not an engine. */
export function readEngineVersion(dir: string, fs: EngineFs): BuildVersion | null {
  const bytes = fs.read(win.join(dir, 'Engine', 'Build', 'Build.version'), 64 * 1024);
  return bytes ? parseBuildVersion(bytes.toString('utf8')) : null;
}

/** Whether an engine folder is an installed build (what the launcher installs): Engine\Build\InstalledBuild.txt. */
export function isInstalledBuild(dir: string, fs: EngineFs): boolean {
  return fs.exists(win.join(dir, 'Engine', 'Build', 'InstalledBuild.txt'));
}

const BUILD_ID = /^(\{[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}\}|[A-Za-z0-9][A-Za-z0-9._ -]{0,63})$/;

/** Whether a name can be a source build's registered name (UnrealVersionSelector writes a {GUID}). */
export const isBuildId = (id: string): boolean => BUILD_ID.test(id);

/**
 * A source build's registered name when it has none of its own: a GUID made from its folder, so it is the same every
 * boot and a project that was switched to it keeps finding it.
 */
export function stableBuildId(dir: string): string {
  const h = crypto.createHash('sha1').update(win.normalize(dir).toLowerCase()).digest('hex').toUpperCase();
  return '{' + h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32) + '}';
}

/** The engine in a folder, or null when it is not one. `id`: a source build's registered name (else one is made). */
export function engineAt(
  dir: string,
  origin: EngineOrigin,
  writable: boolean,
  fs: EngineFs,
  id?: string,
): UnrealEngine | null {
  if (!win.isAbsolute(dir) || /["\r\n]/.test(dir)) return null;
  const version = readEngineVersion(dir, fs);
  if (!version) return null;
  const build = isInstalledBuild(dir, fs) ? 'installed' : 'source';
  const name = build === 'installed' ? launcherAppName(version) : id && isBuildId(id) ? id : stableBuildId(dir);
  return { id: name, dir: win.normalize(dir), version, build, origin, writable };
}

/** What the guest knows of this PC's engines (session.json's pcInstalls items of kind "unreal"). */
export interface MappedEngine {
  readonly guest: string;
  readonly id: string;
  /** A registered folder of this PC: mapped writable. */
  readonly writable?: boolean;
  /** A source build's registered name on this PC (HKCU ... Builds), kept so the project's association still matches. */
  readonly buildId?: string;
}

export interface EngineSources {
  /** Engines of this PC mapped into the sandbox. */
  readonly mapped: readonly MappedEngine[];
  /** tools\unreal\engines on the data disk. */
  readonly enginesRoot: string;
  /** The folders of the engines the launcher installed there (from its saved manifests). */
  readonly launcherDirs: readonly string[];
  /** Project roots in the sandbox (C:\Projects\<root>): their folders are looked at for source builds. */
  readonly projectRoots: readonly string[];
}

/** At most this many folders are looked at in one place (a project root may hold many projects). */
const MAX_LOOK = 200;
/** At most this many engines are used. */
export const MAX_ENGINES = 16;

/** Every engine the sandbox can use, in a fixed order (this PC's, the data disk's, the project roots'), each folder once. */
export function findEngines(s: EngineSources, fs: EngineFs): UnrealEngine[] {
  const found: UnrealEngine[] = [];
  const add = (e: UnrealEngine | null): void => {
    if (!e || found.length >= MAX_ENGINES) return;
    if (found.some((f) => f.dir.toLowerCase() === e.dir.toLowerCase())) return;
    found.push(e);
  };
  for (const m of s.mapped) add(engineAt(m.guest, m.writable ? 'pc-folder' : 'pc', m.writable === true, fs, m.buildId));
  const launched = new Set(s.launcherDirs.map((d) => win.normalize(d).toLowerCase()));
  for (const name of fs.list(s.enginesRoot).slice(0, MAX_LOOK)) {
    if (name.startsWith('.')) continue;
    const dir = win.join(s.enginesRoot, name);
    add(engineAt(dir, launched.has(dir.toLowerCase()) ? 'launcher' : 'data', true, fs));
  }
  for (const root of s.projectRoots)
    for (const name of fs.list(root).slice(0, MAX_LOOK)) {
      const dir = win.join(root, name);
      if (fs.exists(win.join(dir, 'Engine', 'Build', 'Build.version'))) add(engineAt(dir, 'project', true, fs));
    }
  return found;
}

// ---- A project's engine -----------------------------------------------------------------------------------------

export type EngineAssociation =
  | { readonly kind: 'none' }
  | { readonly kind: 'version'; readonly version: string }
  | { readonly kind: 'build'; readonly id: string };

/** What a .uproject's EngineAssociation names: "5.4" (an installed build), "{GUID}" or a name (a source build). */
export function parseEngineAssociation(value: unknown): EngineAssociation {
  if (typeof value !== 'string' || !value.trim()) return { kind: 'none' };
  const text = value.trim();
  const version = /^(\d{1,2}\.\d{1,2})(?:\.\d{1,3})?$/.exec(text);
  if (version) return { kind: 'version', version: version[1] };
  return isBuildId(text) ? { kind: 'build', id: text } : { kind: 'none' };
}

/** The EngineAssociation of a .uproject's text (null when it is not JSON). */
export function uprojectAssociation(text: string): EngineAssociation | null {
  try {
    const json: unknown = JSON.parse(stripBom(text));
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
    return parseEngineAssociation((json as Record<string, unknown>).EngineAssociation);
  } catch {
    return null;
  }
}

/** A project's .uproject: in its folder, else one folder down (the first by name), or null. */
export function findUproject(workspace: string, fs: EngineFs): string | null {
  const own = (dir: string): string | null => {
    const hit = fs
      .list(dir)
      .filter((n) => /\.uproject$/i.test(n))
      .sort()[0];
    return hit ? win.join(dir, hit) : null;
  };
  const here = own(workspace);
  if (here) return here;
  for (const name of fs.list(workspace).slice(0, MAX_LOOK).sort()) {
    if (name.startsWith('.') || /^(node_modules|Engine|Binaries|Intermediate|Saved|DerivedDataCache)$/i.test(name))
      continue;
    const hit = own(win.join(workspace, name));
    if (hit) return hit;
  }
  return null;
}

/** Writable before read-only (the editor writes into a project's engine plugins and caches), installed before source. */
const preference = (e: UnrealEngine): number => (e.writable ? 0 : 2) + (e.build === 'installed' ? 0 : 1);

export interface EngineChoice {
  readonly engine: UnrealEngine | null;
  /** Why this one, in plain words (or why none). */
  readonly reason: string;
}

/**
 * The engine a project builds with: the one its EngineAssociation names (a version: a writable one before this PC's
 * read-only one; a build: that registered build), else the newest. Null when the project names one that is not here.
 */
export function chooseEngine(engines: readonly UnrealEngine[], association: EngineAssociation): EngineChoice {
  const best = (list: readonly UnrealEngine[]): UnrealEngine | null =>
    [...list].sort((a, b) => preference(a) - preference(b) || compareVersions(b.version, a.version))[0] ?? null;
  if (association.kind === 'version') {
    const engine = best(engines.filter((e) => majorMinor(e.version) === association.version));
    return engine
      ? { engine, reason: 'the project asks for ' + association.version }
      : { engine: null, reason: 'the project asks for Unreal Engine ' + association.version + ', which is not here' };
  }
  if (association.kind === 'build') {
    const engine = engines.find((e) => e.id.toLowerCase() === association.id.toLowerCase()) ?? null;
    return engine
      ? { engine, reason: 'the project asks for the source build ' + association.id }
      : { engine: null, reason: 'the project asks for the source build ' + association.id + ', which is not here' };
  }
  const newest = [...engines].sort((a, b) => compareVersions(b.version, a.version) || preference(a) - preference(b))[0];
  return newest
    ? { engine: newest, reason: 'the newest engine here' }
    : { engine: null, reason: 'no engine is installed yet' };
}

// ---- Registration -----------------------------------------------------------------------------------------------

/** One registry value the sandbox writes (string values only). */
export interface RegistryValue {
  readonly hive: 'HKLM' | 'HKCU';
  readonly key: string;
  /** '' is the default value. */
  readonly name: string;
  readonly value: string;
}

/** Installed builds: where an installer records them (UnrealVersionSelector and the editor read it). */
export const INSTALLED_KEY = 'SOFTWARE\\EpicGames\\Unreal Engine';
/** Source builds: UnrealVersionSelector's list (name = the build's id, value = its folder). */
export const BUILDS_KEY = 'Software\\Epic Games\\Unreal Engine\\Builds';

/**
 * The registry values that make Unreal find the engines: an installed build as HKLM\SOFTWARE\EpicGames\Unreal
 * Engine\<5.4> InstalledDirectory (one per version: the one a project would pick), a source build as a value under
 * HKCU\Software\Epic Games\Unreal Engine\Builds.
 */
export function registryPlan(engines: readonly UnrealEngine[]): RegistryValue[] {
  const values: RegistryValue[] = [];
  const versions = new Map<string, UnrealEngine>();
  for (const e of engines) {
    if (e.build === 'source') {
      values.push({ hive: 'HKCU', key: BUILDS_KEY, name: e.id, value: e.dir });
      continue;
    }
    const v = majorMinor(e.version);
    const had = versions.get(v);
    if (!had || preference(e) < preference(had)) versions.set(v, e);
  }
  for (const [v, e] of versions)
    values.push({ hive: 'HKLM', key: INSTALLED_KEY + '\\' + v, name: 'InstalledDirectory', value: e.dir });
  return values;
}

/** UnrealVersionSelector inside an engine (it opens, switches and generates project files for .uproject files). */
export function versionSelectorIn(dir: string): string {
  return win.join(dir, 'Engine', 'Binaries', 'Win64', 'UnrealVersionSelector.exe');
}

/**
 * The .uproject file association UnrealVersionSelector /fileassociations writes (per user): open in the editor, launch
 * the game, generate Visual Studio project files, switch the engine version.
 */
export function fileAssociationPlan(selector: string): RegistryValue[] {
  if (!win.isAbsolute(selector) || /["\r\n]/.test(selector)) throw new Error('not a program path: ' + selector);
  const exe = '"' + selector + '"';
  const classes = 'Software\\Classes';
  const type = classes + '\\Unreal.ProjectFile';
  const v = (key: string, value: string, name = ''): RegistryValue => ({ hive: 'HKCU', key, name, value });
  const verb = (id: string, label: string, args: string): RegistryValue[] => [
    v(type + '\\shell\\' + id, label),
    v(type + '\\shell\\' + id + '\\command', exe + ' ' + args + ' "%1"'),
  ];
  return [
    v(classes + '\\.uproject', 'Unreal.ProjectFile'),
    v(type, 'Unreal Engine Project File'),
    v(type + '\\DefaultIcon', exe),
    ...verb('open', 'Open', '/editor'),
    ...verb('run', 'Launch game', '/game'),
    ...verb('rungenproj', 'Generate Visual Studio project files', '/projectfiles'),
    ...verb('switchversion', 'Switch Unreal Engine version...', '/switchversion'),
  ];
}

// ---- Environment, PATH, derived data cache ---------------------------------------------------------------------

/** The folders of an engine an agent runs its tools from (those that exist), in PATH order. */
export function engineToolDirs(dir: string, fs: Pick<EngineFs, 'exists'>): string[] {
  return [
    win.join(dir, 'Engine', 'Build', 'BatchFiles'),
    win.join(dir, 'Engine', 'Binaries', 'Win64'),
    win.join(dir, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool'),
  ].filter((d) => fs.exists(d));
}

/** Variables for the project's engine: UE_ROOT (the engine folder) and UE_ENGINE_DIR (its Engine folder). */
export function engineVars(engine: UnrealEngine): Record<string, string> {
  return { UE_ROOT: engine.dir, UE_ENGINE_DIR: win.join(engine.dir, 'Engine') };
}

/**
 * The derived data cache: UE-LocalDataCachePath moves the local cache (and from 5.4 the Zen store, in its Zen
 * subfolder) out of the engine and off the sandbox's disk. "local" leaves Unreal's own place (the sandbox's disk).
 */
export function ddcVars(mode: 'persisted' | 'local', ddcDir: string): Record<string, string> {
  return mode === 'persisted' ? { 'UE-LocalDataCachePath': ddcDir } : {};
}

/** The editor's MCP server (Unreal 5.8's ModelContextProtocol plugin): its default address. */
export const UNREAL_MCP_URL = 'http://127.0.0.1:8000/mcp';
const MCP_PLUGIN = ['Experimental', 'ModelContextProtocol', 'ModelContextProtocol.uplugin'];

/** Whether an engine ships the ModelContextProtocol plugin (5.8 and later). */
export function hasMcpPlugin(engine: UnrealEngine, fs: Pick<EngineFs, 'exists'>): boolean {
  if (engine.version.major < 5 || (engine.version.major === 5 && engine.version.minor < 8)) return false;
  return fs.exists(win.join(engine.dir, 'Engine', 'Plugins', ...MCP_PLUGIN));
}
