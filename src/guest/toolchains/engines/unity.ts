// Unity (toolchains.unity), for each project: the Unity CLI on PATH (pinned, checked), every editor the sandbox has
// (this PC's, read-only, and the data disk's) registered with it, the editor the project's ProjectVersion.txt names
// (installed on the data disk when nothing has that exact version), UNITY_EDITOR, the Asset Store cache, the licence,
// Unity Hub when asked and the agent's MCP server and skills. Machine-wide writes only add; a project that joins
// later only adds its own editor choice. A project is never opened or changed here.
import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile } from '../../../shared/io/bounded.js';
import {
  chooseEditor,
  editorsAddArgs,
  findEditors,
  installArgs,
  installModulesArgs,
  installNeedBytes,
  installPathArgs,
  unitySummaryLine,
  wantedVersion,
  type UnityEditor,
  type UnityFs,
  type WantedEditor,
} from '../../../shared/unity/index.js';
import type { Toolchains } from '../../../core/types.js';
import { errMsg } from '../../../core/util/errors.js';
import { activateUnityLicence } from '../../accounts/kinds/unity.js';
import { exists, mkdirp } from '../../runtime/fs.js';
import { log, warn } from '../../runtime/log.js';
import { dryRun } from '../../runtime/paths.js';
import { heavy } from '../../runtime/pools.js';
import { runScriptWithJsonAsync } from '../../runtime/process.js';
import { projectWorkspace } from '../../runtime/project-context.js';
import { session } from '../../runtime/session.js';
import { setupUnityAgentTools } from '../../setup/unity-agent.js';
import { ensurePersisted, installRecords } from '../persisted.js';
import type { ToolCtx } from '../step.js';
import type { ToolEnv } from '../tool-env.js';
import { ensureUnityCli, runUnityCli, runUnityCliChecked, type UnityCli } from './unity-cli.js';
import { ensureUnityHub } from './unity-hub.js';
import { findUnityRelease } from './unity-release.js';
import { ASSET_DIR, EDITORS_DIR, readUnityStatus, updateUnityStatus } from './unity-status.js';

const MAX_PROJECT_VERSION_BYTES = 64 * 1024;
const MARKER = 'Editor\\Unity.exe';
const TERMS = 'https://unity.com/legal/terms-of-service';
const FALLBACK_NEED_BYTES = 15 * 1024 ** 3;

/** The real disk, for the editor search. */
const DISK: UnityFs = {
  exists: (file) => exists(file),
  list: (dir) => {
    try {
      return fs.readdirSync(dir).slice(0, 500);
    } catch {
      return []; // Not a folder: nothing in it.
    }
  },
};

/** This PC's editors the host mapped (session.json's pcInstalls; the id is the version). */
function mappedEditors(ctx: Pick<ToolCtx, 'pcInstalls'>): { guest: string; id: string }[] {
  return ctx.pcInstalls.items.filter((i) => i.kind === 'unity').map((i) => ({ guest: i.guest, id: i.id }));
}

/** Every editor this sandbox has. */
export function sandboxEditors(ctx: Pick<ToolCtx, 'pcInstalls'>): UnityEditor[] {
  return findEditors({ mapped: mappedEditors(ctx), dataRoot: EDITORS_DIR }, DISK);
}

/**
 * The editor a project asks for: its ProjectVersion.txt (read bounded) always wins, since opening a project in another
 * version upgrades its files; the version the setting names is only for folders without one.
 */
export function wantedEditor(config: Pick<Toolchains['unity'], 'version'>, workspace: string): WantedEditor | null {
  const file = path.join(workspace, 'ProjectSettings', 'ProjectVersion.txt');
  const bytes = readBoundedFile(file, MAX_PROJECT_VERSION_BYTES);
  return wantedVersion(bytes ? bytes.toString('utf8') : null, config.version);
}

/** Whether the project's editor is already here (a first install goes to the background). */
export function unityEditorSaved(config: Toolchains['unity'], ctx: Pick<ToolCtx, 'pcInstalls'>): boolean {
  const wanted = wantedEditor(config, projectWorkspace());
  if (!wanted) return true;
  return sandboxEditors(ctx).some((e) => e.version === wanted.version);
}

function sizeOf(e: UnityEditor): number | null {
  if (e.origin !== 'data') return null;
  return installRecords().find((r) => r.name === 'unity/editors' && r.version === e.version)?.sizeBytes ?? null;
}

const statusEditor = (e: UnityEditor) => ({
  version: e.version,
  root: e.root,
  origin: e.origin,
  writable: e.writable,
  modules: [...e.modules],
  sizeBytes: sizeOf(e),
});

/**
 * Installs one editor version on the data disk with the CLI (into a staging folder with TEMP inside it) and returns its
 * folder. One heavy slot while the CLI runs.
 */
export async function ensureUnityEditor(
  cli: UnityCli,
  version: string,
  changeset: string | null,
  modules: readonly string[],
  keepVersions: number,
): Promise<string> {
  const release = await findUnityRelease(version);
  const cs = changeset ?? release?.changeset ?? null;
  const need = release ? installNeedBytes(release, modules) : FALLBACK_NEED_BYTES;
  const installed = await ensurePersisted(
    { name: 'unity/editors', version, needBytes: need, marker: MARKER, what: 'Unity ' + version, keepVersions },
    async (staging, temp) => {
      log('Installing Unity ' + version + ' on the data disk (several GB; this takes a while) ...');
      await heavy.run(() => runUnityCliChecked(cli.exe, installArgs(version, cs, modules, staging), { temp }));
    },
  );
  return installed.dir;
}

/** Adds modules to an editor on the data disk. */
async function addModules(cli: UnityCli, editor: UnityEditor, modules: readonly string[]): Promise<void> {
  const temp = path.join(editor.root, '.temp');
  mkdirp(temp);
  try {
    log('Adding to Unity ' + editor.version + ': ' + modules.join(', ') + ' ...');
    const args = installModulesArgs(editor.version, modules, editor.root);
    await heavy.run(() => runUnityCliChecked(cli.exe, args, { temp }));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** While the sandbox runs: lists the editors again (the user may have installed one with Hub) for the status. */
export function captureUnityEditors(): Promise<void> {
  const unity = session.toolchains.unity;
  if (dryRun || unity.enabled !== true || !exists(EDITORS_DIR)) return Promise.resolve();
  const editors = sandboxEditors({ pcInstalls: session.pcInstalls ?? { items: [] } });
  const describe = (list: readonly { root: string; modules: readonly string[] }[]): string =>
    list.map((e) => e.root + '|' + e.modules.join(',')).join(';');
  if (describe(editors) !== describe(readUnityStatus().editors))
    updateUnityStatus((s) => ({ ...s, editors: editors.slice(0, 32).map(statusEditor) }));
  return Promise.resolve();
}

/** The editors, the project's choice, the CLI, the licence, the asset cache: set up and written to the status. */
export async function setupUnity(env: ToolEnv, config: Toolchains['unity'], ctx: ToolCtx): Promise<void> {
  if (!config.acceptLicense)
    throw new Error(
      'Unity is set up only with toolchains.unity.acceptLicense = true: you accept the Unity terms of service (' +
        TERMS +
        ') and the editor needs a Unity licence (Personal is free).',
    );
  const workspace = projectWorkspace();
  if (dryRun) {
    log('(dry run) would set up Unity ' + config.version + ' for ' + workspace);
    return;
  }
  const cli = await ensureUnityCli(config.cliVersion);
  env.prepend.push(path.dirname(cli.exe));
  let problem: string | null = null;
  const quiet = (what: string) => (e: unknown) => warn('Unity CLI: ' + what + ' (' + errMsg(e) + ')');
  // Settings that only keep the CLI quiet: a failure is not worth stopping for.
  await runUnityCli(cli.exe, ['config', 'update-check', 'off'], { timeoutMs: 60_000 }).catch(quiet('update-check'));
  await runUnityCli(cli.exe, ['analytics', 'opt-out'], { timeoutMs: 60_000 }).catch(quiet('analytics'));
  mkdirp(EDITORS_DIR);
  await runUnityCli(cli.exe, installPathArgs(EDITORS_DIR), { timeoutMs: 60_000 }).catch(quiet('install-path'));

  let editors = sandboxEditors(ctx);
  if (editors.length)
    await runUnityCli(cli.exe, editorsAddArgs(editors.map((e) => e.root)), { timeoutMs: 120_000 }).catch(
      quiet('editors add'),
    );

  const wanted = wantedEditor(config, workspace);
  let choice = chooseEditor(editors, wanted, config.modules, true);
  const install = choice.install;
  if (install) {
    try {
      const { version, changeset } = install;
      await ensureUnityEditor(cli, version, changeset, config.modules, config.keepVersions);
      editors = sandboxEditors(ctx);
      choice = chooseEditor(editors, wanted, config.modules, true);
    } catch (e) {
      problem = 'Unity ' + install.version + ' was not installed: ' + errMsg(e);
      warn(problem);
    }
  }
  let editor = choice.editor;
  if (editor) {
    const have = editor.modules;
    const lack = config.modules.filter((m) => !have.includes(m));
    if (lack.length && editor.writable) {
      try {
        await addModules(cli, editor, lack);
        editors = sandboxEditors(ctx);
        const root = editor.root;
        editor = editors.find((e) => e.root === root) ?? editor;
      } catch (e) {
        problem = 'Unity modules were not added: ' + errMsg(e);
        warn(problem);
      }
    } else if (lack.length) {
      problem =
        'Unity ' +
        editor.version +
        ' from this PC has no ' +
        lack[0] +
        " module: add it with Unity Hub on your PC, or remove that editor from This PC's editors to install one here.";
      warn(problem);
    }
    env.vars.UNITY_EDITOR = editor.exe;
  }

  // The Asset Store cache: where downloads made here go (HKCU too, so an editor started from Explorer agrees).
  // For "pc" the mapped Asset Store folder (guest of the unity-assets item) sits inside the cache root.
  const pcAssets = ctx.pcInstalls.items.filter((i) => i.kind === 'unity-assets').map((i) => i.guest);
  let cacheDir: string | null = null;
  if (config.assetCache === 'persisted') cacheDir = mkdirp(ASSET_DIR);
  else if (config.assetCache === 'pc' && pcAssets[0]) cacheDir = path.win32.dirname(pcAssets[0]);
  if (cacheDir) {
    env.vars.ASSETSTORE_CACHE_PATH = cacheDir;
    if (!ctx.duringSession)
      await runScriptWithJsonAsync('set-registry-values.ps1', 'PlanFile', {
        values: [{ hive: 'HKCU', key: 'Environment', name: 'ASSETSTORE_CACHE_PATH', value: cacheDir }],
      }).catch((e: unknown) => warn('Unity: the Asset Store cache was not set for Explorer (' + errMsg(e) + ')'));
  }

  const licence = await activateUnityLicence({ editorExe: editor?.exe ?? null, unityExe: cli.exe }).catch(
    (e: unknown) => {
      warn('Unity licence: ' + errMsg(e));
      return readUnityStatus().licence;
    },
  );

  let hub = readUnityStatus().hub;
  if (config.hub)
    try {
      hub = { installed: true, path: await ensureUnityHub() };
    } catch (e) {
      warn('Unity Hub was not installed: ' + errMsg(e));
    }

  const agent = await setupUnityAgentTools({
    unityExe: cli.exe,
    projectPath: workspace,
    mcp: config.mcp,
    skills: config.agentSkills,
  }).catch((e: unknown) => {
    warn('Unity agent tools: ' + errMsg(e));
    return { mcp: null, skills: false };
  });

  const chosen = editor;
  const status = updateUnityStatus((s) => {
    const mine = s.projects.find((p) => p.workspace.toLowerCase() === workspace.toLowerCase());
    return {
      ...s,
      cli: { version: cli.version, path: cli.exe },
      editors: editors.slice(0, 32).map(statusEditor),
      projects: [
        ...s.projects.filter((p) => p !== mine),
        {
          workspace,
          version: wanted?.version ?? null,
          editor: chosen?.root ?? null,
          reason: choice.reason,
          bridge: mine?.bridge ?? null,
        },
      ].slice(-64),
      licence,
      assetCache: { mode: config.assetCache, dir: cacheDir },
      pcAssets: pcAssets.slice(0, 4),
      hub,
      mcp: agent.mcp ?? (ctx.duringSession ? s.mcp : null),
      skills: agent.skills || (ctx.duringSession && s.skills),
      problem,
    };
  });
  env.summary.push(unitySummaryLine(status, workspace));
  log(
    'Unity: ' +
      editors.length +
      ' editor(s); ' +
      (editor ? editor.version + ' at ' + editor.root : 'none for this project') +
      ' (' +
      choice.reason +
      ')',
  );
}
