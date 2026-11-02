// Agent commands in every terminal, SQLite folders of agents, and the PATH rules (planner, rebuild, shell start-up).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, mergeConfig, validateConfig } from '../core/config/index.js';
import { isWin } from '../core/util/index.js';
import { SYSTEM } from '../shared/system.js';
import {
  agentCommand,
  agentShims,
  bootResetPaths,
  codexConfigWithoutSandbox,
  isCopyableDatabaseFile,
  isDatabaseFile,
  localStateEntries,
  shimText,
} from '../guest/agents/agent-files.js';
import {
  appendMissing,
  expandVars,
  isPinnedNodeDir,
  parseRegPath,
  pathKey,
  planPath,
  rebuildPath,
  splitPath,
} from '../guest/setup/path-plan.js';
import { withReloadEnvironment } from '../host/tools/index.js';
import { HarnessSchema } from '../core/schema/index.js';
import type { Suite } from './support/suite.js';

export const agentPathsSuite: Suite = {
  name: 'agent-paths',
  title: 'agent commands, agent SQLite folders and PATH rules',
  run: (t) => {
    t.section('agent commands');
    const tools = 'C:\\AgentData\\tools';
    const shims = agentShims(tools, DEFAULTS.harnesses);
    const codex = shims.find((s) => s.name === 'codex');
    t.equal(codex?.command, 'codex', 'codex is typed as codex');
    t.equal(codex?.target, tools + '\\agents\\codex\\codex.cmd', 'an npm agent runs its .cmd');
    t.equal(
      shims.find((s) => s.name === 'claude')?.target,
      tools + '\\agents\\claude\\claude.exe',
      'claude runs its .exe',
    );
    t.check(shims.length === Object.keys(DEFAULTS.harnesses).length, 'every built-in agent gets a command');
    t.equal(agentCommand('aider', DEFAULTS.harnesses.aider), 'aider', 'a uv agent is typed as its uv command');
    const text = shimText(codex!, { node: 'C:\\n\\node.exe', script: 'C:\\r\\agent.js' });
    t.check(
      text.includes('\r\n') && text.includes('install codex') && text.endsWith('%*\r\n'),
      'the command installs on first use',
    );
    t.check(text.includes('if exist "%SBX_REAL%" goto run'), 'an installed agent starts at once');
    t.equal(
      agentShims(tools, { 'bad name': DEFAULTS.harnesses.codex }).length,
      0,
      'an agent name that is not a plain word gets no command file',
    );

    t.section('agent SQLite folders');
    t.equal(DEFAULTS.harnesses.codex.localState, { CODEX_SQLITE_HOME: 'sqlite' }, 'codex runs its databases locally');
    const entries = localStateEntries(DEFAULTS.harnesses, 'C:\\AgentData\\state', 'C:\\nvm\\agent-state');
    t.equal(
      entries.map((e) => [e.agent, e.env, e.store, e.local, e.processes[0]]),
      [
        [
          'codex',
          'CODEX_SQLITE_HOME',
          'C:\\AgentData\\state\\codex\\sqlite',
          'C:\\nvm\\agent-state\\codex\\sqlite',
          'codex.exe',
        ],
      ],
      'saved copy in the state folder, working copy on the sandbox disk',
    );
    // A user's own harnesses.codex is merged over the built-in one: fields it leaves out (localState) stay.
    const { localState: _omitted, ...pinned } = DEFAULTS.harnesses.codex;
    const merged = (harnesses: unknown): Record<string, { localState?: unknown }> =>
      validateConfig(mergeConfig(DEFAULTS, { harnesses }), 'test').harnesses;
    t.equal(
      [
        merged({ codex: { npmPackage: '@openai/codex@0.9.0' } }).codex.localState,
        merged({ codex: pinned }).codex.localState,
      ],
      [{ CODEX_SQLITE_HOME: 'sqlite' }, { CODEX_SQLITE_HOME: 'sqlite' }],
      'a customized or pinned built-in agent keeps localState from the defaults',
    );
    t.check(
      HarnessSchema.safeParse({ ...DEFAULTS.harnesses.codex, localState: { X: '..\\up' } }).success === false,
      'a local state folder cannot leave the agent state folder',
    );
    t.equal(
      ['state_5.sqlite', 'x.sqlite-wal', 'x.sqlite-shm', 'a.db', 'auth.json'].map(isDatabaseFile),
      [true, true, true, true, false],
      'database files are told apart',
    );
    t.equal(
      ['state_5.sqlite', 'x.sqlite-wal', 'x.sqlite-shm'].map(isCopyableDatabaseFile),
      [true, true, false],
      'the -shm file is not copied (SQLite rebuilds it)',
    );

    t.section('agent files sealed to the last sandbox');
    t.equal(
      bootResetPaths(DEFAULTS.harnesses, 'C:\\AgentData\\state')
        .filter((p) => p.agent === 'codex')
        .map((p) => p.path),
      [
        'C:\\AgentData\\state\\codex\\.sandbox-secrets',
        'C:\\AgentData\\state\\codex\\.sandbox\\setup_marker.json',
        'C:\\AgentData\\state\\codex\\.sandbox\\deny_read_acl_state.json',
      ],
      "codex's DPAPI-sealed sandbox users and setup marker are removed at boot (CryptUnprotectData otherwise)",
    );
    t.check(
      HarnessSchema.safeParse({ ...DEFAULTS.harnesses.codex, bootReset: ['..\\login'] }).success === false &&
        HarnessSchema.safeParse({ ...DEFAULTS.harnesses.codex, bootReset: ['C:\\Windows'] }).success === false,
      'bootReset takes only plain paths below the agent state folder',
    );

    t.section('codex without its own command sandbox');
    const userToml = '[tui]\nscreen_reader_detection_done = true\n\n[windows]\nsandbox = "elevated"\n';
    const off = codexConfigWithoutSandbox(userToml) ?? '';
    t.check(
      off.split('\n').find((l) => !l.startsWith('#')) === 'sandbox_mode = "danger-full-access"' &&
        off.endsWith(userToml),
      'sandbox_mode goes above the first table, the rest of the file is kept',
    );
    t.check(
      codexConfigWithoutSandbox('') === off.slice(0, off.indexOf('\n\n') + 1),
      'a missing config.toml gets just the setting',
    );
    t.equal(
      [
        codexConfigWithoutSandbox(off),
        codexConfigWithoutSandbox('model = "o3"\nsandbox_mode = "workspace-write"\n[windows]\n'),
      ],
      [null, null],
      'a sandbox_mode already set (by the sandbox or by the user) is left alone',
    );
    t.check(
      codexConfigWithoutSandbox('[profiles.x]\nsandbox_mode = "read-only"\n') !== null,
      'a sandbox_mode inside a table does not count as the top-level one',
    );

    t.section('PATH planner');
    const present = new Set(['c:\\a', 'c:\\b', 'c:\\c\\d', 'c:\\nvm\\v24.1.0']);
    const exists = (f: string): boolean => present.has(pathKey(f));
    t.equal(
      planPath({ entries: ['C:\\A\\;c:\\b', 'C:\\a', 'C:\\missing;"C:\\C\\D"', '', 'c:/B'], exists }),
      ['C:\\A\\', 'c:\\b', 'C:\\C\\D'],
      'ordered, no duplicates (case, slash, quotes), no missing folders',
    );
    t.equal(
      planPath({ entries: ['C:\\a;C:\\nvm\\v24.1.0'], exists, drop: (f) => isPinnedNodeDir(f, 'C:\\NVM') }),
      ['C:\\a'],
      'a pinned node version is never machine-wide',
    );
    t.check(
      isPinnedNodeDir('C:\\nvm\\v24.1.0\\', 'C:\\nvm') && !isPinnedNodeDir('C:\\nvm', 'C:\\nvm'),
      'only versions are pinned',
    );
    t.equal(pathKey('C:\\'), 'c:\\', 'a drive root keeps its slash');
    t.equal(splitPath(' "C:\\a" ;; C:\\b;'), ['C:\\a', 'C:\\b'], 'splitting drops empty parts and quotes');
    t.equal(
      expandVars('%SystemRoot%\\x;%nope%', { SYSTEMROOT: 'C:\\W' }),
      'C:\\W\\x;%nope%',
      'variables expand in any case',
    );
    t.equal(
      appendMissing('C:\\a;C:\\b', 'c:\\B;C:\\n;C:\\skip', (f) => f === 'C:\\skip'),
      'C:\\a;C:\\b;C:\\n',
      'missing folders go last',
    );
    t.equal(
      rebuildPath({
        machine: 'C:\\a\\;%SystemRoot%;C:\\b',
        user: 'c:\\B;C:\\u',
        process: 'C:\\only;C:\\A;C:\\AgentData\\tools\\node',
        env: { SystemRoot: 'C:\\Windows' },
        skip: (f) => pathKey(f) === 'c:\\agentdata\\tools\\node',
      }),
      'C:\\only;C:\\a\\;C:\\Windows;C:\\b;C:\\u',
      'a new shell: process-only entries first, then the registry, no duplicates, no runner node',
    );
    t.equal(
      parseRegPath('\r\nHKEY_LOCAL_MACHINE\\X\r\n    Path    REG_EXPAND_SZ    C:\\a;%SystemRoot%\r\n\r\n'),
      'C:\\a;%SystemRoot%',
      'reg query output is parsed',
    );
    t.equal(parseRegPath('ERROR: nothing'), '', 'no Path value is an empty PATH');

    t.section('Windows Terminal reloads the environment');
    t.equal(
      withReloadEnvironment({ compatibility: { reloadEnvironmentVariables: true } }),
      null,
      'already set: unchanged',
    );
    t.equal(
      withReloadEnvironment({ theme: 'dark', compatibility: { other: 1 } })?.compatibility,
      { other: 1, reloadEnvironmentVariables: true },
      'set without touching the rest of compatibility',
    );

    if (!isWin) return;
    t.section('shell start-up (pathsync.exe and the start-up files)');
    const dir = t.at('pathsync');
    const exe = path.join(dir, 'pathsync.exe');
    fs.mkdirSync(dir, { recursive: true });
    const csc = spawnSync(
      SYSTEM.csc(),
      ['/nologo', '/out:' + exe, path.join(t.packageRoot, 'sandbox', 'csharp', 'PathSync.cs')],
      { encoding: 'utf8', windowsHide: true },
    );
    t.check(csc.status === 0, 'PathSync.cs compiles', csc.stdout);
    if (csc.status !== 0) return;
    const sync = spawnSync(
      exe,
      [
        '--machine',
        'C:\\a\\;%SystemRoot%;C:\\b',
        '--user',
        'c:\\B;C:\\u',
        '--process',
        'C:\\only;C:\\A;C:\\AgentData\\tools\\node',
      ],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, AGENT_TOOLS: 'C:\\AgentData\\tools' } },
    );
    t.equal(
      sync.stdout,
      'C:\\only;C:\\a\\;' + (process.env.SystemRoot ?? 'C:\\Windows') + ';C:\\b;C:\\u',
      'pathsync.exe follows the same rules',
    );
    const root = t.at('shell-root');
    const install = spawnSync(
      SYSTEM.powershell(),
      [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(t.packageRoot, 'sandbox', 'scripts', 'install-shell-path.ps1'),
        '-Helper',
        exe,
        '-Root',
        root,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    t.check(install.status === 0, 'install-shell-path.ps1 runs (to a temp folder, no registry)', install.stderr);
    const cmdFile = path.join(dir, 'shell-path.cmd');
    // Quotes and & in the command line of cmd /c must not run the script again (that once looped for ever).
    const nested = spawnSync(SYSTEM.cmd(), ['/d', '/c', 'echo "a & b" & call "' + cmdFile + '" && echo guard-ok'], {
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    t.check(
      nested.stdout.includes('guard-ok') && !nested.stdout.includes('RECURSION'),
      'the cmd start-up file leaves `cmd /c` alone',
    );
  },
};
