// Helpers for the live suites: they run the real session daemon, ptyhost (ConPTY) and the compiled git shim on Windows.
//
// Timing rule: a live test never sleeps for a fixed time and never gives up early. It polls until the condition holds,
// with a generous deadline (a busy machine, a cold csc.exe or an antivirus scan can make any step 10x slower), and a
// failure prints what was seen (the viewer's screen, the daemon's log) so the cause is visible.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type net from 'node:net';
import type { GuestResponse, SessionStatus } from '../../core/types.js';
import { ensureDir, sleep } from '../../core/util/index.js';
import {
  connect,
  encodeFrame,
  FrameReader,
  FrameType,
  helloFrame,
  queryViewers,
  type Endpoint,
  type Viewers,
} from '../../shared/pty/index.js';
import { readJsonFile, writeJsonAtomic } from '../../shared/io/index.js';
import type { Fixtures } from './fixtures.js';
import type { Harness } from './harness.js';

const WINDIR = process.env.WINDIR ?? 'C:\\Windows';
export const CSC = path.join(WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
/** Live suites need Windows (ConPTY) and the .NET Framework compiler that ships with it. */
export function liveTestsAvailable(): boolean {
  return process.platform === 'win32' && fs.existsSync(CSC);
}

/** Deadlines, in ms. Generous on purpose: they only matter when something is really wrong. */
export const WAIT = { start: 120000, screen: 45000, response: 60000, viewers: 45000, exit: 45000 } as const;

export function tail(text: string, chars = 500): string {
  return (text.length > chars ? '...' + text.slice(-chars) : text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/** Connects, retrying until `ms`: a connection attempt can time out while the machine is busy. */
export async function connectPatiently(endpoint: Endpoint, ms = 60000): Promise<net.Socket> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await connect(endpoint, 10000);
    } catch (e) {
      if (Date.now() >= end) throw e;
      await sleep(250);
    }
  }
}

/** One connection to a session's ptyhost, collecting what the server sends. */
export interface Viewer {
  socket: net.Socket;
  /** Everything the agent has printed since this viewer connected. */
  output: () => string;
  /** The exit code frame, once the agent ended. */
  exitCode: () => number | null;
  /** The error frame ("access denied"), if the server sent one. */
  error: () => string;
  /** True once the server closed the connection. */
  closed: () => boolean;
  type: (text: string) => void;
  close: () => void;
}

/** Connects like a terminal tab would (`token` can be wrong on purpose) and says hello. */
export async function openViewer(
  attach: Endpoint,
  options: { token?: string; cols?: number; rows?: number } = {},
): Promise<Viewer> {
  const socket = await connectPatiently({ ...attach, addresses: ['127.0.0.1'] });
  const reader = new FrameReader();
  let output = '';
  let exitCode: number | null = null;
  let error = '';
  let closed = false;
  socket.on('data', (chunk: Buffer) => {
    for (const frame of reader.push(chunk)) {
      if (frame.type === FrameType.Output) output += frame.payload.toString();
      else if (frame.type === FrameType.Exit) exitCode = frame.payload.readInt32LE(0);
      else if (frame.type === FrameType.Error) error = frame.payload.toString();
    }
  });
  socket.on('error', () => undefined);
  socket.on('close', () => {
    closed = true;
  });
  socket.write(helloFrame(options.token ?? attach.token, options.cols ?? 100, options.rows ?? 30));
  return {
    socket,
    output: () => output,
    exitCode: () => exitCode,
    error: () => error,
    closed: () => closed,
    type: (text) => {
      socket.write(encodeFrame(FrameType.Input, Buffer.from(text + '\r')));
    },
    close: () => socket.destroy(),
  };
}

/** Polls until the viewer's screen shows `needle`. */
export function sees(t: Harness, viewer: Viewer, needle: string, ms: number = WAIT.screen): Promise<true | null> {
  return t.waitFor(() => viewer.output().includes(needle), ms);
}

/**
 * Polls the session's viewer count until `accept` is satisfied; null when it never was. A query that gets no answer is
 * retried.
 */
export function viewersWhen(
  t: Harness,
  attach: Endpoint,
  accept: (v: Viewers) => boolean,
  ms: number = WAIT.viewers,
): Promise<Viewers | null> {
  return t.waitFor(async () => {
    const v = await queryViewers({ ...attach, addresses: ['127.0.0.1'] }, 5000);
    return v && accept(v) ? v : null;
  }, ms);
}

export function copyCmdAsFakeAgent(dataPath: string): void {
  const agentDir = path.join(dataPath, 'tools', 'agents', 'claude');
  ensureDir(agentDir);
  fs.copyFileSync(path.join(WINDIR, 'System32', 'cmd.exe'), path.join(agentDir, 'claude.exe'));
}

/**
 * A real session daemon (guest runtime) working on a generated launch folder, driven through the run folder like the
 * host does.
 */
export interface LiveDaemon {
  run: string;
  child: ChildProcess;
  request: (body: Record<string, unknown>) => void;
  response: (id: string, ms?: number) => Promise<GuestResponse | null>;
  status: (id: string) => SessionStatus | null;
  /** Waits until a session has left "starting". */
  started: (id: string, ms?: number) => Promise<SessionStatus | null>;
  /** The daemon's stdout/stderr and its log files, for failure messages. */
  diagnostics: () => string;
  /** Ends the daemon. */
  stop: () => Promise<void>;
}

export function startDaemon(
  t: Harness,
  f: Fixtures,
  options: { launchPath: string; data: string; workspace: string; env?: Record<string, string> },
): LiveDaemon {
  const { launchPath, data } = options;
  const output = t.at(path.basename(data) + '-daemon.out');
  const fd = fs.openSync(output, 'w');
  const env = {
    ...process.env,
    AGENT_LAUNCH_DIR: launchPath,
    AGENT_DATA_DIR: data,
    AGENT_WORKSPACE: options.workspace,
    AGENT_LOCAL_DIR: f.at(path.basename(data) + '-local'),
    // The daemon's live-folder state: a temp folder, never C:\ProgramData of the machine running the test.
    AGENT_DAEMON_STATE_DIR: f.at(path.basename(data) + '-daemon-state'),
    AGENT_LOG_PREFIX: 'daemon',
    AGENT_NO_TABS: '1',
    ...options.env,
  };
  const child = spawn(process.execPath, [path.join(launchPath, 'runtime', 'daemon.js')], {
    env,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  const run = path.join(data, 'run');
  const status = (id: string): SessionStatus | null =>
    readJsonFile<SessionStatus>(path.join(run, 'sessions', id + '.json'));
  return {
    run,
    child,
    request: (body) =>
      writeJsonAtomic(path.join(run, 'requests', body.id + '.json'), { createdAt: new Date().toISOString(), ...body }),
    response: (id, ms = WAIT.response) =>
      t.waitFor(() => readJsonFile<GuestResponse>(path.join(run, 'responses', id + '.json')), ms),
    status,
    started: (id, ms = WAIT.start) =>
      t.waitFor(() => {
        const s = status(id);
        return s && s.phase !== 'starting' ? s : null;
      }, ms),
    diagnostics: () => {
      const logs = path.join(data, 'logs');
      const files = fs.existsSync(logs) ? fs.readdirSync(logs).filter((n) => n.startsWith('daemon')) : [];
      const logText = files.map((n) => fs.readFileSync(path.join(logs, n), 'utf8')).join('\n');
      return 'daemon output: ' + tail(fs.readFileSync(output, 'utf8'), 600) + '\ndaemon log: ' + tail(logText, 1200);
    },
    stop: async () => {
      if (!exited) child.kill();
      await t.waitFor(() => exited, 10000);
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    },
  };
}
