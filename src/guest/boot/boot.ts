// The boot inside the sandbox: network, hooks, developer tools, Git, Claude, the agent, then its first session.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeGuides } from './guide.js';
import { setupToolchains, type ToolchainResult } from '../toolchains/index.js';
import { agents } from '../agents/agent-installer.js';
import { agentShims, sbxAgentText, shimText } from '../agents/agent-files.js';
import { resetMachineBound, restoreLocalState } from '../agents/local-state.js';
import { installShellPath } from '../setup/shell-path.js';
import { linkProfileDirs } from '../agents/profile-links.js';
import { restoreClaudeMem } from '../setup/claude-mem.js';
import { syncClaudeProfile } from '../setup/claude-profile.js';
import { agentEnv, persistEnvironment } from '../setup/environment.js';
import { runHooks } from '../setup/hooks.js';
import { applyAllowOnly, proxyEnv } from '../network/allow-only.js';
import { applyNetworkPolicy, networkProblems, type LanState } from '../network/firewall.js';
import { writeManagedSettings } from '../setup/managed-policy.js';
import { applyPersonalization } from '../setup/desktop.js';
import { setupGitConfig } from '../setup/git-identity.js';
import { loginGithub, prepareGithubFolder } from '../setup/github-token.js';
import { ensurePtyHost } from '../sessions/pty-host.js';
import { pruneToolLeftovers } from '../toolchains/leftovers.js';
import { wanted } from '../toolchains/detect.js';
import { configureVscode } from '../toolchains/tools/vscode.js';
import { enableProcessAudit } from '../audit/process-audit.js';
import { setupVpn } from '../vpn/index.js';
import { now } from '../../shared/channel/run-dir.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { viewSession } from '../sessions/viewer.js';
import { saveBootEnv } from './boot-env.js';
import { primaryProject, saveProjectStatus } from './project-status.js';
import { dryRun, isWin, localDir, logsDir, run, toolsDir } from '../runtime/paths.js';
import { log, logPath, warn } from '../runtime/log.js';
import { mkdirp } from '../runtime/fs.js';
import { session, workspace } from '../runtime/session.js';
import { applyBootEnvironment, BOOT_SECRETS_VARIABLE, takeSecrets } from '../runtime/secrets.js';
import type { SecretsFile } from '../../shared/channel/secrets.js';
import { setSandboxStatus } from '../runtime/status.js';
import { errMsg } from '../../core/util/errors.js';

const STEPS = 9;
const PRIMARY_POLLS = 600;
const POLL_MS = 500;
const VSCODE_LANGUAGES = ['python', 'java', 'go', 'rust', 'cpp', 'msvc', 'dotnet', 'ruby', 'php', 'deno', 'pwsh'];

/** Step n of STEPS: a line in the window and the host's progress (the short title, with what is set up in it). */
function step(n: number, title: string): void {
  log('\n\x1b[36m[' + n + '/' + STEPS + '] ' + title + '\x1b[0m');
  setSandboxStatus(n === 1 ? 'booting' : 'provisioning', '[' + n + '/' + STEPS + '] ' + title, {
    step: n,
    steps: STEPS,
    title: title.replace(/ \(.*\)$/, ''),
    active: [],
    done: 0,
    total: 0,
  });
}

/** Runs work that may fail without stopping the boot (a warning says what failed). */
async function soft(what: string, work: () => unknown): Promise<void> {
  try {
    await work();
  } catch (e) {
    warn(what + ' failed (continuing): ' + errMsg(e));
  }
}

function startDaemon(env: NodeJS.ProcessEnv, secrets: SecretsFile): void {
  spawn(process.execPath, [path.join(path.dirname(process.argv[1]), 'daemon.js')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...env,
      AGENT_LOG_PREFIX: 'daemon',
      // The agent's environment (it may hold API keys): the daemon moves it into memory and removes this at once.
      ...(secrets.harnessEnvironment
        ? { [BOOT_SECRETS_VARIABLE]: JSON.stringify({ harnessEnvironment: secrets.harnessEnvironment }) }
        : {}),
    },
  }).unref();
}

/**
 * `sbx-db` for terminals and `sandbox db`: this boot's Node running runtime\db.js (on the sandbox's disk, rewritten
 * each boot).
 */
function writeDbCommand(): string {
  const dir = mkdirp(path.join(localDir, 'bin'));
  const db = path.join(path.dirname(process.argv[1]), 'db.js');
  fs.writeFileSync(
    path.join(dir, 'sbx-db.cmd'),
    '@setlocal\r\n@set AGENT_LOG_PREFIX=db\r\n@"' + process.execPath + '" "' + db + '" %*\r\n',
  );
  writeAgentCommands(dir);
  return dir;
}

/**
 * `claude`, `codex` ... by name in every terminal tab, installed yet or not (the command installs the agent on first
 * use), and `sbx-agent`. Written to the sandbox's disk each boot, next to `sbx-db`.
 */
function writeAgentCommands(dir: string): void {
  const install = { node: process.execPath, script: path.join(path.dirname(process.argv[1]), 'agent.js') };
  for (const shim of agentShims(toolsDir, session.agents ?? {}))
    fs.writeFileSync(path.join(dir, shim.command + '.cmd'), shimText(shim, install));
  fs.writeFileSync(path.join(dir, 'sbx-agent.cmd'), sbxAgentText(install));
}

async function waitForPrimary(): Promise<boolean> {
  for (let i = 0; i < PRIMARY_POLLS; i++) {
    const s = run.readSession(session.launchId);
    if (s?.phase === 'running') return true;
    if (s?.phase === 'failed' || s?.phase === 'exited') {
      warn(s.message);
      return false;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

/** The languages VS Code gets extensions for: every language toolchain this project uses. */
function vscodeLanguages(): string[] {
  const toolchains = session.toolchains as unknown as Record<string, { enabled: boolean | 'auto' }>;
  return VSCODE_LANGUAGES.filter((t) => wanted(toolchains[t]?.enabled ?? false, t));
}

/** One boot of the sandbox, step by step: each step is a method, in the order they run. */
export class Boot {
  private ptyHost: string | null = null;
  private lan: LanState = session.networking ? 'open' : 'offline';
  private readonly gitAccess = session.provisioning.git.access ?? 'full';
  /** What the host handed over in its one-shot file (read and deleted at the start of run()). */
  private secrets: SecretsFile = {};

  async run(): Promise<void> {
    log(
      'Agent sandbox: ' +
        session.project +
        ' | workspace ' +
        workspace +
        ' | agent ' +
        session.harnessName +
        ' | log ' +
        logPath,
    );
    if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory())
      throw new Error('Workspace folder is missing in the sandbox: ' + workspace);
    mkdirp(toolsDir);
    mkdirp(run.root);
    this.secrets = takeSecrets(session.launchId);
    applyBootEnvironment(this.secrets.harnessEnvironment);
    prepareGithubFolder(this.secrets.githubToken);
    await this.networkAndSessionHost();
    await this.hooksAndDesktop();
    const { tools, env } = await this.developerTools();
    await this.vpn();
    await this.gitIdentity(env);
    await this.claude(tools);
    await this.agent(env);
    this.preAgentHooks(env);
    await this.start(env);
  }

  private async networkAndSessionHost(): Promise<void> {
    step(1, 'Network and session host');
    if (isWin && !dryRun && session.attach.enabled)
      await soft('Building the session host', () => {
        this.ptyHost = ensurePtyHost();
      });
    await soft('Private-network blocking', async () => {
      this.lan = await applyNetworkPolicy(this.ptyHost);
    });
    await soft('Audit', enableProcessAudit);
  }

  private async hooksAndDesktop(): Promise<void> {
    step(2, 'Pre-provision hooks and desktop');
    runHooks('pre-provision', process.env);
    await soft('Personalisation', applyPersonalization);
  }

  /** Toolchains, databases, apps, the network proxy and VS Code; then the agent environment, saved machine-wide. */
  private async developerTools(): Promise<{ tools: ToolchainResult; env: NodeJS.ProcessEnv }> {
    step(3, 'Developer tools (the first start downloads them once; later starts are quick)');
    const basePath = process.env.PATH ?? '';
    const tools = await setupToolchains(session.toolchains, session.versions, {
      gitEnabled: session.provisioning.git.enabled,
      gitAccess: this.gitAccess,
      hostGit: session.hostTools.git,
      refresh: session.provisioning.refresh,
      databases: session.databases ?? [],
      apps: session.apps,
    });
    for (const p of networkProblems()) tools.summary.push('PROTECTION MISSING: ' + p);
    if (!dryRun) tools.prepend.push(writeDbCommand());
    // network.allowOnly / network.proxy: everything started from now on uses the proxy.
    Object.assign(tools.vars, proxyEnv());
    await soft('Network: allow only some hosts', async () => {
      if (await applyAllowOnly())
        tools.summary.push('network: only network.allowOnly hosts (refused: logs\\netproxy.log)');
    });
    const vscode = session.toolchains.vscode;
    if (vscode.enabled && vscode.setup !== false)
      await soft('VS Code setup', () =>
        configureVscode(tools, {
          toolchains: ['node', ...vscodeLanguages()],
          databases: (session.databases ?? []).map((d) => d.database),
          config: vscode,
          workspace,
        }),
      );
    const env = agentEnv(tools);
    persistEnvironment(env, Object.keys(tools.vars));
    await soft('Shell start-up PATH', installShellPath);
    saveBootEnv({
      basePath,
      toolVars: Object.keys(tools.vars),
      steps: tools.steps,
      summary: tools.summary,
      lan: this.lan,
    });
    saveProjectStatus(primaryProject(), workspace, 'ready', 'Ready', session.databases ?? [], tools.summary);
    for (const line of tools.summary) log('  ' + line);
    await soft('Cleaning old tool builds', () => pruneToolLeftovers());
    return { tools, env };
  }

  /** vpn.enabled: the tunnel and its kill switch, before anything else uses the network (git, the agent). */
  private async vpn(): Promise<void> {
    step(4, session.vpn ? 'VPN (' + session.vpn.server + ')' : 'VPN (off)');
    if (!session.vpn) return;
    await soft('VPN', async () => {
      await setupVpn(this.secrets, this.ptyHost);
    });
  }

  private async gitIdentity(env: NodeJS.ProcessEnv): Promise<void> {
    step(5, 'Git identity');
    await soft('Git config', () => setupGitConfig(env));
    // After the VPN (gh checks the token with GitHub) and the git config (setup-git adds to it).
    const token = this.secrets.githubToken;
    if (token) {
      this.secrets = { ...this.secrets, githubToken: undefined };
      await soft('GitHub token', () => loginGithub(token, env));
    }
  }

  private async claude(tools: ToolchainResult): Promise<void> {
    step(6, 'Claude settings, history and claude-mem');
    if (session.harnessName === 'claude')
      await soft('Claude settings', () => syncClaudeProfile(this.secrets.claudeCredentials));
    await soft('claude-mem restore', restoreClaudeMem);
    await soft('Agent files of the last sandbox', resetMachineBound);
    await soft('Agent databases restore', restoreLocalState);
    await soft('Sandbox guide for the agent', () => writeGuides(tools.summary, this.lan));
    await soft('Claude managed settings', () => writeManagedSettings(this.gitAccess));
  }

  private async agent(env: NodeJS.ProcessEnv): Promise<void> {
    step(7, 'Agent: ' + session.harnessName);
    linkProfileDirs(session.agentProfileDirs ?? {});
    if (session.harness) await agents.provision(session.harnessName, session.harness, env);
  }

  private preAgentHooks(env: NodeJS.ProcessEnv): void {
    step(8, 'Pre-agent hooks');
    runHooks('pre-agent', env);
  }

  /** Ready: starts the session daemon and, with an agent, its first session, shown in this window. */
  private async start(env: NodeJS.ProcessEnv): Promise<void> {
    step(9, 'Starting ' + session.harnessName);
    setSandboxStatus('ready', 'Ready');
    // No agent, or a restart that adds a project (the host opens its sessions itself once the sandbox is ready).
    if (!session.harness || session.autoSession === false) {
      if (!dryRun) startDaemon(env, this.secrets);
      log('Ready' + (session.harness ? '' : ' (no agent requested)') + '. Workspace: ' + workspace);
      return;
    }
    if (dryRun) {
      const launch = agents.resolveLaunch(session.harnessName, session.harness);
      log(
        '(dry run) would run: ' +
          [launch.file, ...launch.args, ...session.harness.arguments, ...session.harnessArguments].join(' ') +
          ' | cwd=' +
          workspace,
      );
      runHooks('post-agent', env);
      return;
    }
    startDaemon(env, this.secrets);
    writeJsonAtomic(run.requestFile(session.launchId), {
      kind: 'session',
      id: session.launchId,
      harness: session.harnessName,
      args: session.harnessArguments,
      cwd: workspace,
      createdAt: now(),
    });
    if (!(await waitForPrimary())) throw new Error('The agent session did not start. Logs: ' + logsDir);
    log('If Claude asks you to sign in, do it once; the login is saved in persistent storage.');
    if (process.stdin.isTTY) await viewSession(session.launchId);
    log('\nThis window stays open in ' + workspace + '. Other sessions keep running in their own tabs.');
  }
}

export function runBoot(): Promise<void> {
  return new Boot().run();
}
