// Which project of the running sandbox a command is run from. Every command that works on a running sandbox uses
// these, so they all agree: `locateHere` only looks (attach, sessions, status, restart), `joinHere` also makes the
// folder a project of the running sandbox when it can without a restart (launch, start, exec, db).
import path from 'node:path';
import { select } from '@inquirer/prompts';
import type { SandboxStatus } from '../../../core/types.js';
import { describeMissing, missingTip, protectionsOf, type Missing } from '../../../core/local-config/index.js';
import { askYesNo } from '../../../core/prompt.js';
import { fail, isInsideOrEqual } from '../../../core/util/index.js';
import { ownerName } from '../../../host/sharing/index.js';
import { resolveRun } from '../../../core/run/index.js';
import { SandboxChannel } from '../../../host/channel/index.js';
import {
  BorrowedRegistry,
  ProjectRegistry,
  type Registry,
  type RegistryEntry,
  joinRunning,
  runningRegistry,
  type MissingChoice,
} from '../../../host/projects/index.js';
import type { ProjectSpec } from '../../../shared/channel/index.js';
import { c, working } from '../../output/index.js';
import { describeSessions } from './describe-sessions.js';
import { guestPathFor, type Context } from '../context.js';

/** The running sandbox's projects: this user's registry, or the record of the user who shares theirs. */
export function registryOf(ctx: Context): ProjectRegistry {
  return ctx.borrowed ? new BorrowedRegistry(ctx.borrowed.record) : new ProjectRegistry(ctx.storageRoot);
}

/** The folder the command is about: --workspace, else the current one. */
export function hereDir(ctx: Context): string {
  return path.resolve(ctx.options.workspace ?? process.cwd());
}

export interface Located {
  project: RegistryEntry | null;
  guestDir: string | null;
}

/**
 * Your running sandbox's registry, rebuilt from its launch folder when the file is missing, unreadable or an earlier
 * sandbox's (another copy or version of this tool started it). null only for a sandbox without one at all.
 */
function ownRegistry(ctx: Context): Registry | null {
  return runningRegistry(ctx.storageRoot, ctx.dataPath, protectionsOf(ctx.loaded.config));
}

/** Where this folder is in the running sandbox, if it is in it at all (nothing is registered). */
export function locateHere(ctx: Context, status: SandboxStatus | null): Located {
  const dir = hereDir(ctx);
  const own = ctx.borrowed ? null : ownRegistry(ctx);
  const here = registryOf(ctx).here(dir);
  if (here) return here;
  // A sandbox started before projects existed: only its launch folder.
  if (!ctx.borrowed && !own && status && isInsideOrEqual(status.workspaceHost, dir))
    return { project: null, guestDir: guestPathFor(dir, status.workspaceHost, status.guestWorkspace) };
  return { project: null, guestDir: null };
}

export interface Joined {
  project: RegistryEntry | null;
  guestDir: string;
  spec: ProjectSpec | null;
  harness: string | null;
  notes: string[];
}

let restartedOnce = false;

/** restart.ts: the sandbox was restarted for a project in this command. */
export function markRestarted(): void {
  restartedOnce = true;
}

/**
 * Makes this folder a project of the running sandbox (nothing to do for the launch folder and projects already in
 * it): its .sandbox-config.json is approved like at a launch, its protections are checked, and it is made visible.
 * Throws NeedsRestart (host/projects) when that is impossible without a restart.
 */
export async function joinHere(ctx: Context, status: SandboxStatus, o: { noRestart?: boolean } = {}): Promise<Joined> {
  const { options, loaded, packageRoot, storageRoot, dataPath } = ctx;
  const dir = hereDir(ctx);
  // Another user's sandbox: only the projects it already has; nothing joins it, nothing restarts it.
  if (ctx.borrowed) {
    const user = ownerName(ctx.borrowed.user);
    const known = registryOf(ctx).here(dir);
    if (!known)
      fail(
        dir + ' is not one of the folders in ' + user + "'s sandbox.",
        'Run it from a folder that sandbox has (sandbox status lists them), or ask ' + user + ' to add this one.',
      );
    return { project: known.project, guestDir: known.guestDir, spec: null, harness: null, notes: [] };
  }
  // A sandbox started before projects existed: only its launch folder (guestPathFor explains why otherwise).
  if (!ownRegistry(ctx))
    return {
      project: null,
      guestDir: guestPathFor(dir, status.workspaceHost, status.guestWorkspace),
      spec: null,
      harness: null,
      notes: [],
    };
  let shown = false;
  const joined = await joinRunning({
    storageRoot,
    dataPath,
    packageRoot,
    hostDir: dir,
    wsbShare: loaded.config.projects.wsbShare,
    liveFolders: loaded.config.projects.liveFolders,
    onNote: (note) => console.log(c.yellow(note)),
    resolve: (root) =>
      resolveRun({
        packageRoot,
        loaded,
        cwd: root,
        workspace: root,
        harness: options.harness,
        noAgent: options.noAgent,
        noLocalConfig: options.noLocalConfig,
        trustConfig: options.trustConfig,
        scripts: options.scripts,
        databases: options.databases,
        nodeVersion: options.node,
        pythonVersion: options.python,
        ask: askYesNo,
      }),
    // Its own settings are stricter than the sandbox's: --yes or a "yes" in a terminal joins with the sandbox's.
    acceptStricter: async (name, stricter): Promise<boolean> => {
      if (options.yes) return true;
      if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
      console.log(
        c.yellow(
          name +
            "'s settings are stricter than this sandbox's (they apply to every session in it):\n  " +
            stricter.join('\n  '),
        ),
      );
      return askYesNo("Join with the sandbox's settings?");
    },
    // Something it wants only comes with a restart: --yes restarts, a terminal asks, anything else continues.
    decide: async (name, missing): Promise<MissingChoice> => {
      // Once per command: what a restart could not give (see the launch notes) never restarts it again.
      if (o.noRestart || restartedOnce) return 'continue';
      if (options.yes) return 'restart';
      if (!process.stdin.isTTY || !process.stdout.isTTY) return 'continue';
      console.log(c.yellow(describeMissing(name, missing)));
      shown = true;
      const sessions = new SandboxChannel(dataPath).currentSessions();
      if (sessions.length) console.log(describeSessions(sessions) + ' will be reopened after the restart.');
      return select<MissingChoice>({
        message: 'What now?',
        choices: [
          { name: 'Restart with them (sessions reopen and continue)', value: 'restart' },
          { name: 'Continue without them', value: 'continue' },
          { name: 'Cancel', value: 'cancel' },
        ],
        default: 'continue',
      });
    },
  });
  const harness = joined.run && joined.run.harnessName !== 'none' ? joined.run.harnessName : null;
  const notes = joined.missing
    ? [...joined.notes, ...missingNotes(ctx, joined.project.name, joined.project.host, joined.missing, shown)]
    : joined.notes;
  return { project: joined.project, guestDir: joined.guestDir, spec: joined.spec, harness, notes };
}

/** The command that restarts the running sandbox with this folder's boot wishes (consent given by --yes). */
export function restartCommand(ctx: Context, host: string): string {
  const agent = ctx.options.noAgent ? 'start' : (ctx.options.harness ?? ctx.loaded.config.defaultHarness);
  return 'sandbox ' + agent + ' --workspace "' + host + '" --yes';
}

/** Joined without what it wants at boot: what is missing, how to restart with it, and how to always have it. */
export function missingNotes(ctx: Context, name: string, host: string, missing: Missing, shown = false): string[] {
  return [
    ...(shown ? [] : [c.yellow(describeMissing(name, missing))]),
    'Joined without them. To restart the sandbox with them (its sessions end): ' + restartCommand(ctx, host),
    c.dim(missingTip(missing)),
  ];
}

/** Waits until the sandbox has set a project up, with its progress on a spinner (plain lines without a terminal). */
export async function provisionJoined(ctx: Context, joined: Joined): Promise<void> {
  if (!joined.spec) return;
  const spec = joined.spec;
  let step = 'starting';
  await working(
    () => 'Setting up ' + spec.name + ' in the running sandbox: ' + step,
    () =>
      new SandboxChannel(ctx.dataPath).prepareProject(spec, (m) => {
        step = m;
      }),
  );
}

/** joinHere, then (for another project) waits until the sandbox has set it up. */
export async function readyHere(ctx: Context, status: SandboxStatus): Promise<Joined> {
  const joined = await joinHere(ctx, status);
  for (const note of joined.notes) console.log(note);
  await provisionJoined(ctx, joined);
  return joined;
}
