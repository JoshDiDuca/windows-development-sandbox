// The program's own updates (install, check, go back, automatic on/off) and your saved settings brought up to date.
// Pure: schemas, labels, CLI hints and the page builder; updates.run.ts does the work through UpdateService and
// MigrateService.
import { z } from 'zod';
import {
  action,
  defineOperation,
  defineQuery,
  defineView,
  type Item,
  type Page,
  type Section,
} from '../../kernel/index.js';

const FailedSchema = z.object({
  version: z.string().describe('The version that failed'),
  reason: z.string().describe('Why it failed, in one sentence'),
});

export const UpdatesStatusSchema = z.object({
  managed: z.boolean().describe('Installed by the installer, so it can update itself'),
  version: z.string().describe('The version installed'),
  scope: z.enum(['user', 'machine']).nullable().describe('Installed for you, or for everyone on this PC'),
  autoUpdate: z.boolean().describe('New versions install by themselves'),
  autoOffText: z.string().nullable().describe('Why automatic updates were turned off, if they were'),
  previous: z.string().nullable().describe('The version an update replaced (roll back goes there)'),
  failed: FailedSchema.nullable().describe('The last update that failed'),
  npmCommand: z.string().describe('How an npm install is updated'),
  error: z.string().nullable().describe('Why the status could not be read'),
  settings: z
    .object({
      pending: z.array(z.string()).describe('Each change still to make, as "name: what it does"'),
      error: z.string().nullable().describe('Why your saved settings could not be read'),
    })
    .describe('Changes still to make to your saved settings'),
});
export type UpdatesStatus = z.output<typeof UpdatesStatusSchema>;

export const updatesStatus = defineQuery({
  id: 'updates.status',
  title: 'Updates',
  summary: 'which version is installed and what your saved settings still need',
  input: z.object({}),
  output: UpdatesStatusSchema,
  surfaces: {
    except: { cli: 'no command shows this page; sandbox update --check and --version cover the command line' },
  },
});

const LineSchema = z.object({ line: z.string().describe('What happened, in one sentence') });

export const runUpdate = defineOperation({
  id: 'updates.update',
  title: 'Update now',
  summary: 'install the newest version, or check, go back, or switch automatic updates',
  input: z.object({
    check: z.boolean().default(false).describe('only look whether a newer version exists'),
    rollback: z.boolean().default(false).describe('go back to the version before the last update'),
    auto: z
      .enum(['on', 'off'])
      .optional()
      .describe('install new versions by themselves (for everyone on this PC: needs an admin terminal)'),
    unattended: z.boolean().default(false).describe('used by automatic updates: no questions, short output'),
    feed: z
      .string()
      .optional()
      .describe('take the release from this folder (a feed.json and the package) instead of GitHub'),
  }),
  output: LineSchema.extend({ latest: z.string().nullable().describe('The newer version a check found') }),
  danger: true,
  text: (o) => o.line,
  cli: {
    name: 'update',
    group: 'Health',
    flags: {
      check: { flag: '--check' },
      rollback: { flag: '--rollback' },
      auto: { flag: '--auto', value: 'on|off' },
      unattended: { flag: '--unattended', noMenu: true, advanced: true },
      feed: { flag: '--feed', value: 'folder', noMenu: true, advanced: true },
    },
    yes: '(--rollback) do not ask first',
  },
});

export const migrateSettings = defineOperation({
  id: 'updates.migrate',
  title: 'Update saved settings',
  summary: 'bring your saved settings up to date with this version',
  input: z.object({
    dryRun: z.boolean().default(false).describe('only list what would change'),
    restore: z
      .string()
      .optional()
      .describe('put back the files saved before an update (a folder under <storage>\\backups)'),
  }),
  output: LineSchema,
  text: (o) => o.line,
  cli: {
    name: 'migrate',
    group: 'Health',
    flags: { dryRun: { flag: '--dry-run' }, restore: { flag: '--restore', value: 'backup', advanced: true } },
    yes: '(--restore) do not ask first',
  },
});

const row = (id: string, label: string, extra: Partial<Item> = {}): Item => ({ id: 'updates:' + id, label, ...extra });

/** The Updates page: "This program" (version, newest, automatic updates, previous, last failure) and saved settings. */
export function updatesPage(s: UpdatesStatus, latest: string | null): Page {
  const managed = s.managed && !s.error;
  const machine = s.scope === 'machine';
  const nextAuto = s.autoUpdate ? 'off' : 'on';
  const rollback = action(runUpdate, { rollback: true }, { label: 'Roll back', verb: 'go back' });
  const program: Section = {
    id: 'program',
    title: 'This program',
    notes: [
      {
        text: 'After an update this page still runs the version it started with; sandbox web open (or the next sandbox start) starts the new one.',
        tone: 'muted',
        only: 'web',
      },
    ],
    items: s.error
      ? [{ id: 'updates:error', label: s.error, tone: 'danger' }]
      : !s.managed
        ? [
            row('version', 'Version', {
              hint: s.version,
              description: 'Installed with npm, so npm updates it: ' + s.npmCommand,
            }),
            row('npm', 'Update', {
              hint: 'with npm',
              tone: 'muted',
              description: 'Run ' + s.npmCommand + ' in a terminal.',
            }),
          ]
        : [
            row('version', 'Version', {
              hint: s.version,
              description: 'Installed ' + (machine ? 'for everyone on this PC' : 'for you') + '.',
            }),
            row('latest', 'Newest version', {
              hint: latest ?? 'not looked yet',
              tone: latest ? 'warn' : 'muted',
              keys: latest ? 'Enter installs it.' : 'Enter looks on GitHub for a newer version.',
              primary: latest
                ? action(runUpdate, {}, { label: 'Install ' + latest, verb: 'install' })
                : action(runUpdate, { check: true }, { label: 'Check now', verb: 'look', danger: false }),
            }),
            row('auto', 'Automatic updates', {
              hint: s.autoUpdate ? 'on' : 'off',
              tone: s.autoUpdate ? 'ok' : 'muted',
              description: machine
                ? 'For everyone: needs an admin terminal.'
                : 'A new version installs once a day, even while a sandbox runs (it keeps its version until it restarts).',
              keys: 'Enter switches them.',
              primary: action(
                runUpdate,
                { auto: nextAuto },
                {
                  label: 'Automatic updates ' + nextAuto,
                  verb: 'switch',
                  danger: false,
                },
              ),
              actions: [
                action(
                  runUpdate,
                  { auto: nextAuto },
                  {
                    key: 'a',
                    label: 'Automatic updates ' + nextAuto,
                    verb: 'automatic on/off',
                    danger: false,
                  },
                ),
              ],
            }),
            ...(s.autoOffText
              ? [
                  row('autooff', 'Automatic updates turned off', {
                    hint: 'off',
                    tone: 'warn',
                    description: s.autoOffText,
                  }),
                ]
              : []),
            ...(s.previous
              ? [
                  row('previous', 'Previous version', {
                    hint: s.previous,
                    keys: 'Enter goes back to it.',
                    primary: rollback,
                    actions: [{ ...rollback, key: 'r', verb: 'roll back' }],
                  }),
                ]
              : []),
            ...(s.failed
              ? [
                  row('failed', 'Last failed update', {
                    hint: s.failed.version,
                    tone: 'danger',
                    description: 'It is not tried again until a newer version is released.',
                    details: [s.failed.reason],
                  }),
                ]
              : []),
          ],
  };
  const pending = s.settings.pending;
  const settingsItems: Item[] = s.settings.error
    ? [{ id: 'settings:error', label: s.settings.error, tone: 'danger' }]
    : pending.length
      ? pending.map((line, i) => ({
          id: 'settings:' + i,
          label: line.split(':')[0],
          hint: 'to update',
          tone: 'warn' as const,
          description: 'A backup is kept first.',
          keys: 'Enter updates your saved settings.',
          details: [line],
          primary: action(migrateSettings, {}, { label: 'Update saved settings', verb: 'update' }),
          actions: [
            action(migrateSettings, {}, { key: 's', label: 'Update saved settings', verb: 'update saved settings' }),
          ],
        }))
      : [{ id: 'settings:none', label: 'Up to date', hint: 'OK', tone: 'ok', description: 'Nothing to update.' }];
  const settings: Section = { id: 'settings', title: 'Saved settings', items: settingsItems };
  return {
    title: 'Updates',
    sections: [program, settings],
    actions: managed
      ? [
          action(runUpdate, { check: true }, { key: 'c', label: 'Check now', verb: 'check now', danger: false }),
          action(runUpdate, {}, { key: 'u', label: 'Update now', verb: 'update now' }),
        ]
      : [],
  };
}

export const updatesView = defineView({
  id: 'updates',
  title: 'Updates',
  summary: 'Which version is installed, installing a newer one, and bringing your saved settings up to date.',
  queries: { status: updatesStatus },
  operations: [runUpdate, migrateSettings],
  build: ({ status }) => updatesPage(status, null),
});
