// Unity's release API (services.api.unity.com): the editor installer, its changeset and its modules for one version.
// The answer is read with a size limit and checked by shared/unity/release.ts.
import { fetchBounded } from '../../../shared/download/index.js';
import { pickRelease, releaseUrl, type UnityRelease } from '../../../shared/unity/index.js';

export type { UnityRelease };

const MAX_ANSWER_BYTES = 2 * 1024 * 1024;

/** The release of one editor version (6000.0.58f2), or null when Unity does not list it or answers oddly. */
export async function findUnityRelease(version: string): Promise<UnityRelease | null> {
  const text = await fetchBounded(releaseUrl(version), MAX_ANSWER_BYTES);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null; // Not JSON: no release.
  }
  const release = pickRelease(json);
  return release && release.version === version ? release : null;
}
