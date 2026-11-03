// Getting the agent (claude, codex, gemini, opencode, aider, ...) into persistent storage and working out how to
// start it.
import fs from 'node:fs';
import path from 'node:path';
import type { Harness } from '../../core/types.js';
import { SYSTEM } from '../../shared/system.js';
import { setupUv, uvVars } from '../toolchains/runtimes.js';
import { emptyEnv } from '../toolchains/tool-env.js';
import { dryRun, hostToolsDir, isWin, toolsDir } from '../runtime/paths.js';
import { execHeavy as execAsync } from '../runtime/pools.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log, warn } from '../runtime/log.js';
import { session } from '../runtime/session.js';
import { addMachineEnvironment } from '../setup/environment.js';
import { agentPaths as paths, type AgentPaths } from './agent-files.js';
import { linkHarnessProfile } from './profile-links.js';

/** Where an agent comes from: copied from this PC, or installed with npm or uv. */
export type AgentSource = 'host' | 'npm' | 'uv';

const agentPaths = (name: string, harness: Harness): AgentPaths => paths(toolsDir, name, harness);

/** npm install with the runner's own npm into tools\agents\<name> (no global state outside persistent storage). */
async function installViaNpm(name: string, harness: Harness, dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (!harness.npmPackage)
    throw new Error('No npmPackage configured for ' + name + ' and no host executable was available.');
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = [npmCli, 'install', '--global', '--prefix', dir, harness.npmPackage, '--no-fund', '--no-audit'];
  log('Installing ' + harness.npmPackage + ' (this can take a minute)...');
  if (dryRun) {
    log('(dry run) ' + process.execPath + ' ' + args.join(' '));
    return;
  }
  if (!exists(npmCli)) throw new Error('npm not found at ' + npmCli);
  await execAsync(process.execPath, args, { env });
}

/** `uv tool install` with its command put straight into tools\agents\<name> (Python agents such as aider). */
async function installViaUv(name: string, harness: Harness, dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const uv = path.join(toolsDir, 'uv', 'uv.exe');
  log('Installing ' + harness.uvPackage + ' with uv (this can take a minute)...');
  if (dryRun) {
    log('(dry run) uv tool install ' + harness.uvPackage);
    return;
  }
  // The uv step runs only for projects that use uv, so an agent that needs it installs uv here.
  if (!exists(uv)) {
    log('Installing uv for ' + name + ' ...');
    await setupUv(emptyEnv());
  }
  await execAsync(uv, ['tool', 'install', '--force', '--python', '3.12', harness.uvPackage!], {
    env: { ...env, ...uvVars(), UV_TOOL_BIN_DIR: dir },
  });
}

/** The agent's folder at the end of PATH: `claude` (or `codex` ...) works in every new terminal tab and in sessions. */
function putOnPath(dir: string, env: NodeJS.ProcessEnv): void {
  const parts = (env.PATH ?? '').split(path.delimiter);
  if (!parts.some((p) => p.toLowerCase() === dir.toLowerCase())) env.PATH = [...parts, dir].join(path.delimiter);
  addMachineEnvironment({}, [dir], true);
}

export class AgentInstaller {
  /** One install per agent at a time: two sessions asking for a new agent at once share the first one's install. */
  private readonly installing = new Map<string, Promise<void>>();

  /**
   * Copies the agent from this PC when it was mapped in (primary agent only), otherwise installs it with npm or uv.
   * Asynchronous, so the session daemon keeps serving other requests while an agent installs.
   */
  provision(
    name: string,
    harness: Harness,
    env: NodeJS.ProcessEnv,
    refresh = session.provisioning.refresh,
  ): Promise<void> {
    const current = this.installing.get(name);
    if (current) return current;
    linkHarnessProfile(name, harness);
    const work = this.install(name, harness, env, refresh)
      .then(() => putOnPath(agentPaths(name, harness).dir, env))
      .finally(() => this.installing.delete(name));
    this.installing.set(name, work);
    return work;
  }

  /** Program + arguments that start the agent (an npm .cmd shim has to go through cmd.exe). */
  resolveLaunch(name: string, harness: Harness): { file: string; args: string[] } {
    const p = agentPaths(name, harness);
    if (p.exe && exists(p.exe)) return { file: p.exe, args: [] };
    if (p.cmd && exists(p.cmd))
      return isWin ? { file: SYSTEM.cmd(), args: ['/d', '/c', p.cmd] } : { file: p.cmd, args: [] };
    if (dryRun) return { file: p.exe ?? p.cmd ?? name, args: [] };
    throw new Error('Cannot find an executable for ' + name + ' after provisioning.');
  }

  /** Where this agent is installed from: this PC's copy (the primary agent, when mapped in), npm or uv. */
  sourceOf(name: string, harness: Harness): AgentSource {
    if (session.provisioning.copyFromHost && harness.hostExecutable && name === session.harnessName) return 'host';
    return harness.uvPackage && !harness.npmPackage ? 'uv' : 'npm';
  }

  private async install(name: string, harness: Harness, env: NodeJS.ProcessEnv, refresh: boolean): Promise<void> {
    const p = agentPaths(name, harness);
    const cached = (p.exe !== null && exists(p.exe)) || (p.cmd !== null && exists(p.cmd));
    if (cached && !refresh) {
      log(name + ' already cached in persistent storage.');
      return;
    }
    mkdirp(p.dir);
    if (this.sourceOf(name, harness) === 'host') {
      const source = path.join(hostToolsDir, 'agents', name, harness.hostExecutable!);
      if (exists(source) && p.exe) {
        fs.copyFileSync(source, p.exe);
        log('Copied ' + name + ' from this PC: ' + source);
        return;
      }
      if (!session.provisioning.fallbackToInstall)
        throw new Error('Host copy of ' + name + ' unavailable and fallbackToInstall is false.');
      warn('Host copy of ' + name + ' not available; installing instead.');
    }
    if (harness.uvPackage && !harness.npmPackage) await installViaUv(name, harness, p.dir, env);
    else await installViaNpm(name, harness, p.dir, env);
  }
}

/** The one installer: its in-flight map spans the boot and every session. */
export const agents = new AgentInstaller();
