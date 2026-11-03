// Runs the planned steps in parallel, a few at a time, after the steps they depend on. One lock per kind of step is
// held across runs: the boot and projects that join later never install two Nodes (or two Gos) at once.
import { AsyncLocalStorage } from 'node:async_hooks';
import { downloader } from '../../shared/download/index.js';
import { warn } from '../runtime/log.js';
import { setSandboxStatus } from '../runtime/status.js';
import { errMsg } from '../../core/util/errors.js';
import { emptyEnv, type ToolEnv } from './tool-env.js';
import type { ToolchainStep } from './step.js';

/** How many installers run at once: enough to overlap downloads with installs, few enough not to thrash the disk. */
const PARALLEL = 4;

export interface RunOptions {
  /** Progress lines ("Installing Go, Rust (3 of 9 done)"); default: the sandbox's boot status. */
  report?: (message: string) => void;
  /** What machine-wide (shared) steps contributed at boot: reused instead of run again. */
  reuse?: Record<string, ToolEnv>;
  /** The boot: gets what runs now instead of the scheduler writing the sandbox status itself. */
  progress?: (p: { active: { name: string; percent?: number }[]; done: number; total: number }) => void;
  /** A step finished (installed, failed or reused). */
  onDone?: (name: string) => void;
}

/** Runs one installer; a failure is reported and skipped so it never blocks the other toolchains. */
async function runReported(name: string, env: ToolEnv, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (e) {
    warn(
      name +
        ' could not be set up and is skipped; everything else still works, and the next start tries again. Reason: ' +
        errMsg(e),
    );
    env.summary.push(name + ': FAILED');
  }
}

export class StepScheduler {
  /** One lock per kind of step ("Node 20" and "Node 22" share nvm's folders): held while that step runs, in any run. */
  private readonly locks = new Map<string, Promise<void>>();
  /** The step a download belongs to (several run at once), for its progress. */
  private readonly currentStep = new AsyncLocalStorage<string>();
  /** Downloads started ahead of their steps (by name), until the step has used them. */
  private readonly fetches = new Map<string, Promise<void>>();

  constructor(private readonly parallel = PARALLEL) {}

  /**
   * Starts the downloads of these steps now (once per step); `run` waits for a step's own download before it installs.
   * Failures are not reported here: the install downloads again and reports the real reason.
   */
  startFetches(steps: readonly ToolchainStep[]): void {
    for (const s of steps) {
      if (!s.fetch || this.fetches.has(s.name)) continue;
      this.fetches.set(
        s.name,
        this.currentStep
          .run(s.name, async () => s.fetch!())
          .catch(() => {
            /* install downloads again and says why it failed */
          }),
      );
    }
  }

  /** Runs the steps (each with its own environment) and returns each step's environment, in plan order. */
  async run(steps: readonly ToolchainStep[], o: RunOptions): Promise<Map<string, ToolEnv>> {
    const envs = new Map(steps.map((s) => [s.name, emptyEnv()]));
    const finished = new Map<string, Promise<void>>();
    const running = new Set<string>();
    const waiting: (() => void)[] = [];
    let done = 0;
    // The boot (no `report`) also publishes structured progress: what runs now, how far its download is, how many are
    // done.
    const percent = new Map<string, number>();
    const active = (): { name: string; percent?: number }[] =>
      [...running].map((name) => ({ name, ...(percent.has(name) ? { percent: percent.get(name)! } : {}) }));
    const say =
      o.report ??
      ((message: string) =>
        o.progress
          ? o.progress({ active: active(), done, total: steps.length })
          : setSandboxStatus('provisioning', message, { active: active(), done, total: steps.length }));
    const report = (): void => {
      if (running.size) say('Installing ' + [...running].join(', ') + ' (' + done + ' of ' + steps.length + ' done)');
    };
    this.startFetches(steps.filter((s) => !(s.shared && o.reuse?.[s.name])));
    if (!o.report)
      downloader.watch(() => {
        const name = this.currentStep.getStore();
        return name
          ? (fraction) => {
              percent.set(name, Math.round(fraction * 100));
              report();
            }
          : null;
      });
    for (const s of steps) {
      // Dependencies first (they are earlier in the plan, so their promises exist), then a free slot.
      finished.set(
        s.name,
        (async () => {
          await Promise.all((s.after ?? []).map((name) => finished.get(name)));
          const env = envs.get(s.name)!;
          const reused = s.shared ? o.reuse?.[s.name] : undefined;
          if (reused) {
            envs.set(s.name, structuredClone(reused));
            done++;
            o.onDone?.(s.name);
            return;
          }
          // Its download (started above, before the dependencies finished) is in by now, or still coming.
          await this.fetches.get(s.name);
          this.fetches.delete(s.name);
          while (running.size >= this.parallel) await new Promise<void>((r) => waiting.push(r));
          running.add(s.name);
          report();
          try {
            await this.currentStep.run(s.name, () =>
              this.exclusive(s.name, () => runReported(s.name, env, async () => s.install(env))),
            );
          } finally {
            running.delete(s.name);
            percent.delete(s.name);
            done++;
            report();
            waiting.shift()?.();
            o.onDone?.(s.name);
          }
        })(),
      );
    }
    try {
      await Promise.all(finished.values());
    } finally {
      if (!o.report) downloader.watch(null);
    }
    o.progress?.({ active: [], done, total: steps.length });
    if (!o.report && !o.progress)
      setSandboxStatus('provisioning', 'Set up ' + steps.length + ' toolchains and databases', {
        active: [],
        done,
        total: steps.length,
      });
    return envs;
  }

  /** Runs `work` once no other step of the same kind (first word of the name) is running. */
  private async exclusive<T>(name: string, work: () => Promise<T>): Promise<T> {
    const key = name.split(' ')[0].toLowerCase();
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const chained = previous.then(() => mine);
    this.locks.set(key, chained);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }
}

/** The one scheduler: its locks span the boot's run and every project's run. */
export const scheduler = new StepScheduler();
