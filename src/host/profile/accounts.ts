// Several Claude logins for the sandbox. Each account is a saved copy of Claude's .credentials.json (a subscription) or
// an Anthropic API key (one a Console login made, or one you gave), plus the `oauthAccount` block of .claude.json, kept
// in host-only storage (<storage>\accounts, never mapped into a sandbox) and encrypted with Windows DPAPI
// (host/secrets): only the name, e-mail, date, kind and a key's last 4 characters are readable in the file. Accounts
// saved before that were plain; they are encrypted the first time they are read.
// Switching writes them into the sandbox's persistent Claude state, where Claude itself keeps that kind of login
// (claude-login.ts); when the sandbox is running the agent is then restarted in place with --continue so the
// conversation carries on.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ANTHROPIC_KEY_HINT } from '../../app/features/accounts/anthropic.def.js';
import { isSafeFileName } from '../../shared/paths/index.js';
import { JsonFile } from '../../shared/io/index.js';
import { storageOf } from '../storage/index.js';
import { errMsg, fail, fileExists, isLink } from '../../core/util/index.js';
import { SecretStore } from '../secrets/index.js';
import { PluginShare } from './plugin-share.js';
import {
  apiKeyProblem,
  clearAccountCaches,
  dropSubscription,
  emailOf,
  keyState,
  LOGIN_KINDS,
  maskApiKey,
  MAX_STATE_BYTES,
  readLogin,
  sandboxClaudeDir,
  readUntrusted,
  sandboxLogin,
  subscriptionState,
  writeSandboxJson,
  type CaptureOptions,
  type Login,
  type LoginFiles,
  type LoginKind,
} from './claude-login.js';

export interface Account {
  readonly name: string;
  readonly savedAt: string;
  readonly email: string | null;
  readonly kind: LoginKind;
  /** sk-ant-...abcd for a key; null for a subscription. */
  readonly keyHint: string | null;
  readonly credentials: unknown;
  readonly oauthAccount: unknown;
  readonly apiKey?: string;
}
export interface AccountRow {
  readonly name: string;
  readonly email: string | null;
  readonly isDefault: boolean;
  readonly isActive: boolean;
  readonly savedAt: string;
  /** Claude accounts only. */
  readonly kind?: LoginKind;
  readonly keyHint?: string | null;
}

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
/** A plain file from before accounts were encrypted (always a subscription). */
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
/** On disk: the readable details and the sealed login ({ credentials, oauthAccount, apiKey }). */
const SealedSchema = z.object({
  name: z.string().regex(NAME),
  savedAt: z.string().max(64),
  email: z.string().max(200).nullable(),
  /** Missing in accounts saved before keys could be: a subscription. */
  kind: z.enum(LOGIN_KINDS).optional(),
  keyHint: z.string().regex(ANTHROPIC_KEY_HINT).optional(),
  sealed: z.string().max(200000),
});
type Stored = z.output<typeof SealedSchema> | z.output<typeof AccountSchema>;
const StoredSchema = z.union([SealedSchema, AccountSchema]) as unknown as z.ZodType<Stored>;
const isSealed = (s: Stored): s is z.output<typeof SealedSchema> => 'sealed' in s;
/** What the sealed part holds. */
const LoginSchema = z.object({
  credentials: z.unknown(),
  oauthAccount: z.unknown(),
  apiKey: z.string().max(512).optional(),
});
/** What lists need: no decryption. */
export interface AccountMeta {
  readonly name: string;
  readonly savedAt: string;
  readonly email: string | null;
  readonly kind: LoginKind;
  readonly keyHint: string | null;
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
    const { name, savedAt, email, kind, keyHint, credentials, oauthAccount, apiKey } = account;
    return {
      name,
      savedAt,
      email,
      kind,
      ...(keyHint ? { keyHint } : {}),
      sealed: this.secrets.sealJson({ credentials, oauthAccount, ...(apiKey ? { apiKey } : {}) }),
    };
  }

  private store(name: string, login: Login): Account {
    const account: Account = {
      name,
      savedAt: new Date().toISOString(),
      email: emailOf(login.oauthAccount),
      keyHint: login.apiKey ? maskApiKey(login.apiKey) : null,
      ...login,
    };
    this.file(name).write(this.seal(account));
    return account;
  }

  /** The saved account's name, date, e-mail and kind (nothing is decrypted). */
  meta(name: string): AccountMeta | null {
    const stored = validName(name) ? this.file(name).read() : null;
    if (!stored) return null;
    const sealed = isSealed(stored) ? stored : null;
    return {
      name: stored.name,
      savedAt: stored.savedAt,
      email: stored.email,
      kind: sealed?.kind ?? 'subscription',
      keyHint: sealed?.keyHint ?? null,
    };
  }

  /**
   * The saved account with its login decrypted. A plain file from an older version is encrypted on the spot (it stays
   * readable when that fails).
   */
  read(name: string): Account | null {
    const stored = validName(name) ? this.file(name).read() : null;
    if (!stored) return null;
    if (isSealed(stored)) {
      const login = LoginSchema.parse(this.secrets.openJson(stored.sealed));
      const kind = stored.kind ?? 'subscription';
      if (kind !== 'subscription' && (login.apiKey === undefined || apiKeyProblem(login.apiKey) !== null))
        fail('The saved account "' + name + '" holds no usable API key.', 'Remove it and save the key again.');
      return {
        name: stored.name,
        savedAt: stored.savedAt,
        email: stored.email,
        kind,
        keyHint: stored.keyHint ?? null,
        credentials: login.credentials,
        oauthAccount: login.oauthAccount,
        ...(kind === 'subscription' ? {} : { apiKey: login.apiKey }),
      };
    }
    const plain: Account = { ...stored, kind: 'subscription', keyHint: null };
    try {
      this.file(name).write(this.seal(plain));
    } catch {
      // Could not encrypt now (DPAPI unavailable): the old plain file stays and is tried again next time.
    }
    return plain;
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
        kind: a.kind,
        keyHint: a.keyHint,
      }));
  }

  /**
   * Saves the sandbox's current login (or this PC's, with fromHost) under `name`, whichever kind it is (`how.keyOnly`:
   * only an API key; `how.envKey`: this PC's ANTHROPIC_API_KEY when nothing else is found).
   */
  save(dataPath: string, name: string, fromHost: LoginFiles | null, how: CaptureOptions = {}): Account {
    assertName(name);
    const source = fromHost ?? sandboxLogin(dataPath);
    return this.keep(dataPath, name, readLogin(source.claudeDir, source.globalStateFile, how), !fromHost);
  }

  /** Saves an API key you gave (typed in) under `name`. */
  saveApiKey(dataPath: string, name: string, apiKey: string): Account {
    assertName(name);
    const key = apiKey.trim();
    const problem = apiKeyProblem(key);
    if (problem) fail('That is not an Anthropic API key.', problem);
    return this.keep(dataPath, name, { kind: 'api-key', credentials: null, oauthAccount: null, apiKey: key }, false);
  }

  private keep(dataPath: string, name: string, login: Login, fromSandbox: boolean): Account {
    const account = this.store(name, login);
    if (fromSandbox) setActive(dataPath, name);
    if (!this.defaultName()) this.setDefault(name);
    return account;
  }

  /**
   * Makes `name` the sandbox's login. Claude refreshes (rotates) subscription tokens while it runs, so the outgoing
   * subscription's current tokens are saved back first; otherwise its stored refresh token could already be invalid.
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
    if (outgoing && outgoing !== name && this.meta(outgoing)?.kind === 'subscription') {
      try {
        const current = readLogin(claudeDir, globalStateFile);
        // Only a subscription is saved back over a subscription (a key login made inside would not be one).
        if (current.kind === 'subscription') this.store(outgoing, current);
      } catch {
        /* nothing usable to save back */
      }
    }
    fs.mkdirSync(claudeDir, { recursive: true });
    clearAccountCaches(claudeDir);
    const state = readUntrusted(globalStateFile, MAX_STATE_BYTES) as Record<string, unknown> | null;
    // A state file that is there but cannot be read (too big, not JSON) is not replaced: it holds the projects' state.
    const writable = state !== null || !fileExists(globalStateFile) || isLink(globalStateFile);
    if (account.kind === 'subscription') {
      writeSandboxJson(path.join(claudeDir, '.credentials.json'), account.credentials);
      if (writable && (account.oauthAccount || typeof state?.primaryApiKey === 'string'))
        writeSandboxJson(globalStateFile, subscriptionState(state ?? {}, account.oauthAccount));
    } else {
      if (!writable)
        fail(
          "The sandbox's Claude state (" + globalStateFile + ') cannot be read, so the API key cannot be put in.',
          'Delete that file (Claude makes a new one), then switch again.',
        );
      dropSubscription(claudeDir);
      writeSandboxJson(globalStateFile, keyState(state ?? {}, account.apiKey ?? '', account.oauthAccount));
    }
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
