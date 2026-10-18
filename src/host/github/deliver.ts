// Whether a launch hands the saved GitHub token to its sandbox (github.shareToken): only when you turned it on, a token
// is saved and opens, and the sandbox's git access is "full" (gh walks past a read-only git through the API). The
// token is returned for generateSandbox's one-shot file only; the notes never hold it.
import type { Config } from '../../core/types.js';
import { GithubToken } from './token.js';

/** github.shareToken is on and this sandbox's git access is "full". */
export function githubTokenAllowed(config: Config): boolean {
  return config.github.shareToken && config.provisioning.git.access === 'full';
}

export interface GithubDelivery {
  /** The token for the one-shot secrets file, when it is handed over. */
  readonly token?: string;
  /** What to tell you about it (never the token). */
  readonly notes: readonly string[];
}

/** What this launch hands over. Never throws: a token that cannot be read is a note, and the launch goes on. */
export function prepareGithubToken(config: Config, storageRoot: string, store?: GithubToken): GithubDelivery {
  if (!config.github.shareToken) return { notes: [] };
  if (config.provisioning.git.access !== 'full')
    return {
      notes: [
        'github.shareToken is on, but git access is "' +
          config.provisioning.git.access +
          '" in this sandbox, so your GitHub token was not handed over (it needs provisioning.git.access "full").',
      ],
    };
  const tokens = store ?? new GithubToken(storageRoot);
  let token: string | null;
  try {
    token = tokens.read();
  } catch {
    // The reason may come from DPAPI or a damaged file; a fixed text is enough (and can never hold the token).
    return {
      notes: [
        'Your saved GitHub token could not be read (only the Windows user that saved it can), so it was not handed over. Save it again: sandbox github login',
      ],
    };
  }
  if (!token)
    return {
      notes: ['github.shareToken is on, but no GitHub token is saved. Save one: sandbox github login'],
    };
  return {
    token,
    notes: [
      'Your GitHub token is handed to this sandbox (github.shareToken): the agent can read it and use it for whatever it allows.',
    ],
  };
}
