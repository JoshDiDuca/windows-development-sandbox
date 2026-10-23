// Starts one ptyhost (the ConPTY bridge, sandbox/csharp/PtyHost.cs) per agent session and waits for it to listen.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { ensureCompiled } from '../runtime/csc.js';
import { portOpen } from '../runtime/ports.js';
import { logsDir, run, toolsDir } from '../runtime/paths.js';
import { session } from '../runtime/session.js';

export function ensurePtyHost(): string {
  return ensureCompiled('ptyhost');
}

/** Resolves when ptyhost listens; rejects early if it exits first (e.g. the agent could not be started). */
export async function waitForPtyHost(child: ChildProcess, port: number, timeoutMs: number): Promise<void> {
  let exitCode: number | null | undefined;
  child.once('exit', (code) => {
    exitCode = code;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitCode !== undefined) throw new Error('the session host stopped right away (exit ' + exitCode + ')');
    if (await portOpen(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('the session host did not start listening on port ' + port);
}

export function ptyHostLog(id: string): string {
  return path.join(logsDir, 'ptyhost-' + id + '.log');
}

/** The last lines of a session's ptyhost log (the agent's final output is written there when it exits). */
export function ptyHostLogTail(id: string, lines = 12): string {
  try {
    return fs.readFileSync(ptyHostLog(id), 'utf8').trim().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

export interface PtyHostOptions {
  exe: string;
  port: number;
  token: string;
  cols: number;
  rows: number;
  command: string;
  restartCommand: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  id: string;
  remote: boolean;
}

/**
 * conpty.dll (+ OpenConsole.exe) the host downloaded, when provisioning.conpty is on; ptyhost falls back to Windows'
 * own.
 */
const conptyDll = (): string | null => {
  const dll = path.join(toolsDir, 'conpty', 'conpty.dll');
  return session.provisioning.conpty?.enabled !== false &&
    fs.existsSync(dll) &&
    fs.existsSync(path.join(toolsDir, 'conpty', 'OpenConsole.exe'))
    ? dll
    : null;
};

/** Starts ptyhost detached, so closing a terminal tab never kills the agent; only the agent exiting ends it. */
export function startPtyHost(o: PtyHostOptions): ChildProcess {
  fs.mkdirSync(run.treesDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...o.env,
    PTYHOST_BIND: o.remote ? 'any' : 'loopback',
    PTYHOST_TREE_FILE: run.treeFile(o.id),
  };
  delete env.PTYHOST_CONPTY;
  const dll = conptyDll();
  if (dll) env.PTYHOST_CONPTY = dll;
  return spawn(
    o.exe,
    [String(o.port), o.token, String(o.cols), String(o.rows), ptyHostLog(o.id), o.command, o.restartCommand],
    { cwd: o.cwd, env, detached: true, stdio: 'ignore', windowsHide: true },
  );
}

/** How long `ptyhost --end-tree` may take (a process snapshot and a few TerminateProcess calls). */
const END_TREE_MS = 30000;

/**
 * Ends what a session's ptyhost left running when it was itself ended (Task Manager, a crash): its program and what
 * that started, from the tree it recorded in run/trees (PTYHOST_TREE_FILE). ptyhost deletes the record when it ends the
 * tree itself, so a record left behind is the sign. `ptyhost --end-tree` checks every process by id and start time (a
 * reused id is never ended), spares the shared ones (databases, sccache ...) and does nothing while the ptyhost that
 * wrote it still runs. Resolves with what it did, or null when there was nothing to do.
 */
export function endLeftoverTree(id: string, exe: string = ensurePtyHost()): Promise<string | null> {
  const file = run.treeFile(id);
  if (!fs.existsSync(file)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(exe, ['--end-tree', file], { timeout: END_TREE_MS, windowsHide: true }, (error, stdout) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      // 3: the ptyhost that wrote it still runs (its session goes on): the record stays.
      if (code !== 3)
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* removed by the next sweep (or the host's reset at the next launch) */
        }
      resolve(code === 0 ? stdout.trim().slice(0, 200) : code === 3 ? null : 'could not end them (code ' + code + ')');
    });
  });
}

/** Session ids with a process tree recorded (running sessions, and any whose ptyhost was ended). */
export function recordedTrees(): string[] {
  try {
    return fs
      .readdirSync(run.treesDir)
      .filter((n) => /^[A-Za-z0-9_-]{1,64}\.json$/.test(n))
      .map((n) => n.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}
