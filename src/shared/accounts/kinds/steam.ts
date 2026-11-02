// SteamCMD's cached login, for the host (a steamcmd folder on this PC) and the sandbox (C:\SteamCMD): config\config.vdf
// (its ConnectCache holds the login token) and the ssfn sentry files beside steamcmd.exe. No password is ever in them.
// Every file is read bounded and without following links: the sandbox may have written them.
import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile } from '../../io/bounded.js';
import { decodeText } from '../../io/text.js';
import { parseVdf, vdfObject, type VdfObject } from '../../vdf.js';
import { SteamPayloadSchema, type Payload } from '../payloads.js';

export type SteamPayload = Payload<'steam'>;

/** At most this much of config.vdf is read (the payload's limit). */
export const MAX_STEAM_CONFIG_BYTES = 256 * 1024;
/** A sentry's bytes (its base64 fits the payload's 64 KB). */
export const MAX_SENTRY_BYTES = 48 * 1024;
const MAX_SENTRIES = 4;
const MAX_ENTRIES = 5000;
const SENTRY = /^ssfn\d{1,40}$/;
export const STEAM_ACCOUNT = /^[A-Za-z0-9_]{1,64}$/;
/** The file SteamCMD's folder keeps the account name in (sbx-steam writes it; config.vdf may not say it). */
export const STEAM_ACCOUNT_FILE = 'sbx-account.txt';

export function steamConfigFile(steamcmdDir: string): string {
  return path.join(steamcmdDir, 'config', 'config.vdf');
}

function steamKey(root: VdfObject | null): VdfObject | undefined {
  return vdfObject(root, 'InstallConfigStore', 'Software', 'Valve', 'Steam');
}

/** Whether a config.vdf holds a cached login (a ConnectCache entry). */
export function hasCachedLogin(configVdf: string): boolean {
  const cache = vdfObject(steamKey(parseVdf(configVdf, { maxBytes: MAX_STEAM_CONFIG_BYTES })), 'ConnectCache');
  return cache !== undefined && Object.keys(cache).length > 0;
}

/** The account names a config.vdf knows (its Accounts block), in order. */
export function steamAccounts(configVdf: string): string[] {
  const accounts = vdfObject(steamKey(parseVdf(configVdf, { maxBytes: MAX_STEAM_CONFIG_BYTES })), 'Accounts');
  return accounts ? Object.keys(accounts).filter((a) => STEAM_ACCOUNT.test(a)) : [];
}

/** The account name kept beside SteamCMD (sbx-account.txt), or null. */
export function readSteamAccountFile(steamcmdDir: string): string | null {
  const bytes = readBoundedFile(path.join(steamcmdDir, 'config', STEAM_ACCOUNT_FILE), 256);
  const name = bytes ? decodeText(bytes).text.trim() : '';
  return STEAM_ACCOUNT.test(name) ? name : null;
}

/** The sentry files beside steamcmd.exe (the newest 4, in name order), each bounded. */
export function readSentries(steamcmdDir: string): { name: string; base64: string }[] {
  let names: string[];
  try {
    names = fs
      .readdirSync(steamcmdDir)
      .slice(0, MAX_ENTRIES)
      .filter((n) => SENTRY.test(n));
  } catch {
    return [];
  }
  const mtime = (name: string): number => {
    try {
      return fs.lstatSync(path.join(steamcmdDir, name)).mtimeMs;
    } catch {
      return 0;
    }
  };
  const found: { name: string; base64: string }[] = [];
  for (const name of names.sort((a, b) => mtime(b) - mtime(a))) {
    if (found.length >= MAX_SENTRIES) break;
    const bytes = readBoundedFile(path.join(steamcmdDir, name), MAX_SENTRY_BYTES);
    if (bytes && bytes.length) found.push({ name, base64: bytes.toString('base64') });
  }
  // By name: the same files read back the same (file times change when they are written in a sandbox).
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The cached login in a SteamCMD folder, or null: no config.vdf, no cached login in it, or no account name (`account`
 * is used when the folder does not say one).
 */
export function readSteamCmdLogin(steamcmdDir: string, account?: string): SteamPayload | null {
  const bytes = readBoundedFile(steamConfigFile(steamcmdDir), MAX_STEAM_CONFIG_BYTES);
  if (!bytes) return null;
  const configVdf = decodeText(bytes).text;
  if (!hasCachedLogin(configVdf)) return null;
  const name = readSteamAccountFile(steamcmdDir) ?? steamAccounts(configVdf)[0] ?? account;
  if (!name) return null;
  const parsed = SteamPayloadSchema.safeParse({ account: name, configVdf, sentries: readSentries(steamcmdDir) });
  return parsed.success ? parsed.data : null;
}

/** Writes a cached login into a SteamCMD folder (config\config.vdf, the sentries, the account name). */
export function writeSteamCmdLogin(steamcmdDir: string, p: SteamPayload): void {
  const login = SteamPayloadSchema.parse(p);
  const config = path.dirname(steamConfigFile(steamcmdDir));
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(steamConfigFile(steamcmdDir), login.configVdf, 'utf8');
  fs.writeFileSync(path.join(config, STEAM_ACCOUNT_FILE), login.account, 'utf8');
  for (const s of login.sentries) fs.writeFileSync(path.join(steamcmdDir, s.name), Buffer.from(s.base64, 'base64'));
}
