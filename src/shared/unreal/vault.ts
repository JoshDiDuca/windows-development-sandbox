// The Epic Games Launcher's vault cache: the Fab and Marketplace packs it downloaded but has not added to a project
// yet, one folder per pack (<VaultCache>\<Pack>\data\Content\..., or data\<Plugin>.uplugin for a code plugin). Where
// it is comes from the launcher's GameUserSettings.ini (VaultCacheDirectories in launcher 20.3; older files may say
// VaultCacheLocation), else its default %ProgramData%\Epic\EpicGamesLauncher\VaultCache. Pure apart from the
// EngineFs-style reads it is given; every walk is bounded.
import path from 'node:path';

const win = path.win32;
const MAX_PACKS = 500;
const MAX_FILES_PER_PACK = 5_000;
const MAX_FILES = 50_000;

/** The default vault cache under a ProgramData folder. */
export function defaultVaultDir(programData: string): string {
  return win.join(programData, 'Epic', 'EpicGamesLauncher', 'VaultCache');
}

/** The vault cache folders a launcher settings text names (VaultCacheDirectories / VaultCacheLocation lines). */
export function vaultDirsFromIni(ini: string): string[] {
  const found: string[] = [];
  for (const raw of ini.split(/\r?\n/).slice(0, 5000)) {
    const m = /^\s*[+.-]?\s*(VaultCacheDirectories|VaultCacheLocation)\s*=\s*(.{0,2000})$/i.exec(raw);
    if (!m) continue;
    for (const hit of m[2].matchAll(/[A-Za-z]:[\\/][^"\r\n,()]{0,400}/g)) {
      const dir = win.normalize(hit[0].trim().replace(/\//g, '\\')).replace(/\\+$/, '');
      if (dir.length > 3 && !found.some((f) => f.toLowerCase() === dir.toLowerCase())) found.push(dir);
    }
  }
  return found;
}

export interface VaultFs {
  exists(file: string): boolean;
  list(dir: string): string[];
  /** A file's size, or null when it is a folder or missing. */
  size(file: string): number | null;
  isDir(dir: string): boolean;
}

export interface VaultPack {
  readonly name: string;
  /** Bytes counted (at least this much when `partial`). */
  readonly sizeBytes: number;
  readonly partial: boolean;
  /** "content" (data\Content: copy it into a project's Content) or "plugin" (a code plugin: into Plugins). */
  readonly kind: 'content' | 'plugin' | 'other';
}

function walk(dir: string, fs: VaultFs, budget: { left: number }): { bytes: number; partial: boolean } {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const at = stack.pop()!;
    for (const name of fs.list(at)) {
      if (++files > MAX_FILES_PER_PACK || --budget.left < 0) return { bytes, partial: true };
      const full = win.join(at, name);
      const size = fs.size(full);
      if (size === null) {
        if (fs.isDir(full)) stack.push(full);
      } else bytes += size;
    }
  }
  return { bytes, partial: false };
}

/** The packs in a vault cache folder, by name, with their size (bounded: very big packs read "at least"). */
export function vaultPacks(vault: string, fs: VaultFs): VaultPack[] {
  const budget = { left: MAX_FILES };
  return fs
    .list(vault)
    .filter((n) => !n.startsWith('.') && fs.isDir(win.join(vault, n)))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_PACKS)
    .map((name) => {
      const dir = win.join(vault, name);
      const data = win.join(dir, 'data');
      const plugin = fs.list(data).some((n) => /\.uplugin$/i.test(n));
      const kind = plugin ? 'plugin' : fs.isDir(win.join(data, 'Content')) ? 'content' : 'other';
      const { bytes, partial } = walk(dir, fs, budget);
      return { name, sizeBytes: bytes, partial, kind } as const;
    });
}
