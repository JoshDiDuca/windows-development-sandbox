// The running sandbox as a whole: what it is doing, its window, and stopping it. Returns data, never prints.
import type { SandboxStatus, SessionStatus } from '../../core/types.js';
import { errMsg, fail, safeText } from '../../core/util/index.js';
import { SandboxChannel } from '../../host/channel/index.js';
import { RepoGuardStore } from '../../host/guard/index.js';
import { SessionLedger } from '../../host/life/index.js';
import type { Registry, RegistryEntry } from '../../host/projects/index.js';
import { hideSandboxWindow, isSandboxRunning, showSandboxWindow } from '../../host/sandbox/index.js';
import { RunDir, type ProjectStatus } from '../../shared/channel/index.js';
import { isWithin, projectForGuestDir } from '../../shared/paths/index.js';
import { watcherRunning } from '../../sync/index.js';
import type { Context } from '../commands/context.js';
import { hereDir, locateHere, registryOf } from '../commands/projects/here.js';
import { AccountsService } from './accounts-service.js';
import { DatabasesService } from './databases-service.js';
import { SessionsService, viewerText, type ListedSession } from './sessions-service.js';

type Finding = ReturnType<RepoGuardStore['findings']>[number];

/** What is known about one project of the running sandbox. */
export interface ProjectInfo {
  readonly name: string;
  readonly host: string;
  readonly guest: string;
  readonly mechanism: RegistryEntry['mechanism'];
  readonly here: boolean;
  readonly setup: { readonly phase: string; readonly message: string };
  readonly databases: { readonly database: string; readonly port: number; readonly state: string }[];
  readonly sessions: {
    readonly id: string;
    readonly harness: string;
    readonly viewers: string;
    readonly started: string;
  }[];
  readonly repoGuard: string[];
}

export interface SandboxState {
  readonly running: boolean;
  readonly phase: string;
  readonly message: string | undefined;
  readonly headless: boolean | undefined;
  /** When the sandbox started (ms), if known. */
  readonly startedAt: number | null;
  readonly daemon: string;
  readonly account: string | null;
  readonly syncWatcher: boolean;
}

export interface OtherSession {
  readonly id: string;
  readonly harness: string;
  readonly cwd: string;
}

export interface SandboxReport {
  readonly sandbox: SandboxState;
  readonly here: { readonly folder: string; readonly project: string | null; readonly guest: string | null };
  readonly roots: Registry['roots'];
  readonly projects: ProjectInfo[];
  readonly otherSessions: OtherSession[];
  readonly repoGuard: { readonly guarded: number; readonly findings: string[] };
}

/** What stopping would end: every project's sessions, and the ones outside this folder's project. */
export interface StopPlan {
  readonly sandbox: SandboxStatus;
  readonly running: SessionStatus[];
  readonly others: SessionStatus[];
}

export class SandboxService {
  constructor(private readonly ctx: Context) {}

  isRunning(): boolean {
    return isSandboxRunning();
  }

  /** Everything `status` shows. Text that comes from the sandbox goes through safeText. */
  async status(): Promise<SandboxReport> {
    const { ctx } = this;
    const running = isSandboxRunning();
    const run = new RunDir(ctx.dataPath);
    const channel = new SandboxChannel(ctx.dataPath);
    // The owner's repo guard, logins and watcher are their host state, outside the folders shared with this user.
    const guard = ctx.borrowed ? null : new RepoGuardStore(ctx.dataPath);
    const sandbox = run.readSandboxStatus();
    const registry = running ? registryOf(ctx).read() : null;
    const ready = running && sandbox?.phase === 'ready';
    const daemon = ready
      ? await channel.ping().then(
          (r) => r.message,
          (e: unknown) => 'no answer (' + errMsg(e) + ')',
        )
      : '-';
    const here = running ? locateHere(ctx, sandbox) : { project: null, guestDir: null };
    const sessionList = running ? await new SessionsService(ctx).list() : [];
    const provisioning = running ? run.listProjectStatus() : [];
    const ports = ready && sandbox ? await new DatabasesService(ctx).runningPorts(sandbox.guestWorkspace) : null;
    const findings = guard?.findings() ?? [];
    const startedAt = Number(/^(\d+)-/.exec(registry?.launchId ?? sandbox?.launchId ?? '')?.[1]) || null;
    const all = registry?.projects ?? [];
    const facts = { here: here.project?.name ?? null, provisioning, sessions: sessionList, ports, findings };
    const projects = all.map((p) => projectInfo(p, all, facts));
    return {
      sandbox: {
        running,
        phase: running ? (sandbox?.phase ?? 'unknown') : 'stopped',
        message: sandbox?.message,
        headless: sandbox?.headless,
        startedAt: running ? startedAt : null,
        daemon,
        account: ctx.borrowed ? null : new AccountsService(ctx).activeName(),
        syncWatcher: ctx.borrowed ? false : watcherRunning(ctx.dataPath),
      },
      here: { folder: hereDir(ctx), project: here.project?.name ?? null, guest: here.guestDir },
      roots: registry?.roots ?? [],
      projects,
      otherSessions: sessionList
        .filter((s) => s.phase === 'running' && !projects.some((p) => p.sessions.some((x) => x.id === s.id)))
        .map((s) => ({ id: s.id, harness: safeText(s.harness), cwd: safeText(s.cwd) })),
      repoGuard: {
        guarded: guard?.guarded().length ?? 0,
        findings: findings.map((f) => f.kind + ': ' + f.detail),
      },
    };
  }

  /** Brings the sandbox window to the front. */
  showWindow(): void {
    if (!showSandboxWindow(this.ctx.storageRoot))
      fail('Could not find the Windows Sandbox window.', 'It may still be starting; try again in a few seconds.');
  }

  async hideWindow(): Promise<void> {
    if (!(await hideSandboxWindow(this.ctx.storageRoot, 5)))
      fail(
        'Could not find a visible Windows Sandbox window.',
        'It may already be hidden (sandbox show brings it back).',
      );
  }

  /** What stopping ends. Fails when this sandbox was not started by this tool. */
  stopPlan(): StopPlan {
    const sandbox =
      new RunDir(this.ctx.dataPath).readSandboxStatus() ??
      fail('This sandbox was not started by this tool.', 'Close its window instead.');
    // Stopping ends every project's sessions, not just this folder's.
    const here = locateHere(this.ctx, sandbox);
    const running = new SandboxChannel(this.ctx.dataPath).currentSessions();
    const others = running.filter((s) => !(here.guestDir && isWithin(here.project?.guest ?? here.guestDir, s.cwd)));
    return { sandbox, running, others };
  }

  /** Asks the sandbox to shut down (history and claude-mem sync back when it closes). */
  async shutdown(sandbox: SandboxStatus): Promise<void> {
    // On purpose, not a crash: its sessions are kept for the next start, and the watcher does not restart it. (Another
    // user's sandbox: that record is theirs; its watcher sees a shutdown with nothing wrong.)
    if (!this.ctx.borrowed) new SessionLedger(this.ctx.storageRoot, this.ctx.dataPath).markClosedOnPurpose();
    await new SandboxChannel(this.ctx.dataPath).exec(
      ['C:\\Windows\\System32\\shutdown.exe', '/s', '/t', '2'],
      sandbox.guestWorkspace,
      30,
    );
  }
}

/** One project: its setup, databases, running sessions and repo guard findings (sandbox text through safeText). */
function projectInfo(
  p: RegistryEntry,
  all: Registry['projects'],
  facts: {
    readonly here: string | null;
    readonly provisioning: ProjectStatus[];
    readonly sessions: ListedSession[];
    readonly ports: Set<number> | null;
    readonly findings: Finding[];
  },
): ProjectInfo {
  const prov = facts.provisioning.find((s) => s.name.toLowerCase() === p.name.toLowerCase());
  const own = facts.sessions.filter((s) => s.phase === 'running' && projectForGuestDir(all, s.cwd)?.name === p.name);
  const { ports } = facts;
  return {
    name: p.name,
    host: p.host,
    guest: p.guest,
    mechanism: p.mechanism,
    here: facts.here === p.name,
    setup: prov
      ? { phase: prov.phase, message: safeText(prov.message) }
      : { phase: 'not set up yet', message: 'set up when you first start a session or command there' },
    databases: (prov?.databases ?? []).map((d) => ({
      database: safeText(d.database),
      port: d.port,
      state: ports ? (ports.has(d.port) ? 'running' : 'stopped') : 'unknown',
    })),
    sessions: own.map((s) => ({
      id: s.id,
      harness: safeText(s.harness),
      viewers: viewerText(s.viewers),
      started: s.startedAt,
    })),
    // With several guarded folders each finding starts with its folder.
    repoGuard: facts.findings
      .filter((f) => f.detail.toLowerCase().startsWith(p.host.toLowerCase() + ':'))
      .map((f) => f.kind + ': ' + safeText(f.detail)),
  };
}
