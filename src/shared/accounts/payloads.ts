// The shape of each saved sign-in (what the host seals, what travels in the one-shot secrets file, what a sandbox may
// hand back). Pure zod, web-safe. Every text is size-bounded: the sandbox may have written it.
import { z } from 'zod';
import { PERPLEXITY_KEY_PATTERN, SERVICE_KINDS, type ServiceKind } from './kinds.js';

const KB = 1024;
const base64 = (maxBytes: number): z.ZodString =>
  z
    .string()
    .min(4)
    .max(maxBytes)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/);
const secretText = (max: number): z.ZodString =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\r\n]+$/);

/** The Epic Games Launcher's "Remember me" (the Data value of [RememberMe] in its GameUserSettings.ini). */
export const EpicPayloadSchema = z.strictObject({
  data: z
    .string()
    .min(16)
    .max(16384)
    .regex(/^[A-Za-z0-9+/=_-]+$/),
});

/** SteamCMD's cached login: config\config.vdf (ConnectCache) and the ssfn sentry files. No password. */
export const SteamPayloadSchema = z.strictObject({
  account: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
  configVdf: z
    .string()
    .min(1)
    .max(256 * KB),
  sentries: z.array(z.strictObject({ name: z.string().regex(/^ssfn\d{1,40}$/), base64: base64(64 * KB) })).max(4),
  /** Reserved for the Steam client's own login (very likely not portable between Windows users). */
  client: base64(256 * KB).optional(),
});

/** A Unity licence file (Unity_lic.ulf), and the Unity ID to sign in with when it has to be made again. */
export const UnityPayloadSchema = z
  .strictObject({
    ulf: z
      .string()
      .min(1)
      .max(128 * KB)
      .optional(),
    /** The named-user licence (UnityEntitlementLicense.xml) a Unity sign-in makes. */
    entitlement: z
      .string()
      .min(1)
      .max(128 * KB)
      .optional(),
    email: z.string().email().max(256).optional(),
    password: secretText(1024).optional(),
    serial: secretText(64).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, 'empty Unity sign-in');

/** A FiveM / RedM server licence key from the Cfx.re keymaster, and an optional Steam Web API key. */
export const CfxPayloadSchema = z.strictObject({
  licenseKey: z
    .string()
    .max(256)
    .regex(/^cfxk_[A-Za-z0-9_]+$/),
  steamWebApiKey: z
    .string()
    .regex(/^[A-F0-9]{32}$/)
    .optional(),
});

/** An Android upload keystore and what opens it. */
export const KeystorePayloadSchema = z.strictObject({
  fileName: z.string().regex(/^[A-Za-z0-9._-]{1,100}\.(jks|keystore|p12)$/i),
  jksBase64: base64(256 * KB),
  storePassword: secretText(1024),
  keyAlias: secretText(256),
  keyPassword: secretText(1024),
});

/** A Google Play service account key (its JSON file). */
export const PlayPayloadSchema = z.strictObject({
  serviceAccountJson: z
    .string()
    .min(2)
    .max(64 * KB)
    .refine((text) => {
      try {
        const parsed: unknown = JSON.parse(text);
        return (
          typeof parsed === 'object' && parsed !== null && (parsed as { type?: unknown }).type === 'service_account'
        );
      } catch {
        return false;
      }
    }, 'not a Google service account key (its "type" is not "service_account")'),
});

/** An Expo access token (EXPO_TOKEN). */
export const ExpoPayloadSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{8,512}$/),
});

/** An App Store Connect API key: its issuer, its ID and the .p8 private key. */
export const AppstorePayloadSchema = z.strictObject({
  issuerId: z.string().uuid(),
  keyId: z.string().regex(/^[A-Z0-9]{10}$/),
  p8: z
    .string()
    .max(8 * KB)
    .regex(/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PRIVATE KEY-----\s*$/),
});

/** A Perplexity API key (PERPLEXITY_API_KEY), billed separately from Perplexity Pro. */
export const PerplexityPayloadSchema = z.strictObject({
  apiKey: z.string().max(256).regex(PERPLEXITY_KEY_PATTERN),
});

/** The only sites whose cookies a Comet sign-in keeps (each with its subdomains). Fixed: never a setting. */
export const COMET_COOKIE_DOMAINS: readonly string[] = ['perplexity.ai'];
/** At most this many cookies are kept. */
export const MAX_COMET_COOKIES = 200;

/** Whether a cookie's domain (".www.perplexity.ai", "perplexity.ai" ...) is one of COMET_COOKIE_DOMAINS or below it. */
export function cometCookieDomainAllowed(domain: string): boolean {
  const host = domain.trim().toLowerCase().replace(/^\./, '');
  return COMET_COOKIE_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

/** Printable text without control characters (a cookie the sandbox hands back could hold anything). */
const cookieText = (min: number, max: number): z.ZodString =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[ -~]*$/);

/** One cookie as CDP's Storage.setCookies takes it (expires: seconds since 1970; none for a session cookie). */
export const CometCookieSchema = z.strictObject({
  name: cookieText(1, 256).regex(/^[^\s;,=]+$/),
  value: cookieText(0, 8192).regex(/^[^;]*$/),
  domain: cookieText(1, 253).refine(cometCookieDomainAllowed, 'not a perplexity.ai cookie'),
  path: cookieText(1, 1024).regex(/^\//),
  expires: z.number().int().min(0).max(4102444800).optional(),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
});
export type CometCookie = z.output<typeof CometCookieSchema>;

/** Comet's sign-in: the allow-listed perplexity.ai cookies only (no passwords, localStorage or history). */
export const CometPayloadSchema = z.strictObject({
  cookies: z.array(CometCookieSchema).min(1).max(MAX_COMET_COOKIES),
});

/** The Perplexity desktop app's sign-in: the same perplexity.ai cookies as Comet's. */
export const PerplexityAppPayloadSchema = CometPayloadSchema;

export const PAYLOADS = {
  epic: EpicPayloadSchema,
  steam: SteamPayloadSchema,
  unity: UnityPayloadSchema,
  cfx: CfxPayloadSchema,
  keystore: KeystorePayloadSchema,
  play: PlayPayloadSchema,
  expo: ExpoPayloadSchema,
  appstore: AppstorePayloadSchema,
  perplexity: PerplexityPayloadSchema,
  comet: CometPayloadSchema,
  perplexityapp: PerplexityAppPayloadSchema,
} as const satisfies { readonly [K in ServiceKind]: z.ZodType };

export type Payload<K extends ServiceKind> = z.output<(typeof PAYLOADS)[K]>;
export type AnyPayload = Payload<ServiceKind>;
export type Payloads = Partial<{ [K in ServiceKind]: Payload<K> }>;

/** The secrets-file field: the sign-ins this launch hands over, each optional. */
export const ServiceAccountsSchema = z.strictObject({
  epic: EpicPayloadSchema.optional(),
  steam: SteamPayloadSchema.optional(),
  unity: UnityPayloadSchema.optional(),
  cfx: CfxPayloadSchema.optional(),
  keystore: KeystorePayloadSchema.optional(),
  play: PlayPayloadSchema.optional(),
  expo: ExpoPayloadSchema.optional(),
  appstore: AppstorePayloadSchema.optional(),
  perplexity: PerplexityPayloadSchema.optional(),
  comet: CometPayloadSchema.optional(),
  perplexityapp: PerplexityAppPayloadSchema.optional(),
});
export type ServiceAccounts = z.output<typeof ServiceAccountsSchema>;

/** A launch's id (generate.ts: "<ms>-<6 hex>"). */
export const LaunchIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

/** What a sandbox leaves in state\accounts\<kind>.json: the renewed sign-in and the launch it belongs to. */
export function handoffSchema<K extends ServiceKind>(
  kind: K,
): z.ZodType<{ kind: K; launchId: string; payload: Payload<K> }> {
  return z.strictObject({
    kind: z.literal(kind),
    launchId: LaunchIdSchema,
    payload: PAYLOADS[kind] as unknown as z.ZodType<Payload<K>>,
  }) as unknown as z.ZodType<{ kind: K; launchId: string; payload: Payload<K> }>;
}

/** The kinds that are in a secrets-file field, in order. */
export function deliveredKinds(given: ServiceAccounts | undefined): ServiceKind[] {
  return given ? SERVICE_KINDS.filter((k) => given[k] !== undefined) : [];
}
