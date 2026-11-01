// Several Claude logins for the sandbox. Each account is a saved copy of Claude's .credentials.json plus the
// `oauthAccount` block of .claude.json, kept in host-only storage (<storage>\accounts, never mapped into a sandbox)
// and encrypted with Windows DPAPI (host/secrets): only the name, e-mail and date are readable in the file. Accounts
// saved before that were plain; they are encrypted the first time they are read.
// Switching writes them into the sandbox's persistent Claude state; when the sandbox is running the agent is then
// restarted in place with --continue so the conversation carries on.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isSafeFileName } from '../../shared/paths/index.js';
import { JsonFile } from '../../shared/io/index.js';
import { storageOf } from '../storage/index.js';
import { errMsg, fail, fileExists } from '../../core/util/index.js';
import { SecretStore } from '../secrets/index.js';
import { PluginShare } from './plugin-share.js';
import {
  clearAccountCaches,
  emailOf,
  MAX_STATE_BYTES,
  readLogin,
  sandboxClaudeDir,
  readUntrusted,
  sandboxLogin,
  writeSandboxJson,
  type Login,
  type LoginFiles,
} from './claude-login.js';

export interface Account {
  readonly name: string;
  readonly savedAt: string;
  readonly email: string | null;
  readonly credentials: unknown;
  readonly oauthAccount: unknown;
}
export interface AccountRow {
  readonly name: string;
  readonly email: string | null;
  readonly isDefault: boolean;
  readonly isActive: boolean;
  readonly savedAt: string;
}

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const AccountSchema = z.object({
  name: z.string().regex(NAME),
  savedAt: z.string().max(64),
  email: z.string().max(200).nullable(),
  credentials: z.looseObject({}),
  oauthAccount: z.unknown(),
});
const IndexSchema = z.object({
  default: z.string().regex(NAME).optional(),
  active: z.record(z.string().max(200), z.string().regex(NAME)).optional(),
});
type Index = z.output<typeof IndexSchema>;
/** On disk: the readable details and the sealed login ({ credentials, oauthAccount }). */
const SealedSchema = z.object({
  name: z.string().regex(NAME),
  savedAt: z.string().max(64),
  email: z.string().max(200).nullable(),
  sealed: z.string().max(200000),
});
type Stored = z.output<typeof SealedSchema> | Account;
const StoredSchema = z.union([SealedSchema, AccountSchema]) as unknown as z.ZodType<Stored>;
const isSealed = (s: Stored): s is z.output<typeof SealedSchema> => 'sealed' in s;
/** What lists need: no decryption. */
export interface AccountMeta {
  readonly name: string;
  readonly savedAt: string;
  readonly email: string | null;
}

export function accountsDir(storageRoot: string): string {
  return path.join(storageRoot, 'accounts');
}
function dataName(dataPath: string): string {
  return path.basename(dataPath);
}
function indexFile(storageRoot: string): JsonFile<Index> {
  return new JsonFile(IndexSchema, path.join(accountsDir(storageRoot), 'index.json'));
}
function readIndex(storageRoot: string): Index {
  return indexFile(storageRoot).read() ?? {};
}
function updateIndex(storageRoot: string, change: (index: Index) => Index): void {
  indexFile(storageRoot).write(change(readIndex(storageRoot)));
}

function setActive(dataPath: string, name: string): void {
  updateIndex(storageOf(dataPath), (i) => ({ ...i, active: { ...i.active, [dataName(dataPath)]: name } }));
}

/** A file name of its own: not "index" (the index file), not a Windows device name such as con or nul. */
function validName(name: string): boolean {
  return NAME.test(name) && name.toLowerCase() !== 'index' && isSafeFileName(name + '.json');
}
function assertName(name: string): void {
  if (!validName(name))
    fail('Invalid account name "' + name + '".', 'Use letters, numbers, - and _ only (max 40), e.g. work or personal.');
}
/** The saved Claude logins under <storage>\accounts, and which one each sandbox data folder uses. */
export class AccountStore {
  /** What the last activate() did with the shared plugins (a problem there never stops the switch). */
  pluginNote: string | null = null;

  /** @param sharePlugins claudeProfile.sharePluginsAcrossAccounts: carry Claude plugins to the account switched to */
  constructor(
    private readonly storageRoot: string,
    private readonly sharePlugins = false,
    private readonly secrets: SecretStore = SecretStore.standard(storageRoot),
  ) {}

  /** With the setting on: refreshes the shared plugin set from this data set, or fills this data set from it. */
  syncPlugins(dataPath: string): void {
    this.shareStep(dataPath, sandboxClaudeDir(dataPath));
  }

  private shareStep(dataPath: string, claudeDir: string): void {
    this.pluginNote = null;
    if (!this.sharePlugins) return;
    try {
      const result = PluginShare.in(this.storageRoot).sync(dataPath, claudeDir);
      if (result === 'restored') this.pluginNote = 'Claude plugins were copied in from your other accounts.';
    } catch (e) {
      this.pluginNote = 'Claude plugins were not copied: ' + errMsg(e);
    }
  }

  private file(name: string): JsonFile<Stored> {
    return new JsonFile(StoredSchema, path.join(accountsDir(this.storageRoot), name + '.json'));
  }

  private seal(account: Account): z.output<typeof SealedSchema> {
    const { name, savedAt, email, credentials, oauthAccount } = account;
    return { name, savedAt, email, sealed: this.secrets.sealJson({ credentials, oauthAccount }) };
  }

  private store(name: string, login: Login): Account {
    const account: Account = { name, savedAt: new Date().toISOString(), email: emailOf(login.oauthAccount), ...login };
    this.file(name).write(this.seal(account));
    return account;
  }

  /** The saved account's name, date and e-mail (nothing is decrypted). */
  meta(name: string): AccountMeta | null {
    const stored = validName(name) ? this.file(name).read() : null;
    return stored ? { name: stored.name, savedAt: stored.savedAt, email: stored.email } : null;
  }

  /**
   * The saved account with its login decrypted. A plain file from an older version is encrypted on the spot (it stays
   * readable when that fails).
   */
  read(name: string): Account | null {
    const stored = validName(name) ? this.file(name).read() : null;
    if (!stored) return null;
    if (isSealed(stored)) {
      const login = this.secrets.openJson(stored.sealed) as { credentials: unknown; oauthAccount: unknown };
      return { name: stored.name, savedAt: stored.savedAt, email: stored.email, ...login };
    }
    try {
      this.file(name).write(this.seal(stored));
    } catch {
      // Could not encrypt now (DPAPI unavailable): the old plain file stays and is tried again next time.
    }
    return stored;
  }

  /** Encrypts every account still saved as plain text (older versions); returns how many it did. */
  sealLegacy(): number {
    const dir = accountsDir(this.storageRoot);
    if (!fs.existsSync(dir)) return 0;
    let done = 0;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'index.json')) {
      const name = f.slice(0, -5);
      const stored = validName(name) ? this.file(name).read() : null;
      if (!stored || isSealed(stored)) continue;
      this.read(name);
      const after = this.file(name).read();
      if (after && isSealed(after)) done++;
    }
    return done;
  }

  defaultName(): string | null {
    return readIndex(this.storageRoot).default ?? null;
  }

  /** The account a data folder uses (kept in the index of the storage folder that data folder is in). */
  activeFor(dataPath: string): string | null {
    return readIndex(storageOf(dataPath)).active?.[dataName(dataPath)] ?? null;
  }

  list(dataPath: string): AccountRow[] {
    const dir = accountsDir(this.storageRoot);
    if (!fs.existsSync(dir)) return [];
    this.sealLegacy();
    const def = this.defaultName();
    const active = this.activeFor(dataPath);
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map((f) => this.meta(f.slice(0, -5)))
      .filter((a): a is AccountMeta => a !== null)
      .map((a) => ({
        name: a.name,
        email: a.email,
        isDefault: a.name === def,
        isActive: a.name === active,
        savedAt: a.savedAt,
      }));
  }

  /** Saves the sandbox's current login (or this PC's, with fromHost) under `name`. */
  save(dataPath: string, name: string, fromHost: LoginFiles | null): Account {
    assertName(name);
    const source = fromHost ?? sandboxLogin(dataPath);
    const account = this.store(name, readLogin(source.claudeDir, source.globalStateFile));
    if (!fromHost) setActive(dataPath, name);
    if (!this.defaultName()) this.setDefault(name);
    return account;
  }

  /**
   * Makes `name` the sandbox's login. Claude refreshes (rotates) tokens while it runs, so the outgoing account's
   * current tokens are saved back first; otherwise its stored refresh token could already be invalid.
   */
  activate(dataPath: string, name: string): Account {
    const account =
      this.read(name) ??
      fail(
        'Unknown account "' + name + '".',
        'Saved accounts: ' +
          (this.list(dataPath)
            .map((a) => a.name)
            .join(', ') || 'none yet; save one with sandbox account save <name>'),
      );
    const { claudeDir, globalStateFile } = sandboxLogin(dataPath);
    const outgoing = this.activeFor(dataPath);
    if (outgoing && outgoing !== name && this.meta(outgoing) && fileExists(path.join(claudeDir, '.credentials.json'))) {
      try {
        this.store(outgoing, readLogin(claudeDir, globalStateFile));
      } catch {
        /* nothing usable to save back */
      }
    }
    fs.mkdirSync(claudeDir, { recursive: true });
    clearAccountCaches(claudeDir);
    writeSandboxJson(path.join(claudeDir, '.credentials.json'), account.credentials);
    const state = readUntrusted(globalStateFile, MAX_STATE_BYTES) as Record<string, unknown> | null;
    if (account.oauthAccount && (state || !fileExists(globalStateFile)))
      writeSandboxJson(globalStateFile, { ...(state ?? {}), oauthAccount: account.oauthAccount });
    this.shareStep(dataPath, claudeDir);
    setActive(dataPath, name);
    return account;
  }

  setDefault(name: string | null): void {
    if (name !== null && !this.meta(name))
      fail('Unknown account "' + name + '".', 'See your accounts with: sandbox account list');
    updateIndex(this.storageRoot, (i) => ({ ...i, default: name ?? undefined }));
  }

  rename(name: string, to: string): void {
    assertName(to);
    const account =
      this.read(name) ?? fail('Unknown account "' + name + '".', 'See your accounts with: sandbox account list');
    if (this.meta(to)) fail('There is an account "' + to + '" already.', 'Pick another name.');
    this.file(to).write(this.seal({ ...account, name: to }));
    fs.rmSync(this.file(name).file);
    updateIndex(this.storageRoot, (i) => ({
      ...i,
      default: i.default === name ? to : i.default,
      active: Object.fromEntries(Object.entries(i.active ?? {}).map(([k, n]) => [k, n === name ? to : n])),
    }));
  }

  remove(name: string): void {
    if (!this.meta(name)) fail('Unknown account "' + name + '".', 'See your accounts with: sandbox account list');
    fs.rmSync(this.file(name).file);
    if (this.defaultName() === name) this.setDefault(null);
  }
}
