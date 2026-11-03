// The heartbeat: every 10 seconds the daemon writes run\heartbeat.json (memory, the governor's dial, the biggest
// programs). When the whole sandbox vanishes, the host reads the last one to say what it was doing.
import os from 'node:os';
import { writeJsonAtomic } from '../../shared/io/json.js';
import type { Heartbeat } from '../../shared/channel/schema.js';
import { now } from '../../shared/channel/run-dir.js';
import { governor, type GovernorSnapshot } from '../governor/index.js';
import { run } from '../runtime/paths.js';
import { warn } from '../runtime/log.js';
import { errMsg } from '../../core/util/errors.js';

const BEAT_MS = 10000;

const clamp = (n: number, low: number, high: number): number => Math.max(low, Math.min(high, n));

/** The heartbeat for these numbers (the governor's snapshot when it has one, else Windows' own free memory). */
export function buildHeartbeat(
  snapshot: GovernorSnapshot | null,
  sessionCount: number,
  uptimeSeconds: number,
  freeBytes: number,
  totalBytes: number,
  at: string,
  ending = false,
): Heartbeat {
  const ramFree = snapshot?.ramFreePercent ?? Math.round((freeBytes / Math.max(1, totalBytes)) * 100);
  return {
    at,
    uptimeS: Math.max(0, Math.round(uptimeSeconds)),
    ramFreePct: clamp(ramFree, 0, 100),
    commitPct: clamp(snapshot?.commitPercent ?? 0, 0, 100),
    step: clamp(snapshot?.step ?? 0, 0, 4),
    hostStep: clamp(snapshot?.hostStep ?? 0, 0, 4),
    topProcesses: (snapshot?.top ?? []).slice(0, 5).map((p) => ({ name: p.name.slice(0, 64), privateMb: p.mb })),
    ...(snapshot?.diskQueue !== null && snapshot?.diskQueue !== undefined
      ? { diskQueueReported: snapshot.diskQueue }
      : {}),
    phase: ending ? 'ending' : sessionCount > 0 ? 'working' : 'ready',
  };
}

/** How many sessions run (set by startHeartbeat; this file must not import the sessions, which end through it). */
let countSessions: () => number = () => 0;

function writeBeat(ending: boolean): void {
  try {
    writeJsonAtomic(
      run.heartbeatFile,
      buildHeartbeat(governor.snapshot(), countSessions(), os.uptime(), os.freemem(), os.totalmem(), now(), ending),
    );
  } catch (e) {
    warn('heartbeat: ' + errMsg(e));
  }
}

/**
 * The last heartbeat of an orderly end (idle shutdown, `sandbox stop`, Windows shutting down): the host then knows the
 * sandbox was not lost. A sandbox that just vanishes leaves a busy heartbeat instead.
 */
export function markEnding(): void {
  writeBeat(true);
}

/** Writes the heartbeat now and every 10 seconds; a failed write is only a warning. */
export function startHeartbeat(sessionCount: () => number): void {
  countSessions = sessionCount;
  writeBeat(false);
  const timer = setInterval(() => writeBeat(false), BEAT_MS);
  timer.unref();
  // Windows shutting down or the console closing: say so, then end (the default for these signals).
  for (const signal of ['SIGHUP', 'SIGBREAK', 'SIGTERM'] as const)
    process.on(signal, () => {
      clearInterval(timer);
      markEnding();
      process.exit(0);
    });
}
