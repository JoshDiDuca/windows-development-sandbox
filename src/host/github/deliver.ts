// Whether a launch hands the saved GitHub token to its sandbox (github.shareToken): only when you turned it on, a token
// is saved and opens, and git access is "full" for the launch AND every other project mapped at boot (gh walks past a
// read-only git through the API, and every agent in the sandbox can reach every project in it). The token is returned
// for generateSandbox's one-shot file only; the notes never hold it.
import type { BootWant } from '../../core/local-config/index.js';
import type { Config } from '../../core/types.js';
import { GithubToken } from './token.js';
import { readPcGhLogin, type PcLoginOptions } from './pc-login.js';

/** The first project (the launch's own, then the others at boot) whose git access is not "full", or null. */
function stricterProject(config: Config, others: readonly BootWant[]): { name: string; access: string } | null {
  if (config.provisioning.git.access !== 'full') return { name: '', access: config.provisioning.git.access };
  const other = others.find((o) => o.config.provisioning.git.access !== 'full');
  return other ? { name: other.name, access: other.config.provisioning.git.access } : null;
}

/** github.shareToken or github.usePcLogin is on and git access is "full" for every project this sandbox boots with. */
export function githubTokenAllowed(config: Config, others: readonly BootWant[] = []): boolean {
  return (config.github.shareToken || config.github.usePcLogin) && stricterProject(config, others) === null;
}

export interface GithubDelivery {
  /** The token for the one-shot secrets file, when it is handed over. */
  readonly token?: string;
  /** What to tell you about it (never the token). */
  readonly notes: readonly string[];
}

/** A token that ends within this many days is mentioned at launch. */
const EXPIRY_NOTE_DAYS = 7;

/** "Your GitHub token expires in 3 days" (or has expired), from what GitHub said when it was saved. */
function expiryNotes(tokens: GithubToken, now: number = Date.now()): string[] {
  const at = Date.parse(tokens.check()?.expiresAt ?? '');
  if (Number.isNaN(at)) return [];
  const days = Math.ceil((at - now) / 86_400_000);
  if (at <= now) return ['Your GitHub token has expired, so GitHub will refuse it. Make a new one in Accounts.'];
  if (days > EXPIRY_NOTE_DAYS) return [];
  return [
    'Your GitHub token expires ' +
      (days <= 1 ? 'within a day' : 'in ' + days + ' days') +
      '. Make a new one in Accounts.',
  ];
}

const PC_LOGIN_NOTE =
  'Your gh login on this PC is handed to this sandbox (github.usePcLogin): the agent can read it and use it for everything your account can.';

/**
 * What this launch hands over. Never throws: a token that cannot be read is a note, and the launch goes on. A token
 * saved for sandboxes (github.shareToken) comes first; then this PC's own gh login (github.usePcLogin), which says
 * nothing when the PC has none.
 */
export function prepareGithubToken(
  config: Config,
  storageRoot: string,
  store?: GithubToken,
  others: readonly BootWant[] = [],
  now: number = Date.now(),
  pc: PcLoginOptions = {},
): GithubDelivery {
  const { shareToken, usePcLogin } = config.github;
  if (!shareToken && !usePcLogin) return { notes: [] };
  const stricter = stricterProject(config, others);
  if (stricter)
    return {
      notes: [
        'github.' +
          (shareToken ? 'shareToken' : 'usePcLogin') +
          ' is on, but git access is "' +
          stricter.access +
          '"' +
          (stricter.name ? ' for ' + stricter.name + ' (also in this sandbox)' : ' in this sandbox') +
          ', so your GitHub login was not handed over (it needs provisioning.git.access "full").',
      ],
    };
  const notes: string[] = [];
  if (shareToken) {
    const tokens = store ?? new GithubToken(storageRoot);
    let token: string | null = null;
    try {
      token = tokens.read();
    } catch {
      // The reason may come from DPAPI or a damaged file; a fixed text is enough (and can never hold the token).
      notes.push(
        'Your saved GitHub token could not be read (only the Windows user that saved it can), so it was not handed over. Save it again: sandbox github login',
      );
    }
    if (token)
      return {
        token,
        notes: [
          'Your GitHub token is handed to this sandbox (github.shareToken): the agent can read it and use it for whatever it allows.',
          ...expiryNotes(tokens, now),
        ],
      };
    if (!usePcLogin && !notes.length)
      notes.push('github.shareToken is on, but no GitHub token is saved. Save one: sandbox github login');
  }
  if (usePcLogin) {
    const login = readPcGhLogin(pc);
    if (login) return { token: login, notes: [...notes, PC_LOGIN_NOTE] };
  }
  return { notes };
}
