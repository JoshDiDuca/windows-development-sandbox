// At boot: each handed-over sign-in goes to its tool (the adapters), then is dropped from memory. What was delivered
// is remembered only as fingerprints, with the kinds whose lease this launch holds, in delivered.json on the
// sandbox's own disk: the daemon's watch starts from them, so its first look never hands back what it was given.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { fingerprint } from '../../shared/accounts/fingerprint.js';
import { SERVICE_KINDS, type ServiceKind } from '../../shared/accounts/kinds.js';
import type { ServiceAccounts } from '../../shared/accounts/payloads.js';
import { readValid, writeJsonAtomic } from '../../shared/io/json.js';
import { errMsg } from '../../core/util/errors.js';
import { accountsRoot, type GuestAdapter } from './adapter.js';
import { ADAPTERS } from './adapters.js';

export const DeliveredSchema = z.object({
  fingerprints: z.partialRecord(z.enum(SERVICE_KINDS), z.string().max(128)),
  leased: z.array(z.enum(SERVICE_KINDS)),
});
export type Delivered = z.output<typeof DeliveredSchema>;

export function deliveredFile(root: string = accountsRoot()): string {
  return path.join(root, 'delivered.json');
}

export function readDelivered(root: string = accountsRoot()): Delivered {
  return readValid(DeliveredSchema, deliveredFile(root)) ?? { fingerprints: {}, leased: [] };
}

export interface ApplyOptions {
  /** The kinds whose lease this launch holds (session.json accountLeases). */
  readonly leased?: readonly ServiceKind[];
  /** The boot log. */
  readonly say?: (line: string) => void;
  readonly root?: string;
  readonly adapters?: { readonly [K in ServiceKind]?: GuestAdapter<K> };
}

/** Applies every sign-in given; returns the variables for the agent's sessions. A failing kind is a log line. */
export async function applyServiceAccounts(
  given: ServiceAccounts | undefined,
  o: ApplyOptions = {},
): Promise<Record<string, string>> {
  const say = o.say ?? ((): void => undefined);
  const env: Record<string, string> = {};
  const fingerprints: Partial<Record<ServiceKind, string>> = {};
  for (const kind of SERVICE_KINDS) {
    const payload = given?.[kind];
    if (payload === undefined) continue;
    const adapter = (o.adapters?.[kind] ?? ADAPTERS[kind]) as GuestAdapter<ServiceKind>;
    try {
      const applied = await adapter.apply(payload as never);
      Object.assign(env, applied.env ?? {});
      fingerprints[kind] = fingerprint(payload);
      say(applied.summary);
    } catch (e) {
      say(kind + ' sign-in: could not be used (' + errMsg(e) + ')');
    }
  }
  const root = o.root ?? accountsRoot();
  fs.mkdirSync(root, { recursive: true });
  writeJsonAtomic(deliveredFile(root), { fingerprints, leased: [...(o.leased ?? [])] } satisfies Delivered);
  return env;
}
