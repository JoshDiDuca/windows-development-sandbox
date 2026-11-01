// The saved VPN login (for NordVPN: the "service credentials", not the account password), kept encrypted with Windows
// DPAPI in host-only storage (<storage>\vpn\<provider>.json). It is read only when a sandbox starts, to hand to the
// sandbox in a one-shot file, and is never printed or written anywhere else.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';
import { fail } from '../../core/util/index.js';
import { VPN_PROVIDERS, type VpnProvider } from '../../core/schema/index.js';
import { SecretStore } from '../secrets/index.js';

export interface VpnCredentials {
  readonly username: string;
  readonly password: string;
}

const SavedSchema = z.object({
  provider: z.enum(VPN_PROVIDERS),
  savedAt: z.string().max(64),
  sealed: z.string().max(10000),
});
type Saved = z.output<typeof SavedSchema>;

/** What `sandbox vpn status` may say about the login: never the values. */
export type LoginState = 'none' | 'saved' | 'unreadable';

/** The login must go on two lines of a file for OpenVPN, so no line breaks or other control characters. */
export function loginProblem(c: VpnCredentials): string | null {
  const clean = (v: string): boolean => !/[\u0000-\u001f\u007f]/.test(v);
  if (!c.username.trim() || !c.password) return 'Both the user name and the password are needed.';
  if (!clean(c.username) || !clean(c.password)) return 'The login may not contain line breaks or control characters.';
  if (c.username.length > 256 || c.password.length > 1024) return 'The user name or password is too long.';
  return null;
}

export class VpnLogin {
  constructor(
    private readonly storageRoot: string,
    private readonly secrets: SecretStore = SecretStore.standard(storageRoot),
  ) {}

  private file(provider: VpnProvider): JsonFile<Saved> {
    return new JsonFile(SavedSchema, path.join(this.storageRoot, 'vpn', provider + '.json'));
  }

  /** Encrypts and saves the login (replacing an earlier one). */
  save(provider: VpnProvider, login: VpnCredentials): void {
    const problem = loginProblem(login);
    if (problem) fail(problem, 'Type the service credentials again.');
    this.file(provider).write({
      provider,
      savedAt: new Date().toISOString(),
      sealed: this.secrets.sealJson({ username: login.username.trim(), password: login.password }),
    });
  }

  /** The login, decrypted. Only the launch calls this. */
  read(provider: VpnProvider): VpnCredentials | null {
    const saved = this.file(provider).read();
    if (!saved) return null;
    const value = this.secrets.openJson(saved.sealed) as Partial<VpnCredentials>;
    if (typeof value.username !== 'string' || typeof value.password !== 'string')
      fail('The saved VPN login is damaged.', 'Save it again with: sandbox vpn login');
    return { username: value.username, password: value.password };
  }

  /** Whether a login is saved and can be decrypted by this Windows user (the values are never returned). */
  state(provider: VpnProvider): LoginState {
    if (!this.file(provider).read()) return 'none';
    try {
      return this.read(provider) ? 'saved' : 'none';
    } catch {
      return 'unreadable';
    }
  }

  savedAt(provider: VpnProvider): string | null {
    return this.file(provider).read()?.savedAt ?? null;
  }

  remove(provider: VpnProvider): boolean {
    const file = this.file(provider).file;
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  }
}
