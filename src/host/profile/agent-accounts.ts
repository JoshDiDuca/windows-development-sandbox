// Saved logins for agents other than Claude: <storage>\accounts\<agent>\<name>\ holds a copy of the agent's login files
// (the harness `home.loginFiles`, each one encrypted with Windows DPAPI as <file>.sealed) and meta.json. Host-only
// storage, never mapped into a sandbox; switching decrypts the files into the sandbox's persistent state. Copies saved
// by older versions were plain: they are encrypted the next time the accounts are listed or one is switched to.
// Claude keeps its own older layout (accounts.ts).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';
import { isSafeFileName } from '../../shared/paths/index.js';
import { SecretStore } from '../secrets/index.js';
import { assertNoLinks, ensureDir, fail, isLink } from '../../core/util/index.js';
import { accountsDir, type AccountRow } from './accounts.js';

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
/** A login file is a few KB; the sandbox writes them, so a huge one is refused. */
const MAX_LOGIN_BYTES = 1024 * 1024;

const MetaSchema = z.object({ name: z.string().regex(NAME), savedAt: z.string().max(64) });
const IndexSchema = z.object({
  default: z.string().regex(NAME).optional(),
  active: z.record(z.string().max(200), z.string().regex(NAME)).optional(),
});
type Index = z.output<typeof IndexSchema>;

function validName(name: string): boolean {
  return NAME.test(name) && !['index', 'meta'].includes(name.toLowerCase()) && isSafeFileName(name);
}
function assertName(name: string): void {
  if (!validName(name))
    fail('Invalid account name "' + name + '".', 'Use letters, numbers, - and _ only (max 40), e.g. work or personal.');
}

export class AgentAccountStore {
  /**
   * @param loginFiles files of the login, relative to the folder they are read from and written to
   */
  constructor(
    private readonly storageRoot: string,
    private readonly agent: string,
    private readonly loginFiles: readonly string[],
    private readonly secrets: SecretStore = SecretStore.standard(storageRoot),
  ) {}

  /** Encrypts the plain login files of every account saved by an older version. */
  sealLegacy(): void {
    if (!fs.existsSync(this.dir)) return;
    for (const d of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.isSymbolicLink() || !validName(d.name)) continue;
      for (const f of this.loginFiles) {
        const plain = path.join(this.folder(d.name), ...f.split(/[\\/]/));
        if (!fs.existsSync(plain) || isLink(plain)) continue;
        try {
          fs.writeFileSync(plain + '.sealed', this.secrets.sealBytes(fs.readFileSync(plain)));
          fs.rmSync(plain);
        } catch {
          // Could not encrypt now: the plain copy stays readable and is tried again next time.
        }
      }
    }
  }

  private get dir(): string {
    return path.join(accountsDir(this.storageRoot), this.agent);
  }
  private folder(name: string): string {
    return path.join(this.dir, name);
  }
  private index(): JsonFile<Index> {
    return new JsonFile(IndexSchema, path.join(this.dir, 'index.json'));
  }
  private readIndex(): Index {
    return this.index().read() ?? {};
  }
  private updateIndex(change: (index: Index) => Index): void {
    ensureDir(this.dir);
    this.index().write(change(this.readIndex()));
  }

  private meta(name: string): z.output<typeof MetaSchema> | null {
    return validName(name) ? new JsonFile(MetaSchema, path.join(this.folder(name), 'meta.json')).read() : null;
  }

  defaultName(): string | null {
    return this.readIndex().default ?? null;
  }
  activeFor(dataPath: string): string | null {
    return this.readIndex().active?.[path.basename(dataPath)] ?? null;
  }
  private setActive(dataPath: string, name: string): void {
    this.updateIndex((i) => ({ ...i, active: { ...i.active, [path.basename(dataPath)]: name } }));
  }

  list(dataPath: string): AccountRow[] {
    if (!fs.existsSync(this.dir)) return [];
    this.sealLegacy();
    const def = this.defaultName();
    const active = this.activeFor(dataPath);
    return fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.isSymbolicLink())
      .map((d) => this.meta(d.name))
      .filter((m) => m !== null)
      .map((m) => ({
        name: m.name,
        email: null,
        isDefault: m.name === def,
        isActive: m.name === active,
        savedAt: m.savedAt,
      }));
  }

  /** Copies the login files found in `from` into the account (an error when there are none: nobody signed in). */
  private store(name: string, from: string): void {
    const target = this.folder(name);
    const found = this.loginFiles.filter((f) => {
      const file = path.join(from, f);
      return (
        fs.existsSync(file) && !isLink(file) && fs.statSync(file).isFile() && fs.statSync(file).size <= MAX_LOGIN_BYTES
      );
    });
    if (!found.length)
      fail(
        'No saved login found for ' + this.agent + ' in ' + from + '.',
        'Sign in to ' + this.agent + ' first, then save it.',
      );
    assertNoLinks(from, path.dirname(path.join(from, found[0])));
    fs.rmSync(target, { recursive: true, force: true });
    for (const f of found) {
      const dest = path.join(target, ...f.split(/[\\/]/));
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest + '.sealed', this.secrets.sealBytes(fs.readFileSync(path.join(from, f))));
    }
    new JsonFile(MetaSchema, path.join(target, 'meta.json')).write({ name, savedAt: new Date().toISOString() });
  }

  /** Saves the login found in `from` (the sandbox's state folder of the agent, or this PC's folder) under `name`. */
  save(dataPath: string, name: string, from: string, fromSandbox: boolean): void {
    assertName(name);
    this.store(name, from);
    if (fromSandbox) this.setActive(dataPath, name);
    if (!this.defaultName()) this.setDefault(name);
  }

  /** Makes `name` the sandbox's login: the files go into `to` (the agent's state folder in the sandbox's data). */
  activate(dataPath: string, name: string, to: string): void {
    if (!this.meta(name))
      fail(
        'Unknown account "' + name + '".',
        'Saved accounts: ' +
          (this.list(dataPath)
            .map((a) => a.name)
            .join(', ') || 'none yet'),
      );
    this.sealLegacy();
    // Tokens rotate while the agent runs: the outgoing account's current files are saved back first.
    const outgoing = this.activeFor(dataPath);
    if (outgoing && outgoing !== name && this.meta(outgoing)) {
      try {
        this.store(outgoing, to);
      } catch {
        /* nothing usable to save back */
      }
    }
    for (const f of this.loginFiles) {
      const dest = path.join(to, ...f.split(/[\\/]/));
      ensureDir(path.dirname(dest));
      // The sandbox wrote this folder: never write through a link it planted.
      assertNoLinks(to, path.dirname(dest));
      if (isLink(dest)) fs.rmSync(dest);
      const saved = path.join(this.folder(name), ...f.split(/[\\/]/));
      if (fs.existsSync(saved + '.sealed'))
        fs.writeFileSync(dest, this.secrets.openBytes(fs.readFileSync(saved + '.sealed', 'utf8')));
      else if (fs.existsSync(saved)) fs.copyFileSync(saved, dest);
      else fs.rmSync(dest, { force: true });
    }
    this.setActive(dataPath, name);
  }

  setDefault(name: string | null): void {
    if (name !== null && !this.meta(name)) fail('Unknown account "' + name + '".', 'See your accounts first.');
    this.updateIndex((i) => ({ ...i, default: name ?? undefined }));
  }

  remove(name: string): void {
    if (!this.meta(name)) fail('Unknown account "' + name + '".', 'See your accounts first.');
    fs.rmSync(this.folder(name), { recursive: true, force: true });
    this.updateIndex((i) => ({
      default: i.default === name ? undefined : i.default,
      active: Object.fromEntries(Object.entries(i.active ?? {}).filter(([, n]) => n !== name)),
    }));
  }

  rename(name: string, to: string): void {
    assertName(to);
    const meta = this.meta(name) ?? fail('Unknown account "' + name + '".', 'See your accounts first.');
    if (this.meta(to) || fs.existsSync(this.folder(to)))
      fail('There is an account "' + to + '" already.', 'Pick another name.');
    fs.renameSync(this.folder(name), this.folder(to));
    new JsonFile(MetaSchema, path.join(this.folder(to), 'meta.json')).write({ ...meta, name: to });
    this.updateIndex((i) => ({
      default: i.default === name ? to : i.default,
      active: Object.fromEntries(Object.entries(i.active ?? {}).map(([k, n]) => [k, n === name ? to : n])),
    }));
  }
}
