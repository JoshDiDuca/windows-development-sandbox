// The Unity Asset Store's download cache: <root>\Asset Store-5.x\<publisher>\<category>\<name>.unitypackage. The root
// is ASSETSTORE_CACHE_PATH, else %APPDATA%\Unity. Pure apart from the reads it is given; every walk is bounded.
import path from 'node:path';

const win = path.win32;
const MAX_PACKAGES = 2000;
const MAX_ROOTS = 2;

export function assetStoreDir(root: string): string {
  return root + '\\Asset Store-5.x';
}

/** The cache roots of this PC that hold an Asset Store-5.x folder: the environment's first, then %APPDATA%\Unity. */
export function pcAssetCacheDirs(
  pc: { readonly appData: string; readonly envValue?: string | undefined },
  isDir: (dir: string) => boolean,
): string[] {
  const all = [pc.envValue?.trim() ?? '', pc.appData ? win.join(pc.appData, 'Unity') : ''].filter(Boolean);
  return all
    .map((d) => win.normalize(d).replace(/\\+$/, ''))
    .filter((d, i, a) => a.findIndex((o) => o.toLowerCase() === d.toLowerCase()) === i)
    .filter((d) => isDir(assetStoreDir(d)))
    .slice(0, MAX_ROOTS);
}

export interface AssetFs {
  list(dir: string): string[];
  isDir(dir: string): boolean;
  /** A file's size, or null when it is a folder or missing. */
  size(file: string): number | null;
}

export interface AssetPackage {
  readonly publisher: string;
  readonly category: string;
  readonly name: string;
  readonly sizeBytes: number;
}

/** The .unitypackage files in an Asset Store-5.x folder (three levels deep), sorted, at most 2000. */
export function assetPackages(dir: string, fs: AssetFs): AssetPackage[] {
  const found: AssetPackage[] = [];
  const sorted = (d: string): string[] => fs.list(d).sort((a, b) => a.localeCompare(b));
  for (const publisher of sorted(dir)) {
    const pdir = win.join(dir, publisher);
    if (!fs.isDir(pdir)) continue;
    for (const category of sorted(pdir)) {
      const cdir = win.join(pdir, category);
      if (!fs.isDir(cdir)) continue;
      for (const file of sorted(cdir)) {
        if (!/\.unitypackage$/i.test(file)) continue;
        const size = fs.size(win.join(cdir, file));
        if (size === null) continue;
        found.push({ publisher, category, name: file.replace(/\.unitypackage$/i, ''), sizeBytes: size });
        if (found.length >= MAX_PACKAGES) return found;
      }
    }
  }
  return found;
}
