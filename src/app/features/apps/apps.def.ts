// Apps: the catalogue of apps every sandbox can install (ticked = installed), grouped by category, for all projects or
// this project. Pure: schemas, the groups, the request address, the operations and the view. The rows are made on the
// Node side (apps-rows.ts), because the catalogue and the files are read there. Ticks written here are saved at once;
// the menu stages them until Ctrl+S (menu/pages/apps-page.ts).
import { z } from 'zod';
import {
  action,
  defineOperation,
  defineQuery,
  defineView,
  FieldSchema,
  type Field,
  type Item,
  type Page,
  type Section,
} from '../../kernel/index.js';
import { setSetting } from '../settings/settings.def.js';

export const AppsScopeSchema = z
  .enum(['user', 'project'])
  .describe("Your own settings (all projects) or this folder's .sandbox-config.json (this project)");
export type AppsScope = z.output<typeof AppsScopeSchema>;

/** A group of apps on the page: the catalogue's categories, merged (members are catalogue category ids). */
export interface AppGroup {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly members: readonly string[];
}

/** The groups the page shows; the menu and the web list the apps by these, so the navigation stays short. */
export const APP_GROUPS: readonly AppGroup[] = [
  {
    id: 'editors',
    label: 'Editors & docs',
    description: 'Code and text editors (VS Code is on by default), plus diagrams and document conversion.',
    members: ['editors', 'diagrams'],
  },
  {
    id: 'clients',
    label: 'DB & API clients',
    description:
      'GUIs for the sandbox databases, tools to send HTTP, REST and GraphQL requests, and to inspect traffic.',
    members: ['databases', 'api', 'network'],
  },
  {
    id: 'tools',
    label: 'Git & utilities',
    description: 'Git GUIs and terminal UIs, archives, file search and comparing, process tools, and decompilers.',
    members: ['git', 'utilities', 'reversing'],
  },
  {
    id: 'cli',
    label: 'Command-line & cloud',
    description: 'Small developer tools (JSON, search, builds, media ...) and tools for clouds and Kubernetes.',
    members: ['cli', 'cloud'],
  },
  {
    id: 'play',
    label: 'Browsers & games',
    description: 'Browsers for testing web apps, and game engines and editors (they draw with OpenGL on the CPU).',
    members: ['browsers', 'gamedev'],
  },
];

/** The group an app's catalogue category is listed under. */
export function groupOf(category: string): string {
  return APP_GROUPS.find((g) => g.members.includes(category))?.id ?? 'tools';
}

/** The row that asks for an app that is not in the list (the menu's id; the web has a button instead). */
export const REQUEST_APP = '@request-app';

/** This project's new-issue page on GitHub. */
export const ISSUES_URL = 'https://github.com/JoshDiDuca/windows-development-sandbox/issues/new';

/** The new-issue address with a title and a body to fill in (the page needs no login to show it). */
export function requestAppUrl(): string {
  const body = [
    '**App name:**',
    '',
    '**Where to get it** (GitHub releases page or a direct download link):',
    '',
    '**What it is for:**',
    '',
    '**Command-line tool or desktop app?**',
    '',
    '**Does it need a GPU, a license or an account?**',
  ].join('\n');
  const query = [
    ['title', 'App request: '],
    ['body', body],
    ['labels', 'app-request'],
  ];
  return ISSUES_URL + '?' + query.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

/** One app of the catalogue as this scope sees it. */
export const AppRowSchema = z.object({
  id: z.string().describe('The app'),
  name: z.string().describe('Its name'),
  about: z.string().describe('What it is for'),
  group: z.string().describe('The group it is listed under (APP_GROUPS id)'),
  size: z.string().describe('Its download size'),
  cli: z.boolean().describe('A command-line tool (on PATH), not a desktop app'),
  mesa: z.boolean().describe('Needs OpenGL on the CPU (Mesa)'),
  fullGitOnly: z.boolean().describe('Only with full git access'),
  setting: z.string().optional().describe('The setting it stands for (VS Code, Windows Terminal)'),
  /** That setting's own Field and value (on, off or auto), so it is changed with its own control. */
  settingField: FieldSchema.optional(),
  settingValue: z.unknown().optional(),
  installed: z.boolean().describe('Downloaded already into the data folder'),
  on: z.boolean().describe('Installed in every sandbox of this scope'),
});
export type AppRow = z.output<typeof AppRowSchema>;

/** One program of your own (apps.custom). */
export const CustomAppRowSchema = z.object({
  id: z.string().describe('Its key in apps.custom'),
  name: z.string().describe('Its name'),
  from: z.string().describe('"From the latest <repo> release." or "From <url>"'),
  cli: z.boolean().describe('A command-line tool'),
});
export type CustomAppRow = z.output<typeof CustomAppRowSchema>;

export const AppsListSchema = z.object({
  scope: AppsScopeSchema,
  file: z.string().describe('The file this scope edits'),
  exists: z.boolean().describe('The file exists already'),
  apps: z.array(AppRowSchema).describe('The catalogue entries this scope can change'),
  custom: z.array(CustomAppRowSchema).describe('Your own programs (your own scope only)'),
  customValue: z.unknown().optional().describe('apps.custom as saved, to edit (your own scope only)'),
  customField: FieldSchema.optional().describe('The Field of apps.custom (your own scope only)'),
});
export type AppsList = z.output<typeof AppsListSchema>;

export const listApps = defineQuery({
  id: 'apps.list',
  title: 'Apps',
  summary: 'the apps catalogue: what every sandbox installs',
  input: z.object({ scope: AppsScopeSchema.default('user') }),
  output: AppsListSchema,
  surfaces: { except: { cli: 'apps are settings: sandbox config set apps.install / apps.custom' } },
});

export const toggleApp = defineOperation({
  id: 'apps.toggle',
  title: 'Install in every sandbox',
  summary: 'turn an app of the catalogue on or off for this scope',
  input: z.object({
    scope: AppsScopeSchema.default('user'),
    id: z.string().max(100).describe('The app'),
    on: z.boolean().describe('Install it (true) or not (false)'),
  }),
  output: z.object({ message: z.string().describe('What changed') }),
  text: (o) => o.message,
  surfaces: { except: { cli: 'apps are settings: sandbox config set apps.install / apps.custom' } },
});

export const setCustomApps = defineOperation({
  id: 'apps.setCustom',
  title: 'Your own programs',
  summary: 'change your own programs (apps.custom)',
  input: z.object({
    scope: AppsScopeSchema.default('user'),
    value: z.unknown().describe('Programs of your own: a GitHub release or a download link, and the program to start.'),
  }),
  output: z.object({ message: z.string().describe('What changed') }),
  text: (o) => o.message,
  surfaces: { except: { cli: 'apps are settings: sandbox config set apps.custom' } },
});

export const requestApp = defineOperation({
  id: 'apps.request',
  title: 'Request an app…',
  summary: 'open a prefilled GitHub request for an app that is not in the list',
  input: z.object({}),
  output: z.object({ url: z.string().describe('The request page') }),
  text: (o) => 'Opened the request form in your browser: ' + o.url,
  surfaces: { except: { cli: 'a request is filed on GitHub; the address is in docs' } },
});

/** The lines under an app: its download, how it starts, what it needs. Plain text, like the CLI's. */
function details(row: AppRow): string[] {
  return [
    'Download  ~' +
      row.size +
      ' once, kept in C:\\AgentData\\tools\\' +
      (row.setting ? '' : 'apps\\') +
      row.id +
      (row.installed ? ' (downloaded already)' : ''),
    'Starts    ' + (row.cli ? 'from a terminal (on PATH)' : 'from the desktop or Start > Sandbox apps'),
    ...(row.mesa ? ['Graphics  OpenGL on the CPU (Mesa) is added for it'] : []),
    ...(row.fullGitOnly
      ? ['Needs full git access (Settings > Projects & setup > Git): it pushes with its own git.']
      : []),
    ...(row.setting ? ['Setting   ' + row.setting] : []),
  ];
}

/** The switch that turns an app on or off: one boolean field, changed in place. */
function switchField(row: AppRow): Field {
  return { name: 'on', key: ['apps', 'install'], kind: 'boolean', label: row.name, optional: false };
}

function appItem(row: AppRow, scope: AppsScope): Item {
  // An app that is a setting of its own (VS Code: on, off or "auto" = when this PC has it) gets that setting's control.
  const primary =
    row.setting && row.settingField
      ? action(
          setSetting,
          { scope: 'user', key: row.setting },
          {
            label: 'Change',
            verb: 'change',
            inline: true,
            fields: [{ ...row.settingField, name: 'value', label: row.name }],
            initial: { value: row.settingValue },
          },
        )
      : action(
          toggleApp,
          { scope, id: row.id },
          {
            label: row.on ? 'Turn off' : 'Turn on',
            verb: 'tick',
            inline: true,
            fields: [switchField(row)],
            initial: { on: row.on },
          },
        );
  return {
    id: row.id,
    label: row.name,
    description: row.about,
    code: row.id,
    keywords: row.id,
    details: details(row),
    ...(row.on ? { tone: 'ok' as const } : {}),
    primary,
  };
}

function customItem(row: CustomAppRow): Item {
  return {
    id: 'custom-' + row.id,
    label: row.name,
    description: row.from,
    hint: row.cli ? 'command line' : 'desktop',
    disabled: 'Your own programs are always installed; change or remove them with Your own programs.',
  };
}

/** The apps page of one scope: a category per group (with a switch per app), your own programs and their actions. */
export function appsPage(o: AppsList): Page {
  const sections: Section[] = APP_GROUPS.map((g) => ({
    id: g.id,
    title: g.label,
    description: g.description,
    items: o.apps.filter((r) => r.group === g.id).map((r) => appItem(r, o.scope)),
  })).filter((s) => (s.items?.length ?? 0) > 0);
  if (o.scope === 'user')
    sections.push({
      id: 'custom',
      title: 'Your own programs',
      description: 'Programs you added yourself, from a GitHub release or a download link.',
      items: o.custom.map(customItem),
    });
  const own = o.scope === 'user';
  return {
    title: 'Apps',
    categories: true,
    notice: {
      text:
        'Editing ' +
        o.file +
        (o.exists ? '' : ' (created when you save)') +
        (o.scope === 'project' ? ': only apps from the list; needs your approval at the next launch' : ''),
      tone: o.scope === 'project' ? 'accent' : 'muted',
    },
    sections,
    actions: own
      ? [
          ...(o.customField
            ? [
                action(
                  setCustomApps,
                  { scope: 'user' },
                  {
                    key: 'c',
                    verb: 'your own programs',
                    fields: [{ ...o.customField, name: 'value', label: 'Your own programs' }],
                    initial: { value: o.customValue },
                  },
                ),
              ]
            : []),
          action(requestApp, {}, { key: 'r', verb: 'request an app' }),
        ]
      : [],
  };
}

export const appsView = defineView({
  id: 'apps',
  title: 'Apps',
  summary: 'Tick the apps every sandbox should have. Each downloads once and is kept.',
  queries: { apps: listApps },
  operations: [toggleApp, setCustomApps, requestApp, setSetting],
  tabs: {
    param: 'scope',
    choices: [
      { value: 'user', label: 'All projects' },
      { value: 'project', label: 'This project' },
    ],
  },
  inputs: (params: { scope: AppsScope }) => ({ apps: { scope: params.scope } }),
  build: ({ apps }) => appsPage(apps),
});
