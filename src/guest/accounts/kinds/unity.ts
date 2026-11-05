// Unity: the licence file (Unity_lic.ulf) goes to %ProgramData%\Unity and the named-user licence to
// %LOCALAPPDATA%\Unity\licenses, where the editor reads them. The Unity ID (and a Plus or Pro serial) are kept in
// secretDir('unity')\activation.json, on the sandbox's own disk, for the editor to sign in with. A serial seat is
// returned when the sandbox stops. Nothing here puts a password, serial or licence text in a log or a summary.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  MAX_ULF_BYTES,
  parseLicenceStatus,
  unityEntitlementFile,
  unityUlfFile,
  type UnityPayload,
} from '../../../shared/accounts/index.js';
import { decodeText, readBoundedFile } from '../../../shared/io/index.js';
import { licenceStatusArgs, UNITY_CLI_ENV } from '../../../shared/unity/cli.js';
import type { UnityStatus } from '../../../shared/unity/status.js';
import { localAppData, secretDir, type GuestAdapter } from '../adapter.js';

const MAX_JSON_BYTES = 16 * 1024;
const RETURN_MS = 120_000;
const ACTIVATE_MS = 180_000;
const STATUS_MS = 60_000;

const ActivationSchema = z.object({
  email: z.string().max(256).optional(),
  password: z.string().max(1024).optional(),
  serial: z.string().max(64).optional(),
});
const ActivatedSchema = z.object({ editorExe: z.string().min(1).max(520), serial: z.literal(true) });

/** Runs a program to its end (or its time limit); the exit code and what it printed. Injected by the self-test. */
export type UnityRunner = (
  file: string,
  args: readonly string[],
  o: { readonly timeoutMs: number; readonly env?: Readonly<Record<string, string>> },
) => Promise<{ readonly code: number; readonly stdout: string }>;

export const runUnityProgram: UnityRunner = (file, args, o) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { windowsHide: true, timeout: o.timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, ...o.env } },
      (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        resolve({ code, stdout: String(stdout ?? '') });
      },
    );
  });

export interface UnityDirs {
  readonly programData: string;
  readonly localAppData: string;
  /** secretDir('unity'). */
  readonly secrets: string;
}

function readText(file: string): string | null {
  const bytes = readBoundedFile(file, MAX_ULF_BYTES);
  return bytes ? decodeText(bytes).text : null;
}

function readSecretJson<S extends z.ZodType>(schema: S, file: string): z.output<S> | null {
  const bytes = readBoundedFile(file, MAX_JSON_BYTES);
  if (!bytes) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(decodeText(bytes).text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // not JSON: treated as absent
  }
}

function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/** The adapter for these folders and this runner (the self-test passes its own). */
export function unityAdapterFor(dirs: UnityDirs, run: UnityRunner = runUnityProgram): GuestAdapter<'unity'> {
  const activation = path.join(dirs.secrets, 'activation.json');
  const activated = path.join(dirs.secrets, 'activated.json');
  return {
    kind: 'unity',
    apply(p: UnityPayload) {
      if (p.ulf) writeText(unityUlfFile(dirs.programData), p.ulf);
      if (p.entitlement) writeText(unityEntitlementFile(dirs.localAppData), p.entitlement);
      const sign: Record<string, string> = {};
      if (p.email) sign.email = p.email;
      if (p.password) sign.password = p.password;
      if (p.serial) sign.serial = p.serial;
      if (Object.keys(sign).length) writeText(activation, JSON.stringify(sign));
      return {
        summary:
          p.ulf || p.entitlement
            ? 'Unity: your licence file is in place'
            : 'Unity: your Unity ID is ready to activate the serial',
      };
    },
    current(): UnityPayload | null {
      const ulf = readText(unityUlfFile(dirs.programData));
      const entitlement = readText(unityEntitlementFile(dirs.localAppData));
      const sign = readSecretJson(ActivationSchema, activation) ?? {};
      const out: UnityPayload = {
        ...(ulf ? { ulf } : {}),
        ...(entitlement ? { entitlement } : {}),
        ...sign,
      };
      return Object.keys(out).length ? out : null;
    },
    async release(): Promise<void> {
      const marker = readSecretJson(ActivatedSchema, activated);
      if (!marker) return;
      const sign = readSecretJson(ActivationSchema, activation);
      if (!sign?.email || !sign.password) return;
      await run(
        marker.editorExe,
        [
          '-batchmode',
          '-nographics',
          '-quit',
          '-returnlicense',
          '-username',
          sign.email,
          '-password',
          sign.password,
          '-logFile',
          path.join(dirs.secrets, 'return.log'),
        ],
        { timeoutMs: RETURN_MS },
      );
    },
  };
}

function defaultDirs(): UnityDirs {
  return {
    programData: process.env.ProgramData ?? process.env.PROGRAMDATA ?? 'C:\\ProgramData',
    localAppData: localAppData(),
    secrets: secretDir('unity'),
  };
}

export const unityAdapter: GuestAdapter<'unity'> = unityAdapterFor(defaultDirs());

/**
 * Activates the serial the sandbox holds once an editor exists, then asks `unity license status` where the licence
 * stands. The detail never holds a secret.
 */
export async function activateUnityLicence(
  o: { readonly editorExe: string | null; readonly unityExe: string | null; readonly source?: string },
  dirs: UnityDirs = defaultDirs(),
  run: UnityRunner = runUnityProgram,
): Promise<UnityStatus['licence']> {
  const sign = readSecretJson(ActivationSchema, path.join(dirs.secrets, 'activation.json'));
  if (sign?.serial && sign.email && sign.password && o.editorExe) {
    await run(
      o.editorExe,
      [
        '-batchmode',
        '-nographics',
        '-quit',
        '-serial',
        sign.serial,
        '-username',
        sign.email,
        '-password',
        sign.password,
        '-logFile',
        path.join(dirs.secrets, 'activate.log'),
      ],
      { timeoutMs: ACTIVATE_MS },
    );
    writeText(path.join(dirs.secrets, 'activated.json'), JSON.stringify({ editorExe: o.editorExe, serial: true }));
  }
  const user = sign?.email ?? null;
  if (!o.unityExe) return { state: 'unknown', kind: '', detail: 'not checked', user };
  let parsed: unknown = null;
  try {
    const r = await run(o.unityExe, licenceStatusArgs(), { timeoutMs: STATUS_MS, env: UNITY_CLI_ENV });
    parsed = r.code === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    parsed = null; // not JSON: reported as not recognised
  }
  const s = parseLicenceStatus(parsed);
  if (s.state === 'active')
    return { state: 'active', kind: s.kind, detail: 'active (' + (s.kind || 'licensed') + ')', user };
  if (s.state === 'none') {
    const hasFile =
      readText(unityUlfFile(dirs.programData)) !== null || readText(unityEntitlementFile(dirs.localAppData)) !== null;
    return hasFile
      ? {
          state: 'invalid',
          kind: '',
          detail:
            'the licence file from ' + (o.source ?? 'your saved sign-in') + ' is not accepted here: sign in again',
          user,
        }
      : { state: 'none', kind: '', detail: 'none: sign in to Unity once in this sandbox', user };
  }
  return { state: 'unknown', kind: '', detail: s.detail, user };
}
