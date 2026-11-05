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
  isCopyableDatabaseFile,
  isDatabaseFile,
  localStateEntries,
  shimText,
} from '../guest/agents/agent-files.js';
import {
  appendMissing,
  expandVars,
  installedToolPaths,
  isGitUsrBin,
  isMsvcToolsDir,
  isPinnedNodeDir,
  msvcBeforeGitUsr,
  parseRegPath,
  pathKey,
  planPath,
  rebuildPath,
  sessionPath,
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
        'C:\\AgentData\\state\\codex\\tmp\\arg0',
        'C:\\AgentData\\state\\codex\\tmp\\arg0-windows',
      ],
      "codex's DPAPI-sealed sandbox users and setup marker are removed at boot (CryptUnprotectData otherwise)",
    );
    t.check(
      HarnessSchema.safeParse({ ...DEFAULTS.harnesses.codex, bootReset: ['..\\login'] }).success === false &&
        HarnessSchema.safeParse({ ...DEFAULTS.harnesses.codex, bootReset: ['C:\\Windows'] }).success === false,
      'bootReset takes only plain paths below the agent state folder',
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
    const agentPath = sessionPath({
      commands: 'C:\\nvm\\bin',
      prepend: ['C:\\AgentData\\tools\\bin', 'C:\\AgentData\\tools\\nvm', 'C:\\nvm\\nodejs'],
      base: ['C:\\Windows\\system32', 'c:\\NVM\\bin\\'],
      append: ['C:\\AgentData\\tools\\agents\\codex'],
    });
    t.equal(
      agentPath,
      [
        'C:\\nvm\\bin',
        'C:\\AgentData\\tools\\bin',
        'C:\\AgentData\\tools\\nvm',
        'C:\\nvm\\nodejs',
        'C:\\Windows\\system32',
        'C:\\AgentData\\tools\\agents\\codex',
      ],
      "the sandbox's agent shims come first, before nvm's node folder (an npm -g codex there) and the agent's own folder",
    );
    t.equal(
      planPath({ entries: [agentPath.join(';')], exists: () => true })[0],
      'C:\\nvm\\bin',
      'and stay first on the machine PATH that terminal tabs get',
    );
    t.equal(
      rebuildPath({ machine: agentPath.join(';'), user: 'C:\\nvm\\nodejs', process: '', env: {} }).split(';')[0],
      'C:\\nvm\\bin',
      'a new shell keeps them first',
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

    t.section('MSVC link before Git coreutils link');
    const gitUsr = 'C:\\AgentData\\tools\\git\\usr\\bin';
    const msvcBin = 'C:\\AgentData\\tools\\msvc\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64';
    t.check(
      isGitUsrBin(gitUsr) && isGitUsrBin('C:\\Program Files\\Git\\usr\\bin\\') && !isGitUsrBin('C:\\x\\usr\\bin'),
      "only Git's usr\\bin is recognised",
    );
    t.check(isMsvcToolsDir(msvcBin) && !isMsvcToolsDir('C:\\a\\bin'), "MSVC's compiler folder is recognised");
    t.equal(
      msvcBeforeGitUsr(['C:\\a', gitUsr, 'C:\\b', msvcBin, 'C:\\c']),
      ['C:\\a', msvcBin, gitUsr, 'C:\\b', 'C:\\c'],
      'MSVC found after Git usr\\bin moves just before it',
    );
    t.equal(msvcBeforeGitUsr([msvcBin, 'C:\\a', gitUsr]), [msvcBin, 'C:\\a', gitUsr], 'already in order: unchanged');
    t.equal(msvcBeforeGitUsr(['C:\\a', gitUsr]), ['C:\\a', gitUsr], 'no MSVC: unchanged');
    t.equal(
      planPath({ entries: [gitUsr, msvcBin], exists: () => true }),
      [msvcBin, gitUsr],
      'the machine PATH plan puts MSVC first',
    );
    t.equal(
      appendMissing(gitUsr, msvcBin).split(';'),
      [msvcBin, gitUsr],
      'a process that gains the MSVC folder later still finds its link first',
    );

    t.section('installed python and rust on every project');
    const tree = new Set(
      [
        'python\\python-3.9.1\\python.exe',
        'python\\python-3.15.2\\python.exe',
        'python\\python-3.15.2',
        'python\\python2-2.7.18\\python.exe',
        'python\\python-3.20.0',
        'shims\\py.cmd',
        'rust\\cargo\\bin\\rustup.exe',
      ].map((p) => 'c:\\t\\' + p.toLowerCase()),
    );
    const names: Record<string, string[]> = {
      'c:\\t\\python': ['python-3.9.1', 'python-3.15.2', 'python2-2.7.18', 'python-3.20.0'],
    };
    const toolsFs = {
      exists: (f: string): boolean => tree.has(f.toLowerCase()),
      list: (d: string): string[] => names[d.toLowerCase()] ?? [],
    };
    const both = installedToolPaths('C:\\T', toolsFs);
    t.equal(
      both.append,
      [
        'C:\\T\\python\\python-3.15.2',
        'C:\\T\\python\\python-3.15.2\\Scripts',
        'C:\\T\\shims',
        'C:\\T\\rust\\cargo\\bin',
      ],
      'the newest complete Python (not Python 2, not an unfinished folder) and rust go on PATH',
    );
    t.equal(
      both.vars,
      { RUSTUP_HOME: 'C:\\T\\rust\\rustup', CARGO_HOME: 'C:\\T\\rust\\cargo' },
      "rust's own tools find their homes",
    );
    t.check(both.summary.length === 2, 'the guide can say what is there');
    t.equal(
      installedToolPaths('C:\\T', toolsFs, new Set(['python', 'rust'])).append,
      [],
      'a toolchain whose step runs brings its own entries',
    );
    t.equal(
      installedToolPaths('C:\\Empty', { exists: () => false, list: () => [] }).append,
      [],
      'nothing installed: nothing added',
    );

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
