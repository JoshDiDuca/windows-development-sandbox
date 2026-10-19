// Who the owner let in (docs/design/remote-access.md): paired devices, Windows sign-ins and the one pending device
// code, in <storage>\web\access.json (the web state's private folder). Only SHA-256 hashes of codes and tokens are kept,
// and the whole list is sealed with SecretStore (DPAPI). Credentials end at a fixed time (never renewed by use); revoke
// one, or all (which also moves the epoch and voids the pending code). The web server and the CLI share this file: the
// server reads it again when it changes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { RemoteRole } from '../../core/schema/web.js';
import { JsonFile } from '../../shared/io/index.js';
import type { SecretStore } from '../secrets/index.js';

const DAY_MS = 86_400_000;
/** A device code is good for this long. */
export const CODE_LIFETIME_MS = 5 * 60_000;
/** A code that has seen this many wrong tries is void (the PC says so). */
export const CODE_MAX_WRONG = 10;
/** Most devices and Windows sign-ins kept (the oldest go first). */
export const MAX_DEVICES = 50;
export const MAX_WINDOWS_GRANTS = 100;
/** Crockford base32 without I, L, O, U: what a person reads off a screen and types on a phone. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const IdSchema = z.string().regex(/^[0-9a-f]{16}$/);
const IsoSchema = z.string().max(40);
const RoleSchema = z.enum(['view', 'control']);

export const DeviceSchema = z.strictObject({
  id: IdSchema,
  name: z.string().max(40),
  role: RoleSchema,
  /** The address it was allowed from. */
  address: z.string().max(45),
  createdAt: IsoSchema,
  expiresAt: IsoSchema,
  lastSeen: IsoSchema.optional(),
  tokenHash: Hex64,
});
export type Device = z.output<typeof DeviceSchema>;

export const WindowsGrantSchema = z.strictObject({
  id: IdSchema,
  sid: z.string().regex(/^S-1-[0-9-]{1,180}$/),
  user: z.string().max(140),
  createdAt: IsoSchema,
  expiresAt: IsoSchema,
  tokenHash: Hex64,
});
export type WindowsGrant = z.output<typeof WindowsGrantSchema>;

export const PendingCodeSchema = z.strictObject({
  hash: Hex64,
  role: RoleSchema,
  createdAt: IsoSchema,
  expiresAt: IsoSchema,
  wrong: z.number().int().min(0).max(1000),
});
export type PendingCode = z.output<typeof PendingCodeSchema>;

export const AccessDataSchema = z.strictObject({
  /** Moves on "revoke all": nothing issued before comes back. */
  epoch: z.number().int().min(0),
  devices: z.array(DeviceSchema).max(MAX_DEVICES),
  windows: z.array(WindowsGrantSchema).max(MAX_WINDOWS_GRANTS),
  code: PendingCodeSchema.nullable(),
  /** The network LAN mode was turned on for (its name from Windows), or null. */
  network: z.string().max(256).nullable(),
  /** The pending code was voided by wrong tries (the PC says so until a new code is made). */
  codeVoided: z.boolean(),
});
export type AccessData = z.output<typeof AccessDataSchema>;

const AccessFileSchema = z.strictObject({ version: z.literal(1), sealed: z.string().max(2_000_000) });

export const EMPTY_ACCESS: AccessData = {
  epoch: 0,
  devices: [],
  windows: [],
  code: null,
  network: null,
  codeVoided: false,
};

/** SHA-256 of a code or token, hex. */
export function secretHash(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Two hex hashes, compared without leaking where they differ. */
function sameHash(a: string, b: string): boolean {
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A new code: 8 characters (40 bits), shown as ABCD-EFGH. */
export function newCode(random: (n: number) => Buffer = crypto.randomBytes): string {
  const bytes = random(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] & 31];
  return code;
}

/** ABCDEFGH -> ABCD-EFGH. */
export function showCode(code: string): string {
  return code.slice(0, 4) + '-' + code.slice(4);
}

/** What a person typed, as a code: upper case, no dashes or spaces, O as 0 and I or L as 1; null when it cannot be one. */
export function normalizeCode(typed: unknown): string | null {
  if (typeof typed !== 'string' || typed.length > 32) return null;
  const code = typed
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

/** A credential as the cookie carries it: `<id>.<token>`. */
export function credentialValue(id: string, token: string): string {
  return id + '.' + token;
}

/** `<16 hex>.<64 hex>`, or null. */
export function parseCredential(value: string | undefined): { id: string; token: string } | null {
  const match = /^([0-9a-f]{16})\.([0-9a-f]{64})$/.exec(value ?? '');
  return match ? { id: match[1], token: match[2] } : null;
}

export type RedeemResult =
  | { readonly ok: true; readonly device: Device; readonly credential: string }
  | { readonly ok: false; readonly reason: 'none' | 'wrong' | 'expired' | 'void' };

export interface AccessStoreOptions {
  readonly now?: () => number;
  readonly random?: (n: number) => Buffer;
  /** Makes the folder private (the web state folder already is; tests pass a no-op). */
  readonly protect?: (dir: string) => void;
}

export class AccessStore {
  private readonly file: JsonFile<z.output<typeof AccessFileSchema>>;
  private cache: { stamp: string; data: AccessData } | undefined;
  private readonly now: () => number;
  private readonly random: (n: number) => Buffer;

  constructor(
    readonly dir: string,
    private readonly secrets: SecretStore,
    private readonly options: AccessStoreOptions = {},
  ) {
    this.file = new JsonFile(AccessFileSchema, path.join(dir, 'access.json'));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? crypto.randomBytes;
  }

  /** <storage>\web. */
  static at(storageRoot: string, secrets: SecretStore, options: AccessStoreOptions = {}): AccessStore {
    return new AccessStore(path.join(storageRoot, 'web'), secrets, options);
  }

  private stamp(): string {
    try {
      const st = fs.statSync(this.file.file);
      return st.mtimeMs + ':' + st.size;
    } catch {
      return 'none';
    }
  }

  /** The list as it is now (read again only when the file changed). A damaged or foreign file counts as empty. */
  read(): AccessData {
    const stamp = this.stamp();
    if (this.cache?.stamp === stamp) return this.cache.data;
    let data = EMPTY_ACCESS;
    try {
      const raw = this.file.read();
      if (raw) {
        const parsed = AccessDataSchema.safeParse(this.secrets.openJson(raw.sealed));
        if (parsed.success) data = parsed.data;
      }
    } catch {
      // A file sealed by another user or system cannot be opened: nobody is let in by it.
    }
    this.cache = { stamp, data };
    return data;
  }

  private write(data: AccessData): AccessData {
    const checked = AccessDataSchema.parse(data);
    fs.mkdirSync(this.dir, { recursive: true });
    this.options.protect?.(this.dir);
    this.file.write({ version: 1, sealed: this.secrets.sealJson(checked) });
    this.cache = { stamp: this.stamp(), data: checked };
    return checked;
  }

  /** Changes the list (expired credentials are dropped on the way). */
  update(change: (data: AccessData) => AccessData): AccessData {
    return this.write(change(this.withoutExpired(this.read())));
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private alive(expiresAt: string): boolean {
    return Date.parse(expiresAt) > this.now();
  }

  private withoutExpired(data: AccessData): AccessData {
    return {
      ...data,
      devices: data.devices.filter((d) => this.alive(d.expiresAt)),
      windows: data.windows.filter((w) => this.alive(w.expiresAt)),
      code: data.code && this.alive(data.code.expiresAt) ? data.code : null,
    };
  }

  private newId(): string {
    return this.random(8).toString('hex');
  }

  private newToken(): string {
    return this.random(32).toString('hex');
  }

  /** A new device code for this role (replaces a pending one). Returns the code; only its hash is kept. */
  newDeviceCode(role: RemoteRole): { code: string; expiresAt: string } {
    const code = newCode(this.random);
    const t = this.now();
    const expiresAt = this.iso(t + CODE_LIFETIME_MS);
    this.update((d) => ({
      ...d,
      code: { hash: secretHash(code), role, createdAt: this.iso(t), expiresAt, wrong: 0 },
      codeVoided: false,
    }));
    return { code, expiresAt };
  }

  /** Whether a code is pending (attempts with none pending are not counted anywhere). */
  codePending(): boolean {
    const code = this.read().code;
    return code !== null && this.alive(code.expiresAt);
  }

  /** Trades the pending code for a new device credential (one use); counts a wrong code. */
  redeem(typed: unknown, name: string, address: string, rememberDays: number): RedeemResult {
    const data = this.read();
    const pending = data.code;
    if (!pending) return { ok: false, reason: 'none' };
    if (!this.alive(pending.expiresAt)) {
      this.update((d) => ({ ...d, code: null }));
      return { ok: false, reason: 'expired' };
    }
    const code = normalizeCode(typed);
    if (!code || !sameHash(secretHash(code), pending.hash)) {
      const wrong = pending.wrong + 1;
      const voided = wrong >= CODE_MAX_WRONG;
      this.update((d) => ({ ...d, code: voided ? null : { ...pending, wrong }, codeVoided: voided || d.codeVoided }));
      return { ok: false, reason: voided ? 'void' : 'wrong' };
    }
    const t = this.now();
    const token = this.newToken();
    const device: Device = {
      id: this.newId(),
      name: name.slice(0, 40),
      role: pending.role,
      address: address.slice(0, 45),
      createdAt: this.iso(t),
      expiresAt: this.iso(t + rememberDays * DAY_MS),
      tokenHash: secretHash(token),
    };
    this.update((d) => ({ ...d, code: null, devices: [...d.devices, device].slice(-MAX_DEVICES) }));
    return { ok: true, device, credential: credentialValue(device.id, token) };
  }

  /** The device a cookie value stands for: known id, same token, not expired. */
  device(value: string | undefined): Device | null {
    const parsed = parseCredential(value);
    if (!parsed) return null;
    const device = this.read().devices.find((d) => d.id === parsed.id);
    if (!device || !this.alive(device.expiresAt)) return null;
    return sameHash(secretHash(parsed.token), device.tokenHash) ? device : null;
  }

  /** Notes when a device was last seen (at most once a minute per device, so a busy page does not keep writing). */
  seen(id: string): void {
    const device = this.read().devices.find((d) => d.id === id);
    const t = this.now();
    if (!device || (device.lastSeen && t - Date.parse(device.lastSeen) < 60_000)) return;
    this.update((d) => ({
      ...d,
      devices: d.devices.map((x) => (x.id === id ? { ...x, lastSeen: this.iso(t) } : x)),
    }));
  }

  /** A credential for a Windows user (after the pipe sign-in): the cookie value. */
  issueWindows(sid: string, user: string, rememberDays: number): string {
    const t = this.now();
    const token = this.newToken();
    const grant: WindowsGrant = {
      id: this.newId(),
      sid,
      user: user.slice(0, 140),
      createdAt: this.iso(t),
      expiresAt: this.iso(t + rememberDays * DAY_MS),
      tokenHash: secretHash(token),
    };
    this.update((d) => ({ ...d, windows: [...d.windows, grant].slice(-MAX_WINDOWS_GRANTS) }));
    return credentialValue(grant.id, token);
  }

  windowsGrant(value: string | undefined): WindowsGrant | null {
    const parsed = parseCredential(value);
    if (!parsed) return null;
    const grant = this.read().windows.find((w) => w.id === parsed.id);
    if (!grant || !this.alive(grant.expiresAt)) return null;
    return sameHash(secretHash(parsed.token), grant.tokenHash) ? grant : null;
  }

  /** Ends one device or Windows sign-in; false when there is no such id. */
  revoke(id: string): boolean {
    const data = this.read();
    if (!data.devices.some((d) => d.id === id) && !data.windows.some((w) => w.id === id)) return false;
    this.update((d) => ({
      ...d,
      devices: d.devices.filter((x) => x.id !== id),
      windows: d.windows.filter((x) => x.id !== id),
    }));
    return true;
  }

  /** Ends every device (and, unless only devices are asked for, every Windows sign-in); voids the pending code. */
  revokeAll(what: 'devices' | 'everything' = 'everything'): void {
    this.update((d) => ({
      ...d,
      epoch: d.epoch + 1,
      devices: [],
      windows: what === 'everything' ? [] : d.windows,
      code: null,
    }));
  }

  /** Remembers which network LAN mode was turned on for (null: forget it). */
  setNetwork(network: string | null): void {
    this.update((d) => ({ ...d, network }));
  }
}
