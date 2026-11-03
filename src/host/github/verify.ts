// Asks GitHub who a token belongs to, when it expires and how many repositories it reaches, right after it was typed,
// so a wrong or expired token is caught at once. The token goes only in the Authorization header of two requests to
// api.github.com; the answers are size-limited and read through strict shapes. Nothing here prints the token.
import { z } from 'zod';
import { fetchBoundedResponse, type RequestFetcher } from '../../shared/download/index.js';

const API = 'https://api.github.com';
const MAX_BYTES = 1024 * 1024;
/** GitHub's header on a token's answers: "2027-02-03 10:00:00 UTC". */
const EXPIRY_HEADER = 'github-authentication-token-expiration';

const UserSchema = z.object({ login: z.string().min(1).max(100) });
const ReposSchema = z.array(z.object({ full_name: z.string().min(1).max(200) })).max(100);

/** What GitHub told about a token (never the token). */
export interface GithubCheck {
  readonly login: string;
  /** ISO time, or null: it never expires (or GitHub did not say). */
  readonly expiresAt: string | null;
  readonly repos: { readonly count: number; readonly sample: readonly string[] };
  /** A classic token's scopes, as GitHub lists them. */
  readonly scopes?: string;
}

/** The answer: a check, GitHub refusing the token, or GitHub not reachable (the token may still be fine). */
export type GithubVerdict =
  | { readonly kind: 'ok'; readonly check: GithubCheck }
  | { readonly kind: 'refused'; readonly status: number }
  | { readonly kind: 'unreachable'; readonly reason: string };

/** "2027-02-03 10:00:00 UTC" as an ISO time, or null. */
export function expiryFromHeader(value: string | null): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec(value?.trim() ?? '');
  if (!match) return null;
  const time = Date.parse(match[1] + 'T' + match[2] + 'Z');
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export async function verifyGithubToken(
  token: string,
  fetcher: RequestFetcher = fetchBoundedResponse,
): Promise<GithubVerdict> {
  const init: RequestInit = {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };
  try {
    const user = await fetcher(API + '/user', MAX_BYTES, init);
    if (user.status === 401 || user.status === 403) return { kind: 'refused', status: user.status };
    if (user.status !== 200) return { kind: 'unreachable', reason: 'GitHub answered ' + user.status + '.' };
    const who = UserSchema.safeParse(JSON.parse(user.text));
    if (!who.success) return { kind: 'unreachable', reason: 'GitHub gave an answer this program does not know.' };
    const expiresAt = expiryFromHeader(user.header(EXPIRY_HEADER));
    const scopes = user.header('x-oauth-scopes')?.trim();
    const repos = await fetcher(
      API + '/user/repos?per_page=100&affiliation=owner,collaborator,organization_member',
      MAX_BYTES,
      init,
    );
    const list = repos.status === 200 ? ReposSchema.safeParse(JSON.parse(repos.text)) : undefined;
    const names = list?.success ? list.data.map((r) => r.full_name) : [];
    return {
      kind: 'ok',
      check: {
        login: who.data.login,
        expiresAt,
        repos: { count: names.length, sample: names.slice(0, 5) },
        ...(scopes ? { scopes } : {}),
      },
    };
  } catch (e) {
    // A timeout, no network, a body that is too big or not JSON: the token itself is not at fault.
    const reason =
      e instanceof Error && e.name === 'TimeoutError'
        ? 'GitHub did not answer in time.'
        : e instanceof Error && e.message.includes('too big')
          ? e.message
          : 'GitHub could not be reached.';
    return { kind: 'unreachable', reason };
  }
}
