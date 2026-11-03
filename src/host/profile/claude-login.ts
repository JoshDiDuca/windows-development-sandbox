// A Claude login as files. Claude Code keeps three kinds (checked against Claude Code 2.1.296):
// - a subscription (/login with Claude Pro, Max, Team ...): `claudeAiOauth` in .credentials.json;
// - a Console login (/login with a Claude Console account): Claude makes an API key and keeps it as `primaryApiKey` in
//   .claude.json (not in .credentials.json), with the last 20 characters in `customApiKeyResponses.approved`;
// - an API key of your own (ANTHROPIC_API_KEY): goes where a Console key goes, so Claude uses it without asking.
// Plus the `oauthAccount` block of .claude.json (the e-mail). Claude uses a subscription over a `primaryApiKey`, so a
// key login goes in with no `claudeAiOauth` next to it, and a subscription goes in with no `primaryApiKey`.
// The sandbox's copies are guest-written: read without following links and size-capped; links are replaced, never
// written through. A key read from the sandbox must have the shape of an API key.
import fs from 'node:fs';
import path from 'node:path';
import { anthropicKeyProblem } from '../../shared/accounts/index.js';
import { assertTestWritable } from '../test-guard.js';
import { hostDataFolder, hostDataRoot } from '../storage/index.js';
import { assertNoLinks, fail, fileExists, isLink, removeLink, tryReadJson, writeJson } from '../../core/util/index.js';

/** subscription: claude.ai OAuth; console: the key a Console login made; api-key: a key you gave. */
export type LoginKind = 'subscription' | 'console' | 'api-key';
export const LOGIN_KINDS = ['subscription', 'console', 'api-key'] as const satisfies readonly LoginKind[];

export interface Login {
  readonly kind: LoginKind;
  /** The text of .credentials.json (a subscription); null for a key. */
  readonly credentials: unknown;
  readonly oauthAccount: unknown;
  /** The API key (console and api-key). */
  readonly apiKey?: string;
}

/** How a login is looked for. */
export interface CaptureOptions {
  /** Only an API key (skip a subscription found next to it). */
  readonly keyOnly?: boolean;
  /** ANTHROPIC_API_KEY of this PC: the last place looked at (--from-host only). */
  readonly envKey?: string | null;
}

/** What is wrong with a typed or found API key (sk-ant-api or sk-ant-usr), or null. Never quotes the key. */
export const apiKeyProblem = anthropicKeyProblem;

/** The most of a key that is ever shown: sk-ant-...abcd. */
export function maskApiKey(key: string): string {
  return 'sk-ant-...' + key.slice(-4);
}

/** What Claude Code records in customApiKeyResponses for a key it may use (its last 20 characters). */
function approvalOf(key: string): string {
  return key.trim().slice(-20);
}

/** A subscription login: .credentials.json with a `claudeAiOauth` block. */
function hasSubscription(credentials: unknown): boolean {
  const oauth = (credentials as { claudeAiOauth?: unknown } | null)?.claudeAiOauth;
  return typeof oauth === 'object' && oauth !== null;
}
export interface LoginFiles {
  readonly claudeDir: string;
  readonly globalStateFile: string;
}

const MAX_LOGIN_BYTES = 1024 * 1024;
/** .claude.json holds per-project state and can be large; still capped so a hostile file cannot exhaust memory. */
export const MAX_STATE_BYTES = 256 * 1024 * 1024;
/** Caches tied to an account (Claude deletes these on /logout). */
const ACCOUNT_CACHES = ['remote-settings.json', 'policy-limits.json', 'policy-limits.json.stamp.json'] as const;

export function sandboxClaudeDir(dataPath: string): string {
  return path.join(hostDataFolder(dataPath, 'state'), 'claude');
}

export function emailOf(oauthAccount: unknown): string | null {
  const email = (oauthAccount as { emailAddress?: unknown } | null)?.emailAddress;
  return typeof email === 'string' ? email.slice(0, 200) : null;
}

/** Reads a JSON file that may be sandbox-written: no links, size-capped. */
export function readUntrusted(file: string, max: number): unknown {
  return fileExists(file) && !isLink(file) && fs.statSync(file).size <= max ? tryReadJson<unknown>(file) : null;
}

/**
 * The login currently in a Claude config folder (+ its global state file), whichever kind it is: a subscription first
 * (Claude uses it over a key), then a Console or API key in `primaryApiKey`, then `envKey`.
 */
export function readLogin(claudeDir: string, globalStateFile: string, how: CaptureOptions = {}): Login {
  const credentials = readUntrusted(path.join(claudeDir, '.credentials.json'), MAX_LOGIN_BYTES);
  const state = readUntrusted(globalStateFile, MAX_STATE_BYTES) as {
    oauthAccount?: unknown;
    primaryApiKey?: unknown;
  } | null;
  const oauthAccount = state?.oauthAccount ?? null;
  if (!how.keyOnly && hasSubscription(credentials)) return { kind: 'subscription', credentials, oauthAccount };
  const managed = typeof state?.primaryApiKey === 'string' ? state.primaryApiKey.trim() : null;
  if (managed !== null && apiKeyProblem(managed) === null)
    return { kind: oauthAccount ? 'console' : 'api-key', credentials: null, oauthAccount, apiKey: managed };
  const envKey = how.envKey?.trim();
  if (envKey && apiKeyProblem(envKey) === null)
    return { kind: 'api-key', credentials: null, oauthAccount: null, apiKey: envKey };
  return how.keyOnly
    ? fail(
        'No Claude API key found in ' + claudeDir + (how.envKey === undefined ? '.' : ' or in ANTHROPIC_API_KEY.'),
        'Sign in to Claude with a Claude Console account first, or save a key you type: sandbox account save <name> --api-key',
      )
    : fail(
        'No Claude login found in ' + claudeDir + '.',
        'Sign in to Claude first (inside the sandbox, or on this PC with --from-host), then save it again.',
      );
}

/** customApiKeyResponses with `add` approved, or `remove` taken off the approved list (Claude's own shape). */
function approvals(state: Record<string, unknown>, change: { add?: string; remove?: string }): Record<string, unknown> {
  const given = (state.customApiKeyResponses ?? {}) as { approved?: unknown; rejected?: unknown };
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const add = change.add === undefined ? undefined : approvalOf(change.add);
  const remove = change.remove === undefined ? undefined : approvalOf(change.remove);
  if (add === undefined && !strings(given.approved).includes(remove ?? '')) return state;
  const approved = strings(given.approved).filter((k) => k !== add && k !== remove);
  return {
    ...state,
    customApiKeyResponses: {
      approved: add === undefined ? approved : [...approved, add],
      rejected: strings(given.rejected).filter((k) => k !== add),
    },
  };
}

/** The sandbox's .claude.json for a subscription: no `primaryApiKey` (Claude would ask about it), its e-mail block. */
export function subscriptionState(state: Record<string, unknown>, oauthAccount: unknown): Record<string, unknown> {
  const { primaryApiKey, ...rest } = state;
  const cleaned = typeof primaryApiKey === 'string' ? approvals(rest, { remove: primaryApiKey }) : rest;
  return oauthAccount ? { ...cleaned, oauthAccount } : cleaned;
}

/** The sandbox's .claude.json for a key: the key where a Console login keeps it, approved, with its e-mail block. */
export function keyState(
  state: Record<string, unknown>,
  apiKey: string,
  oauthAccount: unknown,
): Record<string, unknown> {
  const { primaryApiKey, oauthAccount: _outgoing, ...rest } = state;
  const cleaned = typeof primaryApiKey === 'string' ? approvals(rest, { remove: primaryApiKey }) : rest;
  return { ...approvals(cleaned, { add: apiKey }), primaryApiKey: apiKey, ...(oauthAccount ? { oauthAccount } : {}) };
}

/**
 * Takes the subscription out of the sandbox's .credentials.json (Claude would use it over the key); the rest of the
 * file (MCP server logins) stays. A file that cannot be read holds no login worth keeping and goes.
 */
export function dropSubscription(claudeDir: string): void {
  const file = path.join(claudeDir, '.credentials.json');
  assertTestWritable(file);
  if (isLink(file)) return removeLink(file);
  if (!fs.existsSync(file)) return;
  const credentials = readUntrusted(file, MAX_LOGIN_BYTES);
  if (typeof credentials !== 'object' || credentials === null || Array.isArray(credentials))
    return fs.rmSync(file, { force: true });
  const { claudeAiOauth: _login, ...rest } = credentials as Record<string, unknown>;
  if (Object.keys(rest).length) writeSandboxJson(file, rest);
  else fs.rmSync(file, { force: true });
}

/** The sandbox's Claude login files (refuses when the data folder holds a link on the way). */
export function sandboxLogin(dataPath: string): LoginFiles {
  assertNoLinks(hostDataRoot(dataPath), sandboxClaudeDir(dataPath));
  return {
    claudeDir: sandboxClaudeDir(dataPath),
    globalStateFile: path.join(sandboxClaudeDir(dataPath), '.claude.json'),
  };
}

/** Replaces a file that may be a sandbox-planted link instead of writing through it. */
export function writeSandboxJson(file: string, value: unknown): void {
  assertTestWritable(file);
  if (isLink(file)) removeLink(file);
  writeJson(file, value);
}

/** Removes the previous account's caches; otherwise its org policy could linger. A link is removed, not followed. */
export function clearAccountCaches(claudeDir: string): void {
  for (const cache of ACCOUNT_CACHES) {
    const file = path.join(claudeDir, cache);
    if (isLink(file)) removeLink(file);
    else fs.rmSync(file, { force: true });
  }
}
