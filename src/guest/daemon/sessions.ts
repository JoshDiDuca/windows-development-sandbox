// `session`, `restart` and `close` requests: agent sessions and plain shell sessions, each in its own ptyhost process.
// A session runs in the launch folder's project (the boot environment) or in a project registered later, which is
// provisioned first (daemon/project). A shell gets the same environment as an agent, without the agent's own
// environment (its keys) and without the agent's install, hooks and conversation tracking.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { GuestRequest, Harness, SessionStatus } from '../../core/types.js';
import { FrameType, sendControl } from '../../shared/pty/index.js';
import { isWithin } from '../../shared/paths/projects.js';
import { now } from '../../shared/channel/run-dir.js';
import { SYSTEM } from '../../shared/system.js';
import { buildJobs, cargoJobs, linkSlotsFor, usableCpus } from '../../shared/memory/index.js';
import { commandLine, shellLaunch, type ShellLaunch } from '../sessions/cmdline.js';
import { pwshDir } from '../toolchains/tools/pwsh.js';
import { freePort } from '../runtime/ports.js';
import { primaryProject } from '../boot/project-status.js';
import { ensurePtyHost, ptyHostLogTail, startPtyHost, waitForPtyHost } from '../sessions/pty-host.js';
import { agents } from '../agents/agent-installer.js';
import { saveClaudeMem } from '../setup/claude-mem.js';
import { saveLocalState } from '../agents/local-state.js';
import { projectHooks, runHooks, runHooksAsync, type HookTarget } from '../setup/hooks.js';
import { guestAddresses } from '../network/addresses.js';
import { withRegistryPath } from '../setup/environment.js';
import { dataDir, run, toolsDir } from '../runtime/paths.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { exists } from '../runtime/fs.js';
import { log, warn } from '../runtime/log.js';
import { claudeDir, session, workspace } from '../runtime/session.js';
import { findConversation } from '../sessions/conversation.js';
import { isConversationId } from '../../shared/paths/conversation.js';
import { errMsg } from '../../core/util/errors.js';
import type { SessionRoot } from '../audit/parse.js';
import { provisioner } from './project-provisioner.js';
import { IdleShutdown } from './idle-shutdown.js';
import { insidePrimary, insideWorkspace, respond, safely, saveStatus } from './state.js';

type SessionRequest = Extract<GuestRequest, { kind: 'session' }>;

/** How long a close waits for the session to end before it ends its ptyhost instead. */
const CLOSE_WAIT_MS = 8000;

/** An ended session's ptyhost is remembered this long: its last programs reach the audit up to 15 s later. */
const ROOTS_KEPT_MS = 10 * 60 * 1000;

function terminalTab(id: string, title: string, cwd: string): void {
  const view = [process.execPath, path.join(path.dirname(process.argv[1]), 'view.js'), id];
  const wt = path.join(toolsDir, 'terminal', 'wt.exe');
  if (exists(wt))
    spawn(wt, ['-w', '0', 'nt', '--title', title, '-d', cwd, ...view], { detached: true, stdio: 'ignore' }).unref();
  else spawn(SYSTEM.cmd(), ['/d', '/c', 'start', title, ...view], { detached: true, stdio: 'ignore', cwd }).unref();
}

/** Where a session runs: its environment and hooks (the boot's, or its project's). */
interface Place {
  env: NodeJS.ProcessEnv;
  hooks: HookTarget | null;
  project: string;
}

/**
 * The agent's definition: the one the sandbox booted with, the one the host sent along (another agent, e.g.
 * sandbox codex in a sandbox started for claude), or one the project's config names.
 */
const harnessFor = (req: SessionRequest): Harness => {
  if (req.harness === session.harnessName && session.harness) return session.harness;
  const sent = req.harnessSpec ?? req.project?.harnesses[req.harness];
  if (sent) return sent;
  throw new Error(
    'Agent "' + req.harness + '" is not configured for this sandbox (it runs ' + session.harnessName + ').',
  );
};

/**
 * What keeps heavy load from taking the sandbox down: the agents' job with its last-resort backstop (ptyhost reads
 * PTYHOST_BACKSTOP_MB and the commit limit) and cargo's parallel jobs sized to the sandbox's memory and the sessions
 * building. Slowing builds down comes first (the governor); the backstop only ever picks a build over Windows.
 */
export function memoryEnv(env: NodeJS.ProcessEnv, sessions: number): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  out.PTYHOST_BACKSTOP_MB = String(session.agentBackstop ?? 'auto');
  // What a program sees is what it may use: the processors of the CPU cap (the boot job's affinity), not every one.
  const cpus = usableCpus(os.cpus().length, session.cpuLimitPercent ?? null);
  const memoryGb = os.totalmem() / 1024 ** 3;
  const jobs = cargoJobs(cpus, memoryGb, sessions);
  out.NUMBER_OF_PROCESSORS = String(cpus);
  if (!env.CARGO_BUILD_JOBS) out.CARGO_BUILD_JOBS = String(jobs);
  if (!env.CMAKE_BUILD_PARALLEL_LEVEL) out.CMAKE_BUILD_PARALLEL_LEVEL = String(jobs);
  out.SANDBOX_BUDGET_FILE = run.budgetFile;
  writeBudget(cpus, memoryGb, jobs, env);
  return out;
}

/**
 * run\budget.json (SANDBOX_BUDGET_FILE): the numbers an agent should plan with, because a program in a sandbox sees
 * the sandbox's maximum (all processors, the whole RAM) rather than what it may use. Never stops a session.
 */
function writeBudget(cpus: number, memoryGb: number, jobs: number, env: NodeJS.ProcessEnv): void {
  try {
    writeJsonAtomic(run.budgetFile, {
      processors: cpus,
      memoryMb: Math.round(memoryGb * 1024),
      buildJobs: buildJobs(cpus, memoryGb),
      cargoJobsPerSession: jobs,
      linkSlots: Number(env.AGENT_LINK_SLOTS) || linkSlotsFor(memoryGb),
      cpuLimitPercent: session.cpuLimitPercent ?? null,
      governor: run.pressureFile,
      note: 'Plan builds with these numbers. When memory runs short the sandbox slows builds down in steps (governor); nothing fails.',
    });
  } catch (e) {
    warn('budget.json could not be written: ' + errMsg(e));
  }
}

/** What a session's ptyhost runs: the command line, the one a restart runs, and the program's own variables. */
interface Program {
  command: string;
  restartCommand: string;
  environment: Record<string, string>;
}

/** The agent, installed if it is not yet; its environment may hold its API keys. */
const agentProgram = async (
  req: SessionRequest,
  env: NodeJS.ProcessEnv,
  say: (m: string) => void,
): Promise<Program> => {
  const harness = harnessFor(req);
  // Never refresh here: main already did, and replacing a running agent's executable would fail.
  say('Preparing ' + req.harness);
  await agents.provision(req.harness, harness, env, false);
  const launch = agents.resolveLaunch(req.harness, harness);
  const base = [...launch.args, ...harness.arguments];
  return {
    command: commandLine(launch.file, [...base, ...req.args]),
    restartCommand: commandLine(launch.file, [...base, ...(harness.resumeArguments ?? [])]),
    environment: harness.environment,
  };
};

/** Where the shells are: PowerShell 7 from the toolchains (or an installed copy), Windows' own PowerShell and cmd. */
function shellPaths(): { pwsh: string | null; powershell: string; cmd: string } {
  const candidates = [
    path.join(pwshDir(), 'pwsh.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
  ];
  return { pwsh: candidates.find((f) => fs.existsSync(f)) ?? null, powershell: SYSTEM.powershell(), cmd: SYSTEM.cmd() };
}

/** A plain shell: no install, no arguments of the request, nothing of the agent's environment. */
const shellProgram = (shell: ShellLaunch): Program => {
  const line = commandLine(shell.file, shell.args);
  return { command: line, restartCommand: line, environment: {} };
};

/** Starts ptyhost for the program and waits until it listens; a failure carries the tail of ptyhost's own log. */
const launchPtyHost = async (
  req: SessionRequest,
  program: Program,
  remote: boolean,
  env: NodeJS.ProcessEnv,
  sessions: number,
  onSpawn: (child: ChildProcess) => void,
): Promise<{ child: ChildProcess; port: number; token: string }> => {
  const port = await freePort();
  const token = crypto.randomBytes(24).toString('base64url');
  const sessionEnv: NodeJS.ProcessEnv = {
    ...withRegistryPath(env),
    ...program.environment,
    ...memoryEnv(env, sessions),
  };
  // Each PowerShell builds its own module path; one inherited from another PowerShell breaks its modules.
  if (req.shell) delete sessionEnv.PSModulePath;
  const child = startPtyHost({
    exe: ensurePtyHost(),
    port,
    token,
    cols: 120,
    rows: 32,
    id: req.id,
    cwd: req.cwd,
    env: sessionEnv,
    remote,
    command: program.command,
    restartCommand: program.restartCommand,
  });
  onSpawn(child);
  try {
    await waitForPtyHost(child, port, 15000);
  } catch (e) {
    const tail = ptyHostLogTail(req.id);
    throw new Error(
      errMsg(e) +
        (tail ? '. From its log:\n' + tail : '') +
        '\nLog: ' +
        path.join(dataDir, 'logs', 'ptyhost-' + req.id + '.log'),
    );
  }
  return { child, port, token };
};

/** The launch folder's project, or the registered project this session is for (provisioned first if needed). */
const placeFor = async (req: SessionRequest, say: (m: string) => void): Promise<Place> => {
  if (!req.project) {
    // A project set up earlier (the web UI and sandbox shell name it by its folder only): its own environment.
    const known = insidePrimary(req.cwd) ? null : provisioner.provisionedFor(req.cwd);
    if (known && exists(req.cwd))
      return {
        env: known.env,
        hooks: known.spec.hooks ? projectHooks(known.spec.name, known.spec.workspace) : null,
        project: known.spec.name,
      };
    if (!insidePrimary(req.cwd) && insideWorkspace(req.cwd))
      throw new Error(
        'The project in ' + req.cwd + ' is not set up in the sandbox yet: run sandbox start in its folder first.',
      );
    if (!insidePrimary(req.cwd) || !exists(req.cwd))
      throw new Error('Folder is not inside the sandbox workspace ' + workspace + ': ' + req.cwd);
    return { env: process.env, hooks: null, project: primaryProject() };
  }
  if (!isWithin(req.project.workspace, req.cwd))
    throw new Error(
      'Folder ' + req.cwd + ' is not inside project ' + req.project.name + ' (' + req.project.workspace + ').',
    );
  const ready = await provisioner.provision(req.project, say);
  if (!exists(req.cwd)) throw new Error('Folder does not exist in the sandbox: ' + req.cwd);
  return {
    env: ready.env,
    hooks: req.project.hooks ? projectHooks(req.project.name, req.project.workspace) : null,
    project: req.project.name,
  };
};

/** How often a running Claude session is checked for its conversation, and for how long. */
const CONVERSATION_CHECK_MS = 30 * 1000;
const CONVERSATION_CHECKS = 120;

/** The conversation a reopened Claude session starts in (--resume <id> among its arguments), if it names one. */
const resumedConversation = (args: readonly string[]): string | undefined => {
  const at = args.indexOf('--resume');
  return at >= 0 && isConversationId(args[at + 1] ?? '') ? args[at + 1] : undefined;
};

/** The agent sessions of this sandbox: the running ones, the ones starting, and what happens when one ends. */
export class SessionManager {
  private readonly live = new Map<string, { status: SessionStatus; child: ChildProcess }>();
  /** Sessions and projects being set up right now (a headless sandbox must not shut down under them). */
  private starting = 0;
  private readonly idle = new IdleShutdown(() => this.live.size > 0 || this.starting > 0);
  /** Each session's ptyhost (process id and when it ran), for linking the programs it starts to it (audit). */
  private readonly ptyHosts = new Map<string, SessionRoot>();

  /** How many sessions are running. */
  get count(): number {
    return this.live.size;
  }

  /** The sessions' ptyhosts, running or ended within ROOTS_KEPT_MS (audit events arrive after they happen). */
  roots(): SessionRoot[] {
    const cutoff = Date.now() - ROOTS_KEPT_MS;
    for (const [id, r] of this.ptyHosts) if (r.to !== undefined && r.to < cutoff) this.ptyHosts.delete(id);
    return [...this.ptyHosts.values()];
  }

  private rootStarted(id: string, child: ChildProcess, from: number): void {
    if (child.pid) this.ptyHosts.set(id, { session: id, pid: child.pid, from });
    child.once('exit', () => this.rootEnded(id));
  }

  private rootEnded(id: string): void {
    const r = this.ptyHosts.get(id);
    if (r && r.to === undefined) this.ptyHosts.set(id, { ...r, to: Date.now() });
  }

  /**
   * `session` requests: an agent (or a plain shell) in its own ptyhost, in the launch folder's project or a registered
   * one.
   */
  async start(req: SessionRequest): Promise<void> {
    let shell: ShellLaunch | null = null;
    let problem: string | null = null;
    if (req.shell)
      try {
        shell = shellLaunch(req.shell, shellPaths());
      } catch (e) {
        problem = errMsg(e);
      }
    // A shell is listed by its own name (pwsh, powershell, cmd).
    const name = shell?.name ?? (req.shell ? 'shell' : req.harness);
    let status: SessionStatus = {
      id: req.id,
      launchId: session.launchId,
      harness: name,
      ...(req.shell ? { kind: 'shell' as const } : {}),
      cwd: req.cwd,
      ...(req.project ? { project: req.project.name } : {}),
      phase: 'starting',
      message: 'Starting ' + name,
      updatedAt: now(),
      startedAt: now(),
    };
    saveStatus(status);
    // Progress goes into the session's status: the host prints it while it waits, and the tab inside shows it.
    const say = (message: string): void => {
      status = { ...status, message };
      saveStatus(status);
    };
    this.starting++;
    // Sessions after the first get their own tab right away (it shows the setup progress until the agent starts).
    if (req.id !== session.launchId && process.env.AGENT_NO_TABS !== '1')
      safely('terminal tab', () => terminalTab(req.id, name + ' ' + path.basename(req.cwd), req.cwd));
    try {
      if (problem) throw new Error(problem);
      const place = await placeFor(req, say);
      const program = shell ? shellProgram(shell) : await agentProgram(req, place.env, say);
      const remote = session.networking && session.attach.enabled;
      const from = Date.now();
      const { child, port, token } = await launchPtyHost(req, program, remote, place.env, this.live.size + 1, (c) =>
        this.rootStarted(req.id, c, from),
      );
      const agent = shell === null;
      const resumed = agent && req.harness === 'claude' ? resumedConversation(req.args) : undefined;
      const running: SessionStatus = {
        ...status,
        ...(resumed ? { conversation: resumed } : {}),
        project: place.project,
        phase: 'running',
        message: name + ' is running',
        attach: { addresses: remote ? guestAddresses() : [], port, token },
      };
      this.live.set(req.id, { status: running, child });
      child.once('exit', (code: number | null) => this.onExit(running, place, code));
      saveStatus(running);
      if (agent && req.harness === 'claude') this.trackConversation(running.id, resumed);
      log(
        'Session ' +
          req.id +
          ' started (' +
          name +
          ' in ' +
          req.cwd +
          ', project ' +
          place.project +
          ', port ' +
          port +
          ')',
      );
    } catch (e) {
      this.rootEnded(req.id);
      saveStatus({ ...status, phase: 'failed', message: errMsg(e) });
      warn('Session ' + req.id + ' failed: ' + errMsg(e));
      this.idle.check();
    } finally {
      this.starting--;
    }
  }

  /**
   * `project` requests: provision a registered project without an agent (sandbox start / exec / db from its folder).
   */
  async prepare(req: Extract<GuestRequest, { kind: 'project' }>): Promise<void> {
    this.starting++;
    try {
      const ready = await provisioner.provision(req.project, () => undefined);
      respond(req.id, {
        ok: true,
        message:
          'Project ' + req.project.name + ' is ready in ' + req.project.workspace + '\n' + ready.summary.join('\n'),
      });
    } catch (e) {
      respond(req.id, { ok: false, message: 'Project ' + req.project.name + ' could not be set up: ' + errMsg(e) });
    } finally {
      this.starting--;
      this.idle.check();
    }
  }

  /**
   * `restart` requests: the matching sessions restart their agent (continuing the conversation where it can). Shells
   * are left alone: restarting one would only throw away what it was doing.
   */
  async restart(req: Extract<GuestRequest, { kind: 'restart' }>): Promise<void> {
    const targets = [...this.live.values()].filter(
      (s) =>
        s.status.attach &&
        s.status.kind !== 'shell' &&
        (req.harness === null || s.status.harness === req.harness) &&
        (!req.cwd || isWithin(req.cwd, s.status.cwd)),
    );
    for (const s of targets)
      await sendControl(
        { addresses: ['127.0.0.1'], port: s.status.attach!.port, token: s.status.attach!.token },
        FrameType.Restart,
      );
    respond(req.id, { ok: true, message: 'restarted ' + targets.length + ' session(s)' });
  }

  /**
   * `close` requests: the session's ptyhost ends its program and everything it started (ProcessTree), then exits as
   * if the program had. One that does not end in time has its ptyhost ended instead (closing the pseudo console ends
   * what is attached to it).
   */
  async close(req: Extract<GuestRequest, { kind: 'close' }>): Promise<void> {
    const entry = this.live.get(req.session);
    if (!entry?.status.attach) {
      respond(req.id, { ok: false, message: 'Session ' + req.session + ' is not running.' });
      return;
    }
    const { child, status } = entry;
    const ended = new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
      const timer = setTimeout(() => resolve(false), CLOSE_WAIT_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    try {
      await sendControl(
        { addresses: ['127.0.0.1'], port: status.attach!.port, token: status.attach!.token },
        FrameType.Close,
      );
    } catch (e) {
      warn('Session ' + req.session + ' did not take the close request: ' + errMsg(e));
    }
    if (!(await ended)) {
      warn('Session ' + req.session + ' did not end in time; ending its session host.');
      safely('ending a session host', () => child.kill());
    }
    log('Session ' + req.session + ' closed on request');
    respond(req.id, { ok: true, message: 'Closed ' + status.harness + ' session ' + req.session + '.' });
  }

  /**
   * Finds out which of Claude's conversation files this session writes (it appears with the first message) and puts
   * it in the status, so the host can reopen this very conversation. A reopened session starts with the one it was
   * given and changes to a new file if Claude forks one.
   */
  private trackConversation(id: string, given: string | undefined): void {
    let checks = 0;
    const timer = setInterval(() => {
      const entry = this.live.get(id);
      if (!entry || ++checks > CONVERSATION_CHECKS) {
        clearInterval(timer);
        return;
      }
      const claimed = new Set(
        [...this.live.values()].flatMap((s) => (s.status.conversation ? [s.status.conversation] : [])),
      );
      if (given) claimed.add(given);
      let found: string | null = null;
      try {
        found = findConversation(claudeDir, entry.status.cwd, Date.parse(entry.status.startedAt), claimed);
      } catch (e) {
        warn('Looking for the conversation of session ' + id + ' failed: ' + errMsg(e));
      }
      if (!found) return;
      clearInterval(timer);
      entry.status = { ...entry.status, conversation: found, updatedAt: now() };
      saveStatus(entry.status);
    }, CONVERSATION_CHECK_MS);
    timer.unref();
  }

  private onExit(started: SessionStatus, place: Place, code: number | null): void {
    // The status as it is now (it may have learned its conversation since it started).
    const running = this.live.get(started.id)?.status ?? started;
    this.live.delete(running.id);
    const tail = code === 0 ? '' : ptyHostLogTail(running.id, 6);
    saveStatus({
      ...running,
      phase: 'exited',
      message: running.harness + ' exited with code ' + code + (tail ? '. Last output:\n' + tail : ''),
      exitCode: code ?? 1,
      attach: undefined,
    });
    log('Session ' + running.id + ' ended (exit ' + code + ')');
    // A shell ran no agent: no post-agent hooks, nothing of an agent's to save.
    if (running.kind === 'shell') {
      this.idle.check();
      return;
    }
    if (place.hooks)
      void runHooksAsync('post-agent', place.env, place.hooks).catch((e: unknown) =>
        warn('post-agent hooks failed: ' + errMsg(e)),
      );
    else safely('post-agent hooks', () => runHooks('post-agent', process.env));
    safely('claude-mem save', saveClaudeMem);
    safely('agent databases save', saveLocalState);
    this.idle.check();
  }
}

/** The daemon's one session manager. */
export const sessions = new SessionManager();
