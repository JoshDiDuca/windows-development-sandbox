// Unity editor versions ("6000.0.58f2") and the ProjectSettings/ProjectVersion.txt that names one. Pure; the text read
// from a project is bounded (the first 50 lines of at most 64 KB).

export const UNITY_VERSION = /^(\d{1,4})\.(\d{1,3})\.(\d{1,3})([abfp])(\d{1,3})$/;
/** A changeset (short revision) as Unity prints it. */
export const UNITY_CHANGESET = /^[0-9a-f]{12}$/;

const MAX_PROJECT_VERSION_BYTES = 64 * 1024;
const MAX_PROJECT_VERSION_LINES = 50;
const STAGES = 'abfp';

export interface UnityVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** a (alpha), b (beta), f (final), p (patch). */
  readonly stage: 'a' | 'b' | 'f' | 'p';
  readonly build: number;
}

export function parseUnityVersion(text: string): UnityVersion | null {
  const m = UNITY_VERSION.exec(text);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    stage: m[4] as UnityVersion['stage'],
    build: Number(m[5]),
  };
}

/** Negative when a is older than b, 0 when equal; an unreadable version sorts first. */
export function compareUnityVersions(a: string, b: string): number {
  const x = parseUnityVersion(a);
  const y = parseUnityVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : a.localeCompare(b);
  return (
    x.major - y.major ||
    x.minor - y.minor ||
    x.patch - y.patch ||
    STAGES.indexOf(x.stage) - STAGES.indexOf(y.stage) ||
    x.build - y.build
  );
}

export interface ProjectVersion {
  readonly version: string;
  readonly changeset: string | null;
}

/** The editor a ProjectVersion.txt asks for: m_EditorVersion, and the changeset of m_EditorVersionWithRevision. */
export function parseProjectVersion(text: string): ProjectVersion | null {
  let version: string | null = null;
  let changeset: string | null = null;
  const lines = text.slice(0, MAX_PROJECT_VERSION_BYTES).split('\n', MAX_PROJECT_VERSION_LINES);
  for (const raw of lines) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (line.startsWith('m_EditorVersionWithRevision:')) {
      const rest = line.slice('m_EditorVersionWithRevision:'.length).trim();
      const open = rest.indexOf('(');
      const close = rest.indexOf(')', open);
      const v = (open < 0 ? rest : rest.slice(0, open)).trim();
      if (UNITY_VERSION.test(v)) version ??= v;
      if (open >= 0 && close > open) {
        const cs = rest.slice(open + 1, close).trim();
        if (UNITY_CHANGESET.test(cs)) changeset = cs;
      }
    } else if (line.startsWith('m_EditorVersion:')) {
      const v = line.slice('m_EditorVersion:'.length).trim();
      if (UNITY_VERSION.test(v)) version = v;
    }
  }
  return version ? { version, changeset } : null;
}

/**
 * The editor to open a project with: its own ProjectVersion.txt always wins (another version upgrades its files); the
 * setting's version ("project" or e.g. "6000.0.32f1") is only for folders without one.
 */
export function wantedVersion(projectFile: string | null, setting: string): ProjectVersion | null {
  const own = projectFile === null ? null : parseProjectVersion(projectFile);
  if (own) return own;
  return setting !== 'project' && UNITY_VERSION.test(setting) ? { version: setting, changeset: null } : null;
}

/** The Unity Pipeline package (and so `unity command` / `unity eval`) needs Unity 6 or later. */
export function supportsPipeline(version: string): boolean {
  const v = parseUnityVersion(version);
  return v !== null && v.major >= 6000;
}
