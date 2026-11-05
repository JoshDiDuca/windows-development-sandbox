// The Unity CLI (`unity`): where its pinned build is published, how a download is checked, the environment it runs in
// and the argument lists we pass it. The flags below are checked against the docs
// (docs.unity.com/en-us/unity-cli/reference), not a live run; the ones the docs do not settle are marked.
import { z } from 'zod';

export const UNITY_CLI_CDN = 'https://public-cdn.cloud.unity3d.com/hub/prod/cli';
export const DEFAULT_UNITY_CLI = '1.0.0-beta.16';
const CLI_VERSION = /^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/;
const CLI_FILE = /^unity-windows-(x64|arm64)\.exe$/;
const SHA256 = /^[0-9a-f]{64}$/i;

/** The manifest of a CLI version: "latest" is the newest beta, else that version's own latest.json. */
export function cliManifestUrl(version: string): string {
  if (version === 'latest') return UNITY_CLI_CDN + '/latest-beta.json';
  if (!CLI_VERSION.test(version)) throw new Error('not a Unity CLI version: ' + version);
  return UNITY_CLI_CDN + '/' + version + '/latest.json';
}

export const CliManifestSchema = z.object({
  version: z.string().regex(CLI_VERSION),
  binaries: z
    .record(
      z.string().max(40),
      z.object({
        filename: z.string().max(80),
        sha256: z.string().max(80),
        size: z.number().int().min(0).optional(),
      }),
    )
    .refine((r) => Object.keys(r).length <= 20),
});
export type CliManifest = z.infer<typeof CliManifestSchema>;

export interface CliBinary {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

/** The Windows build for this CPU, or null when the manifest has none or its file name or hash is unexpected. */
export function pickCliBinary(m: CliManifest, arch: 'x64' | 'arm64'): CliBinary | null {
  const b = m.binaries['win32-' + arch];
  if (!b) return null;
  const file = CLI_FILE.exec(b.filename);
  if (!file || file[1] !== arch || !SHA256.test(b.sha256)) return null;
  return {
    version: m.version,
    url: UNITY_CLI_CDN + '/' + m.version + '/' + b.filename,
    sha256: b.sha256.toLowerCase(),
    size: b.size ?? 0,
  };
}

/** No telemetry, hints, pager, elevation prompt or first-run set-up (the skills are synced by us when asked). */
export const UNITY_CLI_ENV = {
  UNITY_NO_CLI_INVOKED_TELEMETRY: '1',
  UNITY_NO_AGENT_HINTS: '1',
  UNITY_CLI_SKIP_SETUP: '1',
  UNITY_NO_PAGER: '1',
  UNITY_NO_ELEVATE: '1',
} as const;

/** `unity install <version> -c <changeset> -m <ids> --cm`. --download-directory is not in the docs: from the plan. */
export function installArgs(
  version: string,
  changeset: string | null,
  modules: readonly string[],
  dir: string,
): string[] {
  return [
    'install',
    version,
    ...(changeset ? ['-c', changeset] : []),
    ...(modules.length ? ['-m', ...modules, '--cm'] : []),
    '--download-directory',
    dir,
  ];
}

/** `unity install-modules -e <version> -m <ids> --cm`. --download-directory is not in the docs: from the plan. */
export function installModulesArgs(version: string, modules: readonly string[], dir: string): string[] {
  return ['install-modules', '-e', version, '-m', ...modules, '--cm', '--download-directory', dir];
}

/** Where the CLI installs editors. `--set` is not in the docs (they say "run install-path --help"): from the plan. */
export function installPathArgs(dir: string): string[] {
  return ['install-path', '--set', dir];
}

/** `unity editors add <path...>` registers editors installed outside the Hub (the docs pass their folders). */
export function editorsAddArgs(exes: readonly string[]): string[] {
  return ['editors', 'add', ...exes];
}

/** `unity license status` is not in the docs; --format json is the global output option. */
export function licenceStatusArgs(): string[] {
  return ['license', 'status', '--format', 'json'];
}
