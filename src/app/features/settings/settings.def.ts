// Settings: every setting of your own file (all projects) or of this folder's .sandbox-config.json (this project), read
// from the config schema through Fields, with get, set and reset. Pure: schemas and the view; the rows are made on the
// Node side (settings-rows.ts) because the config schema is, and secrets never leave it unmasked.
import { z } from 'zod';
import {
  action,
  defineOperation,
  defineQuery,
  defineView,
  FieldSchema,
  fieldOf,
  SchemaNode,
  valueText,
  type Field,
  type Item,
  type Page,
  type Section,
} from '../../kernel/index.js';
import { browseFolder } from '../files/files.def.js';
import { changeDataFolder } from '../storage/storage.def.js';

export const ScopeSchema = z
  .enum(['user', 'project'])
  .describe("Your own settings (all projects) or this folder's .sandbox-config.json (this project)");
export type Scope = z.output<typeof ScopeSchema>;

const KeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/)
  .max(200)
  .describe('The setting, e.g. sandbox.memoryMb');

/** One setting as every surface shows it. Values are what the file or the merged settings say, secrets as ***. */
export const SettingRowSchema = z.object({
  id: z.string().describe('The setting, e.g. sandbox.memoryMb'),
  key: z.array(z.string()),
  label: z.string(),
  category: z.string(),
  /** A heading inside the category (Toolchains › Node.js). */
  section: z.string().optional(),
  field: FieldSchema,
  /** In effect in this scope (this project: only what its file says). */
  value: z.unknown(),
  /** Written in this scope's file. */
  set: z.boolean(),
  /** Your own setting in effect (all projects), and whether your file sets it. */
  yours: z.unknown(),
  yoursSet: z.boolean(),
  /** What this project's file says (undefined: not set there, or a project cannot set it). */
  inProject: z.unknown().optional(),
  /** The built-in default (your own settings only). */
  default: z.unknown().optional(),
  /** A project can only make this stricter than your own setting. */
  locked: z.boolean(),
});
export type SettingRow = z.output<typeof SettingRowSchema>;

export const SettingsListSchema = z.object({
  scope: ScopeSchema,
  file: z.string().describe('The file this scope edits'),
  exists: z.boolean(),
  /** Your own settings: where the data folder is (it has its own flow; its setting is not listed). */
  dataFolder: z.string().optional(),
  /** Where an export goes by default (full path; your own settings only). */
  exportFile: z.string().optional().describe('Where an export goes by default (full path; your own settings only)'),
  categories: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() })),
  rows: z.array(SettingRowSchema),
});
export type SettingsList = z.output<typeof SettingsListSchema>;

export const listSettings = defineQuery({
  id: 'settings.list',
  title: 'Settings',
  summary: 'every setting with its value, by category',
  input: z.object({ scope: ScopeSchema.default('user') }),
  output: SettingsListSchema,
  cli: { name: 'config', action: 'list', json: true },
});

export const getSetting = defineQuery({
  id: 'settings.get',
  title: 'Get a setting',
  summary: 'show one setting (secrets as ***)',
  input: z.object({ key: KeySchema }),
  output: z.object({ key: z.string(), value: z.unknown() }),
  text: (o) => (typeof o.value === 'string' ? o.value : JSON.stringify(o.value, null, 2)),
  surfaces: { except: { menu: 'Settings shows every value', web: 'the Settings page shows every value' } },
  cli: { name: 'config', action: 'get', positional: ['key'] },
});

export const setSetting = defineOperation({
  id: 'settings.set',
  title: 'Change a setting',
  summary: 'change one setting (text is read like the command line: true/on, numbers, JSON)',
  input: z.object({
    scope: ScopeSchema.default('user'),
    key: KeySchema,
    value: z.unknown().describe('The new value'),
  }),
  output: z.object({ key: z.string(), changed: z.boolean(), message: z.string() }),
  text: (o) => o.message,
  cli: { name: 'config', action: 'set', positional: ['key', 'value'] },
});

export const resetSetting = defineOperation({
  id: 'settings.reset',
  title: 'Reset a setting',
  summary: 'put one setting back to its default (in a project file: remove it)',
  input: z.object({ scope: ScopeSchema.default('user'), key: KeySchema }),
  output: z.object({ key: z.string(), changed: z.boolean(), message: z.string() }),
  text: (o) => o.message,
  cli: { name: 'config', action: 'reset', positional: ['key'] },
});

const JsonFileSchema = z
  .string()
  .max(2000)
  .regex(/\.json$/i, 'The file name should end in .json.');

export const exportConfig = defineOperation({
  id: 'settings.export',
  title: 'Export settings…',
  summary: 'write the settings you changed to a .json file to share (no secrets, no data folder, no paths of this PC)',
  input: z.object({
    settingsFile: JsonFileSchema.optional().describe(
      '(export, import) the .json file; default sandbox-settings.json in the current folder',
    ),
    withPaths: z.boolean().default(false).describe('(export) keep folders and files of this PC in the file'),
  }),
  output: z.object({
    file: z.string().describe('The file written (full path)'),
    leftOut: z.array(z.string()).describe('What was left out, one "<key> (<why>)" each'),
    pathsLeftOut: z.boolean().describe('A folder or file of this PC was left out (and --with-paths was not given)'),
  }),
  text: (o) =>
    [
      'Wrote ' + o.file + ' (only what differs from the defaults).',
      ...(o.leftOut.length ? ['Left out:', ...o.leftOut.map((l) => '  ' + l)] : []),
      ...(o.pathsLeftOut ? ["Keep this PC's folders and files in the file with --with-paths."] : []),
    ].join('\n'),
  cli: {
    name: 'config',
    action: 'export',
    positional: ['settingsFile'],
    flags: { withPaths: { flag: '--with-paths' } },
  },
});

export const importConfig = defineOperation({
  id: 'settings.import',
  title: 'Import settings…',
  summary: 'read a shared settings file, show what it would change, and apply it after one yes',
  input: z.object({
    settingsFile: JsonFileSchema.optional().describe('(export, import) the .json file'),
  }),
  output: z.object({
    changed: z.number().describe('How many settings changed'),
    message: z.string().describe('What happened'),
  }),
  text: (o) => o.message,
  cli: { name: 'config', action: 'import', positional: ['settingsFile'] },
});

/** A file field of an operation's input, asked for in the page (a path to a file). */
function fileField(def: typeof exportConfig | typeof importConfig, label: string): Field {
  return {
    ...fieldOf(new SchemaNode(def.input).child('settingsFile')!, ['settingsFile']),
    label,
    optional: false,
  };
}

/** The facts under a setting: its key, your value, the project's, the default, and the lock. */
function details(row: SettingRow, scope: Scope): string[] {
  const text = (v: unknown): string => valueText(v, row.field, 40).text;
  return [
    'Setting       ' + row.id,
    'All projects  ' + text(row.yours) + (row.yoursSet ? '  (your file)' : '  (built-in default)'),
    'This project  ' + (row.inProject === undefined ? 'not set' : text(row.inProject)),
    ...(scope === 'user' ? ['Default       ' + text(row.default)] : []),
    ...(scope === 'project' && row.locked ? ['A project can only make this stricter than your own setting.'] : []),
  ];
}

function settingItem(row: SettingRow, scope: Scope): Item {
  const shown =
    scope === 'project' && !row.set
      ? 'all projects: ' + valueText(row.yours, row.field, 40).text
      : valueText(row.value, row.field).text;
  const editable = row.field.kind === 'secret' ? '' : row.value;
  return {
    id: row.id,
    label: row.label,
    hint: shown,
    ...(row.set ? { tone: scope === 'project' ? 'accent' : 'ok', badges: [{ text: 'changed', tone: 'accent' }] } : {}),
    description: row.field.help,
    group: row.section,
    details: details(row, scope),
    keywords: row.id,
    code: row.id,
    cells: { setting: row.id, value: shown },
    primary: action(
      setSetting,
      { scope, key: row.id },
      {
        label: 'Change',
        verb: 'edit',
        inline: true,
        fields: [{ ...row.field, name: 'value', label: row.label }],
        initial: { value: editable },
      },
    ),
    actions: row.set
      ? [
          action(
            resetSetting,
            { scope, key: row.id },
            { label: scope === 'project' ? 'Remove' : 'Reset to default', verb: 'reset', key: 'r' },
          ),
        ]
      : [],
  };
}

/** The Data folder row: where the saved data is; changing it asks for the folder, then moves or switches (storage). */
function dataFolderItem(folder: string): Item {
  return {
    id: '@data-folder',
    label: 'Data folder',
    hint: folder,
    cells: { setting: 'storage.root', value: folder },
    description:
      'Where your tools, logins, history and logs are kept between sandboxes. Move it with sandbox storage move <folder>.',
    primary: action(changeDataFolder, {}, { label: 'Data folder', verb: 'change' }),
  };
}

/** The settings page of one scope: a section per category, each setting with its value and an edit action. */
export function settingsPage(o: SettingsList): Page {
  const sections: Section[] = o.categories.map((c) => ({
    id: c.id,
    title: c.label,
    description: c.description,
    columns: [
      { key: 'setting', label: 'SETTING' },
      { key: 'value', label: 'VALUE' },
    ],
    columnsOn: 'cli',
    items: [
      ...o.rows.filter((r) => r.category === c.id).map((r) => settingItem(r, o.scope)),
      ...(c.id === 'general' && o.dataFolder ? [dataFolderItem(o.dataFolder)] : []),
    ],
  }));
  return {
    title: 'Settings',
    categories: true,
    notice: {
      text:
        'Editing ' +
        o.file +
        (o.exists ? '' : ' (created when you save)') +
        (o.scope === 'project' ? ': only what a project may set; needs your approval at the next launch' : ''),
      tone: o.scope === 'project' ? 'accent' : 'muted',
    },
    sections,
    // Export and import are for your own settings only (never on the project tab).
    actions:
      o.scope === 'user'
        ? [
            action(
              exportConfig,
              {},
              {
                verb: 'export',
                fields: [fileField(exportConfig, 'Where to write the settings file')],
                initial: { settingsFile: o.exportFile },
                description:
                  'Write the settings you changed to a .json file you can share with a team. Secrets, the data folder and folders or files of this PC are left out.',
              },
            ),
            action(
              importConfig,
              {},
              {
                verb: 'import',
                fields: [fileField(importConfig, 'Which settings file')],
                description:
                  'Read a settings file someone shared, see what it would change, and apply it once you say yes. Secrets, the data folder and paths in it are never taken.',
              },
            ),
          ]
        : [],
  };
}

export const settingsView = defineView({
  id: 'settings',
  title: 'Settings',
  summary: 'Every setting, for all projects or just this project, with its value, default and description.',
  queries: { settings: listSettings },
  operations: [setSetting, resetSetting, exportConfig, importConfig, changeDataFolder],
  pickers: [browseFolder],
  tabs: {
    param: 'scope',
    choices: [
      { value: 'user', label: 'All projects' },
      { value: 'project', label: 'This project' },
    ],
  },
  inputs: (params: { scope: Scope }) => ({ settings: { scope: params.scope } }),
  build: ({ settings }) => settingsPage(settings),
});
