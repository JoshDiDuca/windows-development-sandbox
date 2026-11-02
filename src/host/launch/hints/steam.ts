// Steam: toolchain hints from file contents: a .vdf whose first block is "AppBuild" (a ContentBuilder build script) or
// "workshopitem" (a workshop upload) turns toolchains.steam on. Files are found by name, a few folders deep, and
// size-checked before they are read; links are not followed (the project may be hostile).
import fs from 'node:fs';
import path from 'node:path';
import type { Toolchains } from '../../../core/types.js';
import { readBoundedFile } from '../../../shared/io/index.js';
import { parseVdf } from '../../../shared/vdf.js';
import type { ToolchainHints } from './hint.js';

const SKIP =
  /^(node_modules|\.git|\.hg|\.svn|vendor|target|obj|dist|out|\.next|\.venv|venv|__pycache__|\.gradle|\.idea|\.vs|coverage|Library|Temp|Intermediate|Saved|DerivedDataCache|Binaries)$/i;
const MAX_DEPTH = 4;
const MAX_FOLDERS = 1500;
const MAX_ENTRIES = 2000;
const MAX_FILES = 40;
const MAX_BYTES = 64 * 1024;

/** The .vdf files of a project (bounded walk, no links). */
export function projectVdfFiles(root: string): string[] {
  const found: string[] = [];
  let folders = 0;
  const queue: [string, number][] = [[root, 0]];
  while (queue.length && found.length < MAX_FILES) {
    const [dir, depth] = queue.shift()!;
    if (++folders > MAX_FOLDERS) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, MAX_ENTRIES);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.vdf')) found.push(path.join(dir, e.name));
      else if (e.isDirectory() && depth < MAX_DEPTH && !SKIP.test(e.name))
        queue.push([path.join(dir, e.name), depth + 1]);
      if (found.length >= MAX_FILES) break;
    }
  }
  return found;
}

/** What a SteamCMD script is for, or null: "AppBuild" (a build upload) or "workshopitem". */
export function steamScriptOf(text: string): 'AppBuild' | 'workshopitem' | null {
  const root = parseVdf(text, { maxBytes: MAX_BYTES, escapes: false, maxDepth: 16, maxKeys: 5000 });
  const first = root ? Object.keys(root)[0]?.toLowerCase() : undefined;
  return first === 'appbuild' ? 'AppBuild' : first === 'workshopitem' ? 'workshopitem' : null;
}

export function steamHints(root: string, settings: Toolchains): ToolchainHints {
  if (settings.steam.enabled !== 'auto') return {};
  for (const file of projectVdfFiles(root)) {
    const bytes = readBoundedFile(file, MAX_BYTES);
    const kind = bytes ? steamScriptOf(bytes.toString('utf8')) : null;
    if (!kind) continue;
    const rel = path.relative(root, file).split(path.sep).join('/');
    return { steam: rel + (kind === 'AppBuild' ? ' is a Steam build script' : ' is a Steam workshop item') };
  }
  return {};
}
