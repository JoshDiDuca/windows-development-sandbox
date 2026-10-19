// Reading Windows process-creation events (Security log, 4688, as wevtutil prints them) into audit lines, and which
// agent session each program belongs to. Pure, so the self-test can check it on the PC side.
import path from 'node:path';

/** Background programs of Windows itself: never what an agent ran. */
export const NOISE = new Set([
  'conhost.exe',
  'svchost.exe',
  'backgroundtaskhost.exe',
  'runtimebroker.exe',
  'wmiprvse.exe',
  'dllhost.exe',
  'searchprotocolhost.exe',
  'searchfilterhost.exe',
  'taskhostw.exe',
  'sppsvc.exe',
  'wermgr.exe',
  'consent.exe',
  'smartscreen.exe',
  'mpcmdrun.exe',
  'compattelrunner.exe',
  'wevtutil.exe',
  'audiodg.exe',
  'ctfmon.exe',
  'sihost.exe',
  'werfault.exe',
  'msmpeng.exe',
  'nissrv.exe',
  'usoclient.exe',
  'musnotification.exe',
]);

/** A session's ptyhost: everything it starts (and what those start) is that session's. */
export interface SessionRoot {
  readonly session: string;
  readonly pid: number;
  /** When the ptyhost started and ended (ms); a reused process id outside this window is not the session's. */
  readonly from: number;
  readonly to?: number;
}

/** Windows' clocks and ours differ by a moment: a root counts this long around its window. */
const ROOT_SLACK_MS = 5000;
/** Most process ids remembered (the oldest are forgotten first). */
const MAX_KNOWN = 50000;

/**
 * Follows the process tree through the events themselves: a program belongs to a session when its parent is that
 * session's ptyhost, or a program that belongs to it. Every new process id is recorded (as no session's when its
 * parent is not one's), so an id Windows gives to another process later never inherits a session. A program whose
 * parent was never seen is no session's: nothing is guessed.
 */
export class Attributor {
  private readonly owner = new Map<number, string | null>();

  /** The session of a new process (pid, started by ppid at time t), or undefined. */
  attribute(
    e: { readonly pid: number; readonly ppid: number; readonly t: number },
    roots: readonly SessionRoot[],
  ): string | undefined {
    const root = roots.find(
      (r) => r.pid === e.ppid && e.t >= r.from - ROOT_SLACK_MS && (r.to === undefined || e.t <= r.to + ROOT_SLACK_MS),
    );
    const session = root?.session ?? this.owner.get(e.ppid) ?? undefined;
    this.owner.delete(e.pid);
    this.owner.set(e.pid, session ?? null);
    if (this.owner.size > MAX_KNOWN) this.owner.delete(this.owner.keys().next().value as number);
    return session;
  }
}

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const field = (event: string, name: string): string =>
  decode(new RegExp("<Data Name='" + name + "'>([^<]*)</Data>").exec(event)?.[1] ?? '');
/** A process id as the event writes it (0x1a2c). */
const pidOf = (text: string): number => {
  const n = /^0x[0-9a-f]{1,8}$/i.test(text) ? parseInt(text, 16) : /^\d{1,10}$/.test(text) ? Number(text) : 0;
  return Number.isSafeInteger(n) ? n : 0;
};

/**
 * The events in wevtutil's XML output as audit lines, with the newest record id seen. With an attributor and the
 * sessions' roots, each line says which session started it (s), when that is known. Every event goes through the
 * attributor, Windows' own background programs too (they are left out of the lines only afterwards).
 */
export function parseProcessEvents(
  xml: string,
  attribution?: { readonly attributor: Attributor; readonly roots: readonly SessionRoot[] },
): { lines: string[]; last: number } {
  const lines: string[] = [];
  let last = 0;
  for (const event of xml.split('</Event>')) {
    const id = Number(/<EventRecordID>(\d+)<\/EventRecordID>/.exec(event)?.[1] ?? 0);
    if (!id) continue;
    last = Math.max(last, id);
    const program = field(event, 'NewProcessName');
    const t = /SystemTime='([^']+)'/.exec(event)?.[1] ?? new Date().toISOString();
    const pid = pidOf(field(event, 'NewProcessId'));
    const ppid = pidOf(field(event, 'ProcessId'));
    const session =
      attribution && pid && ppid
        ? attribution.attributor.attribute({ pid, ppid, t: Date.parse(t) || Date.now() }, attribution.roots)
        : undefined;
    if (!program || NOISE.has(path.win32.basename(program).toLowerCase())) continue;
    lines.push(
      JSON.stringify({
        t,
        k: 'proc',
        p: program.slice(0, 1024),
        c: field(event, 'CommandLine').slice(0, 2000),
        pp: field(event, 'ParentProcessName').slice(0, 1024),
        ...(session ? { s: session } : {}),
      }),
    );
  }
  return { lines, last };
}
