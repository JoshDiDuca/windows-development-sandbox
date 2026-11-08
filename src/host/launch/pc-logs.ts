// PC logs for developing the sandbox inside a sandbox: when a launch includes this very source repo, the PC's recent
// crash reports and logs are copied into <launch>\pc-logs (C:\AgentLaunch\pc-logs, read-only, gone with the sandbox).
// The gate is the repository url: a repo that only claims the package name does not pass. If one ever did, it would
// see the owner's crash diagnostics (memory numbers, Windows events, process names), which hold no secrets.
// Nothing else from <storage> is copied: no state files, logins, secrets or session ledger.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assertNoLinks, ensureDir } from '../../core/util/index.js';

const PACKAGE_NAME = 'windows-development-sandbox';
const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const MAX_REPORTS = 10;
const MAX_REPORT_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;

const PackageSchema = z.object({
  name: z.string(),
  repository: z.union([z.string(), z.object({ url: z.string().optional() }).passthrough()]).optional(),
});

function repoUrl(pkg: z.output<typeof PackageSchema>): string | null {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!url) return null;
  return url
    .trim()
    .toLowerCase()
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/** The package.json in a folder, read with a size cap and no links; null when missing, too big or not valid. */
function readPackage(folder: string): z.output<typeof PackageSchema> | null {
  try {
    const file = path.join(folder, 'package.json');
    assertNoLinks(folder, file);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_JSON_BYTES) return null;
    const parsed = PackageSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    // No package.json, a link, or not JSON: not the sandbox's source.
    return null;
  }
}

/** Whether a folder is a checkout (or git worktree) of this sandbox's own source repo, judged by the installed copy. */
export function isSandboxSourceRepo(folder: string, packageRoot: string): boolean {
  const own = readPackage(packageRoot);
  const ownUrl = own ? repoUrl(own) : null;
  if (!ownUrl) return false;
  const pkg = readPackage(folder);
  return pkg !== null && pkg.name === PACKAGE_NAME && repoUrl(pkg) === ownUrl;
}

/** Plain file, no links on the way: its first `max` bytes (head) or last `max` bytes (tail); null when unreadable. */
function readBounded(root: string, file: string, max: number, from: 'head' | 'tail'): Buffer | null {
  try {
    assertNoLinks(root, file);
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, max);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, from === 'tail' ? stat.size - length : 0);
    } finally {
      fs.closeSync(fd);
    }
    return buffer;
  } catch {
    // Missing or unreadable: left out.
    return null;
  }
}

const README = [
  'These files come from the PC that started this sandbox: its recent crash reports and logs, for developing the',
  'sandbox itself. They are read-only here and gone when the sandbox closes.',
  '',
  'They are not part of the repo: never copy them into the workspace and never commit them.',
  '',
  'crashes\\   the newest crash reports (what Windows logged when a sandbox ended, plus the memory log)',
  '*.log       the last 256 KB of the PC memory log, the host watcher log and the live-folders log',
  '',
].join('\r\n');

/** Whether this launch has the sandbox's own source repo among its projects (the launch folder or a mapped project). */
export function launchHasSandboxSource(folders: readonly string[], packageRoot: string): boolean {
  return folders.some((f) => isSandboxSourceRepo(f, packageRoot));
}

/** Copies the PC's recent crash reports and log tails into <launchPath>\pc-logs. Returns the folder. */
export function stagePcLogs(storageRoot: string, dataPath: string, launchPath: string): string {
  const target = path.join(launchPath, 'pc-logs');
  ensureDir(target);
  fs.writeFileSync(path.join(target, 'README.txt'), README, 'utf8');
  const crashes = path.join(storageRoot, 'logs', 'crashes');
  let names: string[] = [];
  try {
    assertNoLinks(storageRoot, crashes);
    names = fs
      .readdirSync(crashes)
      .filter((f) => /^crash-[\w.-]+\.txt$/.test(f))
      .sort()
      .slice(-MAX_REPORTS);
  } catch {
    // No reports folder yet: none to copy.
  }
  for (const name of names) {
    const text = readBounded(storageRoot, path.join(crashes, name), MAX_REPORT_BYTES, 'head');
    if (!text) continue;
    ensureDir(path.join(target, 'crashes'));
    fs.writeFileSync(path.join(target, 'crashes', name), text);
  }
  const data = path.basename(dataPath);
  const tails: readonly (readonly [string, string])[] = [
    [path.join(storageRoot, 'logs', 'host-memory-' + data + '.log'), 'host-memory.log'],
    [path.join(storageRoot, 'logs', 'host-sync-' + data + '.log'), 'host-sync.log'],
    [path.join(storageRoot, 'state', 'live-folders.log'), 'live-folders.log'],
  ];
  for (const [source, name] of tails) {
    const text = readBounded(storageRoot, source, TAIL_BYTES, 'tail');
    if (text) fs.writeFileSync(path.join(target, name), text);
  }
  return target;
}
