// The LAN listener's certificate, kept in <storage>\web\tls.json with its private key sealed by SecretStore (DPAPI).
// Made the first time LAN mode starts and then kept: a new certificate means a new warning on every phone, which
// teaches people to click through, so it is replaced only when it has expired or on request
// (sandbox web lan new-certificate, which also signs out every device).
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';
import type { SecretStore } from '../secrets/index.js';
import { makeCertificate } from './cert.js';

const TlsFileSchema = z.strictObject({
  cert: z.string().max(8000),
  key: z.string().max(8000),
  fingerprint: z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/),
  notAfter: z.string().max(40),
  addresses: z.array(z.string().max(15)).max(16),
});

export interface TlsMaterial {
  readonly cert: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly notAfter: string;
}

/** Renewed this long before it ends. */
const RENEW_BEFORE_MS = 7 * 86_400_000;

export class TlsStore {
  private readonly file: JsonFile<z.output<typeof TlsFileSchema>>;

  constructor(
    dir: string,
    private readonly secrets: SecretStore,
    private readonly now: () => number = Date.now,
  ) {
    this.file = new JsonFile(TlsFileSchema, path.join(dir, 'tls.json'));
  }

  /** The kept certificate when there is a usable one (no key opened), else null. */
  info(): { fingerprint: string; notAfter: string } | null {
    const saved = this.file.read();
    return saved ? { fingerprint: saved.fingerprint, notAfter: saved.notAfter } : null;
  }

  /** The certificate to serve: the kept one, or a new one for these addresses when there is none or it ends soon. */
  material(addresses: readonly string[]): TlsMaterial {
    const saved = this.file.read();
    if (saved && Date.parse(saved.notAfter) - this.now() > RENEW_BEFORE_MS) {
      try {
        return {
          cert: saved.cert,
          key: this.secrets.open(saved.key),
          fingerprint: saved.fingerprint,
          notAfter: saved.notAfter,
        };
      } catch {
        // Sealed by another user or system: a new one is made.
      }
    }
    return this.renew(addresses);
  }

  /** A new certificate (the old one is gone). */
  renew(addresses: readonly string[]): TlsMaterial {
    const made = makeCertificate({ addresses, dnsNames: [os.hostname()], now: this.now() });
    this.file.write({
      cert: made.cert,
      key: this.secrets.seal(made.key),
      fingerprint: made.fingerprint,
      notAfter: made.notAfter,
      addresses: [...addresses],
    });
    return made;
  }
}
