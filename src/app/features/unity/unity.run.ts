// The Unity area's work: what the sandbox last found (tools\unity\status.json, written by the guest, so it is read with
// its schema and its text made safe), what this PC has that the next sandbox maps (its editors and Asset Store
// downloads: bounded reads), opening Unity Hub and signing in (exec requests in the running sandbox) and adding or
// removing the editor bridge in a project's Packages/manifest.json (only on request, after a confirmation).
import fs from 'node:fs';
import path from 'node:path';
import { humanBytes } from '../../../core/disk.js';
import { assertNoLinks, errMsg, fail, safeText } from '../../../core/util/index.js';
import { type Context } from '../../../cli/commands/context.js';
import { ProjectsService } from '../../../cli/services/projects-service.js';
import { SandboxChannel } from '../../../host/channel/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { pcEnv } from '../../../host/accounts/index.js';
import {
  assetCacheEnv,
  findUnityEditorsOnPc,
  unityAssetCacheDirs,
  unityPcFiles,
} from '../../../host/pc-installs/unity.js';
import { readBoundedFile, readValid, writeFileAtomic } from '../../../shared/io/index.js';
import { RunDir } from '../../../shared/channel/index.js';
import {
  assetPackages,
  bridgeOf,
  COPLAY_PACKAGE_URL,
  DEFAULT_PIPELINE_VERSION,
  ORIGIN_LABELS,
  parseProjectVersion,
  supportsPipeline,
  UNITY_STATUS_FILE,
  UnityStatusSchema,
  withBridge,
  type AssetFs,
  type Bridge,
  type UnityStatus,
} from '../../../shared/unity/index.js';
import { implement } from '../../context.js';
import {
  addEditorBridge,
  openUnityHub,
  removeEditorBridge,
  unityOverview,
  unitySignIn,
  type UnityOverview,
} from './unity.def.js';

const win = path.win32;
const MAX_PACKAGES_SHOWN = 40;
const MAX_MANIFEST_READ = 1024 * 1024 + 1;
const PIPELINE_INDEX_URL = 'https://packages.unity.com/com.unity.pipeline';
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const GUEST_EXPLORER = 'C:\\Windows\\explorer.exe';
const SEMVER = /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.-]{1,50})?(\+[0-9A-Za-z.-]{1,50})?$/;

const s = (text: string): string => safeText(text);
const sn = (text: string | null): string | null => (text === null ? null : safeText(text));

export function readStatus(dataPath: string): UnityStatus | null {
  const file = path.join(dataPath, 'tools', 'unity', UNITY_STATUS_FILE);
  try {
    assertNoLinks(dataPath, file);
  } catch {
    return null; // A link under the data folder: never followed.
  }
  return readValid(UnityStatusSchema, file);
}

const settingText = (v: unknown): string => (Array.isArray(v) ? v.join(', ') || 'none' : String(v));

/** What this PC has for the next sandbox. */
export interface PcLook {
  readonly editors: UnityOverview['pc']['editors'];
  readonly assets: UnityOverview['assets']['folders'];
}

/** The project folders of this PC known to the tool, by their folder name (for the bridge buttons). */
export type HostFolders = readonly string[];

/** The overview from the sandbox's status and this PC's own look (no sandbox needed). */
export function unityOverviewOf(
  ctx: Context,
  status: UnityStatus | null,
  pcLook: () => PcLook,
  hostFolders: HostFolders = [],
): UnityOverview {
  const config = ctx.loaded.config;
  let pc: PcLook = { editors: [], assets: [] };
  let problem: string | null = null;
  try {
    pc = pcLook();
  } catch (e) {
    problem = 'Could not look at this PC: ' + errMsg(e);
  }
  const u = config.toolchains.unity;
  const hostFolderOf = (workspace: string): string | null => {
    const name = win.basename(workspace).toLowerCase();
    const same = hostFolders.filter((f) => win.basename(f).toLowerCase() === name);
    return same.length === 1 ? same[0] : null;
  };
  const editorLabel = (root: string | null): string | null => {
    if (root === null) return null;
    const e = status?.editors.find((x) => x.root.toLowerCase() === root.toLowerCase());
    return s(e ? 'Unity ' + e.version : root);
  };
  return {
    setUp: status !== null,
    checkedAt: status ? s(status.updatedAt) : null,
    cli: status?.cli ? { version: s(status.cli.version), path: s(status.cli.path) } : null,
    editors: (status?.editors ?? []).map((e) => ({
      version: s(e.version),
      dir: s(e.root),
      where: ORIGIN_LABELS[e.origin],
      writable: e.writable,
      modules: e.modules.map(s),
      sizeBytes: e.sizeBytes,
      projects: (status?.projects ?? [])
        .filter((p) => p.editor?.toLowerCase() === e.root.toLowerCase())
        .map((p) => s(win.basename(p.workspace))),
    })),
    projects: (status?.projects ?? []).map((p) => ({
      project: s(win.basename(p.workspace)),
      folder: hostFolderOf(p.workspace),
      version: sn(p.version),
      editor: editorLabel(p.editor),
      reason: s(p.reason),
      bridge: p.bridge,
      pipeline: p.version !== null && supportsPipeline(p.version),
    })),
    licence: {
      state: status?.licence.state ?? 'unknown',
      kind: s(status?.licence.kind ?? ''),
      detail: s(status?.licence.detail ?? ''),
      user: sn(status?.licence.user ?? null),
    },
    hub: { installed: status?.hub.installed ?? false, setting: u.hub },
    assetCache: { mode: status?.assetCache.mode ?? u.assetCache, dir: sn(status?.assetCache.dir ?? null) },
    agentTools: {
      cliVersion: u.cliVersion,
      mcp: sn(status?.mcp ?? null),
      mcpSetting: u.mcp,
      skills: status?.skills ?? false,
      skillsSetting: u.agentSkills,
    },
    pc: { setting: settingText(config.pcInstalls.unityEditors), editors: pc.editors, problem },
    assets: { setting: settingText(config.pcInstalls.unityAssets), folders: pc.assets },
    problem: sn(status?.problem ?? null),
    settings: {
      enabled: settingText(u.enabled),
      acceptLicense: u.acceptLicense,
      version: u.version,
      modules: settingText(u.modules),
      hub: u.hub,
      keepVersions: u.keepVersions,
      mcp: u.mcp,
      agentSkills: u.agentSkills,
      cliVersion: u.cliVersion,
      assetCache: u.assetCache,
    },
  };
}

/** This PC's disk for the packages (bounded lists). */
export const PC_ASSET_FS: AssetFs = {
  list: (dir) => {
    try {
      return fs.readdirSync(dir).slice(0, 5000);
    } catch {
      return []; // Not a folder: nothing in it.
    }
  },
  isDir: (dir) => {
    try {
      return fs.lstatSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
  size: (file) => {
    try {
      const st = fs.lstatSync(file);
      return st.isFile() ? st.size : null;
    } catch {
      return null;
    }
  },
};

/** What this PC has for the next sandbox: its editors and its Asset Store packages. */
function lookAtPc(ctx: Context): PcLook {
  const config = ctx.loaded.config.pcInstalls;
  const pc = pcEnv();
  const files = unityPcFiles(pc);
  const editors =
    config.unityEditors === false
      ? []
      : findUnityEditorsOnPc(files, Array.isArray(config.unityEditors) ? config.unityEditors.map(String) : true).map(
          (e) => ({ version: e.id, folder: e.host }),
        );
  const assets =
    config.unityAssets === false
      ? []
      : unityAssetCacheDirs(files, assetCacheEnv(pc)).map((folder) => {
          const packages = assetPackages(folder, PC_ASSET_FS);
          return {
            folder,
            packages: packages.slice(0, MAX_PACKAGES_SHOWN).map((p) => ({
              publisher: p.publisher,
              category: p.category,
              name: p.name,
              size: humanBytes(p.sizeBytes),
            })),
            more: Math.max(0, packages.length - MAX_PACKAGES_SHOWN),
          };
        });
  return { editors, assets };
}

export const unityOverviewRun = implement(unityOverview, async (ctx) => {
  let hostFolders: string[] = [];
  try {
    hostFolders = (await new ProjectsService(ctx).list()).projects.map((p) => p.folder);
  } catch {
    // No project list: the page shows the projects without bridge buttons.
  }
  return unityOverviewOf(ctx, readStatus(ctx.dataPath), () => lookAtPc(ctx), hostFolders);
});

// ---- Unity Hub and sign-in (the running sandbox) ----

async function inSandbox(ctx: Context, argv: string[], seconds: number): Promise<void> {
  if (!isSandboxRunning()) fail('No sandbox is running.', 'Start one for a Unity project; Unity opens in its window.');
  const status = new RunDir(ctx.dataPath).readSandboxStatus();
  if (status?.phase !== 'ready') fail('The sandbox is not ready yet.', 'Try again in a moment.');
  const result = await new SandboxChannel(ctx.dataPath).exec(argv, status.guestWorkspace ?? 'C:\\', seconds);
  // explorer.exe returns 1 even when it started the program.
  if (!result.ok && !(argv[0] === GUEST_EXPLORER && result.exitCode === 1))
    fail('The sandbox could not do it: ' + safeText(result.message));
}

export const openUnityHubRun = implement(openUnityHub, async (ctx, _input, io) => {
  const hub = readStatus(ctx.dataPath)?.hub;
  if (!hub?.installed || !hub.path)
    fail('Unity Hub is not installed in this sandbox.', 'Turn on Unity Hub in the Unity set-up settings and restart.');
  io.progress('Opening Unity Hub in the sandbox…');
  await inSandbox(ctx, [GUEST_EXPLORER, hub.path], 30);
  return {
    message: 'Unity Hub opens in the sandbox window. Sign in once; the licence is kept for the next sandboxes.',
  };
});

export const unitySignInRun = implement(unitySignIn, async (ctx, _input, io) => {
  const status = readStatus(ctx.dataPath);
  io.progress('Opening the Unity sign-in in the sandbox…');
  if (status?.hub.installed && status.hub.path) await inSandbox(ctx, [GUEST_EXPLORER, status.hub.path], 30);
  else if (status?.cli) await inSandbox(ctx, [status.cli.path, 'auth', 'login'], 300);
  else fail('Unity is not set up in a sandbox yet.', 'Start a sandbox for a Unity project first.');
  return { message: 'Sign in in the sandbox window; the licence is kept for the next sandboxes.' };
});

// ---- The editor bridge ----

/** The newest Unity Pipeline package version, from Unity's package registry (bounded, checked as a version). */
export async function latestPipelineVersion(fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(PIPELINE_INDEX_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Unity answered ' + response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Unity sent nothing');
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_INDEX_BYTES) {
      await reader.cancel();
      throw new Error('the package list is over 2 MB');
    }
    chunks.push(Buffer.from(value));
  }
  const json: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const latest = (json as { 'dist-tags'?: { latest?: unknown } } | null)?.['dist-tags']?.latest;
  if (typeof latest !== 'string' || !SEMVER.test(latest)) throw new Error('no usable version in the package list');
  return latest;
}

/** A project of this PC: its manifest file and the editor version it asks for. */
export function unityProjectProblem(dir: string): string | null {
  if (!win.isAbsolute(dir)) return 'Give the full path of the Unity project folder.';
  const version = readBoundedFile(win.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 64 * 1024);
  if (!version || !parseProjectVersion(version.toString('utf8')))
    return dir + ' is not a Unity project (no ProjectSettings\\ProjectVersion.txt).';
  return readBoundedFile(win.join(dir, 'Packages', 'manifest.json'), MAX_MANIFEST_READ)
    ? null
    : dir + ' has no Packages\\manifest.json.';
}

export interface BridgeEdit {
  readonly file: string;
  readonly message: string;
}

export interface BridgeHooks {
  /** The newest Unity Pipeline version (the self-test passes a fixed one: no network). */
  readonly pipelineVersion: () => Promise<string>;
  /** Asks before the file is changed; false leaves it alone. */
  readonly confirm: (file: string, what: string) => Promise<boolean>;
}

function manifestOf(dir: string): { file: string; text: string; unity: string } {
  const problem = unityProjectProblem(dir);
  if (problem) fail(problem, 'Pick the folder that has ProjectSettings and Packages in it.');
  const file = win.join(dir, 'Packages', 'manifest.json');
  assertNoLinks(dir, file);
  const text = readBoundedFile(file, MAX_MANIFEST_READ)!.toString('utf8');
  const version = parseProjectVersion(
    readBoundedFile(win.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 64 * 1024)!.toString('utf8'),
  )!;
  return { file, text, unity: version.version };
}

/** Adds the editor bridge to a project's manifest after the confirmation; the rest of the file is kept. */
export async function addBridgeToProject(
  dir: string,
  wanted: Bridge | undefined,
  hooks: BridgeHooks,
): Promise<BridgeEdit> {
  const { file, text, unity } = manifestOf(dir);
  const have = bridgeOf(text);
  if (have) return { file, message: win.basename(dir) + ' has the editor bridge already (' + bridgeName(have) + ').' };
  const pipeline = supportsPipeline(unity);
  const bridge: Bridge = wanted ?? (pipeline ? 'pipeline' : 'coplay');
  if (bridge === 'pipeline' && !pipeline)
    fail(
      'Unity ' + unity + ' cannot take the Unity Pipeline package.',
      'It needs Unity 6 or later: use the other bridge.',
    );
  let version = DEFAULT_PIPELINE_VERSION;
  let note = '';
  if (bridge === 'pipeline') {
    try {
      version = await hooks.pipelineVersion();
    } catch (e) {
      note = ' (could not ask Unity for the newest version: ' + errMsg(e) + '; used ' + version + ')';
    }
  }
  const what =
    bridge === 'pipeline'
      ? 'com.unity.pipeline ' + version
      : 'MCP for Unity (' + COPLAY_PACKAGE_URL.split('?')[0] + ')';
  if (!(await hooks.confirm(file, what))) return { file, message: 'Nothing was changed.' };
  writeFileAtomic(file, withBridge(text, bridge, true, version));
  return {
    file,
    message:
      'Added ' +
      what +
      ' to ' +
      file +
      note +
      '.' +
      (bridge === 'coplay' ? ' Turn on MCP for Unity in Apps so agents can reach it.' : ''),
  };
}

/** Takes the editor bridge out of a project's manifest after the confirmation. */
export async function removeBridgeFromProject(dir: string, hooks: Pick<BridgeHooks, 'confirm'>): Promise<BridgeEdit> {
  const { file, text } = manifestOf(dir);
  const have = bridgeOf(text);
  if (!have) return { file, message: win.basename(dir) + ' has no editor bridge.' };
  if (!(await hooks.confirm(file, 'remove ' + bridgeName(have)))) return { file, message: 'Nothing was changed.' };
  writeFileAtomic(file, withBridge(text, have, false));
  return { file, message: 'Removed ' + bridgeName(have) + ' from ' + file + '.' };
}

const bridgeName = (b: Bridge): string => (b === 'pipeline' ? 'Unity Pipeline' : 'MCP for Unity');

async function projectOf(
  ctx: Context,
  given: string | undefined,
  io: Parameters<Parameters<typeof implement>[1]>[2],
): Promise<string> {
  if (given) return win.resolve(given);
  let known: string[] = [];
  try {
    known = (await new ProjectsService(ctx).list()).projects
      .map((p) => p.folder)
      .filter((f) => unityProjectProblem(f) === null);
  } catch {
    // No project list: ask for the folder.
  }
  if (known.length === 1) return known[0];
  if (known.length > 1) {
    const picked = await io.choose({
      title: 'Which Unity project?',
      lines: [],
      choices: known.map((f) => ({ value: f, label: win.basename(f), hint: f })),
    });
    if (picked) return picked;
  }
  const dir = await io.path({
    title: 'Which Unity project folder?',
    lines: ['The folder that holds Assets, Packages and ProjectSettings.'],
    pathKind: 'dir',
    validate: (v) => unityProjectProblem(win.resolve(v)) ?? true,
  });
  if (!dir) fail('No folder given.', 'Nothing was changed.');
  return win.resolve(dir);
}

export const addBridgeRun = implement(addEditorBridge, async (ctx, input, io) => {
  const dir = await projectOf(ctx, input.project, io);
  const edit = await addBridgeToProject(dir, input.bridge, {
    pipelineVersion: () => latestPipelineVersion(),
    confirm: (file, what) =>
      io.confirm({
        title: 'Change the project?',
        lines: ['This adds ' + what + ' to ' + file + '.', 'Nothing else in the project changes.'],
        yes: 'Add',
      }),
  });
  return { message: edit.message };
});

export const removeBridgeRun = implement(removeEditorBridge, async (ctx, input, io) => {
  const dir = await projectOf(ctx, input.project, io);
  const edit = await removeBridgeFromProject(dir, {
    confirm: (file, what) =>
      io.confirm({ title: 'Change the project?', lines: ['This will ' + what + ' in ' + file + '.'], yes: 'Remove' }),
  });
  return { message: edit.message };
});
