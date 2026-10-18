// The GitHub token for sandboxes: whether sharing is on, whether a token is saved (its kind and date, never its value),
// and saving or deleting it. Pure: schemas, labels and the view; github.run.ts does the work. The token itself is never
// an input or an output.
import { z } from 'zod';
import {
  action,
  defineOperation,
  defineQuery,
  defineView,
  type Fact,
  type Note,
  type Page,
  type Section,
} from '../../kernel/index.js';

/** Where GitHub makes a fine-grained token. */
export const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

/** The steps to make a token for sandboxes (shown before asking for it). */
export const GITHUB_STEPS: readonly string[] = [
  'Open ' + NEW_TOKEN_URL + ' (a fine-grained personal access token).',
  'Under "Repository access" choose "Only select repositories" and pick only the ones the agent should reach.',
  'Give only the permissions it needs, for example Contents (read and write), Pull requests (read and write) and Actions (read).',
  'Set an expiry date, then generate the token and copy it.',
];

/** What everyone who shares a token must know: on every surface. */
export const GITHUB_WARNINGS: readonly string[] = [
  'The agent in the sandbox can read the token and use it for everything it allows: limit it to some repositories and permissions.',
  'It is handed over only with github.shareToken on and git access "full". Revoke it on GitHub whenever you like.',
];

const TokenStateSchema = z
  .enum(['none', 'saved', 'unreadable'])
  .describe('Whether a token is saved and can be opened by you');

export const GithubStatusSchema = z.object({
  shareToken: z.boolean().describe('Sandboxes get the token (setting github.shareToken)'),
  gitAccess: z.enum(['full', 'readonly', 'none']).describe('Git access in your settings (provisioning.git.access)'),
  token: TokenStateSchema,
  kind: z.enum(['fine-grained', 'classic']).nullable().describe('What kind of token is saved (never the token)'),
  savedAt: z.string().nullable().describe('When the token was saved (the date and time, never the token)'),
});
export type GithubStatus = z.output<typeof GithubStatusSchema>;

export const githubStatus = defineQuery({
  id: 'github.status',
  title: 'GitHub',
  summary: 'whether sandboxes get your GitHub token, and whether one is saved (never the token)',
  input: z.object({}).strict(),
  output: GithubStatusSchema,
  cli: { name: 'github', action: 'status', json: true },
});

export const githubLogin = defineOperation({
  id: 'github.login',
  title: 'Save the GitHub token…',
  summary: 'save a GitHub token for sandboxes (typed hidden, kept encrypted, never printed)',
  input: z.object({}).strict(),
  output: z.object({ message: z.string().describe('What happened') }),
  text: (o) => o.message,
  cli: { name: 'github', action: 'login' },
});

export const githubLogout = defineOperation({
  id: 'github.logout',
  title: 'Delete the GitHub token',
  summary: 'delete the saved GitHub token',
  input: z.object({}).strict(),
  output: z.object({
    deleted: z.boolean().describe('A token was saved and is gone'),
    message: z.string().describe('What happened'),
  }),
  danger: true,
  text: (o) => o.message,
  cli: { name: 'github', action: 'logout' },
});

const TOKEN_TEXT: Readonly<Record<GithubStatus['token'], string>> = {
  none: 'not saved',
  saved: 'saved (encrypted)',
  unreadable: 'cannot be read',
};

const TOKEN_TONE: Readonly<Record<GithubStatus['token'], Fact['tone']>> = {
  none: 'warn',
  saved: 'ok',
  unreadable: 'danger',
};

const KIND_TEXT: Readonly<Record<'fine-grained' | 'classic', string>> = {
  'fine-grained': 'fine-grained',
  classic: 'classic (reaches every repository you can: a fine-grained token is safer)',
};

/** The Settings row of the menu (label, hint, description), from the status. Pure. */
export function githubTokenRowOf(s: GithubStatus): { label: string; hint: string; description: string } {
  return {
    label: 'Set GitHub token…',
    hint: s.token === 'saved' ? 'saved' : s.token === 'unreadable' ? 'cannot be read' : 'not saved',
    description:
      'A GitHub token you made for sandboxes (best a fine-grained one, limited to some repositories and permissions). Typed hidden, kept encrypted for your Windows user, never shown. Sandboxes get it only with github.shareToken on. ' +
      GITHUB_WARNINGS.join(' '),
  };
}

/** The status page: the facts, the next step (command line only), the warnings and the token actions. */
export function githubPage(s: GithubStatus): Page {
  const savedDate = s.savedAt ? '  ' + s.savedAt.slice(0, 10) : '';
  const facts: Fact[] = [
    s.shareToken
      ? { id: 'share', label: 'Share with sandboxes', value: 'on', tone: 'ok' }
      : {
          id: 'share',
          label: 'Share with sandboxes',
          value: 'off  (turn on: sandbox config set github.shareToken true)',
        },
    s.gitAccess === 'full'
      ? { id: 'gitAccess', label: 'Git access', value: 'full' }
      : {
          id: 'gitAccess',
          label: 'Git access',
          value: s.gitAccess + '  (the token is only handed over with "full")',
          tone: 'warn',
        },
    { id: 'token', label: 'Token', value: TOKEN_TEXT[s.token] + savedDate, tone: TOKEN_TONE[s.token] },
    ...(s.kind
      ? [
          {
            id: 'kind',
            label: 'Kind',
            value: KIND_TEXT[s.kind],
            ...(s.kind === 'classic' ? { tone: 'warn' as const } : {}),
          } satisfies Fact,
        ]
      : []),
  ];
  const notes: Note[] = [
    ...(s.token === 'none'
      ? [{ text: 'Next: sandbox github login', tone: 'muted' as const, only: 'cli' as const }]
      : []),
    ...(s.token === 'unreadable'
      ? [
          {
            text: 'Only the Windows user that saved it can read it. Save it again: sandbox github login',
            tone: 'muted' as const,
          },
        ]
      : []),
    ...GITHUB_WARNINGS.map((text) => ({ text, tone: 'muted' as const })),
  ];
  const actions = [
    action(githubLogin, {}, { key: 'g', verb: 'save token' }),
    ...(s.token !== 'none' ? [action(githubLogout, {}, { key: 'x', verb: 'delete token' })] : []),
  ];
  const section: Section = { id: 'github', facts, notes, actions };
  return { title: 'GitHub', sections: [section] };
}

export const githubView = defineView({
  id: 'github',
  title: 'GitHub',
  summary: 'A GitHub token for sandboxes: whether they get it, and the saved token.',
  queries: { status: githubStatus },
  operations: [githubLogin, githubLogout],
  build: ({ status }) => githubPage(status),
});
