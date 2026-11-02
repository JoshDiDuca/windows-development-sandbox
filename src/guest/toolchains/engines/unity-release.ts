// Unity's release API (services.api.unity.com/unity/editor/release/v1/releases): the editor installer and module
// downloads of one version, each with its SRI integrity hash. Not available yet.

export interface UnityDownload {
  /** "editor", or a module id (android, webgl, windows-il2cpp, ios). */
  readonly id: string;
  readonly url: string;
  /** The SRI hash (sha384-... or sha256-...). */
  readonly integrity: string | null;
  readonly sizeBytes: number | null;
}

export interface UnityRelease {
  readonly version: string;
  readonly changeset: string | null;
  readonly downloads: readonly UnityDownload[];
}

/** The release of one editor version (6000.0.32f1), or null when Unity does not list it. */
export async function findUnityRelease(_version: string): Promise<UnityRelease | null> {
  return null;
}
