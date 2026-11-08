// Host-only state of one data folder: <storage>\sync\<data name><suffix>, never in the data folder the sandbox can
// write.
import path from 'node:path';

export type StateFileSuffix =
  | '.json'
  | '-audit.json'
  | '-clipboard.json'
  | '-forwards.json'
  | '-life.json'
  | '-mark.json'
  | '-repo.json'
  | '-repo-findings.json'
  | '-sessions.json'
  | '-size.json'
  | '-views.json';

/** The storage folder a data folder is in (<storage>\data\<name>); inside a sandbox it differs from the context's. */
export function storageOf(dataPath: string): string {
  return path.dirname(path.dirname(dataPath));
}

export function hostStateFile(storageRoot: string, dataPath: string, suffix: StateFileSuffix): string {
  return path.join(storageRoot, 'sync', path.basename(dataPath) + suffix);
}
