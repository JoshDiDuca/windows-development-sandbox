// A GitHub token for sandboxes (github.shareToken): the rules for one (both sides check them) and the gh commands the
// sandbox runs with it. Pure. The token is never part of a message, an argument or a log line: gh reads it on stdin.
import { z } from 'zod';

export const GITHUB_TOKEN_KINDS = ['fine-grained', 'classic'] as const;
export type GithubTokenKind = (typeof GITHUB_TOKEN_KINDS)[number];

const MIN_LENGTH = 20;
const MAX_LENGTH = 255;
/** Printable ASCII without spaces: what GitHub's tokens are made of. */
const PRINTABLE = /^[\x21-\x7e]+$/;

/** The token in the secrets file: the same limits as on the PC. */
export const GithubTokenSchema = z.string().min(MIN_LENGTH).max(MAX_LENGTH).regex(PRINTABLE);

/** Prefixes of tokens that are not personal access tokens (OAuth from `gh auth login`, app and refresh tokens). */
const OTHER_TOKENS: Readonly<Record<string, string>> = {
  gho_: 'This is an OAuth token (from gh auth login or gh auth token), which can reach everything your account can.',
  ghu_: 'This is a GitHub App user token, not a personal access token.',
  ghs_: 'This is a GitHub App installation token, not a personal access token.',
  ghr_: 'This is a refresh token, not a personal access token.',
};

const CREATE_FINE_GRAINED =
  'Create a fine-grained token at https://github.com/settings/personal-access-tokens/new with only the repositories and permissions the agent needs, then run: sandbox github login';

/** What kind of personal access token this is, from its prefix (null: not one). */
export function githubTokenKind(token: string): GithubTokenKind | null {
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (token.startsWith('ghp_')) return 'classic';
  return null;
}

/** Why this text cannot be saved as the sandbox token (fixed texts: never the token), or null when it can. */
export function githubTokenProblem(token: string): { message: string; fix: string } | null {
  if (!token) return { message: 'No token was typed.', fix: CREATE_FINE_GRAINED };
  if (!PRINTABLE.test(token))
    return {
      message: 'The token may not contain spaces, line breaks or other special characters.',
      fix: 'Copy the token again from GitHub (only the token itself) and run: sandbox github login',
    };
  if (token.length < MIN_LENGTH || token.length > MAX_LENGTH)
    return {
      message: 'That is not the length of a GitHub token.',
      fix: 'Copy the whole token again from GitHub and run: sandbox github login',
    };
  const other = Object.keys(OTHER_TOKENS).find((p) => token.startsWith(p));
  if (other) return { message: OTHER_TOKENS[other], fix: CREATE_FINE_GRAINED };
  if (!githubTokenKind(token))
    return {
      message: 'That is not a GitHub personal access token (they start with github_pat_ or ghp_).',
      fix: CREATE_FINE_GRAINED,
    };
  return null;
}

/** One gh run: the program, its arguments, what goes on its stdin, and its environment. */
export interface GhCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly input?: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Variables that would make gh use another token than the one it is given (gh refuses --with-token with them). */
const TOKEN_VARIABLES = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i;

const ghEnv = (base: Readonly<Record<string, string | undefined>>, configDir: string): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined && !TOKEN_VARIABLES.test(e[0])),
  ),
  GH_CONFIG_DIR: configDir,
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
});

/**
 * `gh auth login` with the token on stdin, never in the arguments (other processes can read those). The login is
 * kept as a file in configDir (--insecure-storage, rather than Credential Manager), which is on the sandbox's own disk
 * and gone with it.
 */
export function ghLoginCommand(
  ghExe: string,
  configDir: string,
  token: string,
  base: Readonly<Record<string, string | undefined>>,
): GhCommand {
  return {
    file: ghExe,
    args: ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--insecure-storage', '--with-token'],
    input: token + '\n',
    env: ghEnv(base, configDir),
  };
}

/** `gh auth setup-git`: https git to github.com asks gh for the login. */
export function ghSetupGitCommand(
  ghExe: string,
  configDir: string,
  base: Readonly<Record<string, string | undefined>>,
): GhCommand {
  return { file: ghExe, args: ['auth', 'setup-git', '--hostname', 'github.com'], env: ghEnv(base, configDir) };
}

/** Text from gh, safe to log: the token blanked out should it ever appear, and kept short. */
export function ghOutputText(text: string, token: string): string {
  const clean = token ? text.split(token).join('***') : text;
  return clean.replace(/\s+/g, ' ').trim().slice(0, 300);
}
