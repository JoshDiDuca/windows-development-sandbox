// Runs every command and shortcut binary as a separate process in a simulated HOST: none of the sandbox-only folders
// or variables exist (C:\AgentLaunch, C:\AgentData, CLAUDE_CONFIG_DIR, ...), with a fresh home and storage. Tests
// usually run inside a sandbox, where those exist, so this is what catches code that only works there. Every command
// must either succeed or fail with a friendly "Error:" message; a crash or stack trace fails.
//
// Each command gets its own home and storage folder, so they cannot disturb each other and run several at a time
// (every one is a fresh Node process, which is what makes this the slowest suite when run one by one).
import fs from 'node:fs';
import path from 'node:path';
import type { Suite } from './support/suite.js';

const SANDBOX_ONLY_VARS = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GEMINI_CLI_HOME',
  'COPILOT_HOME',
  'CRUSH_GLOBAL_CONFIG',
  'CRUSH_GLOBAL_DATA',
  'AGENT_WORKSPACE',
  'AGENT_DATA',
  'AGENT_TOOLS',
  'AGENT_PROJECT',
  'NVM_HOME',
  'NVM_SYMLINK',
  'BASH_ENV',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'AGENT_GIT_ACCESS',
  'AGENT_REAL_GIT',
  'AGENT_SANDBOX_CONFIG',
];
const PARALLEL = 2;

interface Command {
  /** The binary in dist/bin. */
  bin: string;
  /** What the person would type, shown on failure. */
  label: string;
  args: string[];
  /** true: `--config <file>` (this run's own storage) is added after `args`. */
  config?: boolean;
  /** Arguments that must come after `--config <file>` (the part after `--`). */
  after?: string[];
}

const sandbox = (label: string, ...args: string[]): Command => ({ bin: 'sandbox', label, args, config: true });
const COMMANDS: Command[] = [
  { bin: 'sandbox', label: '--help', args: ['--help'] },
  sandbox('status', 'status'),
  sandbox('status --json', 'status', '--json'),
  sandbox('sessions', 'sessions'),
  sandbox('doctor', 'doctor'),
  sandbox('account list', 'account', 'list'),
  sandbox('vpn status', 'vpn', 'status'),
  sandbox('vpn status --json', 'vpn', 'status', '--json'),
  sandbox('account use nobody', 'account', 'use', 'nobody'),
  { bin: 'sandbox', label: 'config path', args: ['config', 'path'] },
  sandbox('config show', 'config', 'show'),
  { bin: 'sandbox', label: 'config schema', args: ['config', 'schema'] },
  sandbox('clean', 'clean'),
  sandbox('sync', 'sync'),
  sandbox('logs', 'logs'),
  sandbox('attach', 'attach'),
  { bin: 'sandbox', label: 'exec', args: ['exec'], after: ['--', 'echo', 'hi'], config: true },
  sandbox('restart', 'restart'),
  sandbox('stop', 'stop'),
  sandbox('show', 'show'),
  sandbox('hide', 'hide'),
  sandbox('generate', 'generate'),
  sandbox('launch', 'launch'),
  { bin: 'sandbox', label: 'unknown command', args: ['frobnicate'] },
  { bin: 'sandbox', label: 'claude --headless --continue', args: ['claude', '--headless', '--continue'], config: true },
  { bin: 'sandbox', label: 'codex', args: ['codex'], config: true },
  { bin: 'sandbox', label: 'gemini', args: ['gemini'], config: true },
  { bin: 'sandbox', label: 'host claude --version', args: ['host', 'claude', '--', '--version'] },
];

export const hostSimSuite: Suite = {
  name: 'host-sim',
  title: 'every command run as its own process on a simulated host PC',
  timeoutMs: 300000,
  run: async (t, f) => {
    t.section('every command outside a sandbox');
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SANDBOX_ONLY_VARS.includes(k)));
    const project = t.dir('host-sim-project');
    const envFor = (home: string): NodeJS.ProcessEnv => ({
      ...baseEnv,
      AGENT_SANDBOX_HOME: home,
      AGENT_LAUNCH_DIR: t.at('no-agent-launch'),
      AGENT_DATA_DIR: t.at('no-agent-data'),
      AGENT_HOST_TOOLS_DIR: t.at('no-host-tools'),
      NO_COLOR: '1',
      // This test may itself run inside a sandbox: the CLI must behave as it would on a PC.
      AGENT_SANDBOX_HOST_ONLY: '1',
    });
    /** A fresh home, storage and config file for one command. */
    const freshPc = (name: string): { home: string; config: string } => {
      const home = t.dir('host-sim', name, 'home');
      const storage = t.dir('host-sim', name, 'storage');
      const config = t.writeJson(t.at('host-sim', name, 'config.json'), {
        storage: { root: storage },
        personalization: { enabled: false },
        provisioning: { terminal: { enabled: false } },
      });
      return { home, config };
    };

    const broken: string[] = [];
    const runOne = async (command: Command, index: number, pc = freshPc('c' + index)): Promise<void> => {
      const args = command.config ? [...command.args, '--config', pc.config, ...(command.after ?? [])] : command.args;
      const r = await f.runBin(command.bin, args, { cwd: project, env: envFor(pc.home), timeoutMs: 120000 });
      const crashed =
        r.status === null || r.status > 1 || /Unexpected error|node:internal|^\s+at .+:\d+:\d+\)?$/m.test(r.out);
      const unexplained =
        r.status === 1 && !/(^|\n)(Error: |error: )/.test(r.out) && !command.label.startsWith('host ');
      if (crashed || unexplained)
        broken.push(
          command.label +
            ' (exit ' +
            r.status +
            (r.timedOut ? ', timed out' : '') +
            '): ' +
            r.out.trim().split('\n').slice(0, 4).join(' | '),
        );
    };

    // `config init` twice must see the same home (the second run finds the files the first one made).
    const initPc = freshPc('init');
    const queue = COMMANDS.map((command, index) => ({ command, index }));
    const workers = Array.from({ length: PARALLEL }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await runOne(next.command, next.index);
    });
    const initRuns = (async () => {
      await runOne({ bin: 'sandbox', label: 'config init', args: ['config', 'init'] }, 1000, initPc);
      await runOne({ bin: 'sandbox', label: 'config init (again)', args: ['config', 'init'] }, 1001, initPc);
    })();
    await Promise.all([...workers, initRuns]);

    t.equal(
      broken,
      [],
      'all ' + (COMMANDS.length + 2) + ' commands work or fail with a clear message when run outside a sandbox',
    );
    for (const file of ['config.json', 'config.schema.json', 'sandbox-config.schema.json']) {
      t.check(fs.existsSync(path.join(initPc.home, file)), 'on a fresh PC, config init creates ' + file);
    }
  },
};
