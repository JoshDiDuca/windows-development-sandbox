// What the menu shows about the running sandbox (the status line), kept fresh in the background. Drawing and keys only
// read the last copy, and the screen is told when what it shows has changed. While it runs, the host's own "is the
// sandbox running?" questions are answered from the same copy, so no page waits for a child process.
//
// The process list (tasklist) is the expensive part: on a busy PC one run costs a large share of a second of CPU. So it
// is not fetched on a timer: while a sandbox runs, its processes are checked by id (no program started) and the list is
// fetched again only when one of them has ended; while none runs, the list is fetched less and less often while nothing
// changes (and again soon after a key press, someone is looking, or when the data folder's run folder changes, a start
// writes there), and after every action.
import { sandboxStatus } from '../../app/features/sandbox/index.js';
import { insideSandbox, readTasklistAsync, sandboxPids, useTasklistCache } from '../../host/sandbox/index.js';

export interface LiveOptions {
  /** Fetches the process list (default: tasklist, run without blocking). */
  readonly fetch?: () => Promise<string>;
  /** The status line from the facts now (reads the cached process list and small files; never runs a program). */
  readonly derive: () => string;
  /** The line changed: draw again. */
  readonly onChange: () => void;
  /** How often the line is derived again (and the shortest gap between two process lists). */
  readonly intervalMs?: number;
  /** The longest gap between two process lists while no sandbox runs and nobody presses a key. */
  readonly idleMaxMs?: number;
  /** Whether a process still runs (default: a signal-0 check, which starts no program). */
  readonly alive?: (pid: number) => boolean;
  /** Whether the process list is needed (default: not inside a sandbox, where "is it running?" is always yes). */
  readonly needsList?: () => boolean;
  /**
   * A cheap fingerprint of what a sandbox start changes (the data folder's run folder): while none runs, a change
   * fetches the list at the next tick instead of after the idle gap.
   */
  readonly signal?: () => string;
}

/** The same rule as the web's live status: the sandbox status query's interval. */
const DEFAULT_INTERVAL_MS = sandboxStatus.live?.everyMs ?? 2500;
/** While no sandbox runs, nobody presses a key and the data folder is quiet, the list is fetched this seldom. */
const DEFAULT_IDLE_MAX_MS = 30000;

/** The gap before the next process list after `unchanged` lists in a row found the same: doubling, up to `max`. */
export function listGap(unchanged: number, base: number, max: number): number {
  return Math.min(max, base * 2 ** Math.max(0, Math.min(unchanged, 16)));
}

/** A process with this id exists (EPERM: it does, but belongs to someone else, such as the sandbox's own service). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class LiveStatus {
  private tasklist: string | undefined;
  /** The sandbox's processes in the last list (none: no sandbox was running). */
  private pids: number[] = [];
  private fetchedAt = 0;
  /** Lists in a row that found the same answer (the gap to the next one grows with it). */
  private unchanged = 0;
  /** The signal when the list was last fetched. */
  private signalled = '';
  private text = '';
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;
  private running = false;

  constructor(private readonly o: LiveOptions) {}

  private get interval(): number {
    return this.o.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /** The status line as of the last refresh. */
  line(): string {
    return this.text;
  }

  /** Reads the process list now and derives the line (one fetch at a time; a caller during one waits for it). */
  refresh(): Promise<void> {
    // The next gap starts again from the shortest one.
    this.unchanged = -1;
    return this.fetch();
  }

  private fetch(): Promise<void> {
    // Cleared in a callback, so also after a fetch that finished without waiting for anything.
    this.pending ??= this.load().finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async load(): Promise<void> {
    try {
      const needed = (this.o.needsList ?? (() => !insideSandbox()))();
      this.signalled = this.o.signal?.() ?? '';
      // Not needed: an empty copy, so nothing runs tasklist itself either.
      const list = needed ? await (this.o.fetch ?? readTasklistAsync)() : '';
      // Stopped meanwhile: a command may be running, and nothing here may touch the host's facts any more.
      if (!this.running) return;
      const pids = sandboxPids(list);
      const same = this.tasklist !== undefined && pids.length > 0 === this.pids.length > 0;
      this.unchanged = same ? this.unchanged + 1 : 0;
      this.tasklist = list;
      this.pids = pids;
      this.fetchedAt = Date.now();
      this.derive();
    } catch {
      // The line keeps what it showed; the next refresh tries again.
    }
  }

  /** Whether the process list may have changed since it was fetched (checked on every tick, cheaply). */
  private listDue(now: number): boolean {
    if (this.tasklist === undefined) return true;
    if (this.pids.length) return !this.pids.every((pid) => (this.o.alive ?? processAlive)(pid));
    if (this.o.signal && this.o.signal() !== this.signalled) return true;
    return now - this.fetchedAt >= listGap(this.unchanged, this.interval, this.o.idleMaxMs ?? DEFAULT_IDLE_MAX_MS);
  }

  private tick(): void {
    if (this.pending) return;
    if (this.listDue(Date.now())) void this.fetch();
    else this.derive();
  }

  /** A key was pressed: someone is looking, so a list older than one interval is fetched again (after the draw). */
  touch(): void {
    if (!this.running || this.pending || this.pids.length || Date.now() - this.fetchedAt < this.interval) return;
    setImmediate(() => {
      if (this.running) void this.refresh();
    });
  }

  private derive(): void {
    const next = this.o.derive();
    if (next === this.text) return;
    this.text = next;
    if (this.running) this.o.onChange();
  }

  /** Starts keeping the line fresh and answers the host's process questions from it (until stop). */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    useTasklistCache(() => this.tasklist);
    this.timer = setInterval(() => this.tick(), this.interval);
    this.timer.unref();
    await this.refresh();
  }

  /** Stops; the host's questions run their own programs again (a command that runs after the menu needs the truth). */
  stop(): void {
    this.running = false;
    clearInterval(this.timer);
    this.timer = undefined;
    useTasklistCache(null);
    this.tasklist = undefined;
    this.pids = [];
  }
}
