// Unreal engines, for each project: every engine the sandbox has (this PC's, mapped read-only or as folders you
// registered; the launcher's and other folders in tools\unreal\engines; source builds in project roots) is registered
// (the registry, the launcher's LauncherInstalled.dat, the .uproject file association), and the engine the project's
// .uproject names (else the newest) goes on its PATH with UE_ROOT, the derived data cache on the data disk and, with
// Unreal 5.8's MCP plugin, the editor's MCP server in Claude Code. Machine-wide writes only add; a project that joins
// later only adds its own engine choice.
import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile } from '../../../shared/io/bounded.js';
import {
  chooseEngine,
  ddcVars,
  engineToolDirs,
  engineVars,
  fileAssociationPlan,
  findEngines,
  findUproject,
  hasMcpPlugin,
  incompleteDirs,
  itemSizes,
  launcherManifestsDir,
  launcherEntriesFor,
  registryPlan,
  UNREAL_MCP_URL,
  unrealSummaryLine,
  uprojectAssociation,
  versionSelectorIn,
  versionText,
  type EngineFs,
  type LauncherEntry,
  type MappedEngine,
  type UnrealEngine,
} from '../../../shared/unreal/index.js';
import type { Toolchains } from '../../../core/types.js';
import { errMsg } from '../../../core/util/errors.js';
import { exists, mkdirp } from '../../runtime/fs.js';
import { log, warn } from '../../runtime/log.js';
import { dryRun } from '../../runtime/paths.js';
import { runScriptWithJsonAsync } from '../../runtime/process.js';
import { projectWorkspace } from '../../runtime/project-context.js';
import { session } from '../../runtime/session.js';
import { setUnrealMcp, writeAddonMcpServers } from '../../setup/addon-mcp.js';
import type { ToolCtx } from '../step.js';
import type { ToolEnv } from '../tool-env.js';
import { saveLauncherState, savedEntries, writeLauncherEntries } from './epic-launcher.js';
import { DDC_DIR, ENGINES_DIR, SAVED_DIR, updateUnrealStatus } from './unreal-status.js';

const SAVED_MANIFESTS = path.join(SAVED_DIR, 'Manifests');

/** The real disk, read bounded. */
export const DISK: EngineFs = {
  exists: (file) => exists(file),
  read: (file, max) => readBoundedFile(file, max),
  list: (dir) => {
    try {
      return fs.readdirSync(dir).slice(0, 500);
    } catch {
      return []; // Not a folder: nothing in it.
    }
  },
};

/** This PC's engines the host mapped (session.json's pcInstalls). */
export function mappedEngines(ctx: Pick<ToolCtx, 'pcInstalls'>): MappedEngine[] {
  return ctx.pcInstalls.items
    .filter((i) => i.kind === 'unreal')
    .map((i) => ({
      guest: i.guest,
      id: i.id,
      ...(i.writable ? { writable: true } : {}),
      ...(i.buildId ? { buildId: i.buildId } : {}),
    }));
}

/** The project roots of this sandbox (their folders may hold source builds). */
function projectRoots(): string[] {
  const roots = (session.mappedProjects ?? []).filter((m) => m.root).map((m) => m.guest);
  return [...new Set([...roots, ...(session.roots ?? [])])].filter((r) => exists(r));
}

/** The engines the launcher installed in tools\unreal\engines (its saved manifests and entries name them). */
function launcherDirs(): string[] {
  return [...savedEntries().map((e) => e.InstallLocation), ...itemSizes(SAVED_MANIFESTS).keys()];
}

/** Every engine this sandbox has (an install the launcher has not finished is not one yet). */
export function sandboxEngines(ctx: Pick<ToolCtx, 'pcInstalls'>, disk: EngineFs = DISK): UnrealEngine[] {
  const incomplete = incompleteDirs(
    launcherManifestsDir(process.env.ProgramData ?? 'C:\\ProgramData'),
    SAVED_MANIFESTS,
  );
  return findEngines(
    {
      mapped: mappedEngines(ctx),
      enginesRoot: ENGINES_DIR,
      launcherDirs: launcherDirs(),
      projectRoots: projectRoots(),
    },
    disk,
  ).filter((e) => !incomplete.has(path.win32.normalize(e.dir).toLowerCase()));
}

/** The LauncherInstalled.dat entries for the installed builds: the launcher's own saved ones, else made from them. */
export function launcherEntries(engines: readonly UnrealEngine[], ctx: Pick<ToolCtx, 'pcInstalls'>): LauncherEntry[] {
  return launcherEntriesFor(engines, savedEntries(), ctx.pcInstalls.items);
}

/** Registers the engines machine-wide: the registry, LauncherInstalled.dat, the .uproject file association. */
export async function registerEngines(
  engines: readonly UnrealEngine[],
  selectorFrom: UnrealEngine | null,
  ctx: Pick<ToolCtx, 'pcInstalls'>,
  aliases: readonly { readonly id: string; readonly dir: string }[] = [],
): Promise<void> {
  const selector = selectorFrom ? versionSelectorIn(selectorFrom.dir) : null;
  const values = [
    ...registryPlan(engines, aliases),
    ...(selector && exists(selector) ? fileAssociationPlan(selector) : []),
  ];
  if (values.length) await runScriptWithJsonAsync('set-registry-values.ps1', 'PlanFile', { values });
  try {
    writeLauncherEntries(launcherEntries(engines, ctx));
  } catch (e) {
    warn("Unreal: the Epic Games Launcher's LauncherInstalled.dat was left as it is (" + errMsg(e) + ')');
  }
}

/**
 * While the sandbox runs (the daemon, every few minutes): saves what the launcher learned about engines it installed
 * on the data disk and, when something is new, registers them and lists them for the Unreal page.
 */
export async function captureLauncherEngines(): Promise<void> {
  const unreal = session.toolchains.unreal;
  if (dryRun || unreal.enabled !== true || !unreal.persistEngines || !saveLauncherState()) return;
  const ctx = { pcInstalls: session.pcInstalls ?? { items: [] } };
  const engines = sandboxEngines(ctx);
  await registerEngines(engines, engines[0] ?? null, ctx);
  const sizes = itemSizes(SAVED_MANIFESTS);
  updateUnrealStatus((s) => ({ ...s, engines: engines.map((e) => statusEngine(e, sizes)) }));
}

const statusEngine = (e: UnrealEngine, sizes: ReadonlyMap<string, number>) => ({
  id: e.id,
  dir: e.dir,
  version: versionText(e.version),
  build: e.build,
  origin: e.origin,
  writable: e.writable,
  sizeBytes: sizes.get(e.dir.toLowerCase()) ?? null,
});

/** The project's engine on PATH, its variables, the guide's facts; the engines registered. */
export async function setupUnrealEngines(env: ToolEnv, config: Toolchains['unreal'], ctx: ToolCtx): Promise<void> {
  const workspace = projectWorkspace();
  const engines = sandboxEngines(ctx);
  const uproject = findUproject(workspace, DISK);
  const text = uproject ? readBoundedFile(uproject, 1024 * 1024) : null;
  const association = (text ? uprojectAssociation(text.toString('utf8')) : null) ?? { kind: 'none' as const };
  const choice = chooseEngine(engines, association);
  const engine = choice.engine;
  if (dryRun) {
    log('(dry run) would register ' + engines.length + ' Unreal engines and use ' + (engine?.dir ?? 'none'));
    return;
  }
  try {
    await registerEngines(
      engines,
      engine ?? engines[0] ?? null,
      ctx,
      engine && choice.alias ? [{ id: choice.alias, dir: engine.dir }] : [],
    );
  } catch (e) {
    warn('Unreal: registering the engines failed (' + errMsg(e) + '); Build.bat and RunUAT.bat still work from PATH');
  }
  const ddc = config.derivedDataCache === 'persisted' ? mkdirp(DDC_DIR) : null;
  Object.assign(env.vars, ddcVars(config.derivedDataCache, DDC_DIR));
  if (engine) {
    env.prepend.push(...engineToolDirs(engine.dir, DISK));
    Object.assign(env.vars, engineVars(engine));
  }
  const mcp = engine && hasMcpPlugin(engine, DISK) ? UNREAL_MCP_URL : null;
  if (mcp || !ctx.duringSession) {
    setUnrealMcp(mcp);
    try {
      writeAddonMcpServers();
    } catch (e) {
      warn("Unreal: the editor's MCP server was not added to Claude Code (" + errMsg(e) + ')');
    }
  }
  const sizes = itemSizes(SAVED_MANIFESTS);
  const status = updateUnrealStatus((s) => ({
    ...s,
    engines: engines.map((e) => statusEngine(e, sizes)),
    projects: [
      ...s.projects.filter((p) => p.workspace.toLowerCase() !== workspace.toLowerCase()),
      { workspace, engine: engine?.dir ?? null, reason: choice.reason },
    ].slice(-64),
    ddc: { mode: config.derivedDataCache, dir: ddc },
    vaults: ctx.pcInstalls.items.filter((i) => i.kind === 'unreal-vault').map((i) => i.guest),
    mcpUrl: mcp ?? (ctx.duringSession ? s.mcpUrl : null),
  }));
  env.summary.push(unrealSummaryLine(status, workspace));
  log(
    'Unreal: ' +
      engines.length +
      ' engine(s); ' +
      (engine ? 'this project uses ' + engine.id + ' at ' + engine.dir : 'none for this project') +
      ' (' +
      choice.reason +
      ')',
  );
}
