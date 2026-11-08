// The boot inside the sandbox: network, hooks, developer tools, Git, Claude, the agent, then its first session.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeGuides } from './guide.js';
import { setupToolchains, type ToolchainResult } from '../toolchains/index.js';
import { mergeToolchains } from '../toolchains/setup.js';
import { tool } from '../toolchains/tool-env.js';
import { installedAddon } from '../setup/agent-addons.js';
import { agents } from '../agents/agent-installer.js';
import { agentArguments, agentShims, codexArguments, sbxAgentText, shimText } from '../agents/agent-files.js';
import { codexBootConfig, resetMachineBound, restoreLocalState } from '../agents/local-state.js';
import { installShellPath } from '../setup/shell-path.js';
import { linkProfileDirsAsync } from '../agents/profile-links.js';
import { restoreClaudeMem } from '../setup/claude-mem.js';
import { syncClaudeProfile } from '../setup/claude-profile.js';
import { agentEnv, persistEnvironment } from '../setup/environment.js';
import { hasHooks, runHooks } from '../setup/hooks.js';
import { applyAllowOnly, proxyEnv } from '../network/allow-only.js';
import { applyNetworkPolicy, networkProblems, type LanState } from '../network/firewall.js';
import { writeManagedSettings } from '../setup/managed-policy.js';
import { writeAddonMcpServers } from '../setup/addon-mcp.js';
import { awaitHeadroom, spawnHeadroom } from '../setup/headroom.js';
import { applyPersonalization } from '../setup/desktop.js';
import { keepBrowsersOffGpu } from '../setup/browser-gpu.js';
import { setupGitConfig } from '../setup/git-identity.js';
import { loginGithub, prepareGithubFolder } from '../setup/github-token.js';
import { applyServiceAccounts } from '../accounts/apply.js';
import { devToolsFor } from '../devtools/registry.js';
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
import { BOOT_DEFS, STAGES, stageName, stageTitle, type BootTaskId, type StageWho } from './graph.js';
import { BootRunner, duration, type RunnerStatus, type TaskRun } from './runner.js';
import { BootConsole } from './boot-console.js';
import { stepsDetail } from './progress-view.js';
import { installPools } from '../runtime/pools.js';
import { primaryProject, saveProjectStatus } from './project-status.js';
import { dryRun, isWin, localDir, logsDir, run, toolsDir } from '../runtime/paths.js';
import { log, logPath, notice, record, runQuiet, warn, withLogContext } from '../runtime/log.js';
import { mkdirp } from '../runtime/fs.js';
import { session, workspace } from '../runtime/session.js';
import { applyBootEnvironment, BOOT_SECRETS_VARIABLE, takeSecrets } from '../runtime/secrets.js';
import type { SecretsFile } from '../../shared/channel/secrets.js';
import { setBackgroundWork, setSandboxStatus } from '../runtime/status.js';
import { errMsg } from '../../core/util/errors.js';

const PRIMARY_POLLS = 600;
const POLL_MS = 500;
const VSCODE_LANGUAGES = [
  'python',
  'java',
  'go',
  'rust',
  'cpp',
  'msvc',
  'unreal',
  'dotnet',
  'ruby',
  'php',
  'deno',
  'pwsh',
];

function startDaemon(env: NodeJS.ProcessEnv, secrets: SecretsFile): void {
  spawn(process.execPath, [path.join(path.dirname(process.argv[1]), 'daemon.js')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...env,
      AGENT_LOG_PREFIX: 'daemon',
      // The agent's environment (it may hold API keys): the daemon moves it into memory and removes this at once.
      // The live-folder key (projects.liveFolders "hcs") goes the same way into the daemon's own state.
      ...(secrets.harnessEnvironment || secrets.liveFoldersKey
        ? {
            [BOOT_SECRETS_VARIABLE]: JSON.stringify({
              ...(secrets.harnessEnvironment ? { harnessEnvironment: secrets.harnessEnvironment } : {}),
              ...(secrets.liveFoldersKey ? { liveFoldersKey: secrets.liveFoldersKey } : {}),
            }),
          }
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
  writeDevToolCommands(dir);
  return dir;
}

/** sbx-steam, sbx-fivem, sbx-android for the toolchains that are on: runtime\tool.js with that helper. */
function writeDevToolCommands(dir: string): void {
  const script = path.join(path.dirname(process.argv[1]), 'tool.js');
  for (const tool of devToolsFor(session.toolchains))
    fs.writeFileSync(
      path.join(dir, 'sbx-' + tool.name + '.cmd'),
      '@setlocal\r\n@set AGENT_LOG_PREFIX=' +
        tool.name +
        '\r\n@"' +
        process.execPath +
        '" "' +
        script +
        '" ' +
        tool.name +
        ' %*\r\n',
    );
}

/**
 * `claude`, `codex` ... by name in every terminal tab, installed yet or not (the command installs the agent on first
 * use), and `sbx-agent`. Written to the sandbox's disk each boot, next to `sbx-db`.
 */
function writeAgentCommands(dir: string): void {
  const install = { node: process.execPath, script: path.join(path.dirname(process.argv[1]), 'agent.js') };
  for (const shim of agentShims(
    toolsDir,
    session.agents ?? {},
    session.codex ? { codex: codexArguments(session.codex) } : {},
  ))
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

/** Headroom's own marker: the app was installed in an earlier boot (so the Apps step will not replace its folder). */
function headroomInstalledBefore(): boolean {
  return (
    !session.provisioning.refresh &&
    installedAddon('headroom') !== null &&
    fs.existsSync(path.join(tool('apps', 'headroom'), '.agent-sandbox-app'))
  );
}

/** Warns and goes on (a step inside a task that must not stop the rest of that task). */
async function soft(what: string, work: () => unknown): Promise<void> {
  try {
    await work();
  } catch (e) {
    warn(what + ' failed (continuing): ' + errMsg(e));
  }
}

/** One boot of the sandbox: a graph of tasks (graph.ts) run by the BootRunner, each task a method below. */
export class Boot {
  // The shared boot state: each field is written by one task (graph.ts says which); readers come after that task.
  private ptyHost: string | null = null;
  private lan: LanState = session.networking ? 'open' : 'offline';
  private tools: (ToolchainResult & { later: Promise<ToolchainResult> | null }) | null = null;
  private dbBin: string | null = null;
  private allowSummary: string[] = [];
  private vscodeSummary: string[] = [];
  private env: NodeJS.ProcessEnv = {};
  private toolVars: string[] = [];
  private summary: string[] = [];
  private headroom: string | null = null;

  private readonly gitAccess = session.provisioning.git.access ?? 'full';
  /** What the host handed over in its one-shot file (read and deleted in the prelude; never changed afterwards). */
  private secrets: Readonly<SecretsFile> = Object.freeze({});
  private basePath = '';
  private readonly startedAt = Date.now();
  private readonly who: StageWho = {
    ...(session.vpn ? { vpnServer: session.vpn.server } : {}),
    agent: session.harnessName,
  };
  /** The console while the boot runs: the stage rows, warnings and summary (released before the first session). */
  private readonly progress = BootConsole.create(
    Array.from({ length: STAGES }, (_, i) => ({ stage: i + 1, name: stageName(i + 1, this.who) })),
    BOOT_DEFS.filter((d) => !d.background),
    { plain: dryRun },
  );
  private openGate: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.openGate = resolve;
  });
  /** The boot is ready: the runner no longer writes the status (the session owns it). */
  private ready = false;
  private lastStatus: RunnerStatus | null = null;
  private activeSteps: { name: string; percent?: number }[] = [];
  private stepsDone = 0;
  private stepsTotal = 0;

  async run(): Promise<void> {
    const agent = session.harness ? session.harnessName : 'no agent';
    this.progress.start('Agent sandbox · ' + session.project + ' · ' + agent + ' · ' + workspace);
    let runner: BootRunner<BootTaskId>;
    try {
      runner = await this.foreground();
    } catch (e) {
      this.progress.release(null);
      throw e;
    }
    this.progress.release({
      ms: Date.now() - this.startedAt,
      outcomes: runner.results(),
      background: this.backgroundNames(),
      logPath,
    });
    if (dryRun) {
      // Same graph, one task at a time: the background tasks run in place, right after the session.
      this.openGate();
      await runner.run('background');
      return;
    }
    this.openGate();
    const later = runner.run('background');
    // The viewer owns the console now: the background tasks write to the log file only.
    if (session.harness && session.autoSession !== false && process.stdin.isTTY) {
      await viewSession(session.launchId);
      log('\nThis window stays open in ' + workspace + '. Other sessions keep running in their own tabs.');
    }
    await later.catch((e: unknown) => warn('Background work failed: ' + errMsg(e)));
  }

  /** The prelude, then every foreground task (the console shows them). */
  private async foreground(): Promise<BootRunner<BootTaskId>> {
    if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory())
      throw new Error('Workspace folder is missing in the sandbox: ' + workspace);
    this.basePath = process.env.PATH ?? '';
    mkdirp(toolsDir);
    mkdirp(run.root);
    // The prelude is sequential: it changes process.env, so it ends before any task starts a program.
    this.secrets = await this.takeSecretsAndAccounts();
    applyBootEnvironment(this.secrets.harnessEnvironment);
    prepareGithubFolder(this.secrets.githubToken);
    installPools();

    const runner = new BootRunner<BootTaskId>(BOOT_DEFS, this.tasks(), {
      trace: (line) => record(line),
      warn: (line, quiet) => (quiet ? runQuiet(() => warn(line)) : warn(line)),
      now: () => Date.now(),
      dryRun,
      stages: STAGES,
      stageTitle: (n) => this.stageTitle(n),
      status: (s) => {
        this.lastStatus = s;
        this.publish();
      },
      observer: this.progress,
      inContext: (ctx, work) => withLogContext({ stage: ctx.stage, task: ctx.title, quiet: ctx.quiet }, work),
    });
    await runner.run('foreground');
    return runner;
  }

  private stageTitle(n: number): string {
    return stageTitle(n, this.who);
  }

  /** The toolchain steps that go on after the boot is ready (Visual Studio and what needs it), in plan order. */
  private backgroundNames(): string[] {
    const t = this.tools;
    if (!t?.later) return [];
    return t.names.filter((n) => !(n in t.steps));
  }

  /** Runs a stage's hooks; they write to the terminal themselves, so the progress block steps aside for them. */
  private hooks(stage: string, env: NodeJS.ProcessEnv): void {
    if (hasHooks(stage)) this.progress.aside(() => runHooks(stage, env));
  }

  /**
   * The host's one-shot file, read once. Your saved service sign-ins (accounts.<kind>.share) go to their tools before
   * anything opens them, and leave memory at once; what they give the agent (EXPO_TOKEN ...) joins its environment
   * (in memory only).
   */
  private async takeSecretsAndAccounts(): Promise<Readonly<SecretsFile>> {
    const taken = takeSecrets(session.launchId);
    const given = taken.serviceAccounts;
    let secrets: SecretsFile = { ...taken, serviceAccounts: undefined };
    if (!dryRun && (given || session.accountLeases?.length)) {
      try {
        const env = await applyServiceAccounts(given, {
          leased: session.accountLeases ?? [],
          say: (line) => log(line),
        });
        if (Object.keys(env).length)
          secrets = { ...secrets, harnessEnvironment: { ...env, ...secrets.harnessEnvironment } };
      } catch (e) {
        warn('Service sign-ins failed (continuing): ' + errMsg(e));
      }
    }
    return Object.freeze(secrets);
  }

  /** The host's progress line: the runner's stage, the tasks that run now, and what the toolchain scheduler runs. */
  private publish(): void {
    const s = this.lastStatus;
    if (!s || this.ready) return;
    setSandboxStatus(s.phase, s.message, {
      step: s.step,
      steps: STAGES,
      title: stageName(s.step, this.who),
      active: [...s.running.map((name) => ({ name })), ...this.activeSteps],
      done: this.stepsDone,
      total: this.stepsTotal,
    });
  }

  /** Every task of the graph. */
  private tasks(): Record<BootTaskId, TaskRun> {
    return {
      // 1 - network and session host
      ptyhost: () => {
        if (isWin && !dryRun && session.attach.enabled) this.ptyHost = ensurePtyHost();
      },
      network: async () => {
        this.lan = await applyNetworkPolicy(this.ptyHost);
      },
      audit: () => enableProcessAudit(),
      // 2 - pre-provision hooks and desktop
      hooksPreProvision: () => this.hooks('pre-provision', process.env),
      desktop: () => applyPersonalization(),
      browserGpu: () => keepBrowsersOffGpu(),
      // 3 - developer tools
      toolchains: () => this.toolchains(),
      dbCommands: () => {
        if (!dryRun) this.dbBin = writeDbCommand();
      },
      allowOnly: async () => {
        if (await applyAllowOnly())
          this.allowSummary = ['network: only network.allowOnly hosts (refused: logs\\netproxy.log)'];
      },
      vscode: () => this.vscode(),
      env: () => this.environment(),
      bootEnv: () => this.bootEnv(),
      // 4 - VPN
      vpn: async () => {
        if (session.vpn) await setupVpn(this.secrets, this.ptyHost);
      },
      // 5 - git
      gitConfig: () => setupGitConfig(this.env),
      githubLogin: async () => {
        const token = this.secrets.githubToken;
        if (token) await loginGithub(token, this.env);
      },
      // 6 - Claude settings
      claudeProfile: async () => {
        if (session.harnessName === 'claude') await syncClaudeProfile(this.secrets.claudeCredentials);
      },
      claudeMem: () => restoreClaudeMem(),
      agentState: async () => {
        // All three touch the agents' state folders: one task, in this order, each failing on its own.
        await soft('Agent files of the last sandbox', resetMachineBound);
        await soft('Codex settings', codexBootConfig);
        await soft('Agent databases restore', restoreLocalState);
      },
      headroomSpawn: async () => {
        // Early only when the proxy is installed already (the Apps step must not replace a running one).
        if (headroomInstalledBefore()) await spawnHeadroom(this.headroomAgentEnv());
      },
      mcpServers: () => {
        writeAddonMcpServers();
      },
      headroomReady: async () => {
        this.headroom = await awaitHeadroom(this.headroomAgentEnv());
      },
      managedSettings: () => writeManagedSettings(this.gitAccess, this.headroom),
      guide: () => {
        writeGuides(this.summary, this.lan);
      },
      // 7 - agent
      profileLinks: () => linkProfileDirsAsync(session.agentProfileDirs ?? {}),
      agentProvision: async () => {
        if (session.harness) await agents.provision(session.harnessName, session.harness, this.env);
      },
      // 8 - pre-agent hooks
      hooksPreAgent: () => this.hooks('pre-agent', this.env),
      // 9 - start
      session: () => this.start(),
      // After the first session runs
      toolchainsLater: () => this.toolchainsLater(),
      prune: () => {
        pruneToolLeftovers();
      },
    };
  }

  /** The agent environment before the toolchains are known (the proxy needs no PATH of theirs). */
  private headroomAgentEnv(): NodeJS.ProcessEnv {
    return agentEnv({ vars: { ...session.toolchains.environment, ...proxyEnv() }, prepend: [], append: [] });
  }

  /** Foreground toolchain steps and databases and apps; Visual Studio and what needs it wait for the background. */
  private async toolchains(): Promise<void> {
    const deferHeavy = !dryRun && !session.vpn && !(session.network.allowOnly ?? []).length;
    this.tools = await setupToolchains(
      session.toolchains,
      session.versions,
      {
        gitEnabled: session.provisioning.git.enabled,
        gitAccess: this.gitAccess,
        hostGit: session.hostTools.git,
        refresh: session.provisioning.refresh,
        databases: session.databases ?? [],
        apps: session.apps,
        deferHeavy,
        ...(session.pcInstalls ? { pcInstalls: session.pcInstalls } : {}),
      },
      {
        progress: (p) => {
          this.progress.detail(
            'toolchains',
            stepsDetail(
              p.active.map((a) => a.name + (a.percent === undefined ? '' : ' ' + Math.round(a.percent) + '%')),
              p.done,
              p.total,
            ),
          );
          this.activeSteps = p.active;
          this.stepsDone = p.done;
          this.stepsTotal = p.total;
          this.publish();
        },
        // Headroom is installed by the Apps step on a first boot: start it as soon as that step is done.
        onDone: (name) => {
          if (name === 'Apps')
            void spawnHeadroom(this.headroomAgentEnv()).catch((e: unknown) =>
              warn('Headroom proxy failed (continuing): ' + errMsg(e)),
            );
        },
      },
      { gate: this.gate },
    );
  }

  private vscode(): void {
    const vscode = session.toolchains.vscode;
    const tools = this.tools!;
    if (!vscode.enabled || vscode.setup === false) return;
    // configureVscode only adds lines to `summary`: they are collected here and merged by the bootEnv task.
    const lines: string[] = [];
    configureVscode(
      { vars: tools.vars, prepend: tools.prepend, append: tools.append, summary: lines },
      {
        toolchains: ['node', ...vscodeLanguages()],
        databases: (session.databases ?? []).map((d) => d.database),
        config: vscode,
        workspace,
      },
    );
    this.vscodeSummary = lines;
  }

  /** The agent environment, saved machine-wide, and the PATH of new shells. */
  private async environment(): Promise<void> {
    const tools = this.tools!;
    // network.allowOnly / network.proxy: everything started from now on uses the proxy.
    const vars = { ...tools.vars, ...proxyEnv() };
    this.toolVars = Object.keys(vars);
    this.env = agentEnv({
      vars,
      prepend: [...tools.prepend, ...(this.dbBin ? [this.dbBin] : [])],
      append: tools.append,
    });
    await persistEnvironment(this.env, this.toolVars);
    await soft('Shell start-up PATH', installShellPath);
  }

  /** What the tools left: lines for the guide and status, and what later projects start from. */
  private bootEnv(): void {
    const tools = this.tools!;
    this.summary = this.summaryLines(tools.summary);
    saveBootEnv({
      basePath: this.basePath,
      toolVars: this.toolVars,
      steps: tools.steps,
      summary: this.summary,
      lan: this.lan,
    });
    saveProjectStatus(primaryProject(), workspace, 'ready', 'Ready', session.databases ?? [], this.summary);
    this.progress.summary(this.summary);
  }

  /** The toolchains' lines, then the missing protections, allowOnly and VS Code (in this order). */
  private summaryLines(toolchainLines: readonly string[]): string[] {
    return [
      ...toolchainLines,
      ...networkProblems().map((p) => 'PROTECTION MISSING: ' + p),
      ...(session.clipboard ? ['Clipboard: ' + session.clipboard.line] : []),
      ...this.allowSummary,
      ...this.vscodeSummary,
    ];
  }

  /** Visual Studio and what depends on it (after the session has started): merged into the environment again. */
  private async toolchainsLater(): Promise<void> {
    const tools = this.tools;
    if (!tools?.later) return;
    const names = this.backgroundNames();
    const name = names.length ? names.slice(0, 3).join(', ') + (names.length > 3 ? ' ...' : '') : 'Visual Studio';
    const began = Date.now();
    setBackgroundWork([{ name, state: 'running' }]);
    log('Background: ' + name + ' (installing)');
    try {
      const part = await tools.later;
      const steps = { ...tools.steps, ...part.steps };
      const all = mergeToolchains(session.toolchains, tools.names, steps);
      const vars = { ...all.vars, ...proxyEnv() };
      const env = agentEnv({
        vars,
        prepend: [...all.prepend, ...(this.dbBin ? [this.dbBin] : [])],
        append: all.append,
      });
      // Additive: nothing the boot or a project added since is taken away.
      await persistEnvironment(env, Object.keys(vars), true);
      this.summary = this.summaryLines(all.summary);
      saveBootEnv({
        basePath: this.basePath,
        toolVars: Object.keys(vars),
        steps,
        summary: this.summary,
        lan: this.lan,
      });
      saveProjectStatus(primaryProject(), workspace, 'ready', 'Ready', session.databases ?? [], this.summary);
      await soft('Sandbox guide for the agent', () => writeGuides(this.summary, this.lan));
      setBackgroundWork([{ name, state: 'done' }]);
      log('Background done in ' + duration(Date.now() - began) + ': ' + name);
    } catch (e) {
      setBackgroundWork([{ name, state: 'failed' }]);
      throw e;
    }
  }

  /** Ready: starts the session daemon and, with an agent, its first session (shown in this window by run()). */
  private async start(): Promise<void> {
    const env = this.env;
    this.ready = true;
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
          [
            launch.file,
            ...launch.args,
            ...agentArguments(session.harnessName, session.harness, session.codex),
            ...session.harnessArguments,
          ].join(' ') +
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
    notice('If Claude asks you to sign in, do it once; the login is saved in persistent storage.');
  }
}

export function runBoot(): Promise<void> {
  return new Boot().run();
}
