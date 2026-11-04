// Runs the boot's tasks: each starts when the tasks it comes after are finished, a few at a time, in declaration order.
// Pure (no runtime imports): the boot injects the log, the clock, the log context, the status and the progress view.

export interface BootTaskDef<Id extends string = string> {
  readonly id: Id;
  readonly stage: number;
  readonly title: string;
  readonly after: readonly Id[];
  /** A failure stops the tasks that come after it and fails the boot (otherwise it is a warning). */
  readonly critical: boolean;
  /** Starts only after the gate (`run('background')`) and logs to the file only. */
  readonly background?: boolean;
  /** Runs alone (the hooks inherit the terminal). */
  readonly exclusive?: boolean;
}

export type TaskRun = () => Promise<void> | void;

export interface TaskOutcome {
  readonly id: string;
  readonly title: string;
  readonly state: 'done' | 'failed' | 'skipped';
  readonly ms: number;
  readonly error?: string;
}

/** Where the boot stands, for the host's progress line. */
export interface RunnerStatus {
  readonly phase: 'booting' | 'provisioning';
  /** The lowest stage that still has an unfinished foreground task. */
  readonly step: number;
  /** Titles of the tasks that run now. */
  readonly running: readonly string[];
  readonly message: string;
}

/** What the console's progress view hears (foreground tasks only: the background ones are file-only). */
export interface RunnerObserver {
  started(task: BootTaskDef): void;
  /** Also for a task that was skipped (it never started). */
  finished(task: BootTaskDef, outcome: TaskOutcome): void;
}

/** Who logs while a task runs. */
export interface TaskContext {
  readonly stage: number;
  readonly title: string;
  readonly quiet: boolean;
}

export interface RunnerOptions {
  /** A line for the log file only: when each task started and finished (the console shows the progress view). */
  trace(line: string): void;
  /** `quiet`: file only (background tasks). */
  warn(line: string, quiet?: boolean): void;
  /** Milliseconds. */
  now(): number;
  dryRun: boolean;
  /** Tasks at once (default: 1 in a dry run, else 4). */
  parallel?: number;
  stages: number;
  stageTitle(stage: number): string;
  status?(status: RunnerStatus): void;
  observer?: RunnerObserver;
  /** Runs a task's work so that its log lines carry the task (its stage and title, and whether they stay quiet). */
  inContext?<T>(ctx: TaskContext, work: () => T): T;
}

const PARALLEL = 4;
const MINUTE = 60000;

/** "4.6s" under a minute, "7m02s" from there. */
export function duration(ms: number): string {
  // 59.96 s would round to "60.0s": from there it is "1m00s".
  if (ms < MINUTE - 50) return (Math.max(0, ms) / 1000).toFixed(1) + 's';
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
}

/** Dependencies must exist, ids be unique, the graph acyclic and no foreground task wait for a background one. */
export function checkGraph(defs: readonly BootTaskDef[]): void {
  const byId = new Map<string, BootTaskDef>();
  for (const d of defs) {
    if (byId.has(d.id)) throw new Error('Boot task "' + d.id + '" is defined twice');
    byId.set(d.id, d);
  }
  for (const d of defs)
    for (const a of d.after) {
      const dep = byId.get(a);
      if (!dep) throw new Error('Boot task "' + d.id + '" comes after "' + a + '", which does not exist');
      if (dep.background && !d.background)
        throw new Error('Boot task "' + d.id + '" waits for the background task "' + a + '"');
    }
  // Kahn: whatever cannot be taken off the front is in a cycle.
  const left = new Map(defs.map((d) => [d.id, d.after.length]));
  const queue = defs.filter((d) => d.after.length === 0).map((d) => d.id);
  let taken = 0;
  while (queue.length) {
    const id = queue.shift()!;
    taken++;
    for (const d of defs)
      if (d.after.includes(id)) {
        left.set(d.id, left.get(d.id)! - 1);
        if (left.get(d.id) === 0) queue.push(d.id);
      }
  }
  if (taken !== defs.length) throw new Error('The boot tasks depend on each other in a circle');
}

type State = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export class BootRunner<Id extends string> {
  private readonly byId = new Map<string, BootTaskDef<Id>>();
  private readonly state = new Map<string, State>();
  private readonly outcomes = new Map<string, TaskOutcome>();
  private readonly running = new Set<string>();

  constructor(
    private readonly defs: readonly BootTaskDef<Id>[],
    private readonly impl: Readonly<Record<Id, TaskRun>>,
    private readonly o: RunnerOptions,
  ) {
    checkGraph(defs);
    for (const d of defs) {
      this.byId.set(d.id, d);
      this.state.set(d.id, 'pending');
    }
  }

  /** Every outcome so far, in declaration order. */
  results(): TaskOutcome[] {
    return this.defs.flatMap((d) => (this.outcomes.has(d.id) ? [this.outcomes.get(d.id)!] : []));
  }

  /**
   * Runs the foreground tasks, or (after the gate) the background ones. Resolves with the outcomes of this run;
   * rejects with the first critical error once the tasks that were running have finished.
   */
  run(which: 'foreground' | 'background'): Promise<TaskOutcome[]> {
    const todo = this.defs.filter((d) => Boolean(d.background) === (which === 'background'));
    const quiet = which === 'background';
    const parallel = this.o.parallel ?? (this.o.dryRun ? 1 : PARALLEL);
    return new Promise<TaskOutcome[]>((resolve, reject) => {
      let firstCritical: unknown;
      let failed = false;
      const pending = (): BootTaskDef<Id>[] => todo.filter((d) => this.state.get(d.id) === 'pending');
      const settle = (): void => {
        if (this.running.size === 0 && pending().length === 0) {
          if (failed) reject(firstCritical);
          else resolve(todo.map((d) => this.outcomes.get(d.id)!));
        }
      };
      const start = (d: BootTaskDef<Id>): void => {
        this.state.set(d.id, 'running');
        this.running.add(d.id);
        const began = this.o.now();
        this.begin(d, quiet);
        const ctx: TaskContext = { stage: d.stage, title: d.title, quiet };
        const work = async (): Promise<void> => {
          await this.impl[d.id]();
        };
        const call = (): Promise<void> => (this.o.inContext ? this.o.inContext(ctx, work) : work());
        // A synchronous throw from a task is a failure too: the call starts inside a promise.
        void Promise.resolve()
          .then(call)
          .then(
            () => this.finish(d, began, quiet, undefined),
            (e: unknown) => {
              this.finish(d, began, quiet, e);
              if (d.critical && firstCritical === undefined) {
                firstCritical = e;
                failed = true;
              }
            },
          )
          .finally(() => {
            this.running.delete(d.id);
            if (!quiet) this.report(d.stage);
            pump();
          });
      };
      const pump = (): void => {
        // Tasks that come after a failed critical (or skipped) task are skipped, and so is whatever comes after those.
        for (let again = true; again;) {
          again = false;
          for (const d of pending()) {
            const bad = d.after.find((a) => this.isBlocked(a));
            if (bad) {
              this.skip(d, this.byId.get(bad)!.title + ' failed', quiet);
              again = true;
            }
          }
        }
        for (const d of pending()) {
          if (this.running.size >= parallel) break;
          if (!d.after.every((a) => this.isFinished(a))) continue;
          if (d.exclusive) {
            // Waits until nothing runs, and holds back everything declared after it.
            if (this.running.size === 0) start(d);
            break;
          }
          start(d);
        }
        settle();
      };
      pump();
    });
  }

  private isFinished(id: string): boolean {
    const s = this.state.get(id);
    return s === 'done' || s === 'failed' || s === 'skipped';
  }

  /** The task cannot have run properly: skipped, or failed with a critical failure. */
  private isBlocked(id: string): boolean {
    const s = this.state.get(id);
    return s === 'skipped' || (s === 'failed' && this.byId.get(id)!.critical);
  }

  private tag(d: BootTaskDef<Id>): string {
    return (d.background ? '[background] ' : '[' + d.stage + '/' + this.o.stages + '] ') + d.title;
  }

  private skip(d: BootTaskDef<Id>, why: string, quiet: boolean): void {
    this.state.set(d.id, 'skipped');
    const outcome: TaskOutcome = { id: d.id, title: d.title, state: 'skipped', ms: 0, error: why };
    this.outcomes.set(d.id, outcome);
    this.o.trace(this.tag(d) + ': skipped (' + why + ')');
    if (!quiet) this.o.observer?.finished(d, outcome);
  }

  private begin(d: BootTaskDef<Id>, quiet: boolean): void {
    this.o.trace(this.tag(d) + ': started');
    if (quiet) return;
    this.o.observer?.started(d);
    this.report(d.stage);
  }

  private finish(d: BootTaskDef<Id>, began: number, quiet: boolean, error: unknown): void {
    const ms = this.o.now() - began;
    const message = error === undefined ? undefined : error instanceof Error ? error.message : String(error);
    const outcome: TaskOutcome = {
      id: d.id,
      title: d.title,
      state: message === undefined ? 'done' : 'failed',
      ms,
      ...(message === undefined ? {} : { error: message }),
    };
    this.state.set(d.id, outcome.state);
    this.outcomes.set(d.id, outcome);
    this.o.trace(this.tag(d) + (message === undefined ? ': done in ' : ': FAILED in ') + duration(ms));
    // A soft failure is a warning and the boot goes on; a critical one stops the boot, which shows that error.
    if (message !== undefined && !d.critical) this.o.warn(d.title + ' failed (continuing): ' + message, quiet);
    if (message !== undefined && d.critical) this.o.trace(this.tag(d) + ': ' + message);
    if (!quiet) this.o.observer?.finished(d, outcome);
  }

  private report(stageHint: number): void {
    if (!this.o.status) return;
    const open = this.defs.filter((d) => !d.background && !this.isFinished(d.id));
    const step = open.length ? Math.min(...open.map((d) => d.stage)) : stageHint;
    const stage1Open = open.some((d) => d.stage === 1);
    const running = this.defs.filter((d) => this.running.has(d.id)).map((d) => d.title);
    this.o.status({
      phase: stage1Open ? 'booting' : 'provisioning',
      step,
      running,
      message: '[' + step + '/' + this.o.stages + '] ' + this.o.stageTitle(step),
    });
  }
}
