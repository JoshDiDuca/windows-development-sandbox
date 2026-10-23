// The one-shot secrets the host handed over (shared/channel/secrets.ts): read once, the file deleted at once. What the
// boot read for the agent is passed to the daemon in its own environment (SBX_BOOT_SECRETS, removed there at start), so
// nothing waits on disk.
import fs from 'node:fs';
import type { GuestRequest } from '../../core/types.js';
import { mergeRequestSecrets, SecretsFileSchema, type SecretsFile } from '../../shared/channel/secrets.js';
import { run } from './paths.js';
import { warn } from './log.js';
import { session } from './session.js';

/** Where the boot's secrets travel from main.js to the daemon. */
export const BOOT_SECRETS_VARIABLE = 'SBX_BOOT_SECRETS';
const MAX_BYTES = 4 * 1024 * 1024;

/** Reads and deletes <data>\secrets\<id>.json; nothing (or an unreadable file) gives {}. */
export function takeSecrets(id: string): SecretsFile {
  const file = run.secretFile(id);
  let text: string;
  try {
    if (fs.statSync(file).size > MAX_BYTES) throw new Error('too big');
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return {};
  } finally {
    fs.rmSync(file, { force: true });
  }
  try {
    const parsed = SecretsFileSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON: treated like an invalid file below.
  }
  warn('The secrets file for ' + id + ' was not valid and was ignored.');
  return {};
}

/** The agent the sandbox booted with gets its environment (in memory only). */
export function applyBootEnvironment(environment: Record<string, string> | undefined): void {
  if (session.harness && environment) session.harness.environment = { ...environment };
}

/**
 * The daemon takes what main.js passed it, and removes it from its own environment before any session starts. Returns
 * the live-folder key, if the launch made one (the daemon keeps it in its own state).
 */
export function adoptBootSecrets(): string | undefined {
  const text = process.env[BOOT_SECRETS_VARIABLE];
  delete process.env[BOOT_SECRETS_VARIABLE];
  if (!text) return undefined;
  try {
    const parsed = SecretsFileSchema.pick({ harnessEnvironment: true, liveFoldersKey: true }).safeParse(
      JSON.parse(text),
    );
    if (parsed.success) {
      applyBootEnvironment(parsed.data.harnessEnvironment);
      return parsed.data.liveFoldersKey;
    }
  } catch {
    // Reported below.
  }
  warn('The boot secrets given to the daemon were not valid.');
  return undefined;
}

/** A request with the agent environment values that travelled in its own secrets file put back (in memory only). */
export function withRequestSecrets(req: GuestRequest): GuestRequest {
  if (req.kind !== 'session' && req.kind !== 'project') return req;
  return mergeRequestSecrets(req, takeSecrets(req.id));
}
