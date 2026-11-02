// Your saved service sign-ins for sandboxes (accounts.<kind>.share), one file per kind in host-only storage
// (<storage>\accounts\<kind>.json): when and where it was saved, a short summary (an account name, never a secret) and
// the sign-in sealed with Windows DPAPI. Never printed, logged or returned to a surface: only the launch reads it.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';
import {
  ACCOUNT_SOURCES,
  PAYLOADS,
  SERVICE_SPECS,
  type AccountSource,
  type Payload,
  type ServiceKind,
} from '../../shared/accounts/index.js';
import { fail } from '../../core/util/index.js';
import { SecretStore } from '../secrets/index.js';

const SavedSchema = z.object({
  savedAt: z.string().max(64),
  source: z.enum(ACCOUNT_SOURCES as [AccountSource, ...AccountSource[]]),
  summary: z.string().max(200).nullable(),
  sealed: z.string().max(4 * 1024 * 1024),
});
type Saved = z.output<typeof SavedSchema>;

export type AccountState = 'none' | 'saved' | 'unreadable';

export interface AccountInfo {
  readonly savedAt: string;
  readonly source: AccountSource;
  readonly summary: string | null;
}

/** The folder of the store, the leases and nothing else (host-only storage, never mapped). */
export function accountsDir(storageRoot: string): string {
  return path.join(storageRoot, 'accounts');
}

export class ServiceAccountStore {
  constructor(
    private readonly storageRoot: string,
    private readonly secrets: SecretStore = SecretStore.standard(storageRoot),
  ) {}

  private file(kind: ServiceKind): JsonFile<Saved> {
    return new JsonFile(SavedSchema, path.join(accountsDir(this.storageRoot), kind + '.json'));
  }

  /** Whether a sign-in is saved and can be opened by this Windows user (it is never returned here). */
  state(kind: ServiceKind): AccountState {
    if (!this.file(kind).read()) return 'none';
    try {
      return this.read(kind) ? 'saved' : 'none';
    } catch {
      return 'unreadable';
    }
  }

  info(kind: ServiceKind): AccountInfo | null {
    const saved = this.file(kind).read();
    return saved ? { savedAt: saved.savedAt, source: saved.source, summary: saved.summary } : null;
  }

  /** The sign-in, decrypted. Only the launch calls this; throws when this Windows user cannot open it. */
  read<K extends ServiceKind>(kind: K): Payload<K> | null {
    const saved = this.file(kind).read();
    if (!saved) return null;
    const payload = PAYLOADS[kind].safeParse(this.secrets.openJson(saved.sealed));
    if (!payload.success)
      fail(
        'The saved ' + SERVICE_SPECS[kind].label + ' sign-in is damaged.',
        'Save it again: sandbox account import ' + kind + ' (or login).',
      );
    return payload.data as Payload<K>;
  }

  save<K extends ServiceKind>(
    kind: K,
    payload: Payload<K>,
    source: AccountSource,
    summary: string | null = null,
  ): void {
    const checked = PAYLOADS[kind].parse(payload);
    if (JSON.stringify(checked).length > SERVICE_SPECS[kind].maxBytes)
      fail('That ' + SERVICE_SPECS[kind].label + ' sign-in is too big to keep.');
    this.file(kind).write({
      savedAt: new Date().toISOString(),
      source,
      summary: summary === null ? null : summary.slice(0, 200),
      sealed: this.secrets.sealJson(checked),
    });
  }

  remove(kind: ServiceKind): boolean {
    const file = this.file(kind).file;
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  }
}
