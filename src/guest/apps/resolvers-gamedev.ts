// Where the latest version of the game-development apps (catalogue-gamedev.ts) is, when it is not a plain GitHub
// release: Krita (download.kde.org, with the SHA-256 its mirror publishes beside each file), Inkscape (inkscape.org's
// portable 7z and its .sha256) and RenderDoc (renderdoc.org's portable zip; it publishes no checksum, the download is
// HTTPS from renderdoc.org).
import { fetchText } from '../../shared/download/index.js';
import type { Download } from './resolvers.js';

const firstHash = (text: string): string | null => /\b([0-9a-f]{64})\b/i.exec(text)?.[1].toLowerCase() ?? null;

const byVersion = (a: string, b: string): number => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** The newest Krita release folder that has the portable Windows zip (a hotfix folder may have only some files). */
async function krita(): Promise<Download> {
  const base = 'https://download.kde.org/stable/krita/';
  const versions = [...(await fetchText(base)).matchAll(/href="(\d+\.\d+\.\d+(?:\.\d+)?)\/"/g)]
    .map((m) => m[1])
    .sort(byVersion)
    .reverse()
    .slice(0, 4);
  for (const v of versions) {
    const file = 'krita-x64-' + v + '.zip';
    if (!(await fetchText(base + v + '/')).includes('href="' + file + '"')) continue;
    const url = base + v + '/' + file;
    return { url, fileName: file, sha256: firstHash(await fetchText(url + '.sha256').catch(() => '')) };
  }
  throw new Error('no portable Krita zip on download.kde.org');
}

async function inkscape(): Promise<Download> {
  const release = await fetchText('https://inkscape.org/release/');
  const v = /\/release\/inkscape-(\d+\.\d+(?:\.\d+)?)\//.exec(release)?.[1];
  if (!v) throw new Error('could not find the latest Inkscape release');
  const page = await fetchText('https://inkscape.org/release/inkscape-' + v + '/windows/64-bit/compressed-7z/dl/');
  const item = /\/gallery\/item\/\d+\/inkscape-[\w.-]+-x64[\w-]*\.7z/.exec(page);
  const sums = /https:\/\/media\.inkscape\.org\/media\/resources\/sigs\/[\w.-]+\.sha256/.exec(page)?.[0];
  if (!item) throw new Error('no portable Inkscape 7z for ' + v);
  return {
    url: 'https://inkscape.org' + item[0],
    fileName: 'inkscape-' + v + '-x64.7z',
    sha256: sums ? firstHash(await fetchText(sums).catch(() => '')) : null,
  };
}

async function renderdoc(): Promise<Download> {
  const page = await fetchText('https://renderdoc.org/builds');
  const hit = /https:\/\/renderdoc\.org\/stable\/([\d.]+)\/RenderDoc_[\d.]+_64\.zip/.exec(page);
  if (!hit) throw new Error('could not find the RenderDoc download on renderdoc.org');
  return { url: hit[0], fileName: 'RenderDoc_' + hit[1] + '_64.zip' };
}

export const GAMEDEV_RESOLVERS: Readonly<Record<string, () => Promise<Download>>> = { krita, inkscape, renderdoc };
