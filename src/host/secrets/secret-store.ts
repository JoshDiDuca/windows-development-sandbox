// Encryption at rest for what must not sit in plain files (saved logins, the VPN login). The real box is Windows DPAPI
// for the current user (HostTools.exe protect, else native\scripts\protect-data.ps1: data on standard input, never on
// a command line); the memory box is the self-test's stand-in and is not secure. A sealed value is a short string:
// "<kind>:<base64>".
import { spawnSync } from 'node:child_process';
import { fail } from '../../core/util/index.js';
import { SYSTEM } from '../../shared/system.js';
import { selfTestRunning } from '../../shared/test-guard.js';
import { hostToolsExe, nativeScript } from '../native.js';

/** Something that turns bytes into a sealed string and back. */
export interface SecretBox {
  readonly kind: string;
  seal(plain: Buffer): string;
  open(sealed: string): Buffer;
}

const TIMEOUT_MS = 60000;

/** HostTools.exe per storage folder (null: it cannot be built there), found once per process. */
const toolsFor = new Map<string, string | null>();

function dpapiTool(storageRoot: string): string | null {
  if (!toolsFor.has(storageRoot)) {
    let exe: string | null = null;
    try {
      exe = hostToolsExe(storageRoot);
    } catch {
      // Its bin folder cannot be written (another user's storage): PowerShell does the work.
    }
    toolsFor.set(storageRoot, exe);
  }
  return toolsFor.get(storageRoot) ?? null;
}

/**
 * DPAPI for the current Windows user: HostTools.exe (built in <storageRoot>\bin; about 0.15 s a call) when a storage
 * folder is known, else powershell.exe 5.1 (about 2 s a call, which a menu feels). Both read and write the same format.
 */
class DpapiBox implements SecretBox {
  readonly kind = 'dpapi1';
  constructor(private readonly storageRoot: string | null) {}

  seal(plain: Buffer): string {
    return this.run('protect', plain.toString('base64'));
  }

  open(sealed: string): Buffer {
    return Buffer.from(this.run('unprotect', sealed), 'base64');
  }

  private run(mode: 'protect' | 'unprotect', input: string): string {
    const tools = this.storageRoot ? dpapiTool(this.storageRoot) : null;
    const [exe, args] = tools
      ? [tools, [mode]]
      : [SYSTEM.powershell(), nativeScript('protect-data.ps1', ['-Mode', mode])];
    const result = spawnSync(exe, args, {
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: TIMEOUT_MS,
    });
    if (result.status !== 0 || result.error)
      fail(
        'Windows could not ' +
          (mode === 'protect' ? 'encrypt' : 'decrypt') +
          ' a saved secret: ' +
          (result.stderr || result.error?.message || 'no answer').trim().slice(0, 300),
        mode === 'protect'
          ? 'Check that powershell.exe runs for your user.'
          : 'It can only be opened by the Windows user that saved it, on the PC that saved it. Save it again.',
      );
    return result.stdout.trim();
  }
}

/** A reversible stand-in for tests: it only proves the callers seal and open, not that anything is secret. */
class MemoryBox implements SecretBox {
  readonly kind = 'mem1';

  seal(plain: Buffer): string {
    return Buffer.from(plain.toString('base64')).toString('base64');
  }

  open(sealed: string): Buffer {
    return Buffer.from(Buffer.from(sealed, 'base64').toString('utf8'), 'base64');
  }
}

/** Seals and opens text and JSON with one box. The sealed form says which box made it. */
export class SecretStore {
  constructor(private readonly box: SecretBox) {}

  /** Windows DPAPI, current user; with a storage folder, through its HostTools.exe (much faster than PowerShell). */
  static dpapi(storageRoot: string | null = null): SecretStore {
    return new SecretStore(new DpapiBox(storageRoot));
  }

  /** The test stand-in (not secure). */
  static memory(): SecretStore {
    return new SecretStore(new MemoryBox());
  }

  /** What the program uses: DPAPI, except during the self-test (it never spawns Windows for this). */
  static standard(storageRoot: string | null = null): SecretStore {
    return selfTestRunning() ? SecretStore.memory() : SecretStore.dpapi(storageRoot);
  }

  /** True when `value` looks like something seal() made (any box). */
  static isSealed(value: unknown): value is string {
    return typeof value === 'string' && /^(dpapi1|mem1):[A-Za-z0-9+/=]+$/.test(value);
  }

  seal(text: string): string {
    return this.box.kind + ':' + this.box.seal(Buffer.from(text, 'utf8'));
  }

  open(sealed: string): string {
    return this.openBytes(sealed).toString('utf8');
  }

  sealBytes(plain: Buffer): string {
    return this.box.kind + ':' + this.box.seal(plain);
  }

  openBytes(sealed: string): Buffer {
    const at = sealed.indexOf(':');
    if (at < 0 || sealed.slice(0, at) !== this.box.kind)
      fail('A saved secret was made on another system or with another store.', 'Save it again.');
    return this.box.open(sealed.slice(at + 1));
  }

  sealJson(value: unknown): string {
    return this.seal(JSON.stringify(value));
  }

  openJson(sealed: string): unknown {
    return JSON.parse(this.open(sealed));
  }
}
