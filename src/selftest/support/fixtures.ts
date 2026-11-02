// A fake "host PC" inside the temp folder: Node, claude.exe, a ~/.claude profile, workspaces, and helpers to resolve a
// run, generate the sandbox for it, run the guest against it and start the CLI. Shared by all suites.
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Config, HostProbe, ResolvedRun, RunRequest } from '../../core/types.js';
import { DEFAULTS } from '../../core/config/index.js';
import { generateSandbox } from '../../host/launch/index.js';
import { resolveRun } from '../../core/run/index.js';
import type { Harness } from './harness.js';
import { onFixedPc } from './pc-memory.js';

export const HOST_NODE_VERSION = 'v22.3.0';

/** Colour codes are removed from captured output, so tests can match plain text. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

export interface NodeRun {
  status: number | null;
  out: string;
  timedOut: boolean;
}
export interface NodeRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Runs `node <args>` and collects stdout + stderr (colours removed). Never throws; a hung process is killed at the
 * timeout.
 */
export function runNode(args: string[], options: NodeRunOptions = {}): Promise<NodeRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
    });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 120000);
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.on('error', (e) => {
      out += String(e);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status: timedOut ? null : status, out: stripAnsi(out), timedOut });
    });
  });
}

// The fixtures type is inferred from this function (Fixtures below), so it has no written return type.
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function createFixtures(t: Harness) {
  const { at, write } = t;

  // The PC: Node with npm, Claude Code, a ~/.claude profile (with a login that must never be copied) and
  // ~/.claude.json.
  const hostNode = at('host-node');
  write(path.join(hostNode, 'node.exe'), 'x');
  write(path.join(hostNode, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
  const hostClaude = at('host-claude');
  write(path.join(hostClaude, 'claude.exe'), 'fake-claude');
  const hostProfile = at('host-dot-claude');
  write(path.join(hostProfile, 'settings.json'), '{ "theme": "dark" }');
  write(path.join(hostProfile, 'CLAUDE.md'), 'my rules');
  write(path.join(hostProfile, 'commands', 'review.md'), 'review cmd');
  write(
    path.join(hostProfile, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ path: hostProfile + '\\plugins\\cache\\claude-mem' }),
  );
  write(path.join(hostProfile, '.credentials.json'), '{ "token": "secret" }');
  const hostGlobalState = t.writeJson(at('host-claude.json'), {
    hasCompletedOnboarding: true,
    mcpServers: { github: { command: 'npx' } },
  });

  // The install folder, two workspaces (B has a setup script), a folder to share, the storage root, and tools "from
  // this PC".
  const install = at('install');
  t.dir('install', 'sub');
  const workA = t.dir('work-a');
  const workB = at('work-b');
  t.dir('work-b', 'assets');
  const shared = t.dir('shared');
  t.dir('storage');
  write(
    path.join(workB, 'setup.mjs'),
    "import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.AGENT_DATA, 'hook-ran.txt'), process.env.AGENT_WORKSPACE);\n",
  );
  write(at('host-tools', 'agents', 'claude', 'claude.exe'), 'fake-claude');

  /**
   * The default config, pointed at the fake PC. `copyFromHost = false` makes the sandbox download everything instead.
   */
  const makeConfig = (copyFromHost = true): Config => {
    const c = structuredClone(DEFAULTS);
    c.storage.root = at('storage');
    c.storage.dataName = 'testdata';
    c.sandbox.memoryMb = 8192;
    c.provisioning.copyFromHost = copyFromHost;
    c.provisioning.terminal.enabled = false;
    c.harnesses.claude.hostDir = hostClaude;
    c.claudeProfile = { ...c.claudeProfile, hostDir: hostProfile, globalStateFile: hostGlobalState };
    c.personalization.enabled = false;
    c.mappings = [{ host: at('missing-optional'), guest: 'C:\\GameSources\\Missing', readOnly: true, optional: true }];
    return c;
  };
  const baseConfig = makeConfig();
  const probe: HostProbe = {
    nodeDir: hostNode,
    harnessExe: { dir: hostClaude, file: 'claude.exe' },
    gitDir: null,
    nvmDir: null,
    hostNodeVersion: HOST_NODE_VERSION,
  };

  /** Resolves a run for `workA` (or whatever `over` says). */
  const run = (over: Partial<RunRequest> = {}, config: Config = baseConfig): Promise<ResolvedRun> =>
    resolveRun(
      {
        packageRoot: install,
        loaded: { config, configPath: null, base: t.temp },
        cwd: workA,
        noAgent: false,
        noLocalConfig: false,
        trustConfig: false,
        scripts: [],
        ...over,
      },
      HOST_NODE_VERSION,
    );

  const generate = (r: ResolvedRun, args: string[] = [], p: HostProbe = probe): ReturnType<typeof generateSandbox> =>
    // A fixed "this PC has" list and RAM, so "auto" toolchains and the memory decide the same on every machine.
    onFixedPc(() =>
      generateSandbox({
        packageRoot: t.packageRoot,
        run: r,
        harnessArgs: args,
        probe: p,
        pcLanguages: ['python', 'rust', 'cpp', 'dotnet'],
      }),
    );

  /** Resolves a run and generates its sandbox (.wsb + launch folder + session.json) in one step. */
  const launch = async (
    over: Partial<RunRequest> = {},
    options: { config?: Config; args?: string[]; probe?: HostProbe } = {},
  ): Promise<ReturnType<typeof generateSandbox>> =>
    generate(await run(over, options.config ?? baseConfig), options.args, options.probe);

  /** Writes a project's `.sandbox-config.json` (objects are serialised; strings are written as they are). */
  const writeLocal = (dir: string, content: unknown): void => {
    write(path.join(dir, '.sandbox-config.json'), typeof content === 'string' ? content : JSON.stringify(content));
  };

  /** The four folders history sync works with, for a workspace on the PC and its place in the sandbox. */
  const historySides = (name: string, hostWorkspace: string, guestWorkspace: string) => ({
    hostClaudeDir: at(name + '-host'),
    guestClaudeDir: at(name + '-guest'),
    hostWorkspace,
    guestWorkspace,
  });

  /** Runs the guest's bundled main.js in dry-run mode against fake sandbox folders. */
  const runGuest = async (
    launchPath: string,
    data: string,
    workspace: string,
    extra: Record<string, string> = {},
  ): Promise<NodeRun> =>
    runNode([path.join(launchPath, 'runtime', 'main.js')], {
      env: {
        ...process.env,
        AGENT_LAUNCH_DIR: launchPath,
        AGENT_DATA_DIR: data,
        AGENT_HOST_TOOLS_DIR: at('host-tools'),
        AGENT_WORKSPACE: workspace,
        AGENT_LOCAL_DIR: at('local'),
        AGENT_MANAGED_DIR: at('managed'),
        AGENT_DRY_RUN: '1',
        ...extra,
      },
    });

  /** Runs a built command (dist/bin/<name>.js) as its own process. */
  const runBin = (name: string, args: string[], options: NodeRunOptions = {}): Promise<NodeRun> =>
    runNode([path.join(t.packageRoot, 'dist', 'bin', name + '.js'), ...args], options);

  const readJson = t.readJson;
  return {
    at,
    hostNode,
    hostClaude,
    hostProfile,
    hostGlobalState,
    install,
    workA,
    workB,
    shared,
    makeConfig,
    baseConfig,
    probe,
    run,
    generate,
    launch,
    writeLocal,
    historySides,
    runGuest,
    runBin,
    readJson,
  };
}

export type Fixtures = ReturnType<typeof createFixtures>;
