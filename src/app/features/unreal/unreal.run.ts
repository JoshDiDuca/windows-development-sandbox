// The Unreal area's work: what the sandbox last found (tools\unreal\status.json, written by the guest, so it is read
// with its schema and its text made safe), what this PC has that the next sandbox maps (its engines, the folders you
// registered, the launcher's vault cache: bounded reads), registering an engine folder (pcInstalls.unrealEngineFolders)
// and opening the Epic Games Launcher in the running sandbox (an exec request).
import path from 'node:path';
import { humanBytes } from '../../../core/disk.js';
import { assertNoLinks, errMsg, fail, safeText } from '../../../core/util/index.js';
import { requireOnPc, type Context } from '../../../cli/commands/context.js';
import { SandboxChannel } from '../../../host/channel/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { pcEnv } from '../../../host/accounts/index.js';
import {
  findEngineFolders,
  findUnrealInstalls,
  pcSourceBuilds,
  unrealPcFiles,
} from '../../../host/pc-installs/unreal.js';
import { PC_VAULT_FS, vaultDirs } from '../../../host/pc-installs/unreal-vault.js';
import { readBoundedFile, readValid } from '../../../shared/io/index.js';
import { RunDir } from '../../../shared/channel/index.js';
import {
  ORIGIN_LABELS,
  parseBuildVersion,
  UNREAL_STATUS_FILE,
  UnrealStatusSchema,
  vaultPacks,
  versionText,
  type UnrealStatus,
} from '../../../shared/unreal/index.js';
import { implement } from '../../context.js';
import { ConfigFile } from '../settings/index.js';
import {
  forgetEngineFolder,
  openEpicLauncher,
  registerEngineFolder,
  unrealOverview,
  type UnrealOverview,
} from './unreal.def.js';

const win = path.win32;
/** The launcher the sandbox installs (the 64-bit one of launcher 17 and later). */
const GUEST_LAUNCHER = 'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe';
const MAX_PACKS_SHOWN = 40;

const s = (text: string): string => safeText(text);
const sn = (text: string | null): string | null => (text === null ? null : safeText(text));

export function readStatus(dataPath: string): UnrealStatus | null {
  const file = path.join(dataPath, 'tools', 'unreal', UNREAL_STATUS_FILE);
  try {
    assertNoLinks(dataPath, file);
  } catch {
    return null; // A link under the data folder: never followed.
  }
  return readValid(UnrealStatusSchema, file);
}

const settingText = (v: unknown): string => (Array.isArray(v) ? v.join(', ') || 'none' : String(v));

/** The overview from the sandbox's status and this PC's own look (no sandbox needed). */
export function unrealOverviewOf(
  ctx: Context,
  status: UnrealStatus | null,
  pcLook: () => { engines: UnrealOverview['pc']['engines']; vault: UnrealOverview['vault']['folders'] },
): UnrealOverview {
  const config = ctx.loaded.config;
  let pc: ReturnType<typeof pcLook> = { engines: [], vault: [] };
  let problem: string | null = null;
  try {
    pc = pcLook();
  } catch (e) {
    problem = 'Could not look at this PC: ' + errMsg(e);
  }
  const projects = (status?.projects ?? []).map((p) => ({
    project: s(win.basename(p.workspace)),
    engine: p.engine === null ? null : s(status?.engines.find((e) => e.dir === p.engine)?.id ?? p.engine),
    reason: s(p.reason),
  }));
  return {
    setUp: status !== null,
    checkedAt: status ? s(status.updatedAt) : null,
    engines: (status?.engines ?? []).map((e) => ({
      id: s(e.id),
      version: s(e.version),
      dir: s(e.dir),
      where: ORIGIN_LABELS[e.origin],
      writable: e.writable,
      build: e.build,
      sizeBytes: e.sizeBytes,
      projects: (status?.projects ?? [])
        .filter((p) => p.engine?.toLowerCase() === e.dir.toLowerCase())
        .map((p) => s(win.basename(p.workspace))),
    })),
    projects,
    launcher: {
      installed: status?.launcher.installed ?? false,
      installLocation: sn(status?.launcher.installLocation ?? null),
      problem: sn(status?.launcher.problem ?? null),
      free: status?.launcher.freeBytes ? humanBytes(status.launcher.freeBytes) : null,
    },
    visualStudio: {
      version: s(status?.visualStudio.version ?? ''),
      path: s(status?.visualStudio.path ?? ''),
      how: s(status?.visualStudio.how ?? ''),
      check: s(status?.visualStudio.check ?? ''),
      ok: status?.visualStudio.ok ?? false,
    },
    debugger: sn(status?.debugger ?? null),
    ddc: sn(status?.ddc.dir ?? null),
    mcpUrl: sn(status?.mcpUrl ?? null),
    pc: { setting: settingText(config.pcInstalls.unrealEngines), engines: pc.engines, problem },
    vault: { setting: settingText(config.pcInstalls.unrealAssets), folders: pc.vault },
    settings: {
      enabled: settingText(config.toolchains.unreal.enabled),
      acceptLicense: config.toolchains.unreal.acceptLicense,
      persistEngines: config.toolchains.unreal.persistEngines,
      derivedDataCache: config.toolchains.unreal.derivedDataCache,
      visualStudio: config.toolchains.unreal.visualStudio,
    },
  };
}

/** What this PC has for the next sandbox: its engines, the registered folders, its vault packs. */
function lookAtPc(ctx: Context): ReturnType<Parameters<typeof unrealOverviewOf>[2]> {
  const config = ctx.loaded.config.pcInstalls;
  const pc = pcEnv();
  const files = unrealPcFiles(pc);
  const folders = findEngineFolders(files, config.unrealEngineFolders);
  const installs =
    config.unrealEngines === false
      ? []
      : findUnrealInstalls(files, Array.isArray(config.unrealEngines) ? config.unrealEngines : true);
  const engines = [
    ...folders,
    ...installs.filter((i) => !folders.some((f) => f.host.toLowerCase() === i.host.toLowerCase())),
  ].map((e) => ({
    id: e.id,
    name: e.name,
    folder: e.host,
    writable: e.writable === true,
    source: false,
  }));
  const loose = pcSourceBuilds(files)
    .filter((b) => !folders.some((f) => f.host.toLowerCase() === b.host.toLowerCase()))
    .map((b) => ({
      id: '',
      name: 'Unreal Engine ' + b.version + ' (source build)',
      folder: b.host,
      writable: false,
      source: true,
    }));
  const vault =
    config.unrealAssets === false
      ? []
      : vaultDirs(pc, PC_VAULT_FS.isDir).map((folder) => {
          const packs = vaultPacks(folder, PC_VAULT_FS);
          return {
            folder,
            packs: packs.slice(0, MAX_PACKS_SHOWN).map((p) => ({
              name: p.name,
              size: (p.partial ? 'at least ' : '') + humanBytes(p.sizeBytes),
              kind: p.kind,
            })),
            more: Math.max(0, packs.length - MAX_PACKS_SHOWN),
          };
        });
  return { engines: [...engines, ...loose], vault };
}

export const unrealOverviewRun = implement(unrealOverview, (ctx) =>
  unrealOverviewOf(ctx, readStatus(ctx.dataPath), () => lookAtPc(ctx)),
);

/** The engine in a folder of this PC, or a failure that says what is wrong. */
export function engineFolderProblem(folder: string, read: (file: string, max: number) => Buffer | null): string | null {
  if (!win.isAbsolute(folder)) return 'Give the full path of the engine folder (e.g. D:\\UnrealEngine).';
  const bytes = read(win.join(folder, 'Engine', 'Build', 'Build.version'), 64 * 1024);
  if (!bytes) return 'No Engine\\Build\\Build.version in ' + folder + ': that is not an Unreal Engine folder.';
  return parseBuildVersion(bytes.toString('utf8')) ? null : folder + '\\Engine\\Build\\Build.version is not readable.';
}

export const registerEngineFolderRun = implement(registerEngineFolder, async (ctx, input, io) => {
  requireOnPc('unreal add-engine');
  const folder =
    input.folder ??
    (await io.path({
      title: 'Which Unreal Engine folder?',
      lines: [
        'The folder that holds Engine\\Build\\Build.version (a source build, or a copy of an engine).',
        'The next sandbox maps it writable and registers it.',
      ],
      pathKind: 'dir',
      validate: (v) => engineFolderProblem(win.resolve(v), readBoundedFile) ?? true,
    }));
  if (!folder) fail('No folder given.', 'Nothing was changed.');
  const dir = win.resolve(folder);
  const problem = engineFolderProblem(dir, readBoundedFile);
  if (problem) fail(problem, 'Pick the folder that has Engine\\Build\\Build.version in it.');
  const file = ConfigFile.user(ctx.loaded.configPath);
  const now = file.userConfig().pcInstalls.unrealEngineFolders;
  if (now.some((f) => win.resolve(f).toLowerCase() === dir.toLowerCase()))
    return { message: dir + ' is registered already.' };
  if (now.length >= 8) fail('8 engine folders are registered already.', 'Forget one first.');
  const outcome = file.set(['pcInstalls', 'unrealEngineFolders'], [...now, dir]);
  if (typeof outcome === 'object') fail('Could not save the folder: ' + outcome.problems.join('; '));
  const v = parseBuildVersion(
    readBoundedFile(win.join(dir, 'Engine', 'Build', 'Build.version'), 64 * 1024)!.toString('utf8'),
  )!;
  return {
    message:
      'Registered Unreal Engine ' +
      versionText(v) +
      ' at ' +
      dir +
      '. The next sandbox maps it writable and registers it' +
      (isSandboxRunning() ? ' (restart the sandbox to get it now).' : '.'),
  };
});

export const forgetEngineFolderRun = implement(forgetEngineFolder, (ctx, input) => {
  requireOnPc('unreal forget-engine');
  const file = ConfigFile.user(ctx.loaded.configPath);
  const now = file.userConfig().pcInstalls.unrealEngineFolders;
  const dir = win.resolve(input.folder).toLowerCase();
  const left = now.filter((f) => win.resolve(f).toLowerCase() !== dir);
  if (left.length === now.length) return { message: input.folder + ' was not registered.' };
  const outcome = file.set(['pcInstalls', 'unrealEngineFolders'], left);
  if (typeof outcome === 'object') fail('Could not save: ' + outcome.problems.join('; '));
  return { message: 'Forgot ' + input.folder + '; the next sandbox does not map it (nothing on this PC was deleted).' };
});

export const openEpicLauncherRun = implement(openEpicLauncher, async (ctx, _input, io) => {
  requireOnPc('unreal launcher');
  if (!isSandboxRunning())
    fail('No sandbox is running.', 'Start one for a project with a .uproject; the launcher opens in its window.');
  const status = new RunDir(ctx.dataPath).readSandboxStatus();
  if (status?.phase !== 'ready') fail('The sandbox is not ready yet.', 'Try again in a moment.');
  if (!readStatus(ctx.dataPath)?.launcher.installed)
    fail(
      'The Epic Games Launcher is not installed in this sandbox.',
      'It is installed when the sandbox is set up for Unreal with the licence accepted (Unreal set-up settings).',
    );
  io.progress('Opening the Epic Games Launcher in the sandbox…');
  const result = await new SandboxChannel(ctx.dataPath).exec(
    ['C:\\Windows\\explorer.exe', GUEST_LAUNCHER],
    status.guestWorkspace ?? 'C:\\',
    30,
  );
  // explorer.exe returns 1 even when it started the program.
  if (!result.ok && result.exitCode !== 1) fail('The sandbox could not open it: ' + safeText(result.message));
  return {
    message: 'The Epic Games Launcher opens in the sandbox window. Sign in once; engines install to the data disk.',
  };
});
