// Unreal Engine: the engines the sandbox has (and which project uses which), the ones on this PC the next sandbox maps,
// this PC's asset vault, Visual Studio as UnrealBuildTool finds it, the debuggers, the derived data cache and the
// editor's MCP server; registering an engine folder of this PC and opening the Epic Games Launcher in the sandbox.
// Pure: schemas, labels and the view; unreal.run.ts reads the sandbox's tools\unreal\status.json and looks on this PC.
import { z } from 'zod';
import {
  action,
  bytesText,
  defineOperation,
  defineQuery,
  defineView,
  link,
  type Item,
  type Page,
  type Section,
} from '../../kernel/index.js';
import { browseFolder } from '../files/files.def.js';

const EngineSchema = z.object({
  id: z.string().describe("UE_5.4, or a source build's registered name"),
  version: z.string().describe('5.4.4'),
  dir: z.string().describe('Its folder in the sandbox'),
  where: z.string().describe('Where it came from, in words'),
  writable: z.boolean().describe('The sandbox can write into it'),
  build: z.enum(['installed', 'source']).describe('An installed (launcher) build or a source build'),
  sizeBytes: z.number().nullable().describe('Its size, when known'),
  projects: z.array(z.string()).describe('The projects that build with it'),
});

const PcEngineSchema = z.object({
  id: z.string().describe('Its folder name in the sandbox (C:\\PcInstalls\\unreal\\<id>)'),
  name: z.string().describe('Unreal Engine 5.4.4'),
  folder: z.string().describe('Its folder on this PC'),
  writable: z.boolean().describe('A folder you registered (mapped writable)'),
  source: z.boolean().describe('A source build this PC registered: not mapped until its folder is registered'),
});

const PackSchema = z.object({
  name: z.string().describe('The pack folder'),
  size: z.string().describe('Its size in words'),
  kind: z.enum(['content', 'plugin', 'other']).describe('Content, a code plugin, or something else'),
});

export const UnrealOverviewSchema = z.object({
  setUp: z.boolean().describe('A sandbox has set Unreal up (its status file exists)'),
  checkedAt: z.string().nullable().describe('When the sandbox last looked'),
  engines: z.array(EngineSchema).describe('The engines the sandbox has'),
  projects: z
    .array(z.object({ project: z.string(), engine: z.string().nullable(), reason: z.string() }))
    .describe('Which engine each project builds with, and why'),
  launcher: z.object({
    installed: z.boolean().describe('The Epic Games Launcher is installed in the sandbox'),
    installLocation: z.string().nullable().describe('Where it installs engines'),
    problem: z.string().nullable().describe('Why engines would not go to the data disk, or would not fit'),
    free: z.string().nullable().describe('Free room there, in words'),
  }),
  visualStudio: z.object({
    version: z.string(),
    path: z.string(),
    how: z.string().describe('Kept on the data disk, or installed in this sandbox'),
    check: z.string().describe('What UnrealBuildTool finds'),
    ok: z.boolean(),
  }),
  debugger: z.string().nullable().describe('cdb.exe, when the debuggers are there'),
  ddc: z.string().nullable().describe('The derived data cache folder, when it is kept'),
  mcpUrl: z.string().nullable().describe("The editor's MCP server address"),
  pc: z.object({
    setting: z.string().describe('pcInstalls.unrealEngines'),
    engines: z.array(PcEngineSchema).describe("This PC's engines the next sandbox maps"),
    problem: z.string().nullable().describe('Why this PC could not be looked at'),
  }),
  vault: z.object({
    setting: z.string().describe('pcInstalls.unrealAssets'),
    folders: z.array(z.object({ folder: z.string(), packs: z.array(PackSchema), more: z.number() })),
  }),
  settings: z.object({
    enabled: z.string(),
    acceptLicense: z.boolean(),
    persistEngines: z.boolean(),
    derivedDataCache: z.string(),
    visualStudio: z.string(),
  }),
});
export type UnrealOverview = z.output<typeof UnrealOverviewSchema>;

const MessageSchema = z.object({ message: z.string().describe('What happened') });

export const unrealOverview = defineQuery({
  id: 'unreal.overview',
  title: 'Unreal Engine',
  summary: "the engines, which project uses which, this PC's engines and assets, Visual Studio and the build tools",
  input: z.object({}),
  output: UnrealOverviewSchema,
  cli: { name: 'unreal', action: 'status', json: true },
});

export const registerEngineFolder = defineOperation({
  id: 'unreal.registerFolder',
  title: 'Register an engine folder…',
  summary: 'use an Unreal Engine folder of this PC in the sandbox, writable (a source build, or a copy of an engine)',
  input: z.object({
    folder: z.string().optional().describe('the engine folder (it holds Engine\\Build\\Build.version)'),
  }),
  output: MessageSchema,
  text: (o) => o.message,
  cli: { name: 'unreal', action: 'add-engine', positional: ['folder'] },
});

export const forgetEngineFolder = defineOperation({
  id: 'unreal.forgetFolder',
  title: 'Forget this engine folder',
  summary: 'stop mapping a registered engine folder into sandboxes (nothing on this PC is deleted)',
  input: z.object({ folder: z.string().describe('the registered folder') }),
  output: MessageSchema,
  text: (o) => o.message,
  cli: { name: 'unreal', action: 'forget-engine', positional: ['folder'] },
});

export const openEpicLauncher = defineOperation({
  id: 'unreal.openLauncher',
  title: 'Open the Epic Games Launcher',
  summary: 'open the Epic Games Launcher in the running sandbox (sign in once; engines install to the data disk)',
  input: z.object({}),
  output: MessageSchema,
  text: (o) => o.message,
  cli: { name: 'unreal', action: 'launcher' },
});

const SETTINGS: readonly [string, string][] = [
  ['toolchains.unreal.enabled', 'Unreal set-up'],
  ['toolchains.unreal.acceptLicense', 'Licence accepted'],
  ['toolchains.unreal.visualStudio', 'Visual Studio'],
  ['toolchains.unreal.persistEngines', 'Engines on the data disk'],
  ['toolchains.unreal.derivedDataCache', 'Derived data cache'],
  ['pcInstalls.unrealEngines', "This PC's engines"],
  ['pcInstalls.unrealAssets', "This PC's assets"],
];

const sizeOf = (bytes: number | null): string => (bytes === null ? '' : bytesText(bytes));

function enginesSection(o: UnrealOverview): Section {
  const items: Item[] = o.engines.map((e) => ({
    id: 'engine:' + e.dir,
    label: e.id + '  ' + e.version,
    hint: e.where,
    tone: e.writable ? 'ok' : 'accent',
    description:
      e.dir +
      (e.sizeBytes !== null ? ' (' + sizeOf(e.sizeBytes) + ')' : '') +
      '. ' +
      (e.projects.length ? 'Used by ' + e.projects.join(', ') + '.' : 'No project uses it yet.') +
      (e.build === 'source' ? ' A source build.' : ''),
    icon: 'folder',
    cells: {
      engine: e.id,
      version: e.version,
      where: e.where,
      folder: e.dir,
      used: e.projects.join(', ') || '-',
    },
  }));
  return {
    id: 'engines',
    title: 'Engines in the sandbox',
    description:
      'A project builds with the engine its .uproject names (a writable copy before the read-only one from this PC), else with the newest.',
    items,
    columns: [
      { key: 'engine', label: 'Engine' },
      { key: 'version', label: 'Version' },
      { key: 'where', label: 'Where' },
      { key: 'folder', label: 'Folder' },
      { key: 'used', label: 'Used by' },
    ],
    columnsOn: 'cli',
    ...(o.projects.length
      ? {
          notes: o.projects.map((p) => ({
            text: p.project + ': ' + (p.engine ?? 'no engine') + ' (' + p.reason + ')',
            ...(p.engine ? {} : { tone: 'warn' as const }),
          })),
        }
      : {}),
  };
}

function pcSection(o: UnrealOverview): Section {
  return {
    id: 'pc',
    title: 'From this PC',
    description:
      o.pc.setting === 'auto'
        ? 'The next sandbox set up for Unreal maps these read-only (folders you registered: writable) and registers them: no download.'
        : "This PC's engines setting is " + o.pc.setting + '.',
    items: o.pc.engines.map((e): Item => ({
      id: 'pc:' + e.folder,
      label: e.name,
      hint: e.source ? 'source build, not mapped' : e.writable ? 'registered, writable' : 'read-only',
      description: e.source
        ? e.folder + ' is a source build: building writes inside the engine, so register its folder to use it.'
        : e.folder + ' appears in the sandbox at C:\\PcInstalls\\unreal\\' + e.id + '.',
      cells: { engine: e.name, how: e.source ? 'not mapped' : e.writable ? 'writable' : 'read-only', folder: e.folder },
      ...(e.source
        ? { actions: [action(registerEngineFolder, { folder: e.folder }, { key: 'a', verb: 'register' })] }
        : e.writable
          ? { actions: [action(forgetEngineFolder, { folder: e.folder }, { key: 'x', verb: 'forget' })] }
          : {}),
    })),
    columns: [
      { key: 'engine', label: 'Engine' },
      { key: 'how', label: 'Mapped' },
      { key: 'folder', label: 'Folder on this PC' },
    ],
    columnsOn: 'cli',
    notes: o.pc.problem
      ? [{ text: o.pc.problem, tone: 'warn' }]
      : o.pc.engines.length
        ? []
        : [
            {
              text:
                o.pc.setting === 'false'
                  ? "Turned off (This PC's engines)."
                  : 'No Unreal Engine on this PC yet: one you install with the Epic Games Launcher shows up here, and the next sandbox maps it.',
              tone: 'muted',
            },
          ],
    actions: [action(registerEngineFolder, {}, { key: 'a', verb: 'register' })],
  };
}

function vaultSection(o: UnrealOverview): Section {
  // A heading per folder only when there are several (most PCs have the default one).
  const group = (folder: string): { group?: string } => (o.vault.folders.length > 1 ? { group: folder } : {});
  const items: Item[] = o.vault.folders.flatMap((f) => [
    ...f.packs.map((p): Item => ({
      id: 'pack:' + f.folder + '\\' + p.name,
      label: p.name,
      hint: p.size,
      ...group(f.folder),
      description:
        f.folder +
        '\\' +
        p.name +
        (p.kind === 'plugin'
          ? ": a code plugin (agents copy it into a project's Plugins folder)."
          : p.kind === 'content'
            ? ": content (agents copy it into a project's Content folder)."
            : '.'),
    })),
    ...(f.more
      ? [{ id: 'more:' + f.folder, label: '… and ' + f.more + ' more', ...group(f.folder), tone: 'muted' as const }]
      : []),
  ]);
  const empty = !o.vault.folders.some((f) => f.packs.length);
  return {
    id: 'vault',
    title: 'Assets from this PC',
    description:
      'The Fab and Marketplace packs your Epic Games Launcher downloaded (its vault cache). The sandbox sees them read-only at C:\\PcInstalls\\unreal\\Vault, and new ones at once; agents copy what a project needs into it.',
    facts: o.vault.folders.map((f, i) => ({
      id: 'vault:' + i,
      label: 'Vault cache',
      value: f.folder,
      description: 'In the sandbox: C:\\PcInstalls\\unreal\\Vault' + (i ? String(i + 1) : ''),
    })),
    items,
    ...(empty
      ? {
          notes: [
            {
              text:
                o.vault.setting === 'false'
                  ? "Turned off (This PC's assets)."
                  : 'No packs yet: the ones you add to the vault with the Epic Games Launcher appear here.',
              tone: 'muted' as const,
            },
          ],
        }
      : {}),
  };
}

function toolsSection(o: UnrealOverview): Section {
  const vs = o.visualStudio;
  return {
    id: 'tools',
    title: 'Build tools',
    facts: [
      {
        id: 'vs',
        label: 'Visual Studio',
        value: vs.version ? vs.version + (vs.how ? ' (' + vs.how + ')' : '') : 'not set up yet',
        tone: vs.version ? (vs.ok ? 'ok' : 'warn') : 'muted',
        ...(vs.path ? { description: vs.path } : {}),
      },
      ...(vs.check
        ? [
            {
              id: 'ubt',
              label: 'UnrealBuildTool finds',
              value: vs.check,
              tone: vs.ok ? ('ok' as const) : ('danger' as const),
            },
          ]
        : []),
      {
        id: 'cdb',
        label: 'Debugger',
        value: o.debugger ? 'cdb and windbg' : 'not there yet',
        tone: o.debugger ? 'ok' : 'muted',
        ...(o.debugger ? { description: o.debugger } : {}),
      },
      {
        id: 'ddc',
        label: 'Derived data cache',
        value: o.ddc ?? "Unreal's own place (rebuilt every sandbox)",
        tone: o.ddc ? 'ok' : 'muted',
      },
      {
        id: 'launcher',
        label: 'Epic Games Launcher',
        value: o.launcher.installed
          ? 'installs engines to ' + (o.launcher.installLocation ?? 'the sandbox disk')
          : o.setUp
            ? 'not installed'
            : 'not set up yet',
        tone: o.launcher.problem ? 'danger' : o.launcher.installed ? 'ok' : 'muted',
        ...(o.launcher.free ? { description: o.launcher.free + ' free there' } : {}),
      },
      ...(o.mcpUrl
        ? [
            {
              id: 'mcp',
              label: 'Editor MCP server',
              value: o.mcpUrl,
              description: 'In Claude Code as sbx-unreal-editor; it answers while the editor runs with the plugin on.',
            },
          ]
        : []),
    ],
    actions: [action(openEpicLauncher, {}, { key: 'o', verb: 'launcher' })],
  };
}

function settingsSection(o: UnrealOverview): Section {
  const value: Readonly<Record<string, string>> = {
    'toolchains.unreal.enabled': o.settings.enabled,
    'toolchains.unreal.acceptLicense': o.settings.acceptLicense ? 'yes' : 'no',
    'toolchains.unreal.visualStudio': o.settings.visualStudio,
    'toolchains.unreal.persistEngines': o.settings.persistEngines ? 'yes' : 'no',
    'toolchains.unreal.derivedDataCache': o.settings.derivedDataCache,
    'pcInstalls.unrealEngines': o.pc.setting,
    'pcInstalls.unrealAssets': o.vault.setting,
  };
  return {
    id: 'settings',
    title: 'Settings',
    columns: [
      { key: 'setting', label: 'Setting' },
      { key: 'value', label: 'Value' },
      { key: 'key', label: 'Key' },
    ],
    columnsOn: 'cli',
    items: SETTINGS.map(([key, label]) => ({
      id: 'setting:' + key,
      label,
      hint: value[key],
      code: key,
      cells: { setting: label, value: value[key], key },
      ...(key === 'toolchains.unreal.acceptLicense' && !o.settings.acceptLicense ? { tone: 'warn' as const } : {}),
      primary: link({ kind: 'setting', key }, 'Change ' + label.toLowerCase(), { verb: 'change' }),
    })),
  };
}

/** The Unreal page. */
export function unrealPage(o: UnrealOverview): Page {
  return {
    title: 'Unreal Engine',
    ...(o.launcher.problem ? { notice: { text: o.launcher.problem, tone: 'danger' as const } } : {}),
    sections: [
      {
        ...enginesSection(o),
        ...(o.engines.length
          ? {}
          : {
              notes: [
                {
                  text: o.setUp
                    ? 'No engine yet. Install Unreal Engine on this PC with the Epic Games Launcher: the next sandbox maps it read-only. Or open the Epic Games Launcher in the sandbox and sign in once: it installs to the data disk, kept between sandboxes.'
                    : 'No sandbox has set Unreal up yet. It is set up when a project has a .uproject (or the Unreal set-up setting is on).',
                  tone: 'muted' as const,
                },
              ],
            }),
      },
      pcSection(o),
      vaultSection(o),
      toolsSection(o),
      settingsSection(o),
    ],
  };
}

export const unrealView = defineView({
  id: 'unreal',
  title: 'Unreal Engine',
  summary: "Engines, which project uses which, this PC's engines and assets, Visual Studio and the debugger.",
  queries: { overview: unrealOverview },
  operations: [registerEngineFolder, forgetEngineFolder, openEpicLauncher],
  pickers: [browseFolder],
  inputs: () => ({ overview: {} }),
  build: ({ overview }) => unrealPage(overview),
});
