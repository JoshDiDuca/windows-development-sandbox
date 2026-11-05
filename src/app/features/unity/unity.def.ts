// Unity: the editors the sandbox has (and which project opens with which), the editors and Asset Store downloads of
// this PC, the licence and sign-in, the editor bridge of each project, the agent tools and the settings; opening Unity
// Hub, signing in, adding and removing the editor bridge. Pure: schemas, labels and the view; unity.run.ts reads the
// sandbox's tools\unity\status.json and looks on this PC.
import { z } from 'zod';
import {
  action,
  bytesText,
  defineOperation,
  defineQuery,
  defineView,
  link,
  type Item,
  type Note,
  type Page,
  type Section,
} from '../../kernel/index.js';
import { browseFolder } from '../files/files.def.js';

const EditorSchema = z.object({
  version: z.string().describe('6000.0.58f2'),
  dir: z.string().describe('Its folder in the sandbox'),
  where: z.string().describe('Where it is, in words'),
  writable: z.boolean().describe('The sandbox can add modules to it'),
  modules: z.array(z.string()).describe('The platform modules it has'),
  sizeBytes: z.number().nullable().describe('Its size, when known'),
  projects: z.array(z.string()).describe('The projects that open with it'),
});

const ProjectSchema = z.object({
  project: z.string().describe('The project folder name'),
  folder: z.string().nullable().describe('Its folder on this PC, when it is known'),
  version: z.string().nullable().describe('The editor version its ProjectVersion.txt asks for'),
  editor: z.string().nullable().describe('The editor it opens with'),
  reason: z.string().describe('Why that editor, or why none'),
  bridge: z.enum(['pipeline', 'coplay']).nullable().describe('The editor bridge package it has'),
  pipeline: z.boolean().describe('Its Unity version can take the Unity Pipeline package (Unity 6 and later)'),
});

const PackageSchema = z.object({
  publisher: z.string(),
  category: z.string(),
  name: z.string(),
  size: z.string().describe('Its size in words'),
});

export const UnityOverviewSchema = z.object({
  setUp: z.boolean().describe('A sandbox has set Unity up (its status file exists)'),
  checkedAt: z.string().nullable().describe('When the sandbox last looked'),
  cli: z.object({ version: z.string(), path: z.string() }).nullable().describe('The Unity CLI the sandbox has'),
  editors: z.array(EditorSchema).describe('The editors the sandbox has'),
  projects: z.array(ProjectSchema).describe('Which editor each project opens with, and its editor bridge'),
  licence: z.object({
    state: z.enum(['active', 'none', 'invalid', 'unknown']),
    kind: z.string(),
    detail: z.string(),
    user: z.string().nullable(),
  }),
  hub: z.object({ installed: z.boolean(), setting: z.boolean() }).describe('Unity Hub in the sandbox'),
  assetCache: z.object({ mode: z.string(), dir: z.string().nullable() }),
  agentTools: z.object({
    cliVersion: z.string().describe('The Unity CLI version the settings ask for'),
    mcp: z.string().nullable().describe('The MCP server name when it was registered'),
    mcpSetting: z.boolean(),
    skills: z.boolean().describe('Unity skills were synced for the agents'),
    skillsSetting: z.boolean(),
  }),
  pc: z.object({
    setting: z.string().describe('pcInstalls.unityEditors'),
    editors: z.array(z.object({ version: z.string(), folder: z.string() })).describe("This PC's editors"),
    problem: z.string().nullable().describe('Why this PC could not be looked at'),
  }),
  assets: z.object({
    setting: z.string().describe('pcInstalls.unityAssets'),
    folders: z.array(z.object({ folder: z.string(), packages: z.array(PackageSchema), more: z.number() })),
  }),
  problem: z.string().nullable().describe('What went wrong in the sandbox, if anything'),
  settings: z.object({
    enabled: z.string(),
    acceptLicense: z.boolean(),
    version: z.string(),
    modules: z.string(),
    hub: z.boolean(),
    keepVersions: z.number(),
    mcp: z.boolean(),
    agentSkills: z.boolean(),
    cliVersion: z.string(),
    assetCache: z.string(),
  }),
});
export type UnityOverview = z.output<typeof UnityOverviewSchema>;

const MessageSchema = z.object({ message: z.string().describe('What happened') });

export const unityOverview = defineQuery({
  id: 'unity.overview',
  title: 'Unity',
  summary: "the sandbox's editors, this PC's editors and Asset Store downloads, the licence and the editor bridge",
  input: z.object({}),
  output: UnityOverviewSchema,
  cli: { name: 'unity', action: 'status', json: true },
});

export const openUnityHub = defineOperation({
  id: 'unity.openHub',
  title: 'Open Unity Hub',
  summary: 'open Unity Hub in the running sandbox (needs the Unity Hub setting on)',
  input: z.object({}),
  output: MessageSchema,
  text: (o) => o.message,
  cli: { name: 'unity', action: 'hub' },
});

export const unitySignIn = defineOperation({
  id: 'unity.signIn',
  title: 'Sign in to Unity',
  summary: 'sign in to Unity in the running sandbox (Unity Personal; the licence is kept for the next sandboxes)',
  input: z.object({}),
  output: MessageSchema,
  text: (o) => o.message,
  cli: { name: 'unity', action: 'sign-in' },
});

export const addEditorBridge = defineOperation({
  id: 'unity.addBridge',
  title: 'Add the editor bridge…',
  summary: "add the package that lets agents drive a running editor to a project's Packages/manifest.json",
  input: z.object({
    project: z.string().optional().describe('the project folder on this PC (asked when left out)'),
    bridge: z.enum(['pipeline', 'coplay']).optional().describe('pipeline (Unity 6 and later) or coplay (older Unity)'),
  }),
  output: MessageSchema,
  text: (o) => o.message,
  cli: {
    name: 'unity',
    action: 'add-bridge',
    positional: ['project'],
    flags: { bridge: { flag: '--bridge', value: 'name', choices: ['pipeline', 'coplay'] } },
  },
});

export const removeEditorBridge = defineOperation({
  id: 'unity.removeBridge',
  title: 'Remove the editor bridge',
  summary: "take the editor bridge package out of a project's Packages/manifest.json",
  input: z.object({
    project: z.string().optional().describe('the project folder on this PC (asked when left out)'),
  }),
  output: MessageSchema,
  text: (o) => o.message,
  cli: { name: 'unity', action: 'remove-bridge', positional: ['project'] },
});

const SETTINGS: readonly [string, string][] = [
  ['toolchains.unity.enabled', 'Unity set-up'],
  ['toolchains.unity.acceptLicense', 'Licence accepted'],
  ['toolchains.unity.version', 'Editor version'],
  ['toolchains.unity.modules', 'Editor modules'],
  ['toolchains.unity.hub', 'Unity Hub'],
  ['toolchains.unity.keepVersions', 'Editors kept'],
  ['toolchains.unity.mcp', 'MCP server'],
  ['toolchains.unity.agentSkills', 'Agent skills'],
  ['toolchains.unity.cliVersion', 'Unity CLI version'],
  ['toolchains.unity.assetCache', 'Asset Store downloads'],
  ['pcInstalls.unityEditors', "This PC's editors"],
  ['pcInstalls.unityAssets', "This PC's Asset Store downloads"],
];

const yesNo = (b: boolean): string => (b ? 'yes' : 'no');
const sizeOf = (bytes: number | null): string => (bytes === null ? '' : bytesText(bytes));

function editorsSection(o: UnityOverview): Section {
  const items: Item[] = o.editors.map((e) => ({
    id: 'editor:' + e.dir,
    label: 'Unity ' + e.version,
    hint: e.where,
    tone: e.writable ? 'ok' : 'accent',
    description:
      e.dir +
      (e.sizeBytes !== null ? ' (' + sizeOf(e.sizeBytes) + ')' : '') +
      '. ' +
      (e.modules.length ? 'Modules: ' + e.modules.join(', ') + '. ' : 'No platform modules. ') +
      (e.projects.length ? 'Used by ' + e.projects.join(', ') + '.' : 'No project uses it yet.'),
    icon: 'folder',
    cells: {
      version: e.version,
      where: e.where,
      modules: e.modules.join(', ') || '-',
      used: e.projects.join(', ') || '-',
    },
  }));
  return {
    id: 'editors',
    title: 'Editors in the sandbox',
    description:
      "A project opens with exactly the editor version its ProjectVersion.txt names: this PC's read-only copy first when it has the modules, then the data disk, else it is installed there once the Unity licence is accepted.",
    items,
    columns: [
      { key: 'version', label: 'Version' },
      { key: 'where', label: 'Where' },
      { key: 'modules', label: 'Modules' },
      { key: 'used', label: 'Used by' },
    ],
    columnsOn: 'cli',
    ...(items.length
      ? {}
      : {
          notes: [
            {
              text: o.setUp
                ? 'No editor yet. One of this PC is used as it is; otherwise the next sandbox installs the one a project asks for on the data disk (8-13 GB, kept), once the Unity licence is accepted in the settings below.'
                : 'No sandbox has set Unity up yet. It is set up when a project has ProjectSettings/ProjectVersion.txt (or the Unity set-up setting is on).',
              tone: 'muted' as const,
            },
          ],
        }),
  };
}

function pcSection(o: UnityOverview): Section {
  const off = o.pc.setting === 'false';
  return {
    id: 'pc',
    title: 'From this PC',
    description:
      o.pc.setting === 'auto'
        ? 'The next sandbox set up for Unity maps these read-only and uses them: no download.'
        : "This PC's editors setting is " + o.pc.setting + '.',
    items: o.pc.editors.map((e): Item => ({
      id: 'pc:' + e.folder,
      label: 'Unity ' + e.version,
      hint: 'read-only',
      description: e.folder + ' appears in the sandbox at C:\\PcInstalls\\unity\\' + e.version + '.',
      cells: { version: e.version, folder: e.folder },
    })),
    columns: [
      { key: 'version', label: 'Version' },
      { key: 'folder', label: 'Folder on this PC' },
    ],
    columnsOn: 'cli',
    notes: o.pc.problem
      ? [{ text: o.pc.problem, tone: 'warn' }]
      : o.pc.editors.length
        ? []
        : [
            {
              text: off
                ? "Turned off (This PC's editors)."
                : 'No Unity editor on this PC yet: one you install with Unity Hub shows up here, and the next sandbox maps it.',
              tone: 'muted',
            },
          ],
    actions: [
      link({ kind: 'setting', key: 'pcInstalls.unityEditors' }, "Change this PC's editors", { verb: 'change' }),
    ],
  };
}

const MAX_NOTE = 600;

function assetsSection(o: UnityOverview): Section {
  const several = o.assets.folders.length > 1;
  const items: Item[] = o.assets.folders.flatMap((f) => [
    ...f.packages.map((p): Item => ({
      id: 'asset:' + f.folder + '\\' + p.publisher + '\\' + p.category + '\\' + p.name,
      label: p.name,
      hint: p.size,
      group: p.publisher + (several ? ' (' + f.folder + ')' : ''),
      description: p.category + ' by ' + p.publisher + '. Agents import it into a project with the editor closed.',
    })),
    ...(f.more ? [{ id: 'more:' + f.folder, label: '… and ' + f.more + ' more', tone: 'muted' as const }] : []),
  ]);
  const empty = !o.assets.folders.some((f) => f.packages.length);
  return {
    id: 'assets',
    title: 'Assets from this PC',
    description:
      'The Asset Store packages you downloaded in Unity on this PC. The sandbox sees them read-only at C:\\PcInstalls\\unity\\AssetStore, new ones at once; agents import what a project needs.',
    facts: o.assets.folders.map((f, i) => ({
      id: 'folder:' + i,
      label: 'Download folder',
      value: f.folder,
      description: 'In the sandbox: C:\\PcInstalls\\unity\\AssetStore' + (i ? String(i + 1) : ''),
    })),
    items,
    ...(empty
      ? {
          notes: [
            {
              text:
                o.assets.setting === 'false'
                  ? "Turned off (This PC's Asset Store downloads)."
                  : 'No packages yet: the ones you download from the Asset Store in Unity appear here.',
              tone: 'muted' as const,
            },
          ],
        }
      : {}),
    actions: [
      link({ kind: 'setting', key: 'pcInstalls.unityAssets' }, "Change this PC's downloads", { verb: 'change' }),
    ],
  };
}

function licenceSection(o: UnityOverview): Section {
  const l = o.licence;
  const text =
    l.state === 'active'
      ? 'Active'
      : l.state === 'none'
        ? 'No licence'
        : l.state === 'invalid'
          ? 'Refused: sign in again'
          : 'Not checked yet';
  return {
    id: 'licence',
    title: 'Licence and sign-in',
    description:
      'Unity Personal is activated by signing in once in a sandbox; the licence is kept for the next ones. A Plus or Pro serial is saved in Accounts and activated in each sandbox.',
    facts: [
      {
        id: 'state',
        label: 'Licence',
        value: text + (l.kind ? ' (' + l.kind + ')' : ''),
        tone: l.state === 'active' ? 'ok' : l.state === 'unknown' ? 'muted' : 'warn',
        ...(l.detail ? { description: l.detail } : {}),
      },
      ...(l.user ? [{ id: 'user', label: 'Signed in as', value: l.user }] : []),
      {
        id: 'hub',
        label: 'Unity Hub',
        value: o.hub.installed ? 'in the sandbox' : o.hub.setting ? 'installed at the next start' : 'off',
        tone: o.hub.installed ? ('ok' as const) : ('muted' as const),
      },
    ],
    actions: [
      action(unitySignIn, {}, { key: 's', verb: 'sign in' }),
      ...(o.hub.installed ? [action(openUnityHub, {}, { key: 'o', verb: 'hub' })] : []),
      link({ kind: 'view', view: 'accounts' }, 'Unity sign-in in Accounts', { verb: 'accounts' }),
      link({ kind: 'setting', key: 'toolchains.unity.hub' }, 'Change Unity Hub', { verb: 'change' }),
    ],
  };
}

function projectsSection(o: UnityOverview): Section {
  const items: Item[] = o.projects.map((p) => {
    const bridge =
      p.bridge === 'pipeline'
        ? 'Unity Pipeline'
        : p.bridge === 'coplay'
          ? 'MCP for Unity (Coplay)'
          : 'no editor bridge';
    return {
      id: 'project:' + p.project,
      label: p.project,
      hint: p.version ?? 'no Unity version',
      tone: p.editor ? 'ok' : 'warn',
      description: (p.editor ? 'Opens with ' + p.editor + ' (' + p.reason + ')' : p.reason) + '. ' + bridge + '.',
      icon: 'project',
      cells: {
        project: p.project,
        version: p.version ?? '-',
        editor: p.editor ?? '-',
        bridge: p.bridge ?? '-',
      },
      ...(p.folder
        ? {
            actions: [
              p.bridge
                ? action(removeEditorBridge, { project: p.folder }, { key: 'x', verb: 'remove bridge' })
                : action(addEditorBridge, { project: p.folder }, { key: 'a', verb: 'add bridge' }),
            ],
          }
        : {}),
    };
  });
  const notes: Note[] = items.length
    ? [
        {
          text: 'The editor bridge lets agents drive a running editor (scenes, GameObjects, play mode). Nothing in a project changes unless you add it here.',
          tone: 'muted',
        },
      ]
    : [
        {
          text: o.setUp ? 'No Unity project has been opened in a sandbox yet.' : 'No sandbox has set Unity up yet.',
          tone: 'muted',
        },
      ];
  return {
    id: 'projects',
    title: 'Projects',
    items,
    columns: [
      { key: 'project', label: 'Project' },
      { key: 'version', label: 'Version' },
      { key: 'editor', label: 'Editor' },
      { key: 'bridge', label: 'Bridge' },
    ],
    columnsOn: 'cli',
    notes,
    actions: [action(addEditorBridge, {}, { key: 'b', verb: 'add bridge' })],
  };
}

function toolsSection(o: UnityOverview): Section {
  const t = o.agentTools;
  return {
    id: 'tools',
    title: 'Agent tools',
    facts: [
      {
        id: 'cli',
        label: 'Unity CLI',
        value: o.cli ? o.cli.version : 'not set up yet',
        tone: o.cli ? 'ok' : 'muted',
        description: 'The version the settings ask for: ' + t.cliVersion + '. It never updates itself.',
      },
      {
        id: 'mcp',
        label: 'MCP server',
        value: t.mcp ?? (t.mcpSetting ? 'registered at the next start' : 'off'),
        tone: t.mcp ? 'ok' : 'muted',
        description:
          "In Claude Code and Codex. The open editor's tools need the Unity Pipeline package (Unity 6 and later).",
      },
      {
        id: 'skills',
        label: 'Agent skills',
        value: t.skills ? 'synced' : t.skillsSetting ? 'synced at the next start' : 'off',
        tone: t.skills ? 'ok' : 'muted',
      },
      {
        id: 'cache',
        label: 'Asset Store downloads made in the sandbox',
        value:
          o.assetCache.mode === 'persisted'
            ? 'kept on the data disk'
            : o.assetCache.mode === 'pc'
              ? "this PC's downloads (read-only)"
              : 'lost when the sandbox closes',
        ...(o.assetCache.dir ? { description: o.assetCache.dir } : {}),
      },
    ],
    actions: [
      link({ kind: 'setting', key: 'toolchains.unity.mcp' }, 'Change the MCP server', { verb: 'change' }),
      link({ kind: 'setting', key: 'toolchains.unity.agentSkills' }, 'Change the agent skills', { verb: 'change' }),
    ],
  };
}

function settingsSection(o: UnityOverview): Section {
  const s = o.settings;
  const value: Readonly<Record<string, string>> = {
    'toolchains.unity.enabled': s.enabled,
    'toolchains.unity.acceptLicense': yesNo(s.acceptLicense),
    'toolchains.unity.version': s.version,
    'toolchains.unity.modules': s.modules,
    'toolchains.unity.hub': yesNo(s.hub),
    'toolchains.unity.keepVersions': String(s.keepVersions),
    'toolchains.unity.mcp': yesNo(s.mcp),
    'toolchains.unity.agentSkills': yesNo(s.agentSkills),
    'toolchains.unity.cliVersion': s.cliVersion,
    'toolchains.unity.assetCache': s.assetCache,
    'pcInstalls.unityEditors': o.pc.setting,
    'pcInstalls.unityAssets': o.assets.setting,
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
      ...(key === 'toolchains.unity.acceptLicense' && !s.acceptLicense ? { tone: 'warn' as const } : {}),
      primary: link({ kind: 'setting', key }, 'Change ' + label.toLowerCase(), { verb: 'change' }),
    })),
  };
}

/** The Unity page. */
export function unityPage(o: UnityOverview): Page {
  return {
    title: 'Unity',
    ...(o.problem ? { notice: { text: o.problem.slice(0, MAX_NOTE), tone: 'danger' as const } } : {}),
    sections: [
      editorsSection(o),
      pcSection(o),
      assetsSection(o),
      licenceSection(o),
      projectsSection(o),
      toolsSection(o),
      settingsSection(o),
    ],
  };
}

export const unityView = defineView({
  id: 'unity',
  title: 'Unity',
  summary: "Editors, this PC's editors and Asset Store downloads, the licence, the editor bridge and Unity Hub.",
  queries: { overview: unityOverview },
  operations: [openUnityHub, unitySignIn, addEditorBridge, removeEditorBridge],
  pickers: [browseFolder],
  inputs: () => ({ overview: {} }),
  build: ({ overview }) => unityPage(overview),
});
