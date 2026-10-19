// Where the repo guard keeps its snapshots and findings: host-only files next to the sync state, never in the data
// folder the sandbox can write.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';
import { hostStateFile, storageOf } from '../storage/index.js';
import { dirExists, isLink } from '../../core/util/index.js';
import { RepoGuard } from './repo-guard.js';
import { FINDING_KINDS, type RepoFinding, type RepoSnapshot } from './types.js';

const FindingSchema = z.object({
  kind: z.enum(FINDING_KINDS),
  detail: z.string().max(4096),
  at: z.string().max(64).optional(),
});
const GitStateSchema = z.object({
  config: z.array(z.string()),
  hooks: z.record(z.string(), z.string()),
  redirects: z.array(z.string()),
  pathHooks: z.record(z.string(), z.string()).optional(),
});
const SavedSchema = z.object({
  workspace: z
    .string()
    .max(1024)
    .refine((p) => path.isAbsolute(p)),
  snapshot: GitStateSchema.extend({
    gitDir: z.boolean(),
    commands: z.record(z.string(), z.string()),
    agent: z.record(z.string(), z.string()).optional(),
    repos: z.record(z.string(), GitStateSchema).optional(),
  }),
});
type Saved = z.output<typeof SavedSchema>;

/**
 * Every project the sandbox can write, and the project roots (whole folders of projects) it has mapped. Older
 * versions saved a single object.
 */
const StoreSchema = z.strictObject({
  projects: z.array(SavedSchema).max(4096),
  roots: z
    .array(
      z
        .string()
        .max(1024)
        .refine((p) => path.isAbsolute(p)),
    )
    .max(64),
});
type Store = z.output<typeof StoreSchema>;
/** A recorded finding (`at`: when it was found). */
export type RecordedFinding = RepoFinding & { at?: string };
const StoreAnySchema = z.union([StoreSchema, SavedSchema.transform((s) => ({ projects: [s], roots: [] as string[] }))]);
const EMPTY: RepoSnapshot = { gitDir: false, config: [], hooks: {}, redirects: [], commands: {}, agent: {}, repos: {} };
const MAX_ROOT_PROJECTS = 2000;

/** The folders directly inside a project root (plain folders only; links are never followed). */
function rootProjects(root: string): string[] {
  if (!dirExists(root) || isLink(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .slice(0, MAX_ROOT_PROJECTS)
    .map((e) => path.join(root, e.name));
}
function has(projects: readonly Saved[], workspace: string): boolean {
  return projects.some((s) => s.workspace.toLowerCase() === workspace.toLowerCase());
}

/** The guarded projects of one data folder and what the guard found (host-only files next to the sync state). */
export class RepoGuardStore {
  private readonly snapshots: JsonFile<Store>;
  private readonly found: JsonFile<RecordedFinding[]>;

  constructor(
    dataPath: string,
    private readonly guard = new RepoGuard(),
  ) {
    const storageRoot = storageOf(dataPath);
    this.snapshots = new JsonFile(StoreAnySchema, hostStateFile(storageRoot, dataPath, '-repo.json'));
    this.found = new JsonFile(
      z.array(FindingSchema).max(10000),
      hostStateFile(storageRoot, dataPath, '-repo-findings.json'),
    );
  }

  private read(): Store {
    return this.snapshots.read() ?? { projects: [], roots: [] };
  }

  /**
   * At launch: every folder the sandbox will be able to write. The launch folder, projects mapped with it and every
   * project already inside a project root are snapshotted as they are now, before the sandbox can touch them.
   */
  save(workspace: string, more: readonly string[] = [], roots: readonly string[] = []): void {
    const folders = _.uniqBy([workspace, ...more, ...roots.flatMap((r) => [r, ...rootProjects(r)])], (w) =>
      w.toLowerCase(),
    );
    this.snapshots.write({
      projects: folders.map((w) => ({ workspace: w, snapshot: this.guard.snapshot(w) })),
      roots: [...roots],
    });
  }

  /**
   * A project that joins the running sandbox: snapshotted before its first session, then guarded like the launch
   * folder. A project already guarded keeps its first snapshot (what was there before the sandbox could touch it).
   */
  add(workspace: string, o: { empty?: boolean } = {}): void {
    const store = this.read();
    // A folder inside one that is guarded already is covered by it only for its root files; it gets its own entry.
    if (has(store.projects, workspace)) return;
    this.snapshots.write({
      ...store,
      projects: [...store.projects, { workspace, snapshot: o.empty ? EMPTY : this.guard.snapshot(workspace) }],
    });
  }

  /**
   * Folders that appeared inside a project root after the launch: the sandbox could have written them from the start,
   * so they get an EMPTY baseline: any git hook, git config that runs programs (core.hooksPath, core.fsmonitor, ...)
   * or planted command in them counts as added inside the sandbox and is neutralised.
   */
  private discoverRootProjects(): Saved[] {
    const store = this.read();
    const found = store.roots
      .flatMap(rootProjects)
      .filter((w) => !has(store.projects, w))
      .map((workspace) => ({ workspace, snapshot: EMPTY }));
    if (!found.length) return store.projects;
    const projects = [...store.projects, ...found].slice(0, 4096);
    this.snapshots.write({ ...store, projects });
    return projects;
  }

  /** The folders being guarded (for status). */
  guarded(): string[] {
    return this.read().projects.map((s) => s.workspace);
  }

  /**
   * Re-checks every project of the current/last launch; findings are kept in a host-only file for `status`. Returns the
   * new ones.
   */
  check(): RepoFinding[] {
    const saved = this.discoverRootProjects();
    if (!saved.length) return [];
    const old = this.findings();
    // A finding that cannot be fixed (a file locked in the sandbox) is reported once, not every minute.
    const findings = saved
      .flatMap((s) =>
        this.guard
          .guard(s.workspace, s.snapshot)
          .map((f) => (saved.length > 1 ? { ...f, detail: s.workspace + ': ' + f.detail } : f)),
      )
      .filter((f) => !old.some((o) => o.kind === f.kind && o.detail === f.detail));
    if (findings.length) this.found.write([...old, ...findings.map((f) => ({ ...f, at: new Date().toISOString() }))]);
    return findings;
  }

  findings(): RecordedFinding[] {
    return this.found.read() ?? [];
  }
}
