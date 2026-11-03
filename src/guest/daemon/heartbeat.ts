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
import { sessions } from './sessions.js';

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
    ...(snapshot?.diskQueue !== undefined && snapshot.diskQueue !== null
      ? { diskQueueReported: snapshot.diskQueue }
      : {}),
    phase: sessionCount > 0 ? 'working' : 'ready',
  };
}

/** Writes the heartbeat now and every 10 seconds; a failed write is only a warning. */
export function startHeartbeat(): void {
  const beat = (): void => {
    try {
      writeJsonAtomic(
        run.heartbeatFile,
        buildHeartbeat(governor.snapshot(), sessions.count, os.uptime(), os.freemem(), os.totalmem(), now()),
      );
    } catch (e) {
      warn('heartbeat: ' + errMsg(e));
    }
  };
  beat();
  setInterval(beat, BEAT_MS).unref();
}
