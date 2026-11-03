// Splits a plan into the steps that run now and the ones that wait for a gate (the background: Visual Studio and what
// needs it), and merges the steps' parts in plan order. Pure apart from the scheduler it is given.
import { asBackground } from '../../shared/concurrency/index.js';
import { emptyEnv, type ToolEnv } from './tool-env.js';
import type { ToolchainStep } from './step.js';
import type { RunOptions, StepScheduler } from './step-scheduler.js';

/** The steps that wait for the gate: the ones marked `background`, and every step that comes after one. */
export function backgroundNames(steps: readonly ToolchainStep[]): Set<string> {
  const later = new Set(steps.filter((s) => s.background).map((s) => s.name));
  for (let grew = later.size > 0; grew;) {
    grew = false;
    for (const s of steps)
      if (!later.has(s.name) && (s.after ?? []).some((n) => later.has(n))) {
        later.add(s.name);
        grew = true;
      }
  }
  return later;
}

export interface SplitRun {
  /** What the foreground steps contributed, in plan order. */
  readonly now: Map<string, ToolEnv>;
  readonly nowNames: readonly string[];
  readonly laterNames: readonly string[];
  /** The background steps' parts, once the gate opened and they ran; null when nothing was left for later. */
  readonly later: Promise<Map<string, ToolEnv>> | null;
}

/**
 * Runs the foreground steps and returns; the background steps (their downloads start now, behind the foreground ones)
 * run after `gate`, inside `quiet` (file-only logging).
 */
export async function runSplit(
  scheduler: StepScheduler,
  steps: readonly ToolchainStep[],
  run: RunOptions,
  o: { gate?: Promise<void>; quiet?: <T>(work: () => T) => T } = {},
): Promise<SplitRun> {
  const waiting = backgroundNames(steps);
  const now = steps.filter((s) => !waiting.has(s.name));
  const rest = steps.filter((s) => waiting.has(s.name));
  asBackground(() => scheduler.startFetches(rest));
  const parts = await scheduler.run(now, run);
  const quiet = o.quiet ?? (<T>(work: () => T): T => work());
  const later = rest.length
    ? (async (): Promise<Map<string, ToolEnv>> => {
        await o.gate;
        // A progress callback that does nothing: the scheduler must not rewrite the boot's status as "ready".
        return quiet(() => asBackground(() => scheduler.run(rest, { progress: () => undefined })));
      })()
    : null;
  // Nobody may see a failed background run as an unhandled rejection before the boot awaits it.
  later?.catch(() => undefined);
  return { now: parts, nowNames: now.map((s) => s.name), laterNames: rest.map((s) => s.name), later };
}

/** The parts of these steps merged in the order of `names`, so PATH order never depends on which finished first. */
export function mergeParts(
  names: readonly string[],
  parts: ReadonlyMap<string, ToolEnv>,
  o: { environment: Readonly<Record<string, string>>; bin: string },
): ToolEnv & { steps: Record<string, ToolEnv> } {
  const present = names.filter((n) => parts.has(n));
  const env: ToolEnv & { steps: Record<string, ToolEnv> } = {
    ...emptyEnv(),
    steps: Object.fromEntries(present.map((n) => [n, parts.get(n)!])),
  };
  env.prepend.push(o.bin);
  for (const name of present) {
    const p = parts.get(name)!;
    Object.assign(env.vars, p.vars);
    env.prepend.push(...p.prepend);
    env.append.push(...p.append);
    env.summary.push(...p.summary);
  }
  Object.assign(env.vars, o.environment);
  // The git guard's variables (AGENT_GIT_ACCESS, GIT_DIR, GIT_CONFIG_*, BASH_ENV) always win over
  // toolchains.environment.
  Object.assign(env.vars, parts.get('Git')?.vars);
  return env;
}
