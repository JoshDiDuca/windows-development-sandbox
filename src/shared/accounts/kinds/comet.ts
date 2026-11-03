// Comet's sign-in, as the sandbox keeps it: only the perplexity.ai cookies that hold a sign-in (persistent, HttpOnly),
// read from Comet over the DevTools protocol (Storage.getCookies) and written back the same way. Pure: the sandbox
// side (guest/accounts/kinds/comet.ts) talks to Comet, the self-test checks the filter. Never passwords, other sites,
// localStorage or history: those are not cookies of an allowed domain, and nothing else is asked for.
import { cometCookieDomainAllowed, CometPayloadSchema, MAX_COMET_COOKIES } from '../payloads.js';
import type { CometCookie, Payload } from '../payloads.js';

export type CometPayload = Payload<'comet'>;

/** Cloudflare's bot and clearance cookies: tied to one machine and address, and renewed every few minutes. */
const MACHINE_BOUND = /^(__cf_bm|cf_clearance|_cfuvid|__cflb)$/i;
/** Expiry is kept to the hour, so a cookie re-sent with a later expiry on every page is not a new sign-in. */
const EXPIRY_STEP = 3600;

/** A cookie as CDP reports it (Network.Cookie); only the fields read here. */
interface CdpCookie {
  readonly name?: unknown;
  readonly value?: unknown;
  readonly domain?: unknown;
  readonly path?: unknown;
  readonly expires?: unknown;
  readonly session?: unknown;
  readonly secure?: unknown;
  readonly httpOnly?: unknown;
  readonly sameSite?: unknown;
  readonly partitionKey?: unknown;
}

const SAME_SITE: readonly string[] = ['Strict', 'Lax', 'None'];

/** One CDP cookie as a kept cookie, or null when it is not one to keep. */
function keptCookie(raw: unknown, nowSeconds: number): CometCookie | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as CdpCookie;
  if (typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string') return null;
  if (!cometCookieDomainAllowed(c.domain) || MACHINE_BOUND.test(c.name)) return null;
  // A sign-in is a persistent HttpOnly cookie of the site itself: no session cookies, script cookies or partitions.
  if (c.httpOnly !== true || c.session === true || c.partitionKey !== undefined) return null;
  if (typeof c.expires !== 'number' || !Number.isFinite(c.expires) || c.expires <= nowSeconds) return null;
  const cookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: typeof c.path === 'string' && c.path ? c.path : '/',
    expires: Math.floor(c.expires / EXPIRY_STEP) * EXPIRY_STEP,
    secure: c.secure === true,
    httpOnly: true,
    ...(typeof c.sameSite === 'string' && SAME_SITE.includes(c.sameSite)
      ? { sameSite: c.sameSite as 'Strict' | 'Lax' | 'None' }
      : {}),
  };
  const parsed = CometPayloadSchema.shape.cookies.element.safeParse(cookie);
  return parsed.success ? parsed.data : null;
}

/**
 * The sign-in among the cookies Comet reports (every site's, as Storage.getCookies returns them): the allow-listed,
 * persistent HttpOnly ones, in a fixed order so the same sign-in always looks the same. Null when there is none (signed
 * out), or when there are more than a sign-in could need.
 */
export function cometPayloadFromCookies(cookies: readonly unknown[], nowSeconds: number): CometPayload | null {
  const kept = cookies.flatMap((c) => {
    const k = keptCookie(c, nowSeconds);
    return k ? [k] : [];
  });
  if (!kept.length || kept.length > MAX_COMET_COOKIES) return null;
  kept.sort((a, b) => (a.domain + ' ' + a.path + ' ' + a.name < b.domain + ' ' + b.path + ' ' + b.name ? -1 : 1));
  const parsed = CometPayloadSchema.safeParse({ cookies: kept });
  return parsed.success ? parsed.data : null;
}

/** The cookies still valid now, for Storage.setCookies (an expired one would only be thrown away by Comet). */
export function cookiesToRestore(p: CometPayload, nowSeconds: number): CometCookie[] {
  return CometPayloadSchema.parse(p).cookies.filter((c) => c.expires === undefined || c.expires > nowSeconds);
}

/** One line for the status: how many cookies, never their values. */
export function cometSummary(p: CometPayload): string {
  const n = p.cookies.length;
  return n + ' perplexity.ai sign-in cookie' + (n === 1 ? '' : 's');
}
