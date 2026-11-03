// A counting limiter for heavy work (downloads, unpacking, installers). FIFO, foreground before background. A task
// that holds a slot may not take a slot of another limiter: nested pools throw, so a deadlock cannot happen. Pure.
import { AsyncLocalStorage } from 'node:async_hooks';

export type Priority = 'foreground' | 'background';

/** The pool whose slot the current async context holds (at most one). */
const held = new AsyncLocalStorage<Limiter>();

/** The priority of work started in this async context (set by `asBackground`). */
const priorityOf = new AsyncLocalStorage<Priority>();

/** Runs `work` so that every pool slot it asks for queues behind foreground work. */
export function asBackground<T>(work: () => T): T {
  return priorityOf.run('background', work);
}

interface Waiter {
  readonly start: () => void;
}

export class Limiter {
  private active = 0;
  private peakActive = 0;
  private readonly queues: Record<Priority, Waiter[]> = { foreground: [], background: [] };

  constructor(
    private readonly size: number,
    readonly name = 'pool',
  ) {
    if (!Number.isInteger(size) || size < 1) throw new Error('A pool needs a size of at least 1');
  }

  /** The most slots that were ever busy at once (tests). */
  get peak(): number {
    return this.peakActive;
  }

  get running(): number {
    return this.active;
  }

  /** Runs `work` in a free slot (waiting its turn), and frees the slot afterwards. */
  async run<T>(work: () => Promise<T> | T, priority: Priority = priorityOf.getStore() ?? 'foreground'): Promise<T> {
    const holding = held.getStore();
    if (holding) throw new Error('nested pool: ' + this.name + ' requested while holding ' + holding.name);
    await this.acquire(priority);
    try {
      return await held.run(this, async () => work());
    } finally {
      this.release();
    }
  }

  private acquire(priority: Priority): Promise<void> {
    if (this.active < this.size) {
      this.take();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queues[priority].push({
        start: () => {
          this.take();
          resolve();
        },
      });
    });
  }

  private take(): void {
    this.active++;
    this.peakActive = Math.max(this.peakActive, this.active);
  }

  private release(): void {
    this.active--;
    const next = this.queues.foreground.shift() ?? this.queues.background.shift();
    next?.start();
  }
}
