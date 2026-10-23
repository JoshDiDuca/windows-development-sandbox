// The one-shot secrets file: written before the sandbox starts (or with a request), read and deleted by the sandbox at
// once. See shared/channel/secrets.ts for what it holds and why it is not in session.json or the launch folder.
import fs from 'node:fs';
import path from 'node:path';
import { RunDir, type SecretsFile } from '../../shared/channel/index.js';
import { writeJsonAtomic } from '../../shared/io/index.js';
import type { GuestRequest, Harness } from '../../core/types.js';
import { assertNoLinks } from '../../core/util/index.js';

/** Writes <data>\secrets\<id>.json (nothing at all when there is nothing secret to hand over). */
export function writeSecrets(dataPath: string, id: string, secrets: SecretsFile): string | null {
  const empty =
    !Object.keys(secrets.harnessEnvironment ?? {}).length &&
    !Object.keys(secrets.harnessSpecEnvironment ?? {}).length &&
    !Object.keys(secrets.projectHarnessEnvironment ?? {}).length &&
    !secrets.claudeCredentials &&
    !secrets.vpn &&
    !secrets.wireguardConfig &&
    !secrets.githubToken &&
    !secrets.liveFoldersKey;
  if (empty) return null;
  const run = new RunDir(dataPath);
  assertNoLinks(dataPath, run.secretsDir);
  const file = run.secretFile(id);
  writeJsonAtomic(file, secrets);
  return file;
}

/**
 * Removes whatever one-shot files are left (the sandbox did not start, or did not get to read them) and, from older
 * versions, a login copy in a launch folder. Called before a launch writes new ones, and when a launch fails before
 * its sandbox starts.
 */
export function clearSecrets(storageRoot: string, dataPath: string): number {
  let removed = 0;
  const secrets = new RunDir(dataPath).secretsDir;
  try {
    assertNoLinks(dataPath, secrets);
    for (const name of fs.readdirSync(secrets)) {
      fs.rmSync(path.join(secrets, name), { recursive: true, force: true });
      removed++;
    }
  } catch {
    // No such folder, or a link planted there: nothing to remove.
  }
  const launches = path.join(storageRoot, 'launches');
  try {
    for (const launch of fs.readdirSync(launches)) {
      const old = path.join(launches, launch, 'claude-profile', '.credentials.json');
      if (fs.existsSync(old)) {
        fs.rmSync(old, { force: true });
        removed++;
      }
    }
  } catch {
    // No launches yet.
  }
  return removed;
}

const blank = (h: Harness): Harness => ({ ...h, environment: {} });
const hasValues = (e: Record<string, string>): boolean => Object.keys(e).length > 0;

/**
 * A request with every agent's environment taken out (those values may be keys) and the values to hand over in the
 * secrets file of that request. Requests that carry none come back untouched.
 */
export function withoutSecrets(request: GuestRequest): { request: GuestRequest; secrets: SecretsFile | null } {
  if (request.kind !== 'session' && request.kind !== 'project') return { request, secrets: null };
  const project = request.project;
  const spec = request.kind === 'session' ? request.harnessSpec : undefined;
  const projectEnv = Object.fromEntries(
    Object.entries(project?.harnesses ?? {}).filter(([, h]) => hasValues(h.environment)),
  );
  const specEnv = spec && hasValues(spec.environment) ? spec.environment : undefined;
  if (!specEnv && !Object.keys(projectEnv).length) return { request, secrets: null };
  const cleaned = {
    ...request,
    ...(project
      ? {
          project: {
            ...project,
            harnesses: Object.fromEntries(Object.entries(project.harnesses).map(([n, h]) => [n, blank(h)])),
          },
        }
      : {}),
    ...(spec ? { harnessSpec: blank(spec) } : {}),
  } as GuestRequest;
  return {
    request: cleaned,
    secrets: {
      ...(specEnv ? { harnessSpecEnvironment: specEnv } : {}),
      ...(Object.keys(projectEnv).length
        ? {
            projectHarnessEnvironment: Object.fromEntries(
              Object.entries(projectEnv).map(([n, h]) => [n, h.environment]),
            ),
          }
        : {}),
    },
  };
}
