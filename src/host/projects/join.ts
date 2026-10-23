// Joining the running sandbox from another folder. The folder's run is resolved exactly as a fresh launch would
// resolve it (its approved .sandbox-config.json, versions, toolchain detection, database plan), checked against the
// running sandbox's machine-wide protections, made visible inside (host/projects: a project root, a project
// mapped at boot, wsb share, or HCS) and described to the guest, which provisions what is missing before its session.
// When none of those can make it visible, NeedsRestart reaches the caller, which offers a restart. So does a project
// that wants what the sandbox only gets at its start (a .wsb device, more memory, its mappings) when you choose to
// restart for it; otherwise it joins without them and they are named.
import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedRun } from '../../core/types.js';
import {
  checkJoin,
  missingAtBoot,
  nothingMissing,
  protectionsOf,
  type Missing,
} from '../../core/local-config/index.js';
import { resolveToolchains } from '../../core/detect/index.js';
import { assertNoLinks, dirExists, fail } from '../../core/util/index.js';
import { IdSchema, RunDir, type ProjectSpec } from '../../shared/channel/index.js';
import { syncProjectIn } from '../../sync/index.js';
import { decideProjectToolchains, planDatabases, stageScripts } from '../launch/index.js';
import { RepoGuardStore } from '../guard/index.js';
import { ProjectRegistry, type Registry, type RegistryEntry } from './registry.js';
import { NeedsRestart, projectMapper, type ProjectMapper } from './mapper.js';
import { KnownProjects } from './known.js';

/** A launch id as the launch writes it (it comes back from the guest, so it is checked before it names a folder). */
const LAUNCH_ID = /^\d+-[0-9a-f]{6}$/;

/**
 * The running sandbox's registry. When run\projects.json is missing, cannot be read or belongs to an earlier sandbox
 * (another copy or version of this tool started this one), it is rebuilt from the launch folder, so a folder in one of
 * the sandbox's roots can still join. null: no running sandbox reported a launch, or nothing to rebuild it from.
 */
export function runningRegistry(
  storageRoot: string,
  dataPath: string,
  protections: Registry['protections'],
): Registry | null {
  const file = new ProjectRegistry(storageRoot);
  const current = file.read();
  const launchId = new RunDir(dataPath).readSandboxStatus()?.launchId;
  if (!launchId || !LAUNCH_ID.test(launchId)) return current;
  if (current?.launchId === launchId) return current;
  const launchPath = path.join(storageRoot, 'launches', launchId);
  assertNoLinks(storageRoot, launchPath);
  return file.rebuild(launchPath, launchId, protections);
}

/** The launch folder of the running sandbox (host-only storage; its id comes from the guest, so it is checked). */
export function runningLaunchPath(storageRoot: string, dataPath: string): string | null {
  const launchId = new RunDir(dataPath).readSandboxStatus()?.launchId;
  if (!launchId || !LAUNCH_ID.test(launchId) || new ProjectRegistry(storageRoot).read()?.launchId !== launchId)
    return null;
  const launchPath = path.join(storageRoot, 'launches', launchId);
  assertNoLinks(storageRoot, launchPath);
  return fs.existsSync(path.join(launchPath, 'session.json')) ? launchPath : null;
}

/** What a session or command from this folder needs: where it is inside, and (for another project) its spec. */
export interface Joined {
  project: RegistryEntry;
  guestDir: string;
  spec: ProjectSpec | null;
  run: ResolvedRun | null;
  notes: string[];
  /** What it wants at boot that the running sandbox started without (it joined without them). */
  missing: Missing | null;
}

/** What to do when a joining project wants something the running sandbox started without. */
export type MissingChoice = 'continue' | 'restart' | 'cancel';

/** The project spec the guest provisions from (scans the project folder like a launch does). */
export function projectSpec(run: ResolvedRun, entry: RegistryEntry, hooks: boolean): ProjectSpec {
  const { config } = run;
  const toolchains = resolveToolchains(config.toolchains, decideProjectToolchains({ run }));
  const harness = run.harnessName === 'none' ? null : config.harnesses[run.harnessName];
  return {
    name: IdSchema.parse(entry.name),
    workspace: entry.guest,
    workspaceHost: entry.host,
    toolchains,
    versions: run.versions,
    databases: planDatabases(config.databases, run.workspaceHost).slice(0, 8),
    harnesses: harness ? { [run.harnessName]: harness } : {},
    hooks,
  };
}

/**
 * Makes `hostDir` usable in the running sandbox. The launch folder (or a folder below it) needs nothing; any other
 * folder is resolved with `resolve` (the caller's resolveRun, with the approval prompt), checked, and registered.
 */
export async function joinRunning(o: {
  storageRoot: string;
  dataPath: string;
  packageRoot: string;
  hostDir: string;
  wsbShare: boolean;
  /** projects.liveFolders ("hcs": the opt-in alpha that adds folders through HCS where wsb share is missing). */
  liveFolders?: 'off' | 'hcs';
  /** Shown at once (the live-folder warning comes before its permission prompt). */
  onNote?: (note: string) => void;
  resolve: (projectRoot: string) => Promise<ResolvedRun>;
  mapper?: ProjectMapper;
  /** Asked before anything is registered when something is missing (default: continue without it). */
  decide?: (name: string, missing: Missing) => Promise<MissingChoice>;
  /** Asked when the project's own settings are stricter than the running sandbox's (default: refuse). */
  acceptStricter?: (name: string, stricter: string[]) => Promise<boolean>;
}): Promise<Joined> {
  const registryFile = new ProjectRegistry(o.storageRoot);
  const here = registryFile.here(o.hostDir);
  if (here?.project.primary) return { ...here, spec: null, run: null, notes: [], missing: null };
  const registry =
    registryFile.read() ??
    fail(
      "The record of the running sandbox's projects is missing, and its launch folder could not replace it.",
      'Run sandbox doctor (it shows which copy of sandbox runs), or stop the sandbox (sandbox stop) and start it again.',
    );
  // A folder below a project already in the sandbox uses that project; anything else becomes a project of its own.
  const root = here?.project.host ?? path.resolve(o.hostDir);
  const run = await o.resolve(root);
  const check = checkJoin(registry.protections, protectionsOf(run.config), Object.keys(registry.atBoot?.widened ?? {}));
  // Machine-wide settings cannot change for one project, so it either runs with the sandbox's (your consent) or not
  // at all.
  const name = here?.project.name ?? path.basename(root);
  const accepted = check.stricter.length > 0 && (await o.acceptStricter?.(name, check.stricter)) === true;
  if (check.stricter.length && !accepted) {
    fail(
      "This project's settings are stricter than the running sandbox's, and those settings are machine-wide:\n  " +
        check.stricter.join('\n  '),
      "Join with the sandbox's settings: answer yes in a terminal, or add --yes. Or stop the sandbox (sandbox stop) and start it from " +
        root +
        '.',
    );
  }
  // Boot-only wishes (a .wsb device you allowed for it, more memory, its mappings) the running sandbox lacks.
  const launchPath = runningLaunchPath(o.storageRoot, o.dataPath);
  const boot = registryFile.bootRecord(launchPath);
  const found = boot ? missingAtBoot(registry.protections, boot, run.config, dirExists) : null;
  const missing = found && !nothingMissing(found) ? found : null;
  if (missing) {
    const choice = o.decide ? await o.decide(name, missing) : 'continue';
    if (choice === 'cancel') fail('Cancelled: nothing changed.');
    if (choice === 'restart') throw new NeedsRestart(root, 'it wants what the sandbox only gets at its start', missing);
  }
  const mapper =
    o.mapper ??
    projectMapper({
      storageRoot: o.storageRoot,
      packageRoot: o.packageRoot,
      wsbShare: o.wsbShare,
      liveFolders: o.liveFolders,
      dataPath: o.dataPath,
    });
  // Guarded from now on. A folder the sandbox could already write (inside a root, or mapped at boot) and that has no
  // snapshot from the launch gets an empty one: what is there now may have been planted, so it counts as new.
  // Anything else is snapshotted before it becomes visible.
  new RepoGuardStore(o.dataPath).add(root, {
    empty: Boolean(here) || Boolean(registryFile.rootHere(root)),
  });
  const entry = await mapper.register(root, { readOnly: run.config.readOnly, onNote: o.onNote });
  new KnownProjects(o.storageRoot).remember(entry.host);
  // Your hooks in ~/.agent-sandbox/hooks ran at boot (once per sandbox); the project's own scripts ("scripts" in its
  // .sandbox-config.json, --script) run before its first agent. The launch folder is read-only for the sandbox, but
  // this side can still add them to it.
  const hooks = Boolean(launchPath) && run.scripts.length > 0;
  if (launchPath && hooks)
    stageScripts(path.join(launchPath, 'projects', entry.name, 'hooks', 'pre-agent'), run.scripts);
  try {
    syncProjectIn(o.dataPath, { hostWorkspace: entry.host, guestWorkspace: entry.guest });
  } catch {
    /* history is a convenience; never block the session */
  }
  const notes = [
    ...run.notes,
    ...check.looser.map((l) => 'The running sandbox is stricter: ' + l + '.'),
    ...(accepted ? ["Runs with the sandbox's settings (you agreed): " + check.stricter.join('; ') + '.'] : []),
    ...check.shared.map(
      (s) => s + ' is on in this sandbox for another of its projects (you allowed it there); this project shares it.',
    ),
  ];
  return {
    project: entry,
    guestDir: here ? here.guestDir : entry.guest,
    spec: projectSpec(run, entry, hooks),
    run,
    notes,
    missing,
  };
}
