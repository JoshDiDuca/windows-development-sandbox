// Sessions of the running sandbox (agents and plain shells): list, pick one to attach to, restart the agents, open a
// shell, close one. Returns data, never prints.
import _ from 'lodash';
import type { SessionStatus } from '../../core/types.js';
import { fail } from '../../core/util/index.js';
import type { ShellChoice } from '../../shared/channel/index.js';
import { SandboxChannel, sessionsFirstIn, sessionViewers } from '../../host/channel/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import type { RegistryEntry } from '../../host/projects/index.js';
import { RunDir } from '../../shared/channel/index.js';
import { isWithin, projectForGuestDir } from '../../shared/paths/index.js';
import type { Viewers } from '../../shared/pty/index.js';
import type { Context } from '../commands/context.js';
import { hereDir, locateHere, registryOf } from '../commands/projects/here.js';

/** A shell needs no install: the longest it may take is its project's first setup. */
const SHELL_START_MS = 15 * 60 * 1000;

export function viewerText(v: Viewers | null | undefined): string {
  return v === undefined
    ? '-'
    : v === null
      ? 'unknown (older session)'
      : v.remote + ' here, ' + (v.viewers - v.remote) + ' in sandbox';
}

export function projectOf(projects: RegistryEntry[], s: SessionStatus): string {
  return s.project ?? projectForGuestDir(projects, s.cwd)?.name ?? '-';
}

/** A session with who is watching it and whether it is in the project of the current folder. */
export type ListedSession = SessionStatus & {
  readonly viewers?: Viewers | null;
  readonly here?: boolean;
  readonly projectName?: string;
};

/** Which sessions a restart touches: the current folder's project, or every session. */
export interface RestartScope {
  /** Guest folder of the project, or undefined for every session. */
  readonly guest: string | undefined;
  readonly projectName: string | undefined;
  /** The folder is not a project of the running sandbox (and --all was not given): every session restarts. */
  readonly notAProject: boolean;
  readonly folder: string;
}

export class SessionsService {
  constructor(private readonly ctx: Context) {}

  private get channel(): SandboxChannel {
    return new SandboxChannel(this.ctx.dataPath);
  }

  /** Sessions with who is watching them; `here` marks the ones in the project of the current folder. */
  async list(): Promise<ListedSession[]> {
    // Who is attached comes from each session itself, so a terminal that was closed is never counted.
    const live = isSandboxRunning();
    // Only this sandbox's sessions are asked (and at most MAX_QUERIED_SESSIONS): the sandbox writes these files.
    const ask = new Set(live ? this.channel.currentSessions().map((s) => s.id) : []);
    const here = live ? locateHere(this.ctx, new RunDir(this.ctx.dataPath).readSandboxStatus()) : { guestDir: null };
    const projects = this.projects();
    return Promise.all(
      new RunDir(this.ctx.dataPath).listSessions().map(async (s) => ({
        ...s,
        projectName: projectOf(projects, s),
        here: Boolean(here.guestDir && isWithin(here.guestDir, s.cwd)),
        ...(ask.has(s.id) ? { viewers: await sessionViewers(s) } : {}),
      })),
    );
  }

  /** This folder's project first, newest first within each group. */
  ordered(list: readonly ListedSession[]): ListedSession[] {
    return [
      ..._.sortBy(
        list.filter((s) => s.here),
        (s) => s.startedAt,
      ).reverse(),
      ..._.sortBy(
        list.filter((s) => !s.here),
        (s) => s.startedAt,
      ).reverse(),
    ];
  }

  /** The project name to show for a session. */
  projectName(s: SessionStatus): string {
    return projectOf(this.projects(), s);
  }

  runningCount(): number {
    return this.channel.runningSessions().length;
  }

  /** Running sessions, those in the guest folder first. */
  running(guestDir: string | null): SessionStatus[] {
    return sessionsFirstIn(this.channel.runningSessions(), guestDir);
  }

  /** The session to attach to: the one named, else the newest of the folder's project, else the newest. */
  pick(sessionId?: string, guestDir: string | null = null): SessionStatus {
    return this.channel.pickSession(sessionId, guestDir);
  }

  /** What a restart from this folder touches. */
  restartScope(all: boolean): RestartScope {
    const here = locateHere(this.ctx, new RunDir(this.ctx.dataPath).readSandboxStatus());
    const scope = all || !here.project ? undefined : here.project.guest;
    return {
      guest: scope,
      projectName: scope ? here.project?.name : undefined,
      notAProject: !scope && !all,
      folder: hereDir(this.ctx),
    };
  }

  /** Restarts the agents (one kind, or all) of a project or of every session; returns the sandbox's message. */
  async restart(harness: string | null, scope?: string): Promise<string> {
    return (await this.channel.restart(harness, scope)).message;
  }

  /** Starts a plain shell in a folder of the sandbox and waits until it runs. */
  openShell(shell: ShellChoice, guestDir: string): Promise<SessionStatus> {
    const channel = this.channel;
    return channel.waitForSession(channel.requestShell(shell, guestDir), SHELL_START_MS, () => undefined);
  }

  /** Ends a running session and everything it started; returns the sandbox's message (throws when it refused). */
  async close(sessionId: string): Promise<string> {
    const answer = await this.channel.closeSession(sessionId);
    if (!answer.ok) fail(answer.message);
    return answer.message;
  }

  private projects(): RegistryEntry[] {
    return registryOf(this.ctx).read()?.projects ?? [];
  }
}
