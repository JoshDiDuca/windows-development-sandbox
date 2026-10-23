// Several projects in one running sandbox. Windows Sandbox fixes its mapped folders at boot, so a project can only
// join a running sandbox when it is already visible inside:
//  - the launch folder (mapped directly, or shown by the project root it is in);
//  - a folder inside a project root (projects.roots: whole folders of projects, mapped at every start), including
//    projects created after boot;
//  - projects mapped at boot because they were in use when the sandbox was restarted to add them;
//  - a folder shared into the running sandbox with `wsb share` (Windows 11 24H2+, untested);
//  - a folder shared into the running sandbox through HCS (projects.liveFolders "hcs", alpha, untested on a PC).
// A project is at the same place inside the sandbox whichever project started it (git worktrees and Claude's project
// folders store absolute paths):
//  - a project inside a root is always under the root's folder, C:\Projects\<root>\<name> (also as the launch folder);
//  - any other project, mapped on its own, is always at C:\Workspace\<name> (also when it is mapped at boot or shared).
// With guestWorkspace "mirror" both appear at their PC paths when the sandbox can show them there.
// Pure functions only: used by the host (registration, commands), the guest (daemon checks) and the tests.
import path from 'node:path';
import { isValidGuestPath, planMirrorWorkspace } from './guest-paths.js';

/** Where project roots appear inside the sandbox. */
export const PROJECTS_GUEST = 'C:\\Projects';
/**
 * Where projects mapped on their own appear (the launch folder with guestWorkspace "auto", boot-mapped and shared
 * ones).
 */
export const WORKSPACES_GUEST = 'C:\\Workspace';

/**
 * guestWorkspace "auto" for a folder: C:\Workspace\<folder name>. Keeping the real folder name means Claude's
 * per-project history and claude-mem's project name match this PC instead of every project being "Workspace".
 */
export function autoGuestFolder(hostDir: string): string {
  const name = path.win32
    .basename(hostDir.replace(/[\\/]+$/, ''))
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '');
  return WORKSPACES_GUEST + '\\' + (name || 'project');
}

/** How a project got into the sandbox. */
export type Mechanism = 'launch' | 'root' | 'boot' | 'wsb' | 'hcs';

/** One project the running sandbox works on. */
export interface ProjectEntry {
  name: string;
  host: string;
  guest: string;
  primary: boolean;
  mechanism: Mechanism;
}

const norm = (p: string): string =>
  path.win32
    .resolve(p)
    .replace(/[\\/]+$/, '')
    .toLowerCase();

/** `child` is `parent` or somewhere below it (Windows paths, case-insensitive). */
export function isWithin(parent: string, child: string): boolean {
  const a = norm(parent);
  const b = norm(child);
  return a === b || b.startsWith(a.endsWith('\\') ? a : a + '\\');
}

/**
 * A project id (also its folder name under C:\Projects) for a folder: its name with only letters, digits, '-' and
 * '_' (ids become file names on both sides), at most 48 characters, made unique against `taken` with -2, -3, ...
 */
export function hubName(hostDir: string, taken: Iterable<string>): string {
  const base =
    path.win32
      .basename(path.win32.resolve(hostDir))
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'project';
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!used.has((base + '-' + i).toLowerCase())) return base + '-' + i;
}

/**
 * The project a folder on this PC belongs to: the most specific one that contains it (a project inside another wins).
 */
export function projectForHostDir<P extends { host: string }>(projects: P[], hostDir: string): P | null {
  return projects.filter((p) => isWithin(p.host, hostDir)).sort((a, b) => b.host.length - a.host.length)[0] ?? null;
}

/** The same for a folder inside the sandbox. */
export function projectForGuestDir<P extends { guest: string }>(projects: P[], guestDir: string): P | null {
  return projects.filter((p) => isWithin(p.guest, guestDir)).sort((a, b) => b.guest.length - a.guest.length)[0] ?? null;
}

/** Where a folder on this PC appears inside the sandbox, given the mapped folder (project or root) that contains it. */
export function guestDirFor(mapped: { host: string; guest: string }, hostDir: string): string {
  const rel = path.win32.relative(path.win32.resolve(mapped.host), path.win32.resolve(hostDir));
  return rel ? path.win32.join(mapped.guest, rel) : mapped.guest;
}

/** The other way: where a folder inside the sandbox is on this PC, given the mapped folder that contains it. */
export function hostDirFor(mapped: { host: string; guest: string }, guestDir: string): string {
  const rel = path.win32.relative(path.win32.resolve(mapped.guest), path.win32.resolve(guestDir));
  return rel ? path.win32.join(mapped.host, rel) : mapped.host;
}

/** Strictly below `parent` (never `parent` itself). */
export function isBelow(parent: string, child: string): boolean {
  return isWithin(parent, child) && norm(parent) !== norm(child);
}

/**
 * A guest folder some project can be in: below C:\Projects or C:\Workspace (projects mapped on their own, also shared
 * after boot), or inside one of `roots` (the roots' and boot-mapped projects' guest paths).
 */
export function insideProjects(guestDir: string, roots: string[] = [], projectsDir = PROJECTS_GUEST): boolean {
  return (
    isBelow(projectsDir, guestDir) || isBelow(WORKSPACES_GUEST, guestDir) || roots.some((r) => isWithin(r, guestDir))
  );
}

export interface RootMapping {
  host: string;
  guest: string;
}

const resolveDir = (dir: string): string => path.win32.resolve(dir).replace(/[\\/]+$/, '');

/** The project roots that are mapped, in order: existing folders, none inside a root listed before it. */
export function usableRoots(roots: string[], exists: (dir: string) => boolean): string[] {
  const out: string[] = [];
  for (const root of roots.map(resolveDir)) if (exists(root) && !out.some((r) => isWithin(r, root))) out.push(root);
  return out;
}

/**
 * Where a project mapped on its own appears, the same place it has as the launch folder: with "mirror" its PC path
 * when the sandbox can show it there, else C:\Workspace\<name>. -2, -3, ... when that overlaps a folder in `taken`.
 */
export function ownGuestFolder(hostDir: string, mirror: boolean, taken: string[] = []): string {
  const host = resolveDir(hostDir);
  const free = (guest: string): boolean => !taken.some((t) => isWithin(t, guest) || isWithin(guest, t));
  const mirrored = mirror ? planMirrorWorkspace(host, '').guest : '';
  if (mirrored && !isWithin(PROJECTS_GUEST, mirrored) && !isWithin(WORKSPACES_GUEST, mirrored) && free(mirrored))
    return mirrored;
  const base = autoGuestFolder(host);
  if (free(base)) return base;
  for (let i = 2; ; i++) if (free(base + '-' + i)) return base + '-' + i;
}

/**
 * Where a live folder (projects.liveFolders "hcs") appears: C:\Workspace\<name>, the name in the strict form the guest
 * daemon accepts (lower-case letters, digits, '-' and '_'; no dots or spaces), -2, -3, ... when it overlaps `taken`.
 */
export function liveGuestFolder(hostDir: string, taken: string[] = []): string {
  const base =
    path.win32
      .basename(resolveDir(hostDir))
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[-_]+|-+$/g, '')
      .slice(0, 56) || 'project';
  const free = (guest: string): boolean => !taken.some((t) => isWithin(t, guest) || isWithin(guest, t));
  const at = (name: string): string => WORKSPACES_GUEST + '\\' + name;
  if (free(at(base))) return at(base);
  for (let i = 2; ; i++) if (free(at(base + '-' + i))) return at(base + '-' + i);
}

/**
 * Guest folders for the project roots (C:\Projects\<name>, unique; with guestWorkspace "mirror" at its PC path when
 * the sandbox can show it there) and the projects mapped at boot (ownGuestFolder, unique against `taken` and each
 * other). A root's folder depends only on the roots, so every launch with the same roots shows them at the same place.
 */
export function planProjectMappings(
  roots: string[],
  projects: string[],
  mirror: boolean,
  taken: string[] = [],
): { roots: RootMapping[]; projects: RootMapping[] } {
  const names: string[] = [];
  const placeRoot = (host: string): RootMapping => {
    const resolved = resolveDir(host);
    if (mirror && isValidGuestPath(resolved) && !isWithin(PROJECTS_GUEST, resolved))
      return { host: resolved, guest: resolved };
    const name = hubName(resolved, names);
    names.push(name);
    return { host: resolved, guest: path.win32.join(PROJECTS_GUEST, name) };
  };
  const planned = roots.map(placeRoot);
  const used = [...taken, ...planned.map((r) => r.guest)];
  const placed = projects.map((p): RootMapping => {
    const guest = ownGuestFolder(p, mirror, used);
    used.push(guest);
    return { host: resolveDir(p), guest };
  });
  return { roots: planned, projects: placed };
}

/**
 * Where a folder inside one of the (usable) roots appears: under the root's guest folder, whichever project started
 * the sandbox. Null when it is in no root.
 */
export function rootGuestDir(roots: string[], mirror: boolean, hostDir: string): string | null {
  const root = projectForHostDir(planProjectMappings(roots, [], mirror).roots, hostDir);
  return root ? guestDirFor(root, hostDir) : null;
}
