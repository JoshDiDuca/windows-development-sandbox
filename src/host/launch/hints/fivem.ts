// FiveM / RedM: toolchain hints from file contents: fxmanifest.lua or __resource.lua up to 3 folders down turns fivem
// on (resources\[local]\my-resource\fxmanifest.lua), a C# resource dotnet (a manifest that loads *.net.dll, or a
// .csproj in the resource's folder or one below). Files are found by name and size-checked before they are read, links
// are never followed and the walk is bounded (the project may be hostile).
import fs from 'node:fs';
import path from 'node:path';
import type { Toolchains } from '../../../core/types.js';
import type { ToolchainHints } from './hint.js';

const SKIP = /^(node_modules|\.git|\.hg|\.svn|vendor|target|bin|obj|dist|build|out|cache|\.vs|\.idea|packages)$/i;
const MANIFEST = /^(fxmanifest|__resource)\.lua$/i;
const MAX_DEPTH = 3;
const MAX_FOLDERS = 2000;
const MAX_MANIFESTS = 200;
const MAX_BYTES = 64 * 1024;

const list = (dir: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).slice(0, 2000);
  } catch {
    return [];
  }
};

/** The resource manifests in the project (relative paths), at most 3 folders down. */
export function findManifests(root: string): string[] {
  const found: string[] = [];
  let folders = 0;
  const walk = (dir: string, level: number): void => {
    if (++folders > MAX_FOLDERS || found.length >= MAX_MANIFESTS) return;
    for (const e of list(dir)) {
      if (e.isFile() && MANIFEST.test(e.name)) found.push(path.relative(root, path.join(dir, e.name)));
      else if (e.isDirectory() && level < MAX_DEPTH && !SKIP.test(e.name)) walk(path.join(dir, e.name), level + 1);
    }
  };
  walk(root, 0);
  return found;
}

const readSmall = (file: string): string => {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size <= MAX_BYTES ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
};

const hasCsproj = (dir: string): boolean =>
  list(dir).some(
    (e) =>
      (e.isFile() && /\.csproj$/i.test(e.name)) ||
      (e.isDirectory() &&
        !SKIP.test(e.name) &&
        list(path.join(dir, e.name)).some((f) => f.isFile() && /\.csproj$/i.test(f.name))),
  );

/** Whether the resource whose manifest this is is written in C# (FiveM loads C# from *.net.dll). */
function isCsharpResource(root: string, manifest: string): boolean {
  if (/\.net\.dll/i.test(readSmall(path.join(root, manifest)))) return true;
  return hasCsproj(path.dirname(path.join(root, manifest)));
}

export function fivemHints(root: string, settings: Toolchains): ToolchainHints {
  if (settings.fivem.enabled === false) return {};
  const manifests = findManifests(root);
  if (!manifests.length) return {};
  const shown = (rel: string): string => rel.split(path.sep).join('/');
  const hints: ToolchainHints = { fivem: shown(manifests[0]!) + ' (a FiveM / RedM resource)' };
  const csharp = manifests.slice(0, 50).find((m) => isCsharpResource(root, m));
  if (csharp) hints.dotnet = 'a C# FiveM resource (' + shown(csharp) + ')';
  return hints;
}
