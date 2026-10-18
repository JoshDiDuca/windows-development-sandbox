import { type AppEntry } from '../../shared/apps/index.js';
import { githubAsset } from '../../shared/download/index.js';
import { RESOLVERS, type Download } from './resolvers.js';

/** Where to download an entry from. */
export async function resolve(entry: AppEntry): Promise<Download> {
  const s = entry.source;
  if ('github' in s) {
    const a = await githubAsset(s.github, new RegExp(s.asset), true);
    return { url: a.url, fileName: a.name, sha256: a.sha256 };
  }
  if ('url' in s) {
    const name = decodeURIComponent(new URL(s.url).pathname.split('/').pop() || entry.id);
    return { url: s.url, fileName: /\.\w{2,5}$/.test(name) ? name : name + '.zip', sha256: s.sha256 };
  }
  if ('resolve' in s && RESOLVERS[s.resolve]) return RESOLVERS[s.resolve]();
  throw new Error('no download source for ' + entry.name);
}
