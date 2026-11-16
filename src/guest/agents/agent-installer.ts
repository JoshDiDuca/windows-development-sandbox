// Getting the agent (claude, codex, gemini, opencode, aider, ...) into persistent storage and working out how to
// start it.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { Harness } from '../../core/types.js';
import { errMsg } from '../../core/util/errors.js';
import { fetchRetry } from '../../shared/download/index.js';
import { SYSTEM } from '../../shared/system.js';
import { setupUv, uvVars } from '../toolchains/runtimes.js';
import { emptyEnv } from '../toolchains/tool-env.js';
import { dryRun, hostToolsDir, isWin, toolsDir } from '../runtime/paths.js';
import { execHeavy as execAsync } from '../runtime/pools.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log, warn } from '../runtime/log.js';
import { session } from '../runtime/session.js';
import { addMachineEnvironment } from '../setup/environment.js';
import { agentPaths as paths, isNewer, npmSpec, pendingPath, versionOf, type AgentPaths } from './agent-files.js';
import { downloadClaude, latestClaudeVersion } from './claude-release.js';
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
async function installViaUv(
  name: string,
  harness: Harness,
  dir: string,
  env: NodeJS.ProcessEnv,
  upgrade = false,
): Promise<void> {
  const uv = path.join(toolsDir, 'uv', 'uv.exe');
  log((upgrade ? 'Updating ' : 'Installing ') + harness.uvPackage + ' with uv (this can take a minute)...');
  if (dryRun) {
    log('(dry run) uv tool install ' + harness.uvPackage);
    return;
  }
  // The uv step runs only for projects that use uv, so an agent that needs it installs uv here.
  if (!exists(uv)) {
    log('Installing uv for ' + name + ' ...');
    await setupUv(emptyEnv());
  }
  const args = ['tool', 'install', '--force', ...(upgrade ? ['--upgrade'] : []), '--python', '3.12'];
  await execAsync(uv, [...args, harness.uvPackage!], {
    env: { ...env, ...uvVars(), UV_TOOL_BIN_DIR: dir },
  });
}

const installed = (p: AgentPaths): boolean => (p.exe !== null && exists(p.exe)) || (p.cmd !== null && exists(p.cmd));

/** Claude Code's own program (copied from this PC or downloaded): it updates from Anthropic's releases, not npm. */
const nativeClaude = (p: AgentPaths): boolean => p.exe !== null && path.basename(p.exe).toLowerCase() === 'claude.exe';

/** What `<exe> --version` says, or null when it does not run or says no version. */
function exeVersion(exe: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(exe, ['--version'], { env, timeout: 60000, windowsHide: true }, (error, stdout) =>
      resolve(error ? null : versionOf(String(stdout).slice(0, 200))),
    );
    child.stdin?.end(); // a program that does not know --version must not wait for input
  });
}

/**
 * Puts a waiting update (<exe>.new) in the program's place; false while a copy of the program runs (Windows refuses to
 * delete a running .exe, and the data folder refuses rename-over).
 */
export function applyPendingUpdate(exe: string | null): boolean {
  if (!exe || !exists(pendingPath(exe))) return false;
  try {
    fs.rmSync(exe, { force: true });
  } catch {
    return false; // it runs: the next start after it ends takes the update
  }
  fs.renameSync(pendingPath(exe), exe);
  return true;
}

const NpmVersionSchema = z.object({ version: z.string().max(64) });

function npmInstalledVersion(dir: string, pkg: string): string | null {
  try {
    const file = path.join(dir, 'node_modules', ...pkg.split('/'), 'package.json');
    return NpmVersionSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).version;
  } catch {
    return null; // not installed by npm (or damaged): the update installs it
  }
}

async function npmLatestVersion(pkg: string, tag: string): Promise<string> {
  const url = 'https://registry.npmjs.org/' + pkg.replace('/', '%2f') + '/' + encodeURIComponent(tag);
  return NpmVersionSchema.parse(await (await fetchRetry(url, {}, 2, 15000)).json()).version;
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
  private readonly updating = new Map<string, Promise<string>>();
  /** Agents whose launch update check ran in this process (once per agent, not once per session). */
  private readonly checked = new Set<string>();

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
      .then(() => this.updateAtLaunch(name, harness, env))
      .then(() => putOnPath(agentPaths(name, harness).dir, env))
      .finally(() => this.installing.delete(name));
    this.installing.set(name, work);
    return work;
  }

  /** Program + arguments that start the agent (an npm .cmd shim has to go through cmd.exe). */
  resolveLaunch(name: string, harness: Harness): { file: string; args: string[] } {
    const p = agentPaths(name, harness);
    applyPendingUpdate(p.exe);
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

  /**
   * Brings an agent to its latest release: Claude Code from Anthropic's releases (staged as claude.exe.new while a
   * copy runs), npm and uv agents with their installer. Returns what happened, in words.
   */
  update(name: string, harness: Harness, env: NodeJS.ProcessEnv): Promise<string> {
    const current = this.updating.get(name);
    if (current) return current;
    const work = this.updateNow(name, harness, env).finally(() => this.updating.delete(name));
    this.updating.set(name, work);
    return work;
  }

  /** provisioning.updateAgents: the update check when an agent is first provisioned in this process; never fatal. */
  private async updateAtLaunch(name: string, harness: Harness, env: NodeJS.ProcessEnv): Promise<void> {
    if (session.provisioning.updateAgents === false || dryRun || this.checked.has(name)) return;
    this.checked.add(name);
    try {
      log(await this.update(name, harness, env));
    } catch (e) {
      warn('Could not update ' + name + ' (' + errMsg(e) + '); it starts with the installed version.');
    }
  }

  private async updateNow(name: string, harness: Harness, env: NodeJS.ProcessEnv): Promise<string> {
    const p = agentPaths(name, harness);
    if (!installed(p)) {
      this.checked.add(name); // a fresh install is the latest: provision must not wait for this update
      await this.provision(name, harness, env, false);
      return name + ' installed.';
    }
    if (nativeClaude(p)) return this.updateClaude(name, p.exe!, env);
    if (harness.npmPackage) {
      const { name: pkg, tag } = npmSpec(harness.npmPackage);
      if (!tag) return name + ' is pinned to ' + harness.npmPackage + '; change npmPackage to update it.';
      const [from, latest] = [npmInstalledVersion(p.dir, pkg), await npmLatestVersion(pkg, tag)];
      if (!isNewer(latest, from)) return name + ' is up to date (' + latest + ').';
      try {
        await installViaNpm(name, { ...harness, npmPackage: pkg + '@' + latest }, p.dir, env);
      } catch (e) {
        throw new Error(errMsg(e) + '. Close the running ' + name + ' sessions and try again.');
      }
      return name + ' updated: ' + (from ?? 'unknown') + ' -> ' + latest + '.';
    }
    if (harness.uvPackage) {
      await installViaUv(name, harness, p.dir, env, true);
      return name + ' updated.';
    }
    return name + ' comes from this PC: update it there, then start the sandbox again.';
  }

  /** Claude Code: compares with the latest release and downloads it (checked against its manifest) when newer. */
  private async updateClaude(name: string, exe: string, env: NodeJS.ProcessEnv): Promise<string> {
    applyPendingUpdate(exe);
    const [from, latest] = [await exeVersion(exe, env), await latestClaudeVersion()];
    if (!isNewer(latest, from)) return name + ' is up to date (' + from + ').';
    const pending = pendingPath(exe);
    if (!exists(pending) || (await exeVersion(pending, env)) !== latest) {
      log('Downloading Claude Code ' + latest + ' (' + (from ?? 'unknown version') + ' installed)...');
      await downloadClaude(latest, pending);
    }
    if (applyPendingUpdate(exe)) return name + ' updated: ' + (from ?? 'unknown') + ' -> ' + latest + '.';
    return (
      name +
      ' ' +
      latest +
      ' is ready. Running ' +
      name +
      ' sessions keep ' +
      (from ?? 'the old version') +
      '; the next one started after they all close (or the next sandbox) runs ' +
      latest +
      '.'
    );
  }

  private async install(name: string, harness: Harness, env: NodeJS.ProcessEnv, refresh: boolean): Promise<void> {
    const p = agentPaths(name, harness);
    applyPendingUpdate(p.exe);
    const cached = installed(p);
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
