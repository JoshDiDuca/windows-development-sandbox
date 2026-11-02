// What the host generates for a sandbox: the .wsb file, the launch folder (runtime, C# sources, boot scripts),
// session.json, the staged Claude profile, and the values read from this PC (git identity, free RAM).
import fs from 'node:fs';
import path from 'node:path';
import { LocalOverridesSchema } from '../core/schema/index.js';
import { buildWsb, gitIdentity, logonEnv, resolveMemoryMb } from '../host/launch/index.js';
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
  },
};
