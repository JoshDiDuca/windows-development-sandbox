// What the host generates for a sandbox: the .wsb file, the launch folder (runtime, C# sources, boot scripts),
// session.json, the staged Claude profile, and the values read from this PC (git identity, free RAM).
import fs from 'node:fs';
import path from 'node:path';
import { LocalOverridesSchema } from '../core/schema/index.js';
import {
  buildWsb,
  gitIdentity,
  isSandboxSourceRepo,
  launchHasSandboxSource,
  logonEnv,
  resolveMemoryMb,
  stagePcLogs,
} from '../host/launch/index.js';
import { pcLogsGuideLine } from '../guest/boot/guide-lines.js';
import type { Suite } from './support/suite.js';

export const generateSuite: Suite = {
  name: 'generate',
  title: 'generated .wsb, launch folder and session.json',
  run: async (t, f) => {
    t.section('the .wsb file');
    const gen = await f.launch({}, { args: ['--version'], probe: { ...f.probe, gitDir: f.shared, nvmDir: f.workB } });
    const wsb = fs.readFileSync(gen.wsbPath, 'utf8');
    t.check(
      wsb.includes('<MemoryInMB>8192</MemoryInMB>') &&
        wsb.includes('<SandboxFolder>C:\\Workspace\\work-a</SandboxFolder>') &&
        wsb.includes('C:\\HostTools\\git') &&
        wsb.includes('C:\\HostTools\\nvm') &&
        !wsb.includes('Missing') &&
        wsb.includes('logon.cmd</Command>') &&
        wsb.includes('<vGPU>Disable</vGPU>'),
      "wsb: the configured memory, the workspace at its guest folder, this PC's git and nvm, the logon command, vGPU off; a missing optional folder is skipped",
      wsb,
    );
    t.includes(
      buildWsb(f.baseConfig, 4096, [{ host: 'C:\\a&b', guest: 'C:\\X', readOnly: true }]),
      'C:\\a&amp;b',
      'wsb values are XML-escaped',
    );

    t.section('the launch folder');
    const expectedFiles = [
      'package.json',
      'runtime/main.js',
      'runtime/daemon.js',
      'runtime/view.js',
      'runtime/gitguard.js',
      'sandbox/boot/bootstrap.ps1',
      'sandbox/boot/logon.cmd',
      'sandbox/boot/trust.cmd',
      'sandbox/csharp/PtyHost.cs',
      'sandbox/csharp/GitShim.cs',
      'sandbox/csharp/SandboxTools/Program.cs',
      'sandbox/csharp/SandboxTools/CpuCap.cs',
      'sandbox/csharp/SandboxTools/PageFile.cs',
      'sandbox/csharp/SandboxTools/MemoryLog.cs',
      'sandbox/csharp/LinkGate.cs',
    ];
    const missing = expectedFiles.filter((file) => !fs.existsSync(path.join(gen.launchPath, file)));
    t.check(
      missing.length === 0 && fs.readdirSync(path.join(gen.launchPath, 'runtime')).length === 8,
      'the launch folder has the runtime (8 self-contained files), the C# sources and the boot scripts',
      missing.join(', '),
    );
    const logon = fs.readFileSync(path.join(gen.launchPath, 'sandbox', 'boot', 'logon.cmd'), 'utf8');
    t.check(
      logon.indexOf('trust.cmd') < logon.indexOf('wt.exe') &&
        logon.includes('tools\\terminal\\wt.exe') &&
        logon.includes('-NoExit') &&
        logon.indexOf('env.cmd') > 0 &&
        logon.indexOf('env.cmd') < logon.indexOf('wt.exe') &&
        fs.readFileSync(path.join(gen.launchPath, 'env.cmd'), 'utf8').includes('AGENT_WORKSPACE='),
      'logon.cmd applies the trust settings and sets AGENT_WORKSPACE (env.cmd) before Windows Terminal, falling back to a PowerShell window',
    );
    t.equal(
      logonEnv('C:\\Workspace\\100%\\x'),
      '@set "AGENT_WORKSPACE=C:\\Workspace\\100%%\\x"\r\n',
      'a % in the workspace path is escaped for cmd',
    );

    t.section('session.json');
    const session = f.readJson(gen.sessionPath);
    t.equal(
      {
        launchId: session.launchId === gen.launchId,
        workspace: session.workspace,
        workspaceHost: session.workspaceHost,
        firstArgument: session.harnessArguments[0],
        gitFromHost: Boolean(session.hostTools.git),
        nvmFromHost: Boolean(session.hostTools.nvm),
        nodeSpec: session.versions.node.spec,
        gitAccess: session.provisioning.git.access,
        plainNodeVersion: /^\d+\.\d+\.\d+$/.test(session.hostTools.nodeVersion ?? ''),
        cpuLimitPercent: session.cpuLimitPercent,
        pageFileMb: session.pageFileMb,
      },
      {
        launchId: true,
        workspace: 'C:\\Workspace\\work-a',
        workspaceHost: f.workA,
        firstArgument: '--version',
        gitFromHost: true,
        nvmFromHost: true,
        nodeSpec: '22.3.0',
        gitAccess: 'full',
        plainNodeVersion: true,
        cpuLimitPercent: 80,
        pageFileMb: 16384,
      },
      'session.json carries the id, paths, agent arguments, host tools, versions, git access and the CPU (80 %) and paging file (16 GB) limits',
    );
    t.check(
      !LocalOverridesSchema.safeParse({ sandbox: { cpuLimit: 'none' } }).success,
      "a project's .sandbox-config.json cannot lift your CPU cap (sandbox.cpuLimit is yours only)",
    );

    t.section('what is copied from this PC');
    const staged = path.join(gen.launchPath, 'claude-profile');
    const stagedMissing = ['settings.json', 'CLAUDE.md', '.claude.json', 'plugins'].filter(
      (name) => !fs.existsSync(path.join(staged, name)),
    );
    t.check(
      stagedMissing.length === 0 && !fs.existsSync(path.join(staged, '.credentials.json')),
      'Claude settings, instructions, global state and plugins are staged; the Claude login is not',
      stagedMissing.join(', '),
    );
    const gitconfig =
      '[user]\n\tname = Josh\n\temail = "j@x.io"\n[credential]\n\thelper = store\n[url "https://TOKEN@github.com/"]\n\tinsteadOf = https://github.com/\n';
    t.equal(
      [gitIdentity(gitconfig), gitIdentity('[core]\n\tname = x\n')],
      ['[user]\n\tname = Josh\n\temail = j@x.io\n', ''],
      'only name/email from ~/.gitconfig reach the sandbox (no credential helpers or token URLs; a name outside [user] is not an identity)',
    );
    const auto = { ...f.baseConfig.sandbox, memoryMb: 'auto' as const };
    const MB = 1048576;
    const pcRam = 64 * 1024 * MB;
    t.equal(
      [
        resolveMemoryMb(auto, 40000 * MB, pcRam),
        resolveMemoryMb({ ...auto, maxMemoryPercent: 80 }, 30000 * MB, 32 * 1024 * MB),
        resolveMemoryMb({ ...auto, maxMemoryPercent: 50 }, 60000 * MB, pcRam),
      ],
      [31744, 21504, 32768],
      "memory 'auto' follows free RAM minus the reserve and never takes more than maxMemoryPercent of the PC's RAM",
    );
    await t.throws(
      () => resolveMemoryMb(auto, 9000 * MB, pcRam),
      'Not enough free RAM',
      "memory 'auto' refuses when too little RAM is free",
    );

    t.section('PC logs for developing the sandbox');
    const root = path.join(t.temp, 'pc-logs');
    const URL = 'git+https://github.com/JoshDiDuca/windows-development-sandbox.git';
    const project = (name: string, pkg: string): string => {
      t.write(path.join(root, name, 'package.json'), pkg);
      return path.join(root, name);
    };
    const own = project(
      'own',
      JSON.stringify({ name: 'windows-development-sandbox', repository: { type: 'git', url: URL } }),
    );
    const pkgOf = (url: string, name = 'windows-development-sandbox'): string =>
      JSON.stringify({ name, repository: { url } });
    const variants = [
      project('v-https', pkgOf('https://github.com/joshdiduca/windows-development-sandbox')),
      project('v-dotgit', pkgOf('https://github.com/JoshDiDuca/windows-development-sandbox.git')),
      project('v-string', JSON.stringify({ name: 'windows-development-sandbox', repository: URL })),
    ];
    t.equal(
      [isSandboxSourceRepo(own, own), ...variants.map((v) => isSandboxSourceRepo(v, own))],
      [true, true, true, true],
      'a folder with the sandbox name and repository url is its source (git+, .git and case variants too)',
    );
    const big = project('big', pkgOf(URL) + ' '.repeat(300 * 1024));
    const link = path.join(root, 'linked');
    let linked = false;
    try {
      fs.symlinkSync(path.join(root, 'own'), link, 'junction');
      linked = true;
    } catch {
      // No permission for links here: that case is skipped.
    }
    t.equal(
      [
        isSandboxSourceRepo(project('wrong-url', pkgOf('https://github.com/someone/windows-development-sandbox')), own),
        isSandboxSourceRepo(project('wrong-name', pkgOf(URL, 'other')), own),
        isSandboxSourceRepo(project('invalid', '{ nope'), own),
        isSandboxSourceRepo(path.join(root, 'missing'), own),
        isSandboxSourceRepo(big, own),
        linked ? isSandboxSourceRepo(link, own) : false,
      ],
      [false, false, false, false, false, false],
      'a wrong url or name, a missing, oversized or invalid package.json and a link are not the sandbox source',
    );
    t.check(
      launchHasSandboxSource([f.workA, own], own) && !launchHasSandboxSource([f.workA, f.workB], own),
      'any project of the launch can be the source; a launch without it has none',
    );
    t.check(!fs.existsSync(path.join(gen.launchPath, 'pc-logs')), 'a launch of another project gets no pc-logs');

    const storage = path.join(root, 'storage');
    const dataPath = path.join(root, 'data-x');
    for (let i = 0; i < 12; i++)
      t.write(path.join(storage, 'logs', 'crashes', 'crash-2026-01-' + String(10 + i) + '.txt'), 'report ' + i);
    t.write(path.join(storage, 'logs', 'host-memory-data-x.log'), 'start\n' + 'm'.repeat(600 * 1024) + 'END');
    t.write(path.join(storage, 'logs', 'host-sync-data-x.log'), 'small');
    t.write(path.join(storage, 'state', 'live-folders.log'), 'live');
    t.write(path.join(storage, 'state', 'logins.json'), 'SECRET');
    t.write(path.join(storage, 'secrets', 'x.json'), 'SECRET');
    const launch = path.join(root, 'launch');
    const out = stagePcLogs(storage, dataPath, launch);
    const listing = (dir: string): string[] =>
      fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .flatMap((e) =>
          e.isFile() ? [path.relative(out, path.join(e.parentPath, e.name)).replaceAll('\\', '/')] : [],
        );
    const copied = listing(out).sort();
    const reports = copied.filter((n) => n.startsWith('crashes/'));
    const memory = fs.readFileSync(path.join(out, 'host-memory.log'), 'utf8');
    t.check(
      reports.length === 10 &&
        reports.includes('crashes/crash-2026-01-21.txt') &&
        !reports.includes('crashes/crash-2026-01-11.txt') &&
        fs.statSync(path.join(out, 'host-memory.log')).size <= 256 * 1024 &&
        memory.endsWith('END') &&
        fs.readFileSync(path.join(out, 'README.txt'), 'utf8').includes('never commit'),
      'the newest 10 crash reports, the last 256 KB of the memory log and a README are copied',
      copied.join(', '),
    );
    t.equal(
      copied.filter((n) => !n.startsWith('crashes/')),
      ['README.txt', 'host-memory.log', 'host-sync.log', 'live-folders.log'],
      'nothing else from the storage folder is copied (no state, logins or secrets)',
    );

    t.section('the guide line for the PC logs');
    t.equal(
      [pcLogsGuideLine('C:\\AgentLaunch', () => false), pcLogsGuideLine('C:\\AgentLaunch', () => true)],
      [
        [],
        ['- PC crash reports and logs (this project only, read-only, never commit them): `C:\\AgentLaunch\\pc-logs`'],
      ],
      'the guide mentions the PC logs only when the folder exists',
    );
  },
};
