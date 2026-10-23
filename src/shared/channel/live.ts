// Live folders through HCS (opt-in alpha, docs/design/hcs-live-folders.md): the host -> guest messages that make a
// folder the host shared into the running sandbox appear at C:\Workspace\<name>. Requests go in run\live, replies in
// run\live-replies. Every request is signed: {payload: "<the JSON text>", mac: HMAC-SHA256(key, payload)}; the MAC is
// over the exact payload text, never over a re-serialised object. The key is made per launch, travels to the sandbox
// only in the one-shot secrets file (other users of a shared sandbox may write run\, never secrets\) and is kept on the
// host sealed with DPAPI. The agent is an administrator in the sandbox, so it can read the key there: the signature
// keeps other users and stale or replayed files from driving the daemon, and the real boundary is that only the host
// decides what is shared (a guest can only show or hide what it was given).
import crypto from 'node:crypto';
import { z } from 'zod';
import { IdSchema } from './schema.js';

/** This tool's vSMB share names: never the 64-hex names Windows Sandbox gives its own shares. */
export const LIVE_SHARE_NAME = /^agentsbx-[0-9a-f]{8,32}$/;
/** A folder name under C:\Workspace: no dots or spaces, so no "..", "foo." or "foo " aliases of other folders. */
export const LIVE_FOLDER_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const LIVE_KEY = /^[0-9a-f]{64}$/;
export const LIVE_TOKEN = /^[0-9a-f]{32}$/;
/** How old (or how far in the future) a request may be, by the guest's clock. */
export const LIVE_MAX_AGE_MS = 2 * 60 * 1000;
const MAX_PAYLOAD = 4096;

export const LivePayloadSchema = z.strictObject({
  v: z.literal(1),
  /** canary: show the share, read token.txt, hide it again and reply with the token; map / unmap: the real folder. */
  kind: z.enum(['canary', 'map', 'unmap']),
  id: IdSchema,
  launchId: z.string().min(1).max(64),
  share: z.string().regex(LIVE_SHARE_NAME).optional(),
  folder: z.string().regex(LIVE_FOLDER_NAME),
  readOnly: z.boolean(),
  createdAt: z.string().max(64),
});
export type LivePayload = z.output<typeof LivePayloadSchema>;

export const LiveEnvelopeSchema = z.strictObject({
  payload: z.string().min(2).max(MAX_PAYLOAD),
  mac: z.string().regex(/^[0-9a-f]{64}$/),
});
export type LiveEnvelope = z.output<typeof LiveEnvelopeSchema>;

/** run\live-replies\<id>.json (guest-written: checked, capped; the host only ever compares the token). */
export const LiveReplySchema = z.strictObject({
  id: IdSchema,
  ok: z.boolean(),
  message: z.string().max(1000),
  token: z.string().regex(LIVE_TOKEN).optional(),
  finishedAt: z.string().max(64),
});
export type LiveReply = z.output<typeof LiveReplySchema>;

function mac(key: string, payload: string): string {
  return crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(payload, 'utf8').digest('hex');
}

/** A signed request for `payload` (host side). */
export function signLive(key: string, payload: LivePayload): LiveEnvelope {
  if (!LIVE_KEY.test(key)) throw new Error('not a live-folder key');
  const text = JSON.stringify(LivePayloadSchema.parse(payload));
  return { payload: text, mac: mac(key, text) };
}

/** Why a request is refused (guest side), or the payload it carries. */
export function openLive(
  key: string | null,
  envelope: unknown,
  o: { launchId: string; now: number },
): { payload: LivePayload } | { refused: string } {
  if (!key || !LIVE_KEY.test(key))
    return { refused: 'no live-folder key (live folders were off when the sandbox started)' };
  const env = LiveEnvelopeSchema.safeParse(envelope);
  if (!env.success) return { refused: 'not a live-folder request' };
  const want = Buffer.from(mac(key, env.data.payload), 'hex');
  const got = Buffer.from(env.data.mac, 'hex');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got))
    return { refused: 'the signature does not match' };
  let json: unknown;
  try {
    json = JSON.parse(env.data.payload);
  } catch {
    return { refused: 'the signed payload is not JSON' };
  }
  const parsed = LivePayloadSchema.safeParse(json);
  if (!parsed.success) return { refused: 'the signed payload has the wrong shape' };
  const p = parsed.data;
  if (p.launchId !== o.launchId) return { refused: 'it is for another launch' };
  const at = Date.parse(p.createdAt);
  if (!Number.isFinite(at) || Math.abs(o.now - at) > LIVE_MAX_AGE_MS) return { refused: 'it is too old' };
  if (p.kind !== 'unmap' && !p.share) return { refused: 'it names no share' };
  return { payload: p };
}

/** A new random share name (host side). */
export function newShareName(): string {
  return 'agentsbx-' + crypto.randomBytes(8).toString('hex');
}

/** A new launch key (host side). */
export function newLiveKey(): string {
  return crypto.randomBytes(32).toString('hex');
}
