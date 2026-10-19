// Reads a project the way core/detect needs it for databases and toolchains (only manifest/config files, bounded).
import fs from 'node:fs';
import path from 'node:path';
import { INTERESTING_FILE, type ProjectFile } from '../../core/detect/index.js';
import { readSmallFile } from '../../core/util/index.js';

const SKIP =
  /^(node_modules|\.git|\.hg|\.svn|vendor|target|bin|obj|dist|build|out|\.next|\.nuxt|\.venv|venv|env|__pycache__|\.gradle|\.idea|\.vs|coverage|packages)$/i;
const MAX_FILES = 400;
const MAX_BYTES = 256 * 1024;
const MAX_FOLDERS = 2000;

/** Manifest-type files in the project, up to 3 folders deep. Links are not followed (the guest may have written it). */
export function readProjectFiles(root: string, depth = 3): ProjectFile[] {
  const files: ProjectFile[] = [];
  let folders = 0;
  const walk = (dir: string, level: number): void => {
    if (++folders > MAX_FOLDERS) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && INTERESTING_FILE.test(entry.name)) {
        const text = readSmallFile(full, MAX_BYTES);
        if (text !== null) files.push({ path: path.relative(root, full), text });
      } else if (entry.isDirectory() && level < depth && !SKIP.test(entry.name)) walk(full, level + 1);
    }
  };
  walk(root, 0);
  return files;
}

/** File names in the project and its direct sub-folders ("api/go.mod"), for toolchain detection. No links followed. */
export function projectEntries(root: string): string[] {
  const list = (dir: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).slice(0, 2000);
    } catch {
      return [];
    }
  };
  const top = list(root);
  const below = top
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP.test(d.name))
    .slice(0, 200)
    .flatMap((d) =>
      list(path.join(root, d.name))
        .filter((f) => f.isFile())
        .map((f) => d.name + '/' + f.name),
    );
  return [...top.filter((d) => d.isFile()).map((d) => d.name), ...below];
}

/** Scripts in the project root or one folder down that set up MSVC (vcvars*.bat, vswhere): read with bounded effort. */
export function msvcHint(root: string): string | undefined {
  const scripts = projectEntries(root)
    .filter((e) => /\.(ps1|cmd|bat|psm1)$/i.test(e))
    .slice(0, 60);
  for (const rel of scripts) {
    let text = '';
    try {
      const file = path.join(root, rel);
      if (fs.statSync(file).size <= MAX_BYTES) text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (/vcvars(all|64|32)?\.bat|vswhere(\.exe)?/i.test(text)) return rel + ' sets up MSVC';
  }
  return undefined;
}

/** A pyproject.toml in the project root or one folder down that has a [tool.uv] table (read with bounded effort). */
export function uvHint(root: string): string | undefined {
  const files = projectEntries(root).filter((e) => e === 'pyproject.toml' || e.endsWith('/pyproject.toml'));
  for (const rel of files) {
    try {
      const file = path.join(root, rel);
      if (fs.statSync(file).size <= 64 * 1024 && fs.readFileSync(file, 'utf8').includes('[tool.uv]'))
        return 'pyproject.toml uses uv';
    } catch {
      continue;
    }
  }
  return undefined;
}
