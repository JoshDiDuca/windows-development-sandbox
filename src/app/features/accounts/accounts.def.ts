// Accounts: the saved logins of every agent that keeps one, and what to do with them (save, use, default, rename,
// remove). Pure: schemas, labels, the CLI hints of the `account` command's actions, the view and its page builders.
// accounts.run.ts does the work over AccountsService.
import { z } from 'zod';
import {
  action,
  defineOperation,
  defineQuery,
  defineView,
  plural,
  type Item,
  type Page,
  type Section,
} from '../../kernel/index.js';
import { setSetting } from '../settings/settings.def.js';
import {
  listServices,
  SERVICE_OPERATIONS,
  serviceSections,
  ServiceRowSchema,
  type ServicesList,
} from './services.def.js';

const AgentSchema = z.string().default('claude').describe('whose login: an agent that keeps one (default: claude)');
const NameSchema = z.string().optional().describe('account name');

export const AccountRowSchema = z.object({
  name: z.string().describe('The saved login'),
  email: z.string().nullable().describe('Its email, when the agent says'),
  isDefault: z.boolean().describe('New launches start with it'),
  isActive: z.boolean().describe('The sandbox uses it now'),
  savedAt: z.string().describe('When it was saved (ISO time)'),
  kind: z
    .enum(['subscription', 'console', 'api-key'])
    .optional()
    .describe('Claude: a subscription login, a Claude Console login (its API key), or an API key you gave'),
  keyHint: z.string().nullable().optional().describe('The most of an API key ever shown: sk-ant-...abcd'),
});
export type AccountRow = z.output<typeof AccountRowSchema>;

const KIND_LABELS = { subscription: 'subscription', console: 'Console', 'api-key': 'API key' } as const;

/** "API key sk-ant-...abcd", "Console sk-ant-...abcd", "subscription"; null when the agent does not say. */
export function kindText(r: Pick<AccountRow, 'kind' | 'keyHint'>): string | null {
  if (!r.kind) return null;
  return KIND_LABELS[r.kind] + (r.keyHint ? ' ' + r.keyHint : '');
}

export const AgentAccountsSchema = z.object({
  name: z.string().describe('The agent'),
  kept: z.boolean().describe('Its login can be saved and switched'),
  canSavePc: z.boolean().describe("This PC's login can be saved"),
  accounts: z.array(AccountRowSchema).describe('Its saved logins (empty when not kept)'),
});
export type AgentAccounts = z.output<typeof AgentAccountsSchema>;

export const AccountsListSchema = z.object({
  agent: z.string().describe('The agent asked for (the command line table shows only it)'),
  agents: z.array(AgentAccountsSchema).describe('Every agent, Claude first'),
  services: z.array(ServiceRowSchema).describe('Service sign-ins for sandboxes (Epic, Steam ...)'),
});
export type AccountsList = z.output<typeof AccountsListSchema>;

const MessageSchema = z.object({ message: z.string().describe('What happened') });

/** The name rule of a saved login: what the store accepts. */
export const NAME_RULE = 'Use letters, digits, - and _ (up to 40).';

/** The "Services" block under `sandbox account list`: one line per service that is shared or saved. */
function servicesBlock(o: AccountsList): string[] {
  const kept = o.services.filter((s) => s.share || s.state !== 'none');
  const lines = kept.map(
    (s) =>
      '  ' +
      s.kind.padEnd(10) +
      (s.share ? 'shared' : 'not shared') +
      ', ' +
      (s.state === 'none' ? 'not saved' : s.state === 'saved' ? 'saved' : 'cannot be read'),
  );
  return ['', 'Services' + (kept.length ? '' : ': none shared or saved') + '   (sandbox account status)', ...lines];
}

/** `sandbox account list`: the table of one agent, as the command line has always padded it. */
export function accountsText(o: AccountsList): string {
  return [agentText(o), ...servicesBlock(o)].join('\n');
}

function agentText(o: AccountsList): string {
  const rows = o.agents.find((a) => a.name === o.agent)?.accounts ?? [];
  if (!rows.length)
    return o.agent === 'claude'
      ? "No saved accounts. Sign in inside the sandbox, then: sandbox account save <name>   (or --from-host to save this PC's login, or --api-key to type an API key)"
      : 'No saved ' +
          o.agent +
          ' accounts. Sign in inside the sandbox, then: sandbox account save <name> --agent ' +
          o.agent;
  // The KIND column only for an agent whose logins have kinds (Claude).
  const kinds = rows.some((a) => a.kind);
  const table = [
    ['', 'NAME', ...(kinds ? ['KIND'] : []), 'EMAIL', 'SAVED'],
    ...rows.map((a) => [
      (a.isActive ? '*' : ' ') + (a.isDefault ? 'D' : ' '),
      a.name,
      ...(kinds ? [kindText(a) ?? '-'] : []),
      a.email ?? '-',
      a.savedAt.slice(0, 16).replace('T', ' '),
    ]),
  ];
  const widths = table[0].map((_, i) => Math.max(...table.map((r) => r[i].length)));
  const lines = table.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] + 2))).join(''));
  return [...lines, '', '* = active in the sandbox   D = default for new launches'].join('\n');
}

export const listAccounts = defineQuery({
  id: 'accounts.list',
  title: 'Accounts',
  summary: 'Claude logins: list, save, use, set the default, remove',
  input: z.object({ agent: AgentSchema }),
  output: AccountsListSchema,
  text: accountsText,
  cli: {
    name: 'account',
    action: 'list',
    json: true,
    flags: { agent: { flag: '--agent', value: 'name', choices: 'harnesses', label: 'Agent' } },
    // `sandbox account list --json` has always printed the rows of the one agent.
    shapeJson: (o) => o.agents.find((a) => a.name === o.agent)?.accounts ?? [],
  },
});

export const saveAccount = defineOperation({
  id: 'accounts.save',
  title: "Save the sandbox's login",
  summary: "save the sandbox's (or this PC's) login under a name",
  input: z.object({
    agent: AgentSchema,
    name: NameSchema,
    fromHost: z.boolean().default(false).describe("(save) save this PC's login instead of the sandbox's"),
    apiKey: z
      .boolean()
      .default(false)
      .describe("(save, Claude) an Anthropic API key: typed in (hidden), or with --from-host this PC's"),
  }),
  output: z.object({ name: z.string().describe('The saved login'), message: z.string().describe('What happened') }),
  text: (o) => o.message,
  cli: {
    name: 'account',
    action: 'save',
    positional: ['name'],
    flags: { agent: { flag: '--agent' }, fromHost: { flag: '--from-host' }, apiKey: { flag: '--api-key' } },
  },
});

export const useAccount = defineOperation({
  id: 'accounts.use',
  title: 'Use this login',
  summary: 'make the sandbox use a saved login (running sessions restart)',
  input: z.object({
    agent: AgentSchema,
    name: NameSchema,
    noRestart: z.boolean().default(false).describe('(use) do not restart running sessions'),
  }),
  output: z.object({ lines: z.array(z.string()).describe('What happened, line by line') }),
  text: (o) => o.lines.join('\n'),
  cli: {
    name: 'account',
    action: 'use',
    positional: ['name'],
    flags: { agent: { flag: '--agent' }, noRestart: { flag: '--no-restart' } },
  },
});

export const defaultAccount = defineOperation({
  id: 'accounts.default',
  title: 'Make default',
  summary: 'the login every launch starts with; the sandbox switches to it now too',
  input: z.object({
    agent: AgentSchema,
    name: NameSchema,
    noRestart: z.boolean().default(false).describe('(default) do not restart running sessions'),
  }),
  output: MessageSchema,
  text: (o) => o.message,
  cli: {
    name: 'account',
    action: 'default',
    positional: ['name'],
    flags: { agent: { flag: '--agent' }, noRestart: { flag: '--no-restart' } },
  },
});

export const renameAccount = defineOperation({
  id: 'accounts.rename',
  title: 'Rename…',
  summary: 'give a saved login another name (it keeps working)',
  input: z.object({
    agent: AgentSchema,
    name: NameSchema,
    to: z.string().optional().describe('(rename) the new name'),
  }),
  output: MessageSchema,
  text: (o) => o.message,
  cli: {
    name: 'account',
    action: 'rename',
    positional: ['name'],
    flags: { agent: { flag: '--agent' }, to: { flag: '--to' } },
  },
});

export const removeAccount = defineOperation({
  id: 'accounts.remove',
  title: 'Remove…',
  summary: 'delete a saved login (you would sign in again)',
  danger: true,
  input: z.object({ agent: AgentSchema, name: NameSchema }),
  output: MessageSchema,
  text: (o) => o.message,
  cli: {
    name: 'account',
    action: 'remove',
    positional: ['name'],
    flags: { agent: { flag: '--agent' } },
    yes: '(remove) do not ask first',
  },
});

/** One agent's save rows (the sandbox's login, and this PC's when it can be saved). */
function saveItems(a: AgentAccounts): Item[] {
  return [
    {
      id: '@save-sandbox',
      label: "+ Save the sandbox's login…",
      group: 'Save a login',
      description: 'Saves the ' + a.name + ' login you signed in with inside the sandbox, under a name you choose.',
      primary: action(
        saveAccount,
        { agent: a.name, fromHost: false },
        { verb: 'save', label: "Save the sandbox's login" },
      ),
    },
    ...(a.canSavePc
      ? [
          {
            id: '@save-pc',
            label: "+ Save this PC's login…",
            group: 'Save a login',
            description: 'Saves the ' + a.name + ' login of this PC, under a name you choose.',
            primary: action(
              saveAccount,
              { agent: a.name, fromHost: true },
              { verb: 'save', label: "Save this PC's login" },
            ),
          },
        ]
      : []),
    ...(a.name === 'claude'
      ? [
          {
            id: '@save-key',
            label: '+ Save an API key…',
            group: 'Save a login',
            description:
              'Saves an Anthropic API key (from the Claude Console) under a name you choose. What you type is not shown.',
            primary: action(
              saveAccount,
              { agent: a.name, fromHost: false, apiKey: true },
              { verb: 'save', label: 'Save an API key' },
            ),
          },
        ]
      : []),
  ];
}

/** One saved login: its state in the hint and badges, Enter or a click uses it, d/r/x change it. */
function loginItem(a: AgentAccounts, r: AgentAccounts['accounts'][number]): Item {
  const kind = kindText(r);
  const hint = [r.kind ? KIND_LABELS[r.kind] : '', r.isActive ? 'in the sandbox' : '', r.isDefault ? 'default' : '']
    .filter(Boolean)
    .join(' · ');
  return {
    id: a.name + ':' + r.name,
    label: r.name,
    group: 'Saved logins',
    icon: a.name,
    hint,
    badges: [
      ...(r.kind ? [{ text: KIND_LABELS[r.kind], tone: r.kind === 'subscription' ? 'muted' : 'warn' } as const] : []),
      ...(r.isActive ? [{ text: 'in the sandbox', tone: 'ok' as const }] : []),
      ...(r.isDefault ? [{ text: 'default', tone: 'accent' as const }] : []),
    ],
    description: r.isActive ? 'The sandbox uses this login now.' : 'Choose it to make the sandbox use this login.',
    details: [
      'Agent  ' + a.name,
      ...(kind ? ['Kind   ' + kind] : []),
      'Email  ' + (r.email ?? '-'),
      'Saved  ' + r.savedAt.slice(0, 16).replace('T', ' '),
    ],
    // The login in use already offers nothing to switch to.
    ...(r.isActive ? {} : { primary: action(useAccount, { agent: a.name, name: r.name }, { verb: 'use' }) }),
    actions: [
      action(defaultAccount, { agent: a.name, name: r.name }, { key: 'd', verb: 'make default', importance: 1 }),
      action(renameAccount, { agent: a.name, name: r.name }, { key: 'r', verb: 'rename', importance: 2 }),
      action(removeAccount, { agent: a.name, name: r.name }, { key: 'x', verb: 'remove', importance: 1 }),
    ],
  };
}

/** One agent's card: its save rows and logins (a card to pick from), or the note that its login is not kept. */
export function agentSection(a: AgentAccounts): Section {
  if (!a.kept)
    return {
      id: a.name,
      title: a.name,
      summary: 'not kept between sandboxes',
      items: [
        {
          id: 'info:' + a.name,
          label: "This agent's login is not kept between sandboxes",
          tone: 'muted',
          description: 'Sign in again in each new sandbox, or use an API key in the agent’s environment.',
        },
      ],
    };
  return {
    id: a.name,
    title: a.name,
    summary: a.accounts.length ? plural(a.accounts.length, 'saved login') : 'no saved login yet',
    cards: true,
    items: [...saveItems(a), ...a.accounts.map((r) => loginItem(a, r))],
  };
}

/** The web's page: one card per agent (its logins and the save rows), then one section per service sign-in. */
export function accountsPage(o: AccountsList, services: ServicesList = { services: o.services }): Page {
  return { title: 'Accounts', sections: [...o.agents.map(agentSection), ...serviceSections(services)] };
}

/**
 * One agent's page for the menu: its section, and the keys of its save rows (s, p) which the menu's key bar shows
 * while the agent's category is open. The keys of a login row (d, r, x) are on the row itself.
 */
export function agentPage(a: AgentAccounts): Page {
  const keys = a.kept
    ? [
        action(
          saveAccount,
          { agent: a.name, fromHost: false },
          { key: 's', verb: 'save sandbox login', importance: 3 },
        ),
        ...(a.canSavePc
          ? [action(saveAccount, { agent: a.name, fromHost: true }, { key: 'p', verb: 'save PC login', importance: 3 })]
          : []),
        ...(a.name === 'claude'
          ? [
              action(
                saveAccount,
                { agent: a.name, fromHost: false, apiKey: true },
                { key: 'k', verb: 'save API key', importance: 3 },
              ),
            ]
          : []),
      ]
    : [];
  return { title: 'Accounts', sections: [agentSection(a)], actions: keys };
}

export const accountsView = defineView({
  id: 'accounts',
  title: 'Accounts',
  summary:
    'Logins saved on this PC for each agent (every launch starts with the default; "Use this login" switches now), and the service sign-ins sandboxes may get (Epic, Steam, Unity, signing keys ...).',
  queries: { accounts: listAccounts, services: listServices },
  operations: [
    saveAccount,
    useAccount,
    defaultAccount,
    renameAccount,
    removeAccount,
    ...SERVICE_OPERATIONS,
    setSetting,
  ],
  build: ({ accounts, services }) => accountsPage(accounts, services),
});
