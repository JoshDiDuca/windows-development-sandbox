// The environment every agent session, hook and terminal tab in the sandbox gets.
import path from 'node:path';
import type { ToolEnv } from '../toolchains/index.js';
import { claudeDir, session, stateDir, workspace } from '../runtime/session.js';
import { dataDir, dryRun, isWin, localDir, testMode, toolsDir } from '../runtime/paths.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { execOutput, runScriptWithJson, runScriptWithJsonAsync } from '../runtime/process.js';
import { SYSTEM } from '../../shared/system.js';
import { warn } from '../runtime/log.js';
import { errMsg } from '../../core/util/errors.js';
import { localStateVars } from '../agents/local-state.js';
import { agentPaths } from '../agents/agent-files.js';
import {
  appendMissing,
  expandVars,
  isPinnedNodeDir,
  parseRegPath,
  pathKey,
  planPath,
  sessionPath,
} from './path-plan.js';

/** Older launch folders have no agentHomes: these two were always set. */
const LEGACY_HOMES: Record<string, string> = { CODEX_HOME: 'codex', GEMINI_CLI_HOME: 'gemini' };

/** Every agent's home variable (CODEX_HOME ...) with the folder it points to in the persistent state. */
const agentHomes = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(session.agentHomes ?? LEGACY_HOMES)
      .filter(([name]) => name !== 'CLAUDE_CONFIG_DIR')
      .map(([name, sub]) => [name, path.join(stateDir, sub)]),
  );

/** Variables agent-sandbox itself sets (besides the toolchains' own). */
const AGENT_VARS = [
  'CLAUDE_CONFIG_DIR',
  'npm_config_cache',
  'npm_config_update_notifier',
  'AGENT_WORKSPACE',
  'AGENT_DATA',
  'AGENT_TOOLS',
  'AGENT_PROJECT',
  'AGENT_SANDBOX',
  'AGENT_SANDBOX_WORKSPACE',
];

/** Whose environment: the launch folder's at boot, or a project registered later (with the boot's base environment). */
export interface EnvTarget {
  workspace: string;
  project: string;
  base: NodeJS.ProcessEnv;
}

export function agentEnv(
  tools: Pick<ToolEnv, 'vars' | 'prepend' | 'append'>,
  target: EnvTarget = { workspace, project: session.project, base: process.env },
): NodeJS.ProcessEnv {
  const homes = agentHomes();
  const env: NodeJS.ProcessEnv = {
    ...target.base,
    ...tools.vars,
    CLAUDE_CONFIG_DIR: claudeDir,
    ...homes,
    ...localStateVars(),
    npm_config_cache: path.join(toolsDir, 'npm-cache'),
    npm_config_update_notifier: 'false',
    AGENT_WORKSPACE: target.workspace,
    AGENT_DATA: dataDir,
    AGENT_TOOLS: toolsDir,
    AGENT_PROJECT: target.project,
    // For project scripts: "am I in the sandbox, and where is the project?" (stable names; documented).
    AGENT_SANDBOX: '1',
    AGENT_SANDBOX_WORKSPACE: target.workspace,
  };
  const local = Object.keys(localStateVars());
  for (const dir of [
    env.CLAUDE_CONFIG_DIR,
    ...Object.keys(homes).map((n) => env[n]),
    env.npm_config_cache,
    ...local.map((n) => env[n]),
  ])
    mkdirp(dir as string);
  // The runner's own Node (bootstrap.ps1 puts it first on PATH) is not exposed: `node` is whatever nvm selected.
  const runners = [path.join(toolsDir, 'node'), path.dirname(process.execPath)].map((d) => d.toLowerCase());
  const base = (target.base.PATH ?? '').split(path.delimiter).filter((d) => d && !runners.includes(d.toLowerCase()));
  // The sandbox's commands (agent shims, sbx-db) first; MSVC's link.exe before Git's coreutils link.exe.
  env.PATH = sessionPath({
    commands: path.join(localDir, 'bin'),
    prepend: tools.prepend,
    base,
    append: tools.append,
  }).join(path.delimiter);
  return env;
}

/** Makes the agent environment machine-wide, so new terminal tabs and anything the agent starts see the same tools. */
export async function persistEnvironment(env: NodeJS.ProcessEnv, toolVars: string[], additive = false): Promise<void> {
  if (!isWin || dryRun || testMode) return;
  const vars = Object.fromEntries(
    [...toolVars, ...AGENT_VARS, ...Object.keys(agentHomes()), ...Object.keys(localStateVars())]
      .filter((n) => env[n] !== undefined)
      .map((n) => [n, env[n] as string]),
  );
  try {
    await runScriptWithJsonAsync('set-machine-environment.ps1', 'SettingsFile', {
      vars,
      ...(additive
        ? {
            // Visual Studio done: variables not set yet, new folders at the end of the machine PATH.
            path: null,
            add: planPath({
              entries: (env.PATH ?? '').split(path.delimiter),
              exists,
              drop: (dir) => isPinnedNodeDir(dir, nvmHome()),
            }),
          }
        : {
            path: planPath({
              entries: [env.PATH ?? '', ...installedAgentDirs()],
              exists,
              drop: (dir) => isPinnedNodeDir(dir, nvmHome()),
            }).join(path.delimiter),
            add: [],
          }),
      additive,
    });
  } catch (e) {
    warn('Could not persist the environment machine-wide: ' + errMsg(e));
  }
}

/**
 * Adds variables and PATH folders machine-wide after boot (`sbx-db start`): new terminal tabs see them.
 * additive: for a project registered later. Only variables not set yet, and folders go to the END of PATH, so what
 * the boot project's terminals see never changes; the project's own sessions get its full environment anyway.
 */
export function addMachineEnvironment(vars: Record<string, string>, dirs: string[], additive = false): void {
  if (!isWin || dryRun || testMode) return;
  // Folders that do not exist stay out, and so does a pinned Node version (`nvm use` could not move it).
  const planned = planPath({ entries: dirs, exists, drop: (dir) => isPinnedNodeDir(dir, nvmHome()) });
  try {
    runScriptWithJson('set-machine-environment.ps1', 'SettingsFile', { vars, path: null, add: planned, additive });
  } catch (e) {
    warn('Could not add to the environment: ' + errMsg(e));
  }
}

const nvmHome = (): string => path.join(toolsDir, 'nvm');

/** The folder of every configured agent that is installed: its command works in any terminal. */
function installedAgentDirs(): string[] {
  return Object.entries(session.agents ?? {}).flatMap(([name, harness]) => {
    const p = agentPaths(toolsDir, name, harness);
    return (p.exe && exists(p.exe)) || (p.cmd && exists(p.cmd)) ? [p.dir] : [];
  });
}

const MACHINE_ENVIRONMENT_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_ENVIRONMENT_KEY = 'HKCU\\Environment';

const registryPath = (key: string): string => parseRegPath(execOutput(SYSTEM.reg(), ['query', key, '/v', 'Path']));

/**
 * The environment for a program the daemon starts (an agent session, `sandbox exec`): its own PATH, plus every machine
 * and user PATH folder added since the daemon started (python, cargo, other agents ...) at the end. Never changes
 * `env`; without Windows it is returned as it is.
 */
export function withRegistryPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!isWin || dryRun || testMode) return env;
  try {
    const registry = expandVars(registryPath(MACHINE_ENVIRONMENT_KEY) + ';' + registryPath(USER_ENVIRONMENT_KEY), env);
    const runner = pathKey(path.join(toolsDir, 'node'));
    const pathName = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    return {
      ...env,
      [pathName]: appendMissing(
        env[pathName] ?? '',
        registry,
        (dir) => pathKey(dir) === runner || isPinnedNodeDir(dir, nvmHome()),
      ),
    };
  } catch (e) {
    warn('Could not read the machine PATH (the session keeps the one it has): ' + errMsg(e));
    return env;
  }
}
