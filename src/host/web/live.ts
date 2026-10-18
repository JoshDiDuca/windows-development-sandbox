// Live queries shared by every browser: one poll per query and input, however many tabs and components watch it, and
// none when nobody does. A query whose answer has not changed for a while is read less often (up to SLOWEST times its
// interval); any operation that runs (poke) brings every query back to its own pace with a fresh read, so what an
// action changed shows at once.
import type { RpcHost } from '../../app/kernel/index.js';
import { NO_QUESTIONS } from '../../app/kernel/index.js';

/** A query unchanged this many reads in a row is read less often... */
const CALM_READS = 4;
/** ...down to this many times its own interval. */
const SLOWEST = 4;

export type LiveListener = (event: { readonly output: unknown } | { readonly error: unknown }) => void;

interface Poll {
  readonly query: string;
  readonly input: unknown;
  readonly everyMs: number;
  readonly listeners: Set<LiveListener>;
  timer: NodeJS.Timeout | undefined;
  busy: boolean;
  /** The last answer as JSON (what listeners have), or undefined after an error. */
  last: string | undefined;
  lastOutput: unknown;
  calm: number;
  /** A read was asked for while one was running: read again when it ends. */
  again: boolean;
}

export class LiveHub {
  private readonly polls = new Map<string, Poll>();

  constructor(private readonly host: RpcHost) {}

  /** How many polls run (for tests and the idle check). */
  get size(): number {
    return this.polls.size;
  }

  /**
   * Starts listening; the listener gets the current answer (at once when one is known) and every change. Returns the
   * function that stops listening.
   */
  watch(query: string, input: unknown, listener: LiveListener): () => void {
    const key = query + '\u0000' + JSON.stringify(input ?? null);
    let poll = this.polls.get(key);
    if (!poll) {
      poll = {
        query,
        input,
        everyMs: this.host.liveMs(query) ?? 0,
        listeners: new Set(),
        timer: undefined,
        busy: false,
        last: undefined,
        lastOutput: undefined,
        calm: 0,
        again: false,
      };
      this.polls.set(key, poll);
      void this.read(poll);
    } else if (poll.last !== undefined) listener({ output: poll.lastOutput });
    else if (!poll.busy) void this.read(poll); // the last read failed: try again for the newcomer
    poll.listeners.add(listener);
    const p = poll;
    return () => {
      p.listeners.delete(listener);
      if (p.listeners.size) return;
      clearTimeout(p.timer);
      this.polls.delete(key);
    };
  }

  /** Something changed (an operation ran): every query reads again now, at its own pace. */
  poke(): void {
    for (const poll of this.polls.values()) {
      poll.calm = 0;
      void this.read(poll);
    }
  }

  private schedule(poll: Poll): void {
    clearTimeout(poll.timer);
    if (!poll.everyMs || !this.isLive(poll)) return;
    const factor = poll.calm >= CALM_READS ? Math.min(SLOWEST, 1 + Math.floor(poll.calm / CALM_READS)) : 1;
    poll.timer = setTimeout(() => void this.read(poll), poll.everyMs * factor);
    poll.timer.unref?.();
  }

  private isLive(poll: Poll): boolean {
    return [...this.polls.values()].includes(poll);
  }

  private async read(poll: Poll): Promise<void> {
    if (poll.busy) {
      poll.again = true;
      return;
    }
    poll.busy = true;
    clearTimeout(poll.timer);
    try {
      const output = await this.host.run(poll.query, poll.input, NO_QUESTIONS);
      const text = JSON.stringify(output);
      if (text === poll.last) poll.calm++;
      else {
        poll.calm = 0;
        poll.last = text;
        poll.lastOutput = output;
        for (const l of [...poll.listeners]) l({ output });
      }
    } catch (error) {
      poll.calm = 0;
      poll.last = undefined;
      for (const l of [...poll.listeners]) l({ error });
    } finally {
      poll.busy = false;
    }
    if (poll.again) {
      poll.again = false;
      void this.read(poll);
      return;
    }
    this.schedule(poll);
  }
}
