// Visual Studio kept on the data disk (visual-studio.ts runs it): what is saved once after the real install, the marker
// that says the saved copy is complete, and what a later boot puts back (a few copies and registry values) so the Setup
// API, vswhere and vcvars find it again in seconds. The big folders (Visual Studio, the Windows SDK) stay on the data
// disk and are registered where they are; the small ones that programs look for at fixed paths are copied back. Pure:
// no runtime, so the self-test loads it.
import path from 'node:path';
import { z } from 'zod';
import type { VsRequest } from './vs-request.js';

const win = path.win32;

/** The marker file in the saved copy's folder, written last. */
export const MARKER_FILE = '.complete.json';
/** The Setup Configuration COM class (vswhere and UnrealBuildTool find Visual Studio through it). */
export const SETUP_CLSID = '{177F0C4A-1CD3-4DE7-A32C-71DBBB9FA36D}';
const SETUP_DLL = 'Microsoft.VisualStudio.Setup.Configuration.Native.dll';
/** A Visual Studio instance ID (8 hex digits in practice); never a path. */
const INSTANCE_ID = /^[A-Za-z0-9]{1,64}$/;

/** The Windows folders an install uses (from the environment; the tests pass their own). */
export interface WinPlaces {
  readonly programFiles: string;
  readonly programFilesX86: string;
  readonly programData: string;
}

export function winPlaces(env: NodeJS.ProcessEnv): WinPlaces {
  return {
    programFiles: env.ProgramFiles ?? 'C:\\Program Files',
    programFilesX86: env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    programData: env.ProgramData ?? 'C:\\ProgramData',
  };
}

export const FOLDER_NAMES = [
  'Community',
  'BuildTools',
  'WindowsKits10',
  'NETFXSDK',
  'MicrosoftSDKs-v10.0A',
  'ReferenceAssemblies',
  'Installer',
  'Shared',
  'Setup',
  'instance',
] as const;
export type FolderName = (typeof FOLDER_NAMES)[number];

/**
 * What a boot does with a saved folder: 'stay' on the data disk (registered there), 'copy' back to where it came from
 * (programs look for it at a fixed path), or 'copy-missing': only the versions not there yet (the reference assemblies,
 * where the .NET step may have put some).
 */
export type RestoreMode = 'stay' | 'copy' | 'copy-missing';

export interface PersistFolder {
  readonly name: FolderName;
  /** Where the install put it. */
  readonly source: string;
  readonly restore: RestoreMode;
  /** Not every install has it (the Build Tools without .NET parts): skipped when missing. */
  readonly optional: boolean;
}

export function productFolder(product: VsRequest['product']): 'Community' | 'BuildTools' {
  return product === 'community' ? 'Community' : 'BuildTools';
}

/** The instances folder of the Visual Studio installer (one subfolder per instance ID). */
export function instancesDir(places: WinPlaces): string {
  return win.join(places.programData, 'Microsoft', 'VisualStudio', 'Packages', '_Instances');
}

/** Every folder a Visual Studio install spreads over, and what a boot does with each. */
export function persistFolders(
  vs: { readonly product: VsRequest['product']; readonly installationPath: string; readonly instanceId: string },
  places: WinPlaces,
): PersistFolder[] {
  if (!INSTANCE_ID.test(vs.instanceId)) throw new Error('"' + vs.instanceId + '" is not a Visual Studio instance ID');
  const x86 = places.programFilesX86;
  const one = (name: FolderName, source: string, restore: RestoreMode, optional = false): PersistFolder => ({
    name,
    source,
    restore,
    optional,
  });
  return [
    one(productFolder(vs.product), vs.installationPath, 'stay'),
    one('WindowsKits10', win.join(x86, 'Windows Kits', '10'), 'stay'),
    one('NETFXSDK', win.join(x86, 'Windows Kits', 'NETFXSDK'), 'stay', true),
    one('MicrosoftSDKs-v10.0A', win.join(x86, 'Microsoft SDKs', 'Windows', 'v10.0A'), 'stay', true),
    // MSBuild looks for the .NET Framework reference assemblies at this fixed path.
    one(
      'ReferenceAssemblies',
      win.join(x86, 'Reference Assemblies', 'Microsoft', 'Framework', '.NETFramework'),
      'copy-missing',
      true,
    ),
    // Scripts and build tools look for vswhere here; the instance's state names setup.exe here too (144 MB).
    one('Installer', win.join(x86, 'Microsoft Visual Studio', 'Installer'), 'copy'),
    one('Shared', win.join(x86, 'Microsoft Visual Studio', 'Shared'), 'copy', true),
    one('Setup', win.join(places.programData, 'Microsoft', 'VisualStudio', 'Setup'), 'copy'),
    one('instance', win.join(instancesDir(places), vs.instanceId), 'copy'),
  ];
}

export const RegEntrySchema = z.strictObject({
  view: z.enum(['64', '32']),
  /** Under HKLM, e.g. SOFTWARE\Microsoft\Microsoft SDKs\Windows\v10.0 (the view picks WOW6432Node). */
  key: z.string().min(1).max(400),
  /** '' is the default value. */
  name: z.string().max(200),
  kind: z.enum(['string', 'expand', 'dword']),
  value: z.union([z.string().max(2000), z.number().int()]),
});
export type RegEntry = z.infer<typeof RegEntrySchema>;

export interface RegRead {
  readonly view: '64' | '32';
  readonly key: string;
  /** Only these values (null: every string and DWORD value). */
  readonly names: readonly string[] | null;
  readonly recurse: boolean;
}

/** The registry values that point at the saved folders, read in both views at capture time. */
export const REGISTRY_READS: readonly Omit<RegRead, 'view'>[] = [
  { key: 'SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots', names: ['KitsRoot10'], recurse: false },
  { key: 'SOFTWARE\\Microsoft\\Microsoft SDKs\\Windows\\v10.0', names: null, recurse: false },
  { key: 'SOFTWARE\\Microsoft\\Microsoft SDKs\\NETFXSDK', names: null, recurse: true },
  { key: 'SOFTWARE\\Microsoft\\VisualStudio\\Setup', names: null, recurse: false },
];
const VIEWS = ['64', '32'] as const;

export const VsPersistMarkerSchema = z.strictObject({
  product: z.enum(['community', 'buildtools']),
  /** The installed version (17.14.37827.9). */
  version: z.string().min(1).max(100),
  /** The component IDs it was installed with. */
  components: z.array(z.string().max(200)).max(500),
  instanceId: z.string().regex(INSTANCE_ID),
  /** Where the installer put it (the paths in its state and the registry are rewritten from this). */
  installationPath: z.string().min(3).max(400),
  /** The Windows SDK's ProductVersion (10.0.22621), '' when there is none. */
  sdkVersion: z.string().max(50),
  folders: z.array(z.enum(FOLDER_NAMES)).max(FOLDER_NAMES.length),
  /** The registry values as the installer wrote them (paths on C:). */
  registry: z.array(RegEntrySchema).max(500),
  capturedAt: z.string().max(50),
});
export type VsPersistMarker = z.infer<typeof VsPersistMarkerSchema>;

/** What save-visual-studio.ps1 writes to its result file. */
export const SaveResultSchema = z.strictObject({
  copied: z.array(z.enum(FOLDER_NAMES)).max(FOLDER_NAMES.length),
  registry: z.array(RegEntrySchema).max(500),
});
export type SaveResult = z.infer<typeof SaveResultSchema>;

/** Without these a saved copy is not usable (the product, its instance, the Setup API, vswhere, the SDK). */
const needed = (product: VsRequest['product']): FolderName[] => [
  productFolder(product),
  'instance',
  'Setup',
  'Installer',
  'WindowsKits10',
];

/**
 * Whether the saved copy serves this request: the same product with every component, or Community for a Build Tools
 * request (it holds the same C++ parts; only the workload IDs differ).
 */
export function persistCovers(marker: VsPersistMarker, req: Pick<VsRequest, 'product' | 'components'>): boolean {
  const same = marker.product === req.product;
  if (!same && !(marker.product === 'community' && req.product === 'buildtools')) return false;
  if (!needed(marker.product).every((f) => marker.folders.includes(f))) return false;
  const have = new Set(marker.components.map((c) => c.toLowerCase()));
  return req.components.filter((id) => same || !/\.workload\./i.test(id)).every((id) => have.has(id.toLowerCase()));
}

/** A string as it appears inside a JSON string (backslashes doubled). */
const jsonEscaped = (s: string): string => JSON.stringify(s).slice(1, -1);

/**
 * The instance's state.json with every mention of the install folder (JSON-escaped, any case) moved to `to`. A longer
 * folder name that only starts the same (Community2) is left alone.
 */
export function rewriteInstanceState(text: string, from: string, to: string): string {
  const needle = jsonEscaped(win.normalize(from).replace(/\\+$/, ''));
  const replacement = jsonEscaped(win.normalize(to).replace(/\\+$/, ''));
  const lower = text.toLowerCase();
  const find = needle.toLowerCase();
  let out = '';
  let at = 0;
  for (let i = lower.indexOf(find); i !== -1; i = lower.indexOf(find, i + find.length)) {
    const next = text.slice(i + find.length, i + find.length + 2);
    if (next !== '\\\\' && !next.startsWith('"')) continue;
    out += text.slice(at, i) + replacement;
    at = i + find.length;
  }
  return out + text.slice(at);
}

/** `value` with a saved folder's old place swapped for its place on the data disk (case-insensitive prefix). */
export function rebase(value: string, moves: readonly { from: string; to: string }[]): string {
  for (const move of moves) {
    const from = move.from.replace(/\\+$/, '');
    const lower = value.toLowerCase();
    if (lower === from.toLowerCase() || lower.startsWith(from.toLowerCase() + '\\'))
      return move.to.replace(/\\+$/, '') + value.slice(from.length);
  }
  return value;
}

/** Whether a registry value from the marker is one the capture reads (a tampered marker writes nothing else). */
const allowed = (entry: RegEntry): boolean =>
  REGISTRY_READS.some((read) => {
    const key = entry.key.toLowerCase();
    const root = read.key.toLowerCase();
    const under = key === root || (read.recurse && key.startsWith(root + '\\'));
    return under && (read.names === null || read.names.some((n) => n.toLowerCase() === entry.name.toLowerCase()));
  });

/** What the boot writes under HKLM: the saved values (paths moved to the data disk) in both views, the COM class. */
export function registryPlan(marker: VsPersistMarker, root: string, places: WinPlaces): RegEntry[] {
  const folders = persistFolders(marker, places).filter((f) => marker.folders.includes(f.name));
  const moves = folders
    .filter((f) => f.restore === 'stay')
    .map((f) => ({ from: f.source, to: win.join(root, f.name) }));
  const values = new Map<string, Omit<RegEntry, 'view'>>();
  const put = (e: Omit<RegEntry, 'view'>): void => {
    values.set(e.key.toLowerCase() + '|' + e.name.toLowerCase(), e);
  };
  for (const e of marker.registry.filter(allowed))
    put({
      key: e.key,
      name: e.name,
      kind: e.kind,
      value: typeof e.value === 'string' ? rebase(e.value, moves) : e.value,
    });
  if (marker.folders.includes('WindowsKits10')) {
    const kits = win.join(root, 'WindowsKits10') + '\\';
    const sdk = 'SOFTWARE\\Microsoft\\Microsoft SDKs\\Windows\\v10.0';
    put({ key: 'SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots', name: 'KitsRoot10', kind: 'string', value: kits });
    put({ key: sdk, name: 'InstallationFolder', kind: 'string', value: kits });
    if (marker.sdkVersion) put({ key: sdk, name: 'ProductVersion', kind: 'string', value: marker.sdkVersion });
  }
  const both = [...values.values()].flatMap((e) => VIEWS.map((view): RegEntry => ({ view, ...e })));
  const setup = win.join(places.programData, 'Microsoft', 'VisualStudio', 'Setup');
  const com = (view: '64' | '32', arch: string): RegEntry[] => {
    const key = 'SOFTWARE\\Classes\\CLSID\\' + SETUP_CLSID + '\\InprocServer32';
    return [
      { view, key, name: '', kind: 'string', value: win.join(setup, arch, SETUP_DLL) },
      { view, key, name: 'ThreadingModel', kind: 'string', value: 'Both' },
    ];
  };
  return [...both, ...com('64', 'x64'), ...com('32', 'x86')];
}

/** Compares dotted versions (17.14.37827.9) part by part, as numbers. */
function compareVersions(a: string, b: string): number {
  const x = a.split('.').map((p) => parseInt(p, 10) || 0);
  const y = b.split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/**
 * The newest of the instances vswhere lists. Chosen here, not with vswhere's -latest, which fails outright (0x8000FFFF)
 * when two instances have the same install date, as a copy of an instance does.
 */
export function newestInstance<T extends { readonly installationVersion?: string }>(instances: readonly T[]): T | null {
  return (
    [...instances].sort((a, b) => compareVersions(b.installationVersion ?? '', a.installationVersion ?? ''))[0] ?? null
  );
}

export interface SaveCopy {
  readonly name: FolderName;
  readonly from: string;
  readonly to: string;
  readonly optional: boolean;
}

/** The input of save-visual-studio.ps1: the folders to mirror onto the data disk and the registry values to read. */
export function saveInput(
  vs: { readonly product: VsRequest['product']; readonly installationPath: string; readonly instanceId: string },
  root: string,
  places: WinPlaces,
  resultFile: string,
): { copies: SaveCopy[]; registry: RegRead[]; resultFile: string } {
  return {
    copies: persistFolders(vs, places).map((f) => ({
      name: f.name,
      from: f.source,
      to: win.join(root, f.name),
      optional: f.optional,
    })),
    registry: VIEWS.flatMap((view) => REGISTRY_READS.map((r) => ({ view, ...r }))),
    resultFile,
  };
}

/** The marker for a finished capture (written after the instance's state is rewritten). */
export function markerFrom(
  req: Pick<VsRequest, 'product' | 'components'>,
  vs: { readonly installationPath: string; readonly instanceId: string; readonly version: string },
  result: SaveResult,
  capturedAt: string,
): VsPersistMarker {
  const sdk = result.registry.find(
    (e) => /\\Microsoft SDKs\\Windows\\v10\.0$/i.test(e.key) && e.name.toLowerCase() === 'productversion',
  );
  return {
    product: req.product,
    version: vs.version,
    components: [...req.components],
    instanceId: vs.instanceId,
    installationPath: vs.installationPath,
    sdkVersion: typeof sdk?.value === 'string' ? sdk.value : '',
    folders: [...result.copied],
    registry: [...result.registry],
    capturedAt,
  };
}

export interface RestoreCopy {
  readonly name: FolderName;
  readonly from: string;
  readonly to: string;
  /** 'all': what differs is copied; 'missing': each subfolder only when the target has none. */
  readonly mode: 'all' | 'missing';
}

/** The input of restore-visual-studio.ps1: the folders copied back to their fixed places, then the registry values. */
export function restoreInput(
  marker: VsPersistMarker,
  root: string,
  places: WinPlaces,
): { copies: RestoreCopy[]; registry: RegEntry[] } {
  const copies = persistFolders(marker, places)
    .filter((f) => f.restore !== 'stay' && marker.folders.includes(f.name))
    .map((f): RestoreCopy => ({
      name: f.name,
      from: win.join(root, f.name),
      to: f.source,
      mode: f.restore === 'copy-missing' ? 'missing' : 'all',
    }));
  return { copies, registry: registryPlan(marker, root, places) };
}
