// Unity's release API (services.api.unity.com): the editor installer, its changeset and its modules for one version.
// The answer is untrusted JSON: it is parsed with zod, every list and text bounded.
import { z } from 'zod';
import { UNITY_CHANGESET } from './version.js';

const API = 'https://services.api.unity.com/unity/editor/release/v1/releases';
const MARGIN = 1.1;

/** The request for one editor version (Windows, x86_64, one result). */
export function releaseUrl(version: string): string {
  return API + '?version=' + encodeURIComponent(version) + '&platform=WINDOWS&architecture=X86_64&limit=1';
}

const Size = z.object({ value: z.number().min(0) });
const Text = (max: number) => z.string().max(max);

const SubModule: z.ZodType<RawModule> = z.lazy(() =>
  z.object({
    id: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
    downloadSize: Size.optional(),
    installedSize: Size.optional(),
    integrity: Text(200).optional(),
    subModules: z.array(SubModule).max(50).optional(),
  }),
);

interface RawModule {
  id: string;
  downloadSize?: { value: number } | undefined;
  installedSize?: { value: number } | undefined;
  integrity?: string | undefined;
  subModules?: RawModule[] | undefined;
}

const ReleaseResponseSchema = z.object({
  results: z
    .array(
      z.object({
        version: Text(40),
        shortRevision: z.string().regex(UNITY_CHANGESET),
        downloads: z
          .array(
            z.object({
              url: z.string().url().max(2000).startsWith('https://'),
              type: Text(20),
              integrity: Text(200).optional(),
              downloadSize: Size,
              installedSize: Size,
              modules: z.array(SubModule).max(200).default([]),
            }),
          )
          .min(1)
          .max(10),
      }),
    )
    .max(10),
});

export interface UnityRelease {
  readonly version: string;
  readonly changeset: string;
  readonly editor: {
    readonly url: string;
    /** As Unity writes it: "md5-<base64>". */
    readonly integrity: string | null;
    readonly downloadBytes: number;
    readonly installedBytes: number;
  };
  readonly modules: readonly {
    readonly id: string;
    readonly downloadBytes: number;
    readonly installedBytes: number;
    readonly integrity: string | null;
    /** The ids of its sub-modules (android: the SDK, NDK and OpenJDK parts). */
    readonly children: readonly string[];
    /** The sub-modules' sizes together. */
    readonly childDownloadBytes: number;
    readonly childInstalledBytes: number;
  }[];
}

function flatten(m: RawModule, depth = 0): RawModule[] {
  if (depth > 3) return [];
  return (m.subModules ?? []).flatMap((s) => [s, ...flatten(s, depth + 1)]);
}

/** The first release an API answer holds (the EXE installer), or null when it holds none or is not the expected shape. */
export function pickRelease(json: unknown): UnityRelease | null {
  const parsed = ReleaseResponseSchema.safeParse(json);
  if (!parsed.success) return null;
  const r = parsed.data.results[0];
  const d = r?.downloads.find((x) => x.type.toUpperCase() === 'EXE') ?? r?.downloads[0];
  if (!r || !d) return null;
  return {
    version: r.version,
    changeset: r.shortRevision,
    editor: {
      url: d.url,
      integrity: d.integrity ?? null,
      downloadBytes: d.downloadSize.value,
      installedBytes: d.installedSize.value,
    },
    modules: d.modules.map((m) => {
      const kids = flatten(m);
      return {
        id: m.id,
        downloadBytes: m.downloadSize?.value ?? 0,
        installedBytes: m.installedSize?.value ?? 0,
        integrity: m.integrity ?? null,
        children: kids.map((k) => k.id),
        childDownloadBytes: kids.reduce((n, k) => n + (k.downloadSize?.value ?? 0), 0),
        childInstalledBytes: kids.reduce((n, k) => n + (k.installedSize?.value ?? 0), 0),
      };
    }),
  };
}

/** Room an install needs: (editor download + installed + the chosen modules with their children) plus 10%. */
export function installNeedBytes(r: UnityRelease, modules: readonly string[]): number {
  let bytes = r.editor.downloadBytes + r.editor.installedBytes;
  for (const m of r.modules)
    if (modules.includes(m.id))
      bytes += m.downloadBytes + m.installedBytes + m.childDownloadBytes + m.childInstalledBytes;
  return Math.ceil(bytes * MARGIN);
}
