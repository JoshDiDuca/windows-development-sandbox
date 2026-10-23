// Host side of the sandbox channel: follow the boot and send requests (sessions, exec, restart, ping). Attaching a
// terminal to a session is in attach.ts. Everything read from the run folder is guest-written and treated as untrusted.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { GuestRequest, GuestResponse, Harness, SandboxStatus, SessionStatus } from '../../core/types.js';
import { assertNoLinks, fail, isLink, removeLink, safeText, sleep } from '../../core/util/index.js';
import { isWithin } from '../../shared/paths/index.js';
import type { ProjectSpec, ShellChoice } from '../../shared/channel/index.js';
import { now, RunDir } from '../../shared/channel/index.js';
import { safeRemove, writeJsonAtomic } from '../../shared/io/index.js';
import { isSandboxRunning } from '../sandbox/index.js';
import { withoutSecrets, writeSecrets } from '../secrets/index.js';
import { assertTestWritable, refuseInSelfTest } from '../test-guard.js';

const BOOT_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * The boot script writes its first status once Windows has booted the sandbox and logged on (a minute or two, longer on
 * a slow PC or the very first start); none after this long means it never got going.
 */
export const FIRST_STATUS_MS = 8 * 60 * 1000;

/** True when a boot is silent: no status of this launch yet, and the sandbox had its time to write one. */
export function bootSilent(elapsedMs: number, seenStatus: boolean, limitMs: number = FIRST_STATUS_MS): boolean {
  return !seenStatus && elapsedMs > limitMs;
}

/** Most sessions the host will ever contact for one listing: a sandbox can write as many session files as it likes. */
export const MAX_QUERIED_SESSIONS = 32;

/** Where progress lines go: printed by default; a spinner passes its own. Text from the sandbox, made safe first. */
export type Progress = (line: string) => void;
const printLine: Progress = (line) => console.log(line);

const newId = (): string => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

/** Sessions in this guest folder or below (one project's) first, each group newest first. */
export function sessionsFirstIn(sessions: SessionStatus[], guestDir: string | null): SessionStatus[] {
  const newest = [...sessions].reverse();
  if (!guestDir) return newest;
  return [...newest.filter((s) => isWithin(guestDir, s.cwd)), ...newest.filter((s) => !isWithin(guestDir, s.cwd))];
}

/** The channel to the sandbox of one data folder: requests go into its run folder, answers are polled from it. */
export class SandboxChannel {
  private readonly run: RunDir;

  constructor(
    private readonly dataPath: string,
    private readonly isAlive: () => boolean = isSandboxRunning,
  ) {
    this.run = new RunDir(dataPath);
  }

  private async until<T>(timeoutMs: number, poll: () => T | null | undefined, timeoutMessage: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (let round = 0; Date.now() < deadline; round++) {
      const value = poll();
      if (value !== null && value !== undefined) return value;
      if (round % 10 === 0 && !this.isAlive())
        fail(
          'Windows Sandbox closed (or is not running).',
          'Start it again with sandbox claude; sandbox logs shows what happened.',
        );
      await sleep(500);
    }
    fail(timeoutMessage, 'Check what the sandbox is doing with sandbox logs -f (or sbx-show to see its window).');
  }

  /** Deletes an answer once read; a planted link means the answer is read and nothing is deleted. */
  private dropResponse(requestId: string): void {
    try {
      assertNoLinks(this.dataPath, this.run.responsesDir);
      fs.rmSync(this.run.responseFile(requestId), { force: true });
    } catch {
      /* a planted link: the answer is read, nothing is deleted */
    }
  }

  /**
   * Waits until the sandbox finished provisioning, reporting each boot step (onStatus: every status read, validated).
   */
  waitForReady(
    launchId: string | null,
    progress: Progress = (m) => printLine('  [sandbox] ' + m),
    onStatus?: (status: SandboxStatus) => void,
  ): Promise<SandboxStatus> {
    let last = '';
    let seen = false;
    const started = Date.now();
    return this.until(
      BOOT_TIMEOUT_MS,
      () => {
        const status = this.run.readSandboxStatus();
        if (!status || (launchId !== null && status.launchId !== launchId)) {
          if (bootSilent(Date.now() - started, seen))
            fail(
              'The sandbox has not reported anything for ' + Math.round(FIRST_STATUS_MS / 60000) + ' minutes.',
              'It may still be starting, or it cannot reach its folders. Look at its window (sbx-show), the run folder ' +
                this.run.root +
                ' and the data folder ' +
                this.dataPath +
                ', and check that you can write to both. sandbox logs shows what happened.',
            );
          return null;
        }
        seen = true;
        onStatus?.(status);
        if (status.message !== last) {
          progress(safeText(status.message).slice(0, 300));
          last = status.message;
        }
        if (status.phase === 'failed')
          fail(
            'The sandbox failed to start: ' + status.message,
            'See sandbox logs for details; the sandbox window shows the error too (sbx-show if headless).',
          );
        return status.phase === 'ready' ? status : null;
      },
      'Timed out waiting for the sandbox to finish provisioning.',
    );
  }

  send(request: GuestRequest): void {
    assertTestWritable(this.dataPath);
    // Asking the sandbox to power off is the one request with an effect outside it, so the self-test never sends it.
    if (request.kind === 'exec' && /shutdown/i.test(request.command[0] ?? ''))
      refuseInSelfTest('shut down Windows Sandbox');
    assertNoLinks(this.dataPath, this.run.requestsDir);
    // Agent environment values (they may be API keys) never go into run: they travel in a one-shot file next to it.
    const { request: plain, secrets } = withoutSecrets(request);
    if (secrets) writeSecrets(this.dataPath, request.id, secrets);
    writeJsonAtomic(this.run.requestFile(request.id), plain);
  }

  waitForResponse(requestId: string, timeoutMs: number): Promise<GuestResponse> {
    return this.until(
      timeoutMs,
      () => {
        const response = this.run.readResponse(requestId);
        if (response) this.dropResponse(requestId);
        return response;
      },
      'The sandbox did not answer (its session daemon may have stopped).',
    );
  }

  /**
   * project: a project registered after boot (provisioned first). harnessSpec: the agent's definition, for an agent the
   * sandbox did not boot with.
   */
  requestSession(
    harness: string,
    args: string[],
    cwd: string,
    extra: { project?: ProjectSpec; harnessSpec?: Harness } = {},
  ): string {
    const requestId = newId();
    this.send({
      kind: 'session',
      id: requestId,
      harness,
      args,
      cwd,
      ...(extra.project ? { project: extra.project } : {}),
      ...(extra.harnessSpec ? { harnessSpec: extra.harnessSpec } : {}),
      createdAt: now(),
    });
    return requestId;
  }

  /**
   * Provisions a registered project without starting an agent and waits for it, printing its progress (the guest's
   * run\projects\<name>.json) as it goes. Throws when it failed.
   */
  async prepareProject(
    project: ProjectSpec,
    progress: Progress = (m) => printLine('  [' + project.name + '] ' + m),
  ): Promise<GuestResponse> {
    const requestId = newId();
    this.send({ kind: 'project', id: requestId, project, createdAt: now() });
    let last = '';
    const response = await this.until(
      60 * 60 * 1000,
      () => {
        const status = this.run.readProjectStatus(project.name);
        if (status && status.message !== last) {
          progress(safeText(status.message).slice(0, 300));
          last = status.message;
        }
        return this.run.readResponse(requestId);
      },
      'Timed out waiting for the project to be set up.',
    );
    this.dropResponse(requestId);
    if (!response.ok) fail(safeText(response.message), 'See sandbox logs for details.');
    return response;
  }

  waitForSession(
    sessionId: string,
    timeoutMs = 15 * 60 * 1000,
    progress: Progress = (m) => printLine('  [session] ' + m),
  ): Promise<SessionStatus> {
    let last = '';
    return this.until(
      timeoutMs,
      () => {
        const session = this.run.readSession(sessionId);
        if (!session) return null;
        if (session.message !== last) {
          progress(safeText(session.message).slice(0, 300));
          last = session.message;
        }
        if (session.phase === 'failed')
          fail('The agent session failed to start: ' + session.message, 'See sandbox logs for details.');
        if (session.phase === 'exited')
          fail(
            'The agent exited right away (code ' + session.exitCode + ').',
            'Check sandbox logs; a wrong agent argument is the usual cause.',
          );
        return session.phase === 'running' ? session : null;
      },
      'Timed out waiting for the session to start.',
    );
  }

  /** Runs a command inside the sandbox (in the workspace or a folder below it) and returns its output. */
  async exec(command: string[], cwd: string, timeoutSeconds: number): Promise<GuestResponse> {
    const requestId = newId();
    this.send({ kind: 'exec', id: requestId, command, cwd, timeoutSeconds, createdAt: now() });
    return this.waitForResponse(requestId, (timeoutSeconds + 30) * 1000);
  }

  /** Restarts running sessions in place (they resume via the harness's resumeArguments, e.g. claude --continue). */
  async restart(harness: string | null, cwd?: string): Promise<GuestResponse> {
    const requestId = newId();
    this.send({ kind: 'restart', id: requestId, harness, ...(cwd ? { cwd } : {}), createdAt: now() });
    return this.waitForResponse(requestId, 30000);
  }

  /** Asks for a plain shell session in a folder of the sandbox; returns the request id (waitForSession follows it). */
  requestShell(shell: ShellChoice, cwd: string): string {
    const requestId = newId();
    this.send({ kind: 'session', id: requestId, harness: 'shell', args: [], cwd, shell, createdAt: now() });
    return requestId;
  }

  /** Ends a running session (agent or shell) and everything it started; waits for the sandbox's answer. */
  async closeSession(sessionId: string): Promise<GuestResponse> {
    const requestId = newId();
    this.send({ kind: 'close', id: requestId, session: sessionId, createdAt: now() });
    return this.waitForResponse(requestId, 30000);
  }

  /** The PC is low on memory or CPU: the sandbox slows its builds down for `seconds`. Never waits for an answer. */
  pressure(reason: string, seconds: number, level: 'slow' | 'severe' = 'slow'): void {
    this.send({ kind: 'pressure', id: newId(), reason, seconds, level, createdAt: now() });
  }

  async ping(): Promise<GuestResponse> {
    const requestId = newId();
    this.send({ kind: 'ping', id: requestId, createdAt: now() });
    return this.waitForResponse(requestId, 15000);
  }

  runningSessions(): SessionStatus[] {
    return this.run.listSessions().filter((s: SessionStatus) => s.phase === 'running');
  }

  /** Running sessions of the sandbox that is running now (its launch id), newest last, capped. */
  currentSessions(): SessionStatus[] {
    const launchId = this.run.readSandboxStatus()?.launchId;
    return this.runningSessions()
      .filter((s) => s.launchId === launchId)
      .slice(-MAX_QUERIED_SESSIONS);
  }

  /**
   * The session with this id (or id prefix), else the most recently started running one: in `guestDir` (the project
   * you are in) when it has one, else any.
   */
  pickSession(sessionId?: string, guestDir: string | null = null): SessionStatus {
    const running = this.runningSessions();
    if (running.length === 0)
      fail(
        'No agent session is running in the sandbox.',
        'Start one with sandbox claude (it opens a new session in the running sandbox).',
      );
    if (!sessionId) return sessionsFirstIn(running, guestDir)[0];
    return (
      running.find((s: SessionStatus) => s.id === sessionId || s.id.startsWith(sessionId)) ??
      fail(
        'No running session "' + sessionId + '".',
        'Running sessions: ' + running.map((s) => s.id).join(', ') + ' (sandbox sessions lists them).',
      )
    );
  }

  /** Forgets status from a previous sandbox run so nothing stale is picked up. */
  reset(): void {
    const p = this.run;
    // A link (planted by a sandbox) is removed itself and never followed, including `run` itself.
    if (isLink(p.root)) {
      removeLink(p.root);
      return;
    }
    for (const target of [p.sandboxFile, p.requestsDir, p.responsesDir, p.sessionsDir, p.projectsDir, p.treesDir]) {
      safeRemove(target, this.dataPath);
    }
  }
}
