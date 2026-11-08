// What the sandbox did in its last seconds and how it ended, for the status page and the crash report. The sandbox's
// daemon writes run\heartbeat.json every 10 seconds; when the sandbox vanishes, the last one is the best evidence.
// The guest wrote it, so it is read through the schema, never through a link, and printed through safeText.
import { assertNoLinks, safeText } from '../../core/util/index.js';
import { RunDir, type Heartbeat, HeartbeatSchema } from '../../shared/channel/index.js';
import { readValid } from '../../shared/io/index.js';
import { hostDataRoot } from '../storage/index.js';
import type { Life } from './life-record.js';
import type { StopCause } from './stop-events.js';

/** How the last sandbox ended, when nobody closed it. */
export interface LastEnd {
  /** "ended unexpectedly 21:31: this PC's disks were overloaded (queue 40)". */
  readonly text: string;
  readonly at: string;
}

/** The sandbox's last heartbeat, or null (none written, damaged, or reached through a link). */
export function readHeartbeat(dataPath: string): Heartbeat | null {
  try {
    const root = hostDataRoot(dataPath);
    const file = new RunDir(root).heartbeatFile;
    assertNoLinks(root, file);
    return readValid(HeartbeatSchema, file);
  } catch {
    // A link or an unreadable folder: no evidence, never an error.
    return null;
  }
}

const clock = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
};

/** One line of what the sandbox was doing at its last heartbeat (pure; guest text goes through safeText). */
export function heartbeatLine(hb: Heartbeat): string {
  const top = hb.topProcesses.map((p) => safeText(p.name) + ' ' + p.privateMb + ' MB').join(', ');
  return (
    'last seen inside at ' +
    clock(hb.at) +
    ': up ' +
    Math.round(hb.uptimeS / 60) +
    ' min, ' +
    hb.ramFreePct +
    '% RAM free, ' +
    hb.commitPct +
    '% commit used, builds at step ' +
    hb.step +
    (hb.hostStep > 0 ? ' (this PC asked for step ' + hb.hostStep + ')' : '') +
    (hb.diskQueueReported !== undefined ? ', this PC disk queue ' + hb.diskQueueReported : '') +
    (hb.held ? ', ' + hb.held + ' builds held by the memory gate' : '') +
    (top ? '; biggest: ' + top : '')
  );
}

/** The likeliest reason, from the last heartbeat (pure). */
export function guessReason(hb: Heartbeat | null): string {
  if (hb && hb.diskQueueReported !== undefined && hb.hostStep > 0)
    return "this PC's disks were overloaded (queue " + hb.diskQueueReported + ')';
  if (hb && (hb.ramFreePct < 8 || hb.commitPct > 92)) return 'the sandbox was running out of memory';
  return 'Windows stopped it (no reason was logged)';
}

/** A heartbeat older than this before the end is not "it was working when it went". */
const FRESH_MS = 2 * 60 * 1000;

/**
 * The sandbox went and nothing was logged (pure): its last heartbeat is fresh, from this run, says it was working
 * (a session running, or builds slowed down) and does not say it was shutting down in order, and nobody stopped it on
 * purpose (`sandbox stop`, a restart). The guest cannot tell a closed window from a crash, so the wording says both.
 */
export function vanishedCause(
  hb: Heartbeat | null,
  startedIso: string,
  closedOnPurpose: boolean,
  endedAtMs: number,
): StopCause | null {
  if (!hb || closedOnPurpose || hb.phase === 'ending') return null;
  const seen = Date.parse(hb.at);
  if (!Number.isFinite(seen) || seen < Date.parse(startedIso) - 60000 || endedAtMs - seen > FRESH_MS) return null;
  if (hb.phase !== 'working' && hb.step === 0 && hb.hostStep === 0) return null;
  return {
    kind: 'vanished',
    at: new Date(endedAtMs).toISOString(),
    text: 'the sandbox ended suddenly while it was working (its window was closed, or it crashed: Windows logged nothing)',
  };
}

/**
 * How the last sandbox ended (pure): null when it was closed normally, or is still running. `heartbeat` only counts
 * when it was written during that run.
 */
export function lastEndOf(life: Life | null, heartbeat: Heartbeat | null, running: boolean): LastEnd | null {
  if (!life || running) return null;
  if (life.ended && !life.ended.cause) return null;
  const hb = heartbeat && Date.parse(heartbeat.at) >= Date.parse(life.started) - 60000 ? heartbeat : null;
  const at = life.ended?.at ?? life.lastSeen;
  const why = life.ended?.cause ? safeText(life.ended.cause.text) : guessReason(hb);
  return { at, text: 'ended unexpectedly ' + clock(at) + ': ' + why };
}

/** The status page's "Last sandbox" fact for this data folder. */
export function readLastEnd(lifeRead: () => Life | null, dataPath: string, running: boolean): LastEnd | null {
  const life = lifeRead();
  return lastEndOf(life, life && !running ? readHeartbeat(dataPath) : null, running);
}
