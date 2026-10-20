// Opening sessions again in a sandbox that just started: after a restart that adds folders (projects/restart.ts), and
// after a launch or `sandbox resume` that picks up what ran last time. Each session opens in its own folder with the
// arguments that continue its conversation: the one it was in when the agent can open it by id, else the agent's last.
import _ from 'lodash';
import type { SandboxStatus, SessionStatus } from '../../../core/types.js';
import { errMsg } from '../../../core/util/index.js';
import type { LedgerSession } from '../../../host/life/index.js';
import type { Registry } from '../../../host/projects/index.js';
import { hostDirFor, projectForGuestDir, resumeArgumentsFor } from '../../../shared/paths/index.js';
import { c } from '../../output/index.js';
import type { CliOptions } from '../../args.js';
import type { Context } from '../context.js';
import type { LaunchExtras, OpenSessionOptions } from '../launch/index.js';
import type { Joined } from '../projects/here.js';

/** What a restart or resume needs from launch (launch imports them, so it is handed in rather than imported). */
export interface Relauncher {
  launch(ctx: Context, generateOnly: boolean, extras: LaunchExtras): Promise<number>;
  readySandbox(dataPath: string): Promise<SandboxStatus>;
  joinHere(ctx: Context, status: SandboxStatus, o?: { noRestart?: boolean }): Promise<Joined>;
  openSession(ctx: Context, ready: SandboxStatus, joined: Joined, o: OpenSessionOptions): Promise<number>;
}

/** A session to open again: its agent, its folder on this PC and the conversation it was in (when known). */
export interface Reopen {
  readonly harness: string;
  readonly hostDir: string;
  readonly conversation?: string;
}

/** Where each running session is on this PC, so it can be reopened after a restart. */
export function sessionsToReopen(registry: Registry, sessions: readonly SessionStatus[]): Reopen[] {
  return sessions.flatMap((s) => {
    // Shells are not reopened: a new one would not be the one that ended.
    if (s.kind === 'shell') return [];
    const project = projectForGuestDir([...registry.projects, ...registry.roots.map((r) => ({ ...r }))], s.cwd);
    return project
      ? [
          {
            harness: s.harness,
            hostDir: hostDirFor(project, s.cwd),
            ...(s.conversation ? { conversation: s.conversation } : {}),
          },
        ]
      : [];
  });
}

/** The sessions the last sandbox had, as sessions to open. */
export function ledgerToReopen(sessions: readonly LedgerSession[]): Reopen[] {
  return sessions.map((s) => ({
    harness: s.harness,
    hostDir: s.project,
    ...(s.conversation ? { conversation: s.conversation } : {}),
  }));
}

/** Leaves out sessions the sandbox has already (same agent, same folder): reopening them would double them. */
export function notRunningYet(reopen: readonly Reopen[], running: readonly Reopen[]): Reopen[] {
  const taken = [...running];
  return reopen.filter((r) => {
    const at = taken.findIndex((t) => t.harness === r.harness && t.hostDir.toLowerCase() === r.hostDir.toLowerCase());
    if (at < 0) return true;
    taken.splice(at, 1);
    return false;
  });
}

/** The same command for another folder, as a plain new session (nothing attached, no agent arguments). */
export function freshContext(
  ctx: Context,
  workspace: string,
  harness: string | undefined,
  more: Partial<CliOptions> = {},
): Context {
  return {
    ...ctx,
    options: {
      ...ctx.options,
      workspace,
      harness,
      terminal: false,
      newSession: true,
      passthrough: [],
      sessions: [],
      ...more,
    },
  };
}

/** The arguments that continue this session (its conversation when the agent can open one by id). */
export function continueArguments(ctx: Context, s: Reopen): string[] {
  const harness = ctx.loaded.config.harnesses[s.harness];
  return harness ? resumeArgumentsFor(harness, s.conversation) : [];
}

/** Opens each session again; one that cannot be opened is said and skipped. Returns how many opened. */
export async function reopenSessions(
  ctx: Context,
  ready: SandboxStatus,
  reopen: readonly Reopen[],
  relauncher: Relauncher,
): Promise<number> {
  let opened = 0;
  for (const s of reopen) {
    const at = freshContext(ctx, s.hostDir, s.harness);
    try {
      const joined = await relauncher.joinHere(at, ready, { noRestart: true });
      for (const note of joined.notes) console.log(note);
      await relauncher.openSession(at, ready, joined, {
        attach: false,
        harness: s.harness,
        args: continueArguments(ctx, s),
        reuse: false,
      });
      opened++;
    } catch (e) {
      console.warn(c.yellow('Could not reopen ' + s.harness + ' in ' + s.hostDir + ': ' + errMsg(e)));
    }
  }
  return opened;
}

/** "Reopened 2 sessions (continuing their conversations)." */
export function reopenedText(opened: number, wanted: number, reopen: readonly Reopen[]): string {
  const same = _.every(reopen, (s) => Boolean(s.conversation));
  return (
    'Reopened ' +
    opened +
    (opened === wanted ? '' : ' of ' + wanted) +
    ' session' +
    (opened === 1 ? '' : 's') +
    (opened
      ? same
        ? ' (continuing their conversations).'
        : ' (continuing the last conversation of each agent).'
      : '.')
  );
}
