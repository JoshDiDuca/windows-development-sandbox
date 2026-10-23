// Projects a sandbox can open without a restart: roots, known projects, include/exclude. Returns data, never prints.
import path from 'node:path';
import { assertSafeMapping, assertSafeWorkspace } from '../../core/safe-paths.js';
import { dirExists, expandPath, fail, isRootPath } from '../../core/util/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import { KnownProjects, projectMapper, ProjectRegistry } from '../../host/projects/index.js';
import { isWithin } from '../../shared/paths/index.js';
import type { Context } from '../commands/context.js';
import { hereDir } from '../commands/projects/here.js';
import { addToList, removeFromList, setSetting } from '../commands/user-config.js';

export interface ProjectRow {
  readonly folder: string;
  readonly here: boolean;
  readonly known: boolean;
  readonly root: string | null;
  readonly excluded: boolean;
  readonly mappedAtStart: boolean;
  readonly running: string | null;
}

/** projects.all, roots and exclude, with the folders expanded. */
export interface ProjectSettings {
  readonly all: boolean;
  readonly roots: string[];
  readonly exclude: string[];
}

export interface ProjectsListing extends ProjectSettings {
  readonly projects: ProjectRow[];
}

export class ProjectsService {
  constructor(private readonly ctx: Context) {}

  settings(): ProjectSettings {
    const p = this.ctx.loaded.config.projects;
    const expand = (list: string[]): string[] => list.map((x) => expandPath(x, this.ctx.loaded.base));
    return { all: p.all, roots: expand(p.roots), exclude: expand(p.exclude) };
  }

  /** Every project worth listing: known ones, the running sandbox's, and this folder. */
  rows(): ProjectRow[] {
    const { ctx } = this;
    const s = this.settings();
    const registry = isSandboxRunning() ? new ProjectRegistry(ctx.storageRoot).read() : null;
    const here = hereDir(ctx);
    const known = new KnownProjects(ctx.storageRoot).list();
    const folders = [...known.map((k) => k.host), ...(registry?.projects.map((p) => p.host) ?? [])];
    const unique = folders.filter((f, i) => folders.findIndex((g) => g.toLowerCase() === f.toLowerCase()) === i);
    return unique.map((folder) => {
      const root = s.roots.find((r) => isWithin(r, folder)) ?? null;
      const excluded = s.exclude.some((e) => isWithin(e, folder));
      const inSandbox = registry?.projects.find((p) => p.host.toLowerCase() === folder.toLowerCase());
      return {
        folder,
        here: isWithin(folder, here),
        known: known.some((k) => k.host.toLowerCase() === folder.toLowerCase()),
        root,
        excluded,
        mappedAtStart: root !== null || (s.all && !excluded && dirExists(folder)),
        running: inSandbox ? inSandbox.name + ' (' + inSandbox.mechanism + ')' : null,
      };
    });
  }

  list(): ProjectsListing {
    const s = this.settings();
    return { all: s.all, roots: s.roots, exclude: s.exclude, projects: this.rows() };
  }

  /** Remembers a project folder (it must pass the same checks as a workspace). Returns the folder. */
  add(folder: string): string {
    const dir = this.checkFolder(folder, 'a project');
    new KnownProjects(this.ctx.storageRoot).remember(dir);
    return dir;
  }

  /**
   * Forgets a project, in the running sandbox too (a mapped folder stays visible until the sandbox stops; a live folder
   * is hidden and its share removed, with one permission prompt).
   */
  async forget(folder: string): Promise<{ dir: string; removed: boolean }> {
    const { ctx } = this;
    const dir = path.resolve(folder);
    const registered = isSandboxRunning()
      ? new ProjectRegistry(ctx.storageRoot)
          .read()
          ?.projects.find((p) => !p.primary && p.host.toLowerCase() === dir.toLowerCase())
      : undefined;
    // The live folder first: when it cannot be removed, the project stays (in the list and in the sandbox).
    if (registered)
      await projectMapper({
        storageRoot: ctx.storageRoot,
        packageRoot: ctx.packageRoot,
        wsbShare: false,
        dataPath: ctx.dataPath,
      }).unregister(registered.name);
    const forgot = new KnownProjects(ctx.storageRoot).forget(dir);
    return { dir, removed: forgot || Boolean(registered) };
  }

  /** The folder is a live folder (HCS) of the running sandbox: forgetting it removes its share (one prompt). */
  isLive(folder: string): boolean {
    const dir = path.resolve(folder);
    return (
      isSandboxRunning() &&
      new ProjectRegistry(this.ctx.storageRoot)
        .read()
        ?.projects.some((p) => p.mechanism === 'hcs' && p.host.toLowerCase() === dir.toLowerCase()) === true
    );
  }

  /** Excludes a folder from the projects mapped at every start. True when that changed anything. */
  exclude(folder: string): boolean {
    return addToList(this.ctx, ['projects', 'exclude'], path.resolve(folder));
  }

  /** Includes a folder again (and remembers it). True when it was excluded before. */
  include(folder: string): boolean {
    const dir = path.resolve(folder);
    const changed = removeFromList(this.ctx, ['projects', 'exclude'], dir);
    new KnownProjects(this.ctx.storageRoot).remember(dir);
    return changed;
  }

  /** Maps every project at every start (or none). */
  setAll(on: boolean): void {
    setSetting(this.ctx, ['projects', 'all'], on);
  }

  /** Adds a project root (a folder of projects). Returns the folder and whether it was new. */
  addRoot(folder: string): { dir: string; added: boolean } {
    const dir = this.checkFolder(folder, 'a project root');
    return { dir, added: addToList(this.ctx, ['projects', 'roots'], dir) };
  }

  removeRoot(folder: string): { dir: string; removed: boolean } {
    const dir = path.resolve(folder);
    return { dir, removed: removeFromList(this.ctx, ['projects', 'roots'], dir) };
  }

  /** Maps the ticked projects at every start (projects.all on when any is ticked); the rest are excluded. */
  choose(rows: readonly ProjectRow[], picked: readonly string[]): { mapped: number; excluded: number } {
    const s = this.settings();
    const exclude = rows.filter((r) => !picked.includes(r.folder)).map((r) => r.folder);
    setSetting(
      this.ctx,
      ['projects', 'exclude'],
      [...s.exclude.filter((e) => !rows.some((r) => r.folder.toLowerCase() === e.toLowerCase())), ...exclude],
    );
    setSetting(this.ctx, ['projects', 'all'], picked.length > 0);
    return { mapped: picked.length, excluded: exclude.length };
  }

  /** A folder for roots: it holds projects, so it must pass the same checks as a workspace and must not be a drive. */
  private checkFolder(folder: string, what: string): string {
    const dir = path.resolve(folder);
    if (!dirExists(dir)) fail('The folder ' + dir + ' does not exist.', 'Check the path.');
    if (isRootPath(dir))
      fail('A whole drive cannot be ' + what + ': ' + dir, 'Use the folder that holds your projects, e.g. F:\\Code.');
    assertSafeWorkspace(dir, this.ctx.packageRoot, this.ctx.storageRoot);
    assertSafeMapping(dir, this.ctx.packageRoot, this.ctx.storageRoot);
    return dir;
  }
}
