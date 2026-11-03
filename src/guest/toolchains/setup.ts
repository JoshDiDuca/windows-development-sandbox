// Every developer toolchain and database the sandbox provides (the list is in plan.ts). Each step is independent: one
// failing never blocks the rest. The boot runs them for the launch folder; the session daemon runs them again for
// each project registered later, possibly several at once (the scheduler keeps same-kind steps apart). At boot the
// heavy steps (Visual Studio and what depends on it) can wait for a gate and run in the background.
import { asBackground } from '../../shared/concurrency/index.js';
import type { Toolchains, ToolVersions } from '../../core/types.js';
import { log, runQuiet } from '../runtime/log.js';
import { mkdirp } from '../runtime/fs.js';
import { emptyEnv, tool, type ToolEnv } from './tool-env.js';
import { plan } from './plan.js';
import type { ToolchainOptions, ToolchainStep } from './step.js';
import { scheduler, type RunOptions } from './scheduler.js';

/** The combined environment, plus what each step contributed (kept so later projects reuse the shared steps). */
export interface ToolchainResult extends ToolEnv {
  steps: Record<string, ToolEnv>;
  /** Every enabled step of the plan (foreground and background), in plan order: the order the parts are merged in. */
  names: string[];
}

export interface SetupExtras {
  /** The background steps start once this resolves (the boot: the agent's first session is running). */
  gate?: Promise<void>;
}

/** The steps that wait for the gate: the ones marked `background`, and every step that comes after one. */
export function backgroundNames(steps: readonly ToolchainStep[]): Set<string> {
  const later = new Set(steps.filter((s) => s.background).map((s) => s.name));
  for (let grew = later.size > 0; grew; ) {
    grew = false;
    for (const s of steps)
      if (!later.has(s.name) && (s.after ?? []).some((n) => later.has(n))) {
        later.add(s.name);
        grew = true;
      }
  }
  return later;
}

/** The parts of these steps merged in the order of `names`, so PATH order never depends on which finished first. */
export function mergeToolchains(
  config: Toolchains,
  names: readonly string[],
  parts: ReadonlyMap<string, ToolEnv> | Readonly<Record<string, ToolEnv>>,
): ToolchainResult {
  const part = (name: string): ToolEnv | undefined => (parts instanceof Map ? parts.get(name) : (parts as Record<string, ToolEnv>)[name]);
  const present = names.filter((n) => part(n));
  const env: ToolchainResult = {
    ...emptyEnv(),
    steps: Object.fromEntries(present.map((n) => [n, part(n)!])),
    names: [...names],
  };
  env.prepend.push(mkdirp(tool('bin')));
  for (const name of present) {
    const p = part(name)!;
    Object.assign(env.vars, p.vars);
    env.prepend.push(...p.prepend);
    env.append.push(...p.append);
    env.summary.push(...p.summary);
  }
  Object.assign(env.vars, config.environment);
  // The git guard's variables (AGENT_GIT_ACCESS, GIT_DIR, GIT_CONFIG_*, BASH_ENV) always win over
  // toolchains.environment.
  Object.assign(env.vars, part('Git')?.vars);
  return env;
}

/**
 * Provisions every enabled toolchain and database, and returns the combined environment for the agent. `later` is
 * set when steps were left for the background: it resolves with the result of those steps alone.
 */
export async function setupToolchains(
  config: Toolchains,
  versions: ToolVersions,
  options: ToolchainOptions,
  run: RunOptions = {},
  extras: SetupExtras = {},
): Promise<ToolchainResult & { later: Promise<ToolchainResult> | null }> {
  const steps = plan(config, versions, options).filter((s) => s.enabled);
  const names = steps.map((s) => s.name);
  const waiting = backgroundNames(steps);
  const now = steps.filter((s) => !waiting.has(s.name));
  const rest = steps.filter((s) => waiting.has(s.name));
  // The background steps' downloads (the Visual Studio installer) start now, behind the foreground ones.
  asBackground(() => scheduler.startFetches(rest));
  const envs = await scheduler.run(now, run);
  const result = mergeToolchains(
    config,
    now.map((s) => s.name),
    envs,
  );
  log('Set up ' + now.length + ' toolchains and databases' + (rest.length ? ' (' + rest.length + ' more later)' : '') + '.');
  const later = rest.length
    ? (async (): Promise<ToolchainResult> => {
        await extras.gate;
        return runQuiet(async () => {
          // A progress callback that does nothing: the scheduler must not rewrite the boot's status as "ready".
          const parts = await asBackground(() => scheduler.run(rest, { progress: () => undefined }));
          return mergeToolchains(
            config,
            rest.map((s) => s.name),
            parts,
          );
        });
      })()
    : null;
  // Nobody may see a failed background run as an unhandled rejection before the boot awaits it.
  later?.catch(() => undefined);
  return Object.assign(result, { names, later });
}
