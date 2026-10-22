// A sandbox that is already running: wait for it, open sessions in it, attach this terminal to one.
import _ from 'lodash';
import { attachTerminal, findUnwatchedSession, SandboxChannel } from '../../../host/channel/index.js';
import { insideSandbox, hideSandboxWindow, showSandboxWindow } from '../../../host/sandbox/index.js';
import { NeedsRestart } from '../../../host/projects/index.js';
import { RunDir } from '../../../shared/channel/index.js';
import type { SandboxStatus, SessionStatus } from '../../../core/types.js';
import { errMsg, fail, sleep } from '../../../core/util/index.js';
import { c, follow, working, table, type Progressing } from '../../output/index.js';
import { AccountsService } from '../../services/index.js';
import { bootLine, readyIn, stillWorking } from './boot-progress.js';
import type { Context } from '../context.js';
import { hereDir, joinHere, readyHere, offerRestart, type Joined, type Relauncher } from '../projects/index.js';

/** How long a session may take to start (its project's setup, the agent's install). */
const SESSION_START_MS = 60 * 60 * 1000;

/** How openSession starts a session; restart.ts reopens sessions with reuse off and the agent's resume arguments. */
export interface OpenSessionOptions {
  readonly attach: boolean;
  readonly harness?: string;
  readonly args?: string[];
  readonly reuse?: boolean;
}

/** A session to open: an agent (the default one when not given), a folder, arguments of its own. */
interface Want {
  readonly harness?: string;
  readonly folder: string;
  readonly args?: string[];
}

/** A session requested in a folder that joined the running sandbox. */
interface JoinedSession {
  readonly ctx: Context;
  readonly joined: Joined;
}

/**
 * Attaches this terminal; with attach.autoHide the sandbox window hides meanwhile (best effort, never fails the
 * attach).
 */
export function attachHere(ctx: Context, session: Parameters<typeof attachTerminal>[0]): Promise<number> {
  if (ctx.loaded.config.attach.autoHide && !insideSandbox())
    void hideSandboxWindow(ctx.storageRoot, 120).catch(() => false);
  // A copy in the agent reaches this PC's clipboard only when sandbox.clipboard already shares it with the sandbox.
  return attachTerminal(session, {
    clipboardWrites: ctx.loaded.config.sandbox.clipboard,
    confirmCtrlC: ctx.loaded.config.attach.confirmCtrlC,
  });
}

/** The sandbox writes sandbox.json a few seconds into its boot; a second launch right after the first waits for it. */
export async function runningSandboxStatus(dataPath: string): Promise<SandboxStatus> {
  const run = new RunDir(dataPath);
  for (let i = 0; i < 60; i++) {
    const status = run.readSandboxStatus();
    if (status) return status;
    await sleep(1000);
  }
  return fail(
    'A Windows Sandbox is running that this tool did not start (or that uses another storage.dataName).',
    'Close that sandbox window first, then run sandbox claude again.',
  );
}

/**
 * Waits for the boot with its current step and what it sets up on one line (plain lines without a terminal).
 * timed: say how long it took (a first start, where that is worth knowing).
 */
export async function waitForBoot(dataPath: string, launchId: string | null, timed = false): Promise<SandboxStatus> {
  let status: SandboxStatus | null = null;
  const start = Date.now();
  const ready = await follow(
    () => bootLine(status),
    () =>
      new SandboxChannel(dataPath).waitForReady(
        launchId,
        () => undefined,
        (s) => {
          if (s.phase !== 'failed') status = s;
        },
      ),
    { stall: stillWorking },
  );
  if (timed) console.log(readyIn(Date.now() - start));
  return ready;
}

/** The running sandbox, once it is ready. */
export async function readySandbox(dataPath: string): Promise<SandboxStatus> {
  const status = await runningSandboxStatus(dataPath);
  return status.phase === 'ready' ? status : waitForBoot(dataPath, status.launchId);
}

/** Waits for a session to start (its project's setup, the agent's install) with its progress on a spinner. */
export function waitForStart(ctx: Context, requestId: string, what: string): Promise<SessionStatus> {
  let step = 'starting';
  const shown = (): Progressing => ({ line: what + ': ' + step, key: step, what: step });
  return follow(
    shown,
    () =>
      new SandboxChannel(ctx.dataPath).waitForSession(requestId, SESSION_START_MS, (m) => {
        step = m;
      }),
    { stall: stillWorking },
  );
}

/** Asks the sandbox for a session; the agent's definition goes along (the sandbox may have booted with another). */
function requestSession(
  ctx: Context,
  channel: SandboxChannel,
  harness: string,
  args: string[],
  joined: Joined,
): string {
  const harnessSpec = ctx.loaded.config.harnesses[harness];
  // --account into a running sandbox switches its login first (sessions already running switch on their restart).
  if (ctx.options.account && !ctx.borrowed) new AccountsService(ctx).ensure(harness, ctx.options.account);
  return channel.requestSession(harness, args, joined.guestDir, {
    ...(joined.spec ? { project: joined.spec } : {}),
    ...(harnessSpec ? { harnessSpec } : {}),
  });
}

/**
 * Starts (or picks back up) a session in the folder `joined` describes. attach: show it in this terminal.
 * Exported for restart.ts, which reopens the sessions a restart ended.
 */
export async function openSession(
  ctx: Context,
  ready: SandboxStatus,
  joined: Joined,
  o: OpenSessionOptions,
): Promise<number> {
  const { options, loaded, dataPath } = ctx;
  const cwd = joined.guestDir;
  const harness = o.harness ?? options.harness ?? joined.harness ?? loaded.config.defaultHarness;
  const args = o.args ?? options.passthrough;
  // -t with nothing new for the agent: pick up this folder's session if no terminal on this PC shows it (its tab was
  // closed, or you detached). Someone already attached, --new, or agent arguments: a new session, as before.
  const reuse =
    (o.reuse ?? true) && o.attach && !options.newSession && args.length === 0 && loaded.config.attach.reuseSession;
  const existing = reuse ? await findUnwatchedSession(dataPath, harness, cwd) : null;
  if (existing) {
    console.log(
      'Reattaching to ' +
        harness +
        ' session ' +
        existing.id +
        ' in ' +
        cwd +
        ' (no other terminal is attached; --new starts another).',
    );
    return attachHere(ctx, existing);
  }
  console.log(
    joined.spec
      ? 'Starting ' +
          harness +
          ' for ' +
          joined.project?.host +
          ' in the running sandbox (' +
          cwd +
          '; the first time sets up what it needs).'
      : 'Sandbox already running: starting another ' + harness + ' session in ' + cwd,
  );
  const requestId = requestSession(ctx, new SandboxChannel(dataPath), harness, args, joined);
  const session = await waitForStart(ctx, requestId, 'Starting ' + harness + ' in ' + cwd);
  if (o.attach) return attachHere(ctx, session);
  console.log(
    'Session ' +
      session.id +
      ' opened in a new tab inside the sandbox. Attach here with: sandbox attach ' +
      session.id +
      (ready.headless ? '   (headless: sbx-show opens the window)' : ''),
  );
  return 0;
}

/** The sessions a launch asks for: each --session, else one (the agent, in this folder). */
function wantedSessions(ctx: Context): Want[] {
  return ctx.options.sessions.length ? ctx.options.sessions : [{ harness: ctx.options.harness, folder: hereDir(ctx) }];
}

/** The same command, for one of its sessions (its folder, agent, and the arguments after -- plus its own). */
export function contextFor(ctx: Context, want: Want): Context {
  return {
    ...ctx,
    options: {
      ...ctx.options,
      workspace: want.folder,
      harness: want.harness,
      sessions: [],
      passthrough: [...ctx.options.passthrough, ...(want.args ?? [])],
    },
  };
}

/**
 * Several sessions at once: all requested together (projects set up in parallel), then listed; -t attaches the first.
 */
async function openSessions(ctx: Context, ready: SandboxStatus, list: readonly JoinedSession[]): Promise<number> {
  const { loaded, options } = ctx;
  const channel = new SandboxChannel(ctx.dataPath);
  const requests = list.map(({ ctx: at, joined }) => {
    const harness = at.options.harness ?? joined.harness ?? loaded.config.defaultHarness;
    const id = requestSession(ctx, channel, harness, at.options.passthrough, joined);
    return { id, harness, folder: at.options.workspace ?? joined.guestDir, cwd: joined.guestDir };
  });
  let started = 0;
  const results = await working(
    () => 'Starting ' + requests.length + ' sessions (' + started + ' running)',
    () =>
      Promise.allSettled(
        requests.map(async (r) => {
          const s = await channel.waitForSession(r.id, SESSION_START_MS, () => undefined);
          started++;
          return s;
        }),
      ),
  );
  table([
    ['SESSION', 'AGENT', 'FOLDER', ''],
    ...requests.map((r, i) => {
      const result = results[i];
      return [
        r.id,
        r.harness,
        r.folder,
        result.status === 'fulfilled' ? 'running   sandbox attach ' + r.id : c.red('FAILED: ' + errMsg(result.reason)),
      ];
    }),
  ]);
  const first = results.find((r): r is PromiseFulfilledResult<SessionStatus> => r.status === 'fulfilled');
  if (options.terminal && first) return attachHere(ctx, first.value);
  if (!first) return 1;
  console.log(
    'Each has its own tab inside the sandbox' +
      (ready.headless ? ' (headless: sbx-show opens the window)' : '') +
      '. Attach to any of them, from any terminal: sandbox attach',
  );
  return results.every((r) => r.status === 'fulfilled') ? 0 : 1;
}

/** A sandbox is already running: open the sessions in it (new tabs inside; optionally attach here). */
export async function launchIntoRunning(ctx: Context, relauncher: Relauncher): Promise<number> {
  const ready = await readySandbox(ctx.dataPath);
  // Every folder joins first: when one needs a restart, nothing has been started that the restart would end.
  const joined: JoinedSession[] = [];
  const needs: NeedsRestart[] = [];
  for (const want of wantedSessions(ctx)) {
    const at = ctx.options.sessions.length ? contextFor(ctx, want) : ctx;
    try {
      joined.push({ ctx: at, joined: await joinHere(at, ready) });
    } catch (e) {
      if (!(e instanceof NeedsRestart)) throw e;
      if (!needs.some((n) => n.hostDir.toLowerCase() === e.hostDir.toLowerCase())) needs.push(e);
    }
  }
  if (needs.length) return offerRestart(ctx, needs, () => launchIntoRunning(ctx, relauncher), relauncher);
  for (const note of _.uniq(joined.flatMap((j) => j.joined.notes))) console.log(note);
  if (joined.length === 1) return openSession(joined[0].ctx, ready, joined[0].joined, { attach: ctx.options.terminal });
  return openSessions(ctx, ready, joined);
}

/** `sandbox start` while one runs: this folder joins it (set up, no agent), or a restart that adds it is offered. */
export async function startIntoRunning(ctx: Context, relauncher: Relauncher): Promise<number> {
  const ready = await readySandbox(ctx.dataPath);
  let joined: Joined;
  try {
    joined = await readyHere(ctx, ready);
  } catch (e) {
    if (e instanceof NeedsRestart) return offerRestart(ctx, [e], () => startIntoRunning(ctx, relauncher), relauncher);
    throw e;
  }
  const where = joined.spec
    ? ' This folder is ready in it as ' +
      joined.guestDir +
      ' (sbx-shell ' +
      joined.spec.name +
      ' opens a terminal there inside).'
    : '';
  console.log(
    'A sandbox is already running' +
      (showSandboxWindow(ctx.storageRoot) ? '; its window is in front now.' : '.') +
      where +
      ' Start an agent in it with sandbox claude (or sandbox <agent>); stop it with sandbox stop.',
  );
  return 0;
}
