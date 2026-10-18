import type { StopCause, StopKind } from './stop-events.js';
import type { Life } from './life-record.js';

const ADVICE: Record<StopKind, string> = {
  updates:
    'Before leaving agents overnight, restart for pending updates first or pause them (Settings > Windows Update > Pause updates).',
  restart: 'If that was not you, check Settings > Windows Update and Event Viewer > Windows Logs > System.',
  crash:
    'sandbox logs --crash prints what Windows logged and how much memory this PC had; Event Viewer > Windows Logs > System has the rest. A laptop also needs to stay plugged in.',
  sleep:
    'sandbox.keepAwake keeps this PC awake while a sandbox runs (closing a laptop lid still sleeps it). Check it is on, and that sleep is not forced by a policy.',
  sandboxCrash:
    'C:\\AgentData\\logs\\memory-*.log shows what used memory just before. Fewer builds at once inside the sandbox (e.g. cargo build.jobs) makes it less likely.',
  memory:
    'Give the sandbox less RAM (sandbox.maxMemoryMb, sandbox.reserveHostMb) or run fewer builds at once inside it.',
};

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** What to tell about a sandbox that ended without anyone closing it (null: it was closed normally). */
export function stopWarning(
  life: Life,
  find: (since: string) => StopCause | null,
  crashReport: () => string | null = () => null,
): string | null {
  if (life.ended && !life.ended.cause) return null;
  const cause = life.ended ? life.ended.cause : find(life.lastSeen);
  const what = cause
    ? cause.text + ' at ' + when(cause.at) + '. ' + ADVICE[cause.kind]
    : 'this PC stopped (Windows logged no reason). ' + ADVICE.crash;
  const report = crashReport();
  return (
    'The last sandbox did not close normally: it was last seen running at ' +
    when(life.lastSeen) +
    ', and ' +
    what +
    ' Agent conversations are kept: /resume in Claude picks one up.' +
    (report ? ' Crash report: ' + report : '')
  );
}
