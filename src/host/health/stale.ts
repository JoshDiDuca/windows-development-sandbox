// What a closed or crashed sandbox leaves behind, and how to tell it from what is in use: records of sandboxes that are
// gone, run files, old launch folders, background watchers with nothing to watch. These only look; the repair checks
// remove through the safe helpers. Everything takes its folders as arguments, so tests use temp folders.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { dirExists, isLink } from '../../core/util/index.js';
import { RunDir } from '../../shared/channel/index.js';
import type { ActiveSandbox, TaskRow } from '../sharing/index.js';

const DAY = 24 * 60 * 60 * 1000;
const SANDBOX_IMAGES = ['windowssandboxclient.exe', 'windowssandboxremotesession.exe', 'windowssandbox.exe'];
/** A watcher this old, with its log quiet and no sandbox, is left over (a finishing one is done within minutes). */
export const WATCHER_MIN_AGE_MS = 10 * 60 * 1000;
export const WATCHER_LOG_QUIET_MS = 5 * 60 * 1000;

/** Windows sessions that have a sandbox running (empty: none runs). */
export function sandboxSessions(rows: readonly TaskRow[]): number[] {
  const found = rows.filter((r) => SANDBOX_IMAGES.includes(r.image.toLowerCase()));
  return [...new Set(found.map((r) => r.session))];
}

/** Sharing records whose Windows session has no sandbox running (nothing else removes them after a crash). */
export function staleActiveRecords(records: readonly ActiveSandbox[], rows: readonly TaskRow[]): ActiveSandbox[] {
  const sessions = sandboxSessions(rows);
  return records.filter((r) => !sessions.includes(r.windowsSession));
}

export interface RunStateProblems {
  /** Sessions still marked running or starting. */
  readonly sessions: number;
  /** Requests nobody answered (valid or not). */
  readonly requests: number;
  /** The sandbox status file says the boot never finished (booting, provisioning, failed). */
  readonly unfinishedBoot: string | null;
  readonly any: boolean;
}

/** What is left in <data>\run by a sandbox that is no longer running. */
export function runStateProblems(dataPath: string): RunStateProblems {
  const run = new RunDir(dataPath);
  const sessions = run.listSessions().filter((s) => s.phase === 'running' || s.phase === 'starting').length;
  const found = run.scanRequests();
  const requests = found.valid.length + found.invalid.length;
  const phase = run.readSandboxStatus()?.phase;
  const unfinishedBoot = phase && phase !== 'ready' ? phase : null;
  return { sessions, requests, unfinishedBoot, any: sessions > 0 || requests > 0 || unfinishedBoot !== null };
}

export interface OldLaunch {
  readonly path: string;
  readonly ageDays: number;
}

/** Launch folders under <storage>\launches that nothing has touched for `days` days (each is a finished start). */
export function staleLaunchFolders(
  storageRoot: string,
  days: number,
  now: number,
  keep: readonly string[] = [],
): OldLaunch[] {
  const dir = path.join(storageRoot, 'launches');
  if (!dirExists(dir) || isLink(dir)) return [];
  const found: OldLaunch[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (keep.includes(name)) continue;
    const full = path.join(dir, name);
    try {
      const age = now - fs.lstatSync(full).mtimeMs;
      if (age > days * DAY) found.push({ path: full, ageDays: Math.floor(age / DAY) });
    } catch {
      // gone while we looked
    }
  }
  return found;
}

export interface WatcherInfo {
  readonly file: string;
  readonly pid: number | null;
  readonly ageMs: number;
  /** How long ago the watcher's log was written; null when there is none. */
  readonly logAgeMs: number | null;
}

const PidSchema = z.coerce.number().int().positive();

/** The history-sync watcher records in <storage>\run (watcher-<data set>.pid) with the age of each and of its log. */
export function watcherRecords(storageRoot: string, now: number): WatcherInfo[] {
  const dir = path.join(storageRoot, 'run');
  if (!dirExists(dir) || isLink(dir)) return [];
  const age = (p: string): number | null => {
    try {
      return now - fs.statSync(p).mtimeMs;
    } catch {
      return null;
    }
  };
  return fs
    .readdirSync(dir)
    .map((name) => ({ name, m: /^watcher-(.+)\.pid$/i.exec(name) }))
    .flatMap(({ name, m }) => {
      if (!m) return [];
      const file = path.join(dir, name);
      let pid: number | null = null;
      try {
        const parsed = PidSchema.safeParse(fs.readFileSync(file, 'utf8').trim());
        pid = parsed.success ? parsed.data : null;
      } catch {
        return [];
      }
      return [
        {
          file,
          pid,
          ageMs: age(file) ?? 0,
          logAgeMs: age(path.join(storageRoot, 'logs', 'host-sync-' + m[1] + '.log')),
        },
      ];
    });
}

/**
 * Watchers that run with no sandbox to watch: the process is alive and is a Node program (a recycled pid is somebody
 * else's), no sandbox runs, and neither its record nor its log has changed for a while (a finishing watcher is spared).
 */
export function orphanWatchers(
  infos: readonly WatcherInfo[],
  o: { running: boolean; alive: (pid: number) => boolean; image: (pid: number) => string | null },
): WatcherInfo[] {
  if (o.running) return [];
  return infos.filter(
    (w) =>
      w.pid !== null &&
      o.alive(w.pid) &&
      o.image(w.pid)?.toLowerCase() === 'node.exe' &&
      w.ageMs > WATCHER_MIN_AGE_MS &&
      (w.logAgeMs === null || w.logAgeMs > WATCHER_LOG_QUIET_MS),
  );
}

/** null when a small file can be created in the folder, else the reason (the file is removed again). */
export function writeProblem(dir: string): string | null {
  const probe = path.join(dir, '.write-test-' + process.pid);
  try {
    fs.writeFileSync(probe, '');
    return null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? String(e);
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

/** The Windows Sandbox programs of the user that a dead sandbox leaves behind (never the VM's own vmwp.exe). */
export const LEFTOVER_IMAGES = [
  'windowssandbox.exe',
  'windowssandboxclient.exe',
  'windowssandboxremotesession.exe',
  'windowssandboxserver.exe',
] as const;
/** A heartbeat this recent means the sandbox is alive (the sandbox writes one every 10 seconds). */
export const ALIVE_MS = 45 * 1000;
/** A heartbeat older than this, with the sandbox's programs still there, means the sandbox is gone. */
export const GONE_MS = 2 * 60 * 1000;
/** A sandbox started this recently may not have written a heartbeat yet (a first boot takes minutes). */
export const STARTING_MS = 10 * 60 * 1000;

/** What is known about the Windows Sandbox programs on this PC and our sandbox (read by the caller). */
export interface SandboxFacts {
  /** Every process of every session (tasklist). */
  readonly rows: readonly TaskRow[];
  /** The Windows session this program runs in; null when unknown (then nothing is ever ended). */
  readonly mySession: number | null;
  /** Age of our sandbox's last heartbeat from this run; null when there is none. */
  readonly heartbeatAgeMs: number | null;
  /** Our life record says the last sandbox ended (the watcher saw it go). */
  readonly lifeEnded: boolean;
  /** Age of our last launch; null when unknown. */
  readonly startedAgeMs: number | null;
  /** Did the sandbox answer a ping just now? null: not asked. */
  readonly answers: boolean | null;
}

export type SandboxState =
  /** No Windows Sandbox program runs. */
  | 'none'
  /** Ours, and alive (or not known to be gone). */
  | 'running'
  /** Ours, started a moment ago. */
  | 'starting'
  /** Programs of a sandbox that is gone: safe to end after asking. */
  | 'leftover'
  /** Another Windows session's sandbox: never touched. */
  | 'foreign';

export interface SandboxJudgement {
  readonly state: SandboxState;
  /** The programs of this user's session that cleaning up would end. */
  readonly pids: readonly number[];
  readonly images: readonly string[];
  /** Why, in plain words (for the question). */
  readonly why: string;
}

const isLeftoverImage = (image: string): boolean =>
  (LEFTOVER_IMAGES as readonly string[]).includes(image.toLowerCase());

/**
 * Is the Windows Sandbox on this PC ours and alive, ours and gone, or someone else's? (pure) It is "leftover" only
 * with positive evidence: our own programs in our own session, no answer, and either the watcher saw the sandbox end
 * or its heartbeat stopped long ago. No heartbeat at all (an older sandbox) counts as running.
 */
export function judgeSandbox(f: SandboxFacts): SandboxJudgement {
  const sandbox = f.rows.filter((r) => isLeftoverImage(r.image));
  const mine = f.mySession === null ? [] : sandbox.filter((r) => r.session === f.mySession);
  const none = (state: SandboxState, why: string): SandboxJudgement => ({ state, pids: [], images: [], why });
  if (sandbox.length === 0) return none('none', 'No Windows Sandbox program is running.');
  if (mine.length === 0) return none('foreign', 'The Windows Sandbox that runs belongs to another Windows session.');
  const pids = mine.map((r) => r.pid);
  const images = [...new Set(mine.map((r) => r.image))];
  const found = (state: SandboxState, why: string): SandboxJudgement => ({ state, pids, images, why });
  if (f.answers === true || (f.heartbeatAgeMs !== null && f.heartbeatAgeMs <= ALIVE_MS))
    return found('running', 'The sandbox is working.');
  if (f.startedAgeMs !== null && f.startedAgeMs <= STARTING_MS && !f.lifeEnded)
    return found('starting', 'The sandbox started a moment ago.');
  if (f.lifeEnded) return found('leftover', 'The last sandbox has ended, but its Windows programs are still there.');
  if (f.heartbeatAgeMs !== null && f.heartbeatAgeMs > GONE_MS)
    return found(
      'leftover',
      'The sandbox has not shown a sign of life for ' + Math.round(f.heartbeatAgeMs / 60000) + ' minutes.',
    );
  return found('running', 'A sandbox is running (there is no sign that it is gone).');
}
