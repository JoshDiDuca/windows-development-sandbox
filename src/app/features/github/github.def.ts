// The GitHub token for sandboxes: whether sharing is on, whether a token is saved (its kind and date, never its value),
// and saving or deleting it. Pure: schemas, labels and the view; github.run.ts does the work. The token itself is never
// an input or an output.
import { z } from 'zod';
import {
  action,
  defineOperation,
  defineQuery,
  defineView,
  link,
  plural,
  type Badge,
  type Fact,
  type Item,
  type Note,
  type Page,
  type Section,
} from '../../kernel/index.js';
import { setSetting } from '../settings/settings.def.js';

/** Where GitHub makes a fine-grained token. */
export const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

/** What a token for sandboxes needs (GitHub's names for the permissions), asked for in the pre-filled form. */
export const TOKEN_PERMISSIONS: Readonly<Record<string, 'read' | 'write'>> = {
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
  workflows: 'write',
};

/**
 * The link that opens GitHub's "new fine-grained token" form already filled in (name, description, days until it
 * expires, permissions): docs.github.com, "Creating a fine-grained personal access token". Pure.
 */
export function newTokenUrl(o: {
  readonly name: string;
  readonly description?: string;
  readonly days: number;
  readonly permissions: Readonly<Record<string, 'read' | 'write'>>;
}): string {
  const query = new URLSearchParams();
  query.set('name', o.name.slice(0, 40));
  if (o.description) query.set('description', o.description.slice(0, 1024));
  query.set('expires_in', String(Math.max(1, Math.min(366, Math.round(o.days)))));
  for (const [permission, level] of Object.entries(o.permissions)) query.set(permission, level);
  // GitHub reads %20 as well as +; spaces are written %20 so the link reads the same everywhere.
  return NEW_TOKEN_URL + '?' + query.toString().replace(/\+/g, '%20');
}

/** The pre-filled link for this PC (the name says which PC the token is for). */
export function tokenUrlFor(host: string): string {
  return newTokenUrl({
    name: 'Windows Sandbox ' + host,
    description: 'For the agents in my Windows Sandbox. Limit it to the repositories they need.',
    days: 90,
    permissions: TOKEN_PERMISSIONS,
  });
}

/** The steps to make a token for sandboxes (shown before asking for it). */
export const GITHUB_STEPS: readonly string[] = [
  'Make a fine-grained personal access token (the "Make a new token" button opens GitHub with the form filled in).',
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
  login: z.string().nullable().describe('The GitHub user the token belongs to, as GitHub said when it was saved'),
  expiresAt: z.string().nullable().describe('When the token expires (ISO time), when GitHub said'),
  repoCount: z.number().nullable().describe('How many repositories it reaches (at most 100 are counted)'),
  checkedAt: z.string().nullable().describe('When GitHub was asked about it'),
  tokenUrl: z.string().describe("GitHub's new-token form for this PC, filled in"),
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const DAY_MS = 86_400_000;
/** A token that expires within this many days is flagged. */
export const EXPIRY_WARN_DAYS = 14;

/** "3 Feb 2027". */
function dateText(iso: string): string {
  const d = new Date(iso);
  return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

/** How the expiry reads: "Expires 3 Feb 2027 (in 12 days)", "Expired 3 Feb 2027", and its tone. */
export function expiryOf(
  expiresAt: string | null,
  now: number = Date.now(),
): { readonly text: string; readonly tone: 'ok' | 'warn' | 'danger'; readonly days: number } | null {
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) return null;
  const left = Date.parse(expiresAt) - now;
  const days = Math.ceil(left / DAY_MS);
  if (left <= 0) return { text: 'Expired ' + dateText(expiresAt), tone: 'danger', days };
  return {
    text: 'Expires ' + dateText(expiresAt) + ' (' + (days <= 1 ? 'today or tomorrow' : 'in ' + days + ' days') + ')',
    tone: days < EXPIRY_WARN_DAYS ? 'warn' : 'ok',
    days,
  };
}

/** The state badge of a GitHub card (the B5 words), then "shared". */
function badgesOf(s: GithubStatus, now: number): Badge[] {
  const expiry = s.token === 'saved' ? expiryOf(s.expiresAt, now) : null;
  const state: Badge =
    s.token === 'unreadable'
      ? { text: "can't be read", tone: 'danger' }
      : s.token === 'none'
        ? { text: 'not saved', tone: 'muted' }
        : expiry?.tone === 'danger'
          ? { text: 'expired', tone: 'danger' }
          : expiry?.tone === 'warn'
            ? { text: 'expires soon', tone: 'warn' }
            : { text: 'saved', tone: 'ok' };
  return [state, ...(s.shareToken && s.token !== 'none' ? [{ text: 'shared', tone: 'accent' as const }] : [])];
}

/** The GitHub card (the "thing you connect" pattern): used by the GitHub page and the Accounts page. */
export function githubItem(s: GithubStatus, now: number = Date.now()): Item {
  const expiry = s.token === 'saved' ? expiryOf(s.expiresAt, now) : null;
  const badges = badgesOf(s, now);
  const who =
    s.login && s.token === 'saved'
      ? 'Signed in as ' +
        s.login +
        (s.repoCount !== null
          ? ', reaches ' + (s.repoCount >= 100 ? '100 or more' : plural(s.repoCount, 'repository', 'repositories'))
          : '')
      : undefined;
  const details = [
    ...(who ? [who] : []),
    ...(expiry ? [expiry.text] : []),
    ...(s.token === 'unreadable' ? ['Only the Windows user that saved it can read it.'] : []),
    ...(s.kind === 'classic' ? ['A classic token reaches every repository you can: a fine-grained one is safer.'] : []),
  ].slice(0, 2);
  const signIn = action(
    githubLogin,
    {},
    { key: 'g', verb: 'sign in', label: s.token === 'none' ? 'Sign in…' : 'Sign in again…' },
  );
  const share = action(
    setSetting,
    { scope: 'user', key: 'github.shareToken', value: !s.shareToken },
    {
      key: 't',
      verb: s.shareToken ? 'stop sharing' : 'share',
      label: s.shareToken ? 'Stop sharing' : 'Share with sandboxes',
      importance: 1,
    },
  );
  return {
    id: 'github',
    label: 'GitHub',
    hint: badges[0].text,
    tone: badges[0].tone,
    badges,
    description: 'A token that lets agents in a sandbox use gh and git over https.',
    ...(details.length ? { details } : {}),
    primary: s.token === 'saved' ? share : signIn,
    actions:
      s.token === 'none'
        ? []
        : [
            ...(s.token === 'saved' ? [signIn] : []),
            action(githubLogout, {}, { key: 'x', verb: 'remove', label: 'Remove…' }),
          ],
  };
}

/** The GitHub section (the card, the git-access fact, the warnings and the link that opens GitHub's form). */
export function githubSection(s: GithubStatus, now: number = Date.now()): Section {
  const facts: Fact[] =
    s.gitAccess === 'full'
      ? []
      : [
          {
            id: 'gitAccess',
            label: 'Git access',
            value: s.gitAccess + '  (the token is only handed over with "full")',
            tone: 'warn',
            description: 'Change it in Settings (provisioning.git.access).',
          },
        ];
  const notes: Note[] = GITHUB_WARNINGS.map((text) => ({ text, tone: 'muted' as const }));
  const make = link({ kind: 'url', href: s.tokenUrl }, 'Make a new token…', {
    key: 'n',
    verb: 'new token',
    importance: 2,
    description: "Opens GitHub's form with a name, an expiry and the permissions already filled in.",
  });
  return {
    id: 'github',
    title: 'GitHub',
    facts,
    items: [githubItem(s, now)],
    notes,
    actions: [make],
  };
}

/** The status page: the card, the git access it needs, the warnings and how to make a new token. */
export function githubPage(s: GithubStatus, now: number = Date.now()): Page {
  return { title: 'GitHub', sections: [githubSection(s, now)] };
}

export const githubView = defineView({
  id: 'github',
  title: 'GitHub',
  summary: 'A GitHub token for sandboxes: whether they get it, and the saved token.',
  queries: { status: githubStatus },
  operations: [githubLogin, githubLogout, setSetting],
  build: ({ status }) => githubPage(status),
});
