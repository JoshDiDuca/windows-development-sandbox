// Every developer toolchain and database the sandbox provides (the list is in plan.ts). Each step is independent: one
// failing never blocks the rest. The boot runs them for the launch folder; the session daemon runs them again for
// each project registered later, possibly several at once (the scheduler keeps same-kind steps apart). At boot the
// heavy steps (Visual Studio and what depends on it) can wait for a gate and run in the background.
import type { Toolchains, ToolVersions } from '../../core/types.js';
import fs from 'node:fs';
import { log, runQuiet } from '../runtime/log.js';
import { toolsDir } from '../runtime/paths.js';
import { installedToolPaths } from '../setup/path-plan.js';
import { mkdirp } from '../runtime/fs.js';
import { tool, type ToolEnv } from './tool-env.js';
import { plan } from './plan.js';
import type { ToolchainOptions } from './step.js';
import { scheduler, type RunOptions } from './scheduler.js';
import { mergeParts, runSplit } from './split.js';

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

/** The parts of these steps merged in the order of `names` (and the config's own variables on top). */
export function mergeToolchains(
  config: Toolchains,
  names: readonly string[],
  parts: ReadonlyMap<string, ToolEnv> | Readonly<Record<string, ToolEnv>>,
  planNames: readonly string[] = names,
): ToolchainResult {
  const map = parts instanceof Map ? parts : new Map(Object.entries(parts));
  return {
    ...mergeParts(names, map, { environment: config.environment, bin: mkdirp(tool('bin')) }),
    names: [...planNames],
  };
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
  const split = await runSplit(scheduler, steps, run, { ...extras, quiet: runQuiet });
  const result = mergeToolchains(
    config,
    split.nowNames,
    split.now,
    steps.map((s) => s.name),
  );
  // Python and rust already installed in the persistent tools are on PATH for every project (at the end, nothing is
  // installed): the project this session is for may not have asked for them, but its scripts and neighbours use them.
  const have = new Set(steps.map((s) => s.name));
  const installed = installedToolPaths(
    toolsDir,
    { exists: fs.existsSync, list: (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []) },
    new Set([...(have.has('Python') ? ['python' as const] : []), ...(have.has('Rust') ? ['rust' as const] : [])]),
  );
  result.append.push(...installed.append);
  result.summary.push(...installed.summary);
  for (const [name, value] of Object.entries(installed.vars)) result.vars[name] ??= value;
  log(
    'Set up ' +
      split.nowNames.length +
      ' toolchains and databases' +
      (split.laterNames.length ? ' (' + split.laterNames.length + ' more later)' : '') +
      '.',
  );
  const later = split.later
    ? split.later.then((parts) =>
        mergeToolchains(
          config,
          split.laterNames,
          parts,
          steps.map((s) => s.name),
        ),
      )
    : null;
  later?.catch(() => undefined);
  return Object.assign(result, { later });
}
