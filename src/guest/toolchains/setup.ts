// Every developer toolchain and database the sandbox provides (the list is in plan.ts). Each step is independent: one
// failing never blocks the rest. The boot runs them for the launch folder; the session daemon runs them again for
// each project registered later, possibly several at once (the scheduler keeps same-kind steps apart).
import type { Toolchains, ToolVersions } from '../../core/types.js';
import { log } from '../runtime/log.js';
import { mkdirp } from '../runtime/fs.js';
import { emptyEnv, tool, type ToolEnv } from './tool-env.js';
import { plan } from './plan.js';
import type { ToolchainOptions } from './step.js';
import { scheduler, type RunOptions } from './scheduler.js';

/** The combined environment, plus what each step contributed (kept so later projects reuse the shared steps). */
export interface ToolchainResult extends ToolEnv {
  steps: Record<string, ToolEnv>;
}

/** Provisions every enabled toolchain and database, and returns the combined environment for the agent. */
export async function setupToolchains(
  config: Toolchains,
  versions: ToolVersions,
  options: ToolchainOptions,
  run: RunOptions = {},
): Promise<ToolchainResult> {
  const steps = plan(config, versions, options).filter((s) => s.enabled);
  const envs = await scheduler.run(steps, run);
  // Merged in plan order, so PATH order never depends on which download finished first.
  const env: ToolchainResult = { ...emptyEnv(), steps: Object.fromEntries(envs) };
  env.prepend.push(mkdirp(tool('bin')));
  for (const part of envs.values()) {
    Object.assign(env.vars, part.vars);
    env.prepend.push(...part.prepend);
    env.append.push(...part.append);
    env.summary.push(...part.summary);
  }
  Object.assign(env.vars, config.environment);
  // The git guard's variables (AGENT_GIT_ACCESS, GIT_DIR, GIT_CONFIG_*, BASH_ENV) always win over toolchains.environment.
  Object.assign(env.vars, envs.get('Git')?.vars);
  log('Set up ' + steps.length + ' toolchains and databases.');
  return env;
}
