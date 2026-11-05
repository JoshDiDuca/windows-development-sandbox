// The GitHub CLI login on this PC (github.usePcLogin): the github.com token, read only for a launch's one-shot file.
// It comes from gh's hosts.yml (a login made with --insecure-storage) or, when gh keeps it in Windows Credential
// Manager, from this PC's own gh.exe (`gh auth token`, by absolute path). Nothing here prints or logs the token.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GithubTokenSchema } from '../../shared/github/index.js';

const HOST = 'github.com';
const MAX_HOSTS_BYTES = 256 * 1024;
const MAX_HOSTS_LINES = 2000;
const GH_TIMEOUT_MS = 10_000;

/** What hosts.yml says about github.com: the token it holds (null when gh keeps it elsewhere) and the active user. */
export interface HostsLogin {
  readonly signedIn: boolean;
  readonly token: string | null;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const valueOf = (line: string, key: string): string | null => {
  const t = line.trim();
  if (!t.startsWith(key + ':')) return null;
  return (
    t
      .slice(key.length + 1)
      .replace(/\s+#.*$/, '')
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2') || null
  );
};

/**
 * The github.com login in gh's hosts.yml. A small line reader for the two shapes gh writes (the token under
 * `users.<name>.oauth_token`, or `oauth_token` directly under the host): bounded, with no YAML library and no
 * regex that can run away. The active user's token is preferred.
 */
export function parseHostsYml(text: string): HostsLogin {
  const lines = text.split(/\r?\n/, MAX_HOSTS_LINES);
  let inHost = false;
  let user: string | null = null;
  let direct: string | null = null;
  let inUsers = false;
  let current: string | null = null;
  const byUser = new Map<string, string>();
  let signedIn = false;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = indentOf(line);
    if (indent === 0) {
      inHost = line.trim() === HOST + ':';
      signedIn = signedIn || inHost;
      inUsers = false;
      current = null;
      continue;
    }
    if (!inHost) continue;
    const t = line.trim();
    if (indent <= 4) {
      inUsers = t === 'users:';
      current = null;
      user = valueOf(line, 'user') ?? user;
      direct = valueOf(line, 'oauth_token') ?? direct;
    } else if (inUsers && t.endsWith(':') && !t.includes(' ')) {
      current = t.slice(0, -1);
    } else if (inUsers && current) {
      const token = valueOf(line, 'oauth_token');
      if (token) byUser.set(current, token);
    }
  }
  // With an active user, another user's token is never a stand-in (theirs may be in Credential Manager).
  const token = user ? (byUser.get(user) ?? direct) : (direct ?? [...byUser.values()][0] ?? null);
  return { signedIn, token };
}

/** Where gh keeps its settings on this PC (GH_CONFIG_DIR, XDG_CONFIG_HOME, or %APPDATA%\GitHub CLI). */
export function ghConfigFolder(env: Readonly<Record<string, string | undefined>>): string | null {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'gh');
  return env.APPDATA ? path.join(env.APPDATA, 'GitHub CLI') : null;
}

/** Where the GitHub CLI installer puts gh.exe (absolute paths only: the program is never found by name). */
export function ghExeCandidates(env: Readonly<Record<string, string | undefined>>): string[] {
  const roots = [
    env.ProgramFiles && path.join(env.ProgramFiles, 'GitHub CLI'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'GitHub CLI'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'GitHub CLI'),
  ];
  return roots.filter((r): r is string => !!r).map((r) => path.join(r, 'gh.exe'));
}

/** Runs gh.exe `auth token` and returns what it printed (null on any failure). Replaceable in tests. */
export type RunGh = (
  exe: string,
  configDir: string | null,
  env: Readonly<Record<string, string | undefined>>,
) => string | null;

const TOKEN_VARIABLES = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i;

export const runGhAuthToken: RunGh = (exe, configDir, base) => {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined && !TOKEN_VARIABLES.test(e[0])),
  );
  if (configDir) env.GH_CONFIG_DIR = configDir;
  env.GH_PROMPT_DISABLED = '1';
  const result = spawnSync(exe, ['auth', 'token', '--hostname', HOST], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 16 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? String(result.stdout ?? '').trim() : null;
};

export interface PcLoginOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: RunGh;
}

/**
 * The token of this PC's gh login for github.com, or null when there is none (or it cannot be read): no login is
 * normal and silent. The result passes the same limits as a token in the secrets file.
 */
export function readPcGhLogin(options: PcLoginOptions = {}): string | null {
  const env = options.env ?? process.env;
  const dir = ghConfigFolder(env);
  let login: HostsLogin = { signedIn: false, token: null };
  if (dir) {
    try {
      const file = path.join(dir, 'hosts.yml');
      if (fs.statSync(file).size <= MAX_HOSTS_BYTES) login = parseHostsYml(fs.readFileSync(file, 'utf8'));
    } catch {
      // No hosts.yml: gh is not signed in on this PC.
    }
  }
  let token = login.token;
  if (!token && login.signedIn) {
    const run = options.run ?? runGhAuthToken;
    const exe = ghExeCandidates(env).find((c) => fs.existsSync(c));
    token = exe ? (run(exe, dir, env)?.trim() ?? null) : null;
  }
  const checked = GithubTokenSchema.safeParse(token ?? '');
  return checked.success ? checked.data : null;
}
