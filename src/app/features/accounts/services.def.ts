// Service sign-ins for sandboxes (accounts.<kind>.share): Epic, Steam, Unity, Cfx.re, signing keys, app-store keys
// and Perplexity (its API key, Comet's sign-in). Whether each one is shared and saved (where it came from and when,
// never its value), taking one from this PC or a file, typing one, and forgetting it. Pure: schemas, labels and page
// builders; services.run.ts does the work. The kinds live in shared/accounts (a def imports no shared code): the
// query's rows carry everything a page shows.
import { z } from 'zod';
import { action, type Action, type Fact, type Item, type Note, type Page, type Section } from '../../kernel/index.js';
import { defineOperation, defineQuery } from '../../kernel/index.js';
import { setSetting } from '../settings/settings.def.js';

/** The kinds, as the help says them (the self-test checks this against shared/accounts SERVICE_KINDS). */
export const SERVICE_NAMES_TEXT = 'epic, steam, unity, cfx, keystore, play, expo, appstore, perplexity or comet';

const KindSchema = z
  .string()
  .max(40)
  .optional()
  .describe('the service: ' + SERVICE_NAMES_TEXT);

export const ServiceRowSchema = z.object({
  kind: z.string().describe('The service (epic, steam ...)'),
  label: z.string().describe('Its name'),
  share: z.boolean().describe('Sandboxes get it (setting accounts.<kind>.share)'),
  state: z.enum(['none', 'saved', 'unreadable']).describe('Whether one is saved and can be opened by you'),
  source: z.string().nullable().describe('Where the saved one came from: pc, file, typed or sandbox'),
  savedAt: z.string().nullable().describe('When it was saved'),
  summary: z.string().nullable().describe('Which account (never the secret)'),
  heldBy: z.string().nullable().describe('The data set whose sandbox holds it now (one-holder services)'),
  usedBy: z.array(z.string()).describe('The toolchains (or apps) it is handed over for'),
  usedFor: z.string().describe('The same, in words ("unreal", "the Comet app")'),
  warnings: z.array(z.string()).describe('What everyone who shares it must know'),
  canImport: z.boolean().describe('It can be taken from this PC or a file (sandbox account import)'),
  canLogin: z.boolean().describe('It can be typed (sandbox account login)'),
  needsFile: z.boolean().describe('Importing it needs --from <file>'),
});
export type ServiceRow = z.output<typeof ServiceRowSchema>;

export const ServicesListSchema = z.object({ services: z.array(ServiceRowSchema) });
export type ServicesList = z.output<typeof ServicesListSchema>;

const STATE_TEXT: Readonly<Record<ServiceRow['state'], string>> = {
  none: 'not saved',
  saved: 'saved (encrypted)',
  unreadable: 'cannot be read',
};
const STATE_TONE: Readonly<Record<ServiceRow['state'], Fact['tone']>> = {
  none: 'muted',
  saved: 'ok',
  unreadable: 'danger',
};
const SOURCE_TEXT: Readonly<Record<string, string>> = {
  pc: 'taken from this PC',
  file: 'from a file',
  typed: 'typed in',
  sandbox: 'signed in (or renewed) in a sandbox',
};

const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');

/** `sandbox account status`: one line per service. */
export function servicesText(o: ServicesList): string {
  const table = [
    ['SERVICE', 'SHARE', 'SIGN-IN', 'SAVED', 'NOTE'],
    ...o.services.map((s) => [
      s.kind,
      s.share ? 'on' : 'off',
      STATE_TEXT[s.state],
      day(s.savedAt) || '-',
      [s.summary, s.heldBy ? 'in use by sandbox ' + s.heldBy : null].filter(Boolean).join(', ') || '-',
    ]),
  ];
  const widths = table[0].map((_, i) => Math.max(...table.map((r) => r[i].length)));
  return table
    .map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] + 2))).join(''))
    .join('\n');
}

export const listServices = defineQuery({
  id: 'accounts.services',
  title: 'Services',
  summary: 'service sign-ins for sandboxes (Epic, Steam, Unity, signing keys ...): shared or not, saved or not',
  input: z.object({ name: KindSchema }),
  output: ServicesListSchema,
  text: servicesText,
  cli: { name: 'account', action: 'status', positional: ['name'], json: true },
});

const MessageSchema = z.object({ message: z.string().describe('What happened') });

export const serviceImport = defineOperation({
  id: 'accounts.service.import',
  title: 'Import…',
  summary: "save a service sign-in from this PC's program or a file, for sandboxes",
  input: z.object({
    name: KindSchema,
    from: z.string().max(1000).optional().describe('(import) the file or folder to take the sign-in from'),
  }),
  output: MessageSchema,
  text: (o) => o.message,
  cli: { name: 'account', action: 'import', positional: ['name'], flags: { from: { flag: '--from', value: 'path' } } },
});

export const serviceLogin = defineOperation({
  id: 'accounts.service.login',
  title: 'Sign in…',
  summary: 'type a service key or token to keep for sandboxes',
  input: z.object({ name: KindSchema }),
  output: MessageSchema,
  text: (o) => o.message,
  cli: { name: 'account', action: 'login', positional: ['name'] },
});

export const serviceLogout = defineOperation({
  id: 'accounts.service.logout',
  title: 'Forget…',
  summary: 'delete a saved service sign-in, and every copy a sandbox left that this PC has not taken yet',
  danger: true,
  input: z.object({ name: KindSchema }),
  output: z.object({ deleted: z.boolean().describe('One was saved and is gone'), message: z.string() }),
  text: (o) => o.message,
  cli: { name: 'account', action: 'logout', positional: ['name'] },
});

export const SERVICE_OPERATIONS = [serviceImport, serviceLogin, serviceLogout] as const;

/** The category id of a service in the menu and its section id on the web. */
export function serviceCategory(kind: string): string {
  return 'service:' + kind;
}

/** What can be done with one service: share or stop, import, sign in, forget. */
function serviceActions(s: ServiceRow): Action[] {
  return [
    action(
      setSetting,
      { scope: 'user', key: 'accounts.' + s.kind + '.share', value: !s.share },
      {
        key: 't',
        verb: s.share ? 'stop sharing' : 'share',
        label: s.share ? 'Stop sharing' : 'Share with sandboxes',
        importance: 1,
      },
    ),
    ...(s.canImport ? [action(serviceImport, { name: s.kind }, { key: 'i', verb: 'import', importance: 1 })] : []),
    ...(s.canLogin ? [action(serviceLogin, { name: s.kind }, { key: 'n', verb: 'sign in', importance: 1 })] : []),
    ...(s.state !== 'none'
      ? [action(serviceLogout, { name: s.kind }, { key: 'x', verb: 'forget', importance: 2 })]
      : []),
  ];
}

/** How to get a first sign-in, in words. */
function howTo(s: ServiceRow): string {
  const ways = [
    ...(s.canImport ? ['sandbox account import ' + s.kind + (s.needsFile ? ' --from <file>' : '')] : []),
    ...(s.canLogin ? ['sandbox account login ' + s.kind] : []),
  ];
  return ways.length
    ? ways.join(', or ')
    : "sign in once inside a sandbox (it can't be copied from this PC: Windows locks it to your PC account)";
}

/** One service's section: its facts, its warnings and its actions. */
export function serviceSection(s: ServiceRow): Section {
  const facts: Fact[] = [
    {
      id: s.kind + ':share',
      label: 'Shared with sandboxes',
      value: s.share ? 'on' : 'off  (sandbox config set accounts.' + s.kind + '.share true)',
      tone: s.share ? 'ok' : 'muted',
      description: 'For sandboxes that use ' + s.usedFor + '. ' + s.warnings.join(' '),
    },
    {
      id: s.kind + ':state',
      label: 'Sign-in',
      value: STATE_TEXT[s.state] + (s.savedAt ? '  ' + day(s.savedAt) : ''),
      tone: STATE_TONE[s.state],
      description: s.state === 'none' ? 'Save one: ' + howTo(s) + '.' : undefined,
    },
    ...(s.source ? [{ id: s.kind + ':source', label: 'From', value: SOURCE_TEXT[s.source] ?? s.source }] : []),
    ...(s.summary ? [{ id: s.kind + ':summary', label: 'Account', value: s.summary }] : []),
    ...(s.heldBy
      ? [{ id: s.kind + ':held', label: 'In use by', value: 'sandbox ' + s.heldBy, tone: 'accent' as const }]
      : []),
  ];
  const warnings: Item[] = s.warnings.map((w, i) => ({
    id: s.kind + ':warning:' + i,
    label: w,
    tone: 'warn' as const,
    group: 'Before you share it',
  }));
  const notes: Note[] = [
    ...(s.state === 'unreadable'
      ? [{ text: 'Only the Windows user that saved it can read it: save it again.', tone: 'muted' as const }]
      : []),
  ];
  return {
    id: serviceCategory(s.kind),
    title: s.label,
    summary: (s.share ? 'shared' : 'not shared') + ' · ' + STATE_TEXT[s.state],
    facts,
    items: warnings,
    notes,
    actions: serviceActions(s),
  };
}

/** The sections of every service (appended to the accounts page on the web). */
export function serviceSections(o: ServicesList): Section[] {
  return o.services.map(serviceSection);
}

/** One service's page for the menu: its section, and its actions as keys. */
export function servicePage(s: ServiceRow): Page {
  return { title: 'Accounts', sections: [serviceSection(s)] };
}
