// The Unity CLI (`unity`): its pinned build downloaded once into tools\unity\cli\<version> (checked against the SHA-256
// Unity publishes, and its signature when it has one), and the way every other Unity step runs it.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fetchBounded, downloader } from '../../../shared/download/index.js';
import {
  CliManifestSchema,
  cliManifestUrl,
  pickCliBinary,
  UNITY_CLI_ENV,
  type CliBinary,
} from '../../../shared/unity/index.js';
import { log } from '../../runtime/log.js';
import { net } from '../../runtime/pools.js';
import { ensurePersisted } from '../persisted.js';
import { arch } from '../tool-env.js';

const MB = 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface UnityCli {
  readonly exe: string;
  readonly version: string;
}

export interface UnityRun {
  readonly code: number;
  readonly stdout: string;
}

export interface UnityRunOptions {
  /** TEMP and TMP for the run (inside the staging folder of an install). */
  readonly temp?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Extra variables (the asset cache). */
  readonly env?: Readonly<Record<string, string>>;
}

/** The binary the manifest of a CLI version names for this CPU. */
async function resolveCli(version: string): Promise<CliBinary> {
  const text = await net.run(() => fetchBounded(cliManifestUrl(version), MAX_MANIFEST_BYTES));
  const parsed = CliManifestSchema.safeParse(JSON.parse(text));
  const binary = parsed.success ? pickCliBinary(parsed.data, arch) : null;
  if (!binary) throw new Error('the Unity CLI manifest for ' + version + ' has no usable Windows build');
  return binary;
}

/** The pinned Unity CLI on the data disk, downloaded when it is not there yet ("latest" asks the manifest first). */
export async function ensureUnityCli(version: string): Promise<UnityCli> {
  const binary = await resolveCli(version);
  const installed = await ensurePersisted(
    {
      name: 'unity/cli',
      version: binary.version,
      needBytes: 200 * MB,
      marker: 'unity.exe',
      what: 'Unity CLI ' + binary.version,
      keepVersions: 2,
    },
    async (staging) => {
      log('Downloading the Unity CLI ' + binary.version + ' ...');
      // The CLI is not known to be signed: the SHA-256 from Unity's manifest is the check.
      await downloader.file(binary.url, path.join(staging, 'unity.exe'), { sha256: binary.sha256 });
    },
  );
  return { exe: path.join(installed.dir, 'unity.exe'), version: binary.version };
}

/** Downloads the CLI ahead of its step; a failure is ignored (the step downloads again). */
export async function prefetchUnityCli(version: string): Promise<void> {
  await ensureUnityCli(version);
}

/** Runs the CLI without blocking; the exit code and the start of its output (at most 1 MB). Never throws on a code. */
export function runUnityCli(exe: string, args: readonly string[], o: UnityRunOptions = {}): Promise<UnityRun> {
  return new Promise((resolve, reject) => {
    const temp = o.temp ? { TEMP: o.temp, TMP: o.temp } : {};
    const child = spawn(exe, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(o.cwd ? { cwd: o.cwd } : {}),
      env: { ...process.env, ...UNITY_CLI_ENV, ...temp, ...(o.env ?? {}) },
      ...(o.timeoutMs ? { timeout: o.timeoutMs } : {}),
    });
    let stdout = '';
    const take = (chunk: string): void => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.slice(0, MAX_OUTPUT_BYTES - stdout.length);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stdout }));
  });
}

/** runUnityCli that throws with the end of the output when the exit code is not 0. */
export async function runUnityCliChecked(
  exe: string,
  args: readonly string[],
  o: UnityRunOptions = {},
): Promise<string> {
  const r = await runUnityCli(exe, args, o);
  if (r.code !== 0)
    throw new Error(
      'unity ' + args.slice(0, 2).join(' ') + ' failed with exit code ' + r.code + ': ' + r.stdout.trim().slice(-400),
    );
  return r.stdout;
}
