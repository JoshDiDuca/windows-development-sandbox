// A preview of the web UI for working on it: the real server and app, the real settings feature against a config file
// in a temp folder, and sample data for the sandbox and its sessions (a stand-in terminal plays a short agent screen).
// Nothing on this PC is read or changed. Run: npm run web:preview [-- --port 47900], then open the printed address.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AppContext } from '../../app/context.js';
import { listAgents } from '../../app/features/agents/index.js';
import { sandboxStatus } from '../../app/features/sandbox/index.js';
import { vpnStatus } from '../../app/features/vpn/index.js';
import { listAccounts } from '../../app/features/accounts/index.js';
import { engineStatus } from '../../app/features/engine/index.js';
import { lastHealth } from '../../app/features/health/index.js';
import { CRASH, listLogs, tailLog } from '../../app/features/logs/index.js';
import { listProjects } from '../../app/features/projects/index.js';
import { showData } from '../../app/features/data/index.js';
import { updatesStatus } from '../../app/features/updates/index.js';
import { containedStatus, showStorage } from '../../app/features/storage/index.js';
import { listSessions } from '../../app/features/sessions/index.js';
import { auditListing, listAudit } from '../../app/features/audit/index.js';
import { AuditLog, type AuditEvent } from '../../host/audit/index.js';
import { cancelled, type OperationIO, type RpcHost } from '../../app/kernel/index.js';
import { runDefinition } from '../../app/registry.js';
import { webSession } from '../../cli/services/index.js';
import type { SessionStatus } from '../../core/types.js';
import { WebServer, type WebBackend } from '../../host/web/index.js';
import { encodeFrame, FrameReader, FrameType } from '../../shared/pty/index.js';

const TOKEN = 'b'.repeat(64);
const MINUTE = 60_000;

/** A short agent screen with colours, so the terminal page has something real to draw. */
function agentScreen(id: string): string {
  return [
    '\x1b[2J\x1b[H',
    '\x1b[38;5;208m✻\x1b[0m Welcome to \x1b[1mClaude Code\x1b[0m  \x1b[2m(preview session ' + id + ')\x1b[0m\r\n\r\n',
    '\x1b[2m  /help for help, /status for your current setup\x1b[0m\r\n\r\n',
    '\x1b[1m> \x1b[0mFix the failing test in src/app/kernel/view.ts\r\n\r\n',
    '\x1b[32m●\x1b[0m Read(\x1b[1msrc/app/kernel/view.ts\x1b[0m)\r\n',
    '  ⎿  Read 181 lines\r\n\r\n',
    '\x1b[32m●\x1b[0m Update(\x1b[1msrc/app/kernel/view.ts\x1b[0m)\r\n',
    '  ⎿  Updated with \x1b[32m3 additions\x1b[0m and \x1b[31m1 removal\x1b[0m\r\n\r\n',
    '\x1b[2m╭──────────────────────────────────────────────────────────────╮\x1b[0m\r\n',
    '\x1b[2m│\x1b[0m > ' + ' '.repeat(59) + '\x1b[2m│\x1b[0m\r\n',
    '\x1b[2m╰──────────────────────────────────────────────────────────────╯\x1b[0m\r\n',
  ].join('');
}

/** A ptyhost stand-in: sends the screen on HELLO and echoes what is typed. */
function startFakePty(): Promise<number> {
  const server = net.createServer((socket) => {
    const reader = new FrameReader();
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      for (const frame of reader.push(chunk)) {
        if (frame.type === FrameType.Hello) {
          socket.write(encodeFrame(FrameType.Console, Buffer.from('conpty.dll')));
          socket.write(encodeFrame(FrameType.Output, Buffer.from(agentScreen('preview'))));
        } else if (frame.type === FrameType.Input) {
          const text = frame.payload.toString('utf8').replace(/\r/g, '\r\n');
          socket.write(encodeFrame(FrameType.Output, Buffer.from(text)));
        }
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)),
  );
}

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

const SESSIONS: SessionStatus[] = [
  {
    id: 'mva4ungc50e051',
    launchId: 'launch1',
    harness: 'claude',
    cwd: 'C:\\Projects\\AgentProjects\\windows-sandbox',
    project: 'windows-sandbox',
    phase: 'running',
    message: 'running',
    updatedAt: iso(MINUTE),
    startedAt: iso(42 * MINUTE),
  },
  {
    id: '1792104624667-1a3599',
    launchId: 'launch1',
    harness: 'claude',
    cwd: 'C:\\Projects\\AgentProjects\\mw2-agent',
    project: 'mw2-agent',
    phase: 'running',
    message: 'running',
    updatedAt: iso(MINUTE),
    startedAt: iso(43 * MINUTE),
  },
  {
    id: 'k2q9codex0001',
    launchId: 'launch1',
    harness: 'codex',
    cwd: 'C:\\Projects\\AgentProjects\\windows-sandbox',
    project: 'windows-sandbox',
    phase: 'exited',
    message: 'exited',
    exitCode: 0,
    updatedAt: iso(20 * MINUTE),
    startedAt: iso(30 * MINUTE),
  },
];

/** The sandbox as the status query would say it: running, two projects, the helper answering. */
function sampleStatus(running: boolean): unknown {
  const project = (name: string, here: boolean, sessions: SessionStatus[]): unknown => ({
    name,
    host: 'F:\\AgentProjects\\' + name,
    guest: 'C:\\Projects\\AgentProjects\\' + name,
    mechanism: here ? 'launch' : 'root',
    here,
    setup: { phase: 'ready', message: 'Set up 6 toolchains and databases.' },
    databases: name === 'mw2-agent' ? [{ database: 'postgres', port: 5432, state: 'running' }] : [],
    sessions: sessions.map((s) => ({ id: s.id, harness: s.harness, viewers: '1 here', started: s.startedAt })),
    repoGuard: [],
  });
  return sandboxStatus.output.parse({
    sandbox: {
      running,
      phase: running ? 'ready' : 'stopped',
      message: running ? 'Ready' : undefined,
      headless: false,
      startedAt: running ? Date.now() - 45 * MINUTE : null,
      daemon: running ? 'pong (2 session(s) running)' : 'not running',
      account: running ? 'personal' : null,
      syncWatcher: running,
    },
    here: {
      folder: 'F:\\AgentProjects\\windows-sandbox',
      project: 'windows-sandbox',
      guest: 'C:\\Projects\\AgentProjects\\windows-sandbox',
    },
    roots: [{ host: 'F:\\AgentProjects', guest: 'C:\\Projects\\AgentProjects' }],
    projects: running
      ? [
          project(
            'windows-sandbox',
            true,
            SESSIONS.filter((s) => s.project === 'windows-sandbox'),
          ),
          project(
            'mw2-agent',
            false,
            SESSIONS.filter((s) => s.project === 'mw2-agent'),
          ),
        ]
      : [],
    otherSessions: [],
    repoGuard: { guarded: 2, findings: [] },
  });
}

/** Sample logins (names and emails only, no credentials): Claude with two, codex with one, opencode keeps none. */
function sampleAccounts(): unknown {
  return listAccounts.output.parse({
    agent: 'claude',
    agents: [
      {
        name: 'claude',
        kept: true,
        canSavePc: true,
        accounts: [
          {
            name: 'work',
            email: 'dev@example.com',
            isDefault: true,
            isActive: true,
            savedAt: iso(3 * 24 * 60 * MINUTE),
          },
          { name: 'personal', email: null, isDefault: false, isActive: false, savedAt: iso(9 * 24 * 60 * MINUTE) },
        ],
      },
      {
        name: 'codex',
        kept: true,
        canSavePc: false,
        accounts: [{ name: 'main', email: null, isDefault: true, isActive: false, savedAt: iso(2 * 24 * 60 * MINUTE) }],
      },
      { name: 'opencode', kept: false, canSavePc: false, accounts: [] },
    ],
  });
}

function sampleSessions(running: boolean): unknown {
  return listSessions.output.parse({
    sandboxRunning: running,
    defaultAgent: 'claude',
    wide: false,
    sessions: running
      ? SESSIONS.map((s) => ({
          ...s,
          projectName: s.project,
          here: s.project === 'windows-sandbox',
          viewers: s.phase === 'running' ? { viewers: 1, remote: 0 } : undefined,
          canOpen: s.phase === 'running',
        }))
      : [],
  });
}

/** The program's updates: installed for you, one previous version, one failed update, one saved-settings change. */
function sampleUpdates(): unknown {
  return updatesStatus.output.parse({
    managed: true,
    version: '1.4.3',
    scope: 'user',
    autoUpdate: true,
    autoOffText: null,
    previous: '1.4.2',
    failed: { version: '1.4.4', reason: 'it did not start' },
    npmCommand: 'npm install -g windows-development-sandbox',
    error: null,
    settings: {
      pending: ['2026-10-unpin-config-defaults: stop pinning old defaults in your config.json'],
      error: null,
    },
  });
}

/** Where the saved data is (the storage area's query), parsed with its own output schema. */
function sampleStorage(): unknown {
  return showStorage.output.parse({
    root: 'F:\\AgentSandbox',
    exists: true,
    holdsData: true,
    measured: { bytes: 8.9e9, files: 41250, partial: false },
    size: '8.9 GB',
    defaultRoot: 'C:\\ProgramData\\AgentSandbox',
    defaultInUse: false,
    otherFoldersWithData: ['C:\\ProgramData\\AgentSandbox'],
  });
}

/** Contained storage (beta): off, and this PC can use it. */
function sampleContained(): unknown {
  return containedStatus.output.parse({
    setting: 'off',
    maxGb: 60,
    available: true,
    reasons: [],
    fixes: [],
    image: 'F:\\AgentSandbox\\contained\\agent.vhdx',
    imageExists: false,
    imageBytes: null,
    mountFolder: 'F:\\AgentSandbox\\mount',
    recordedMounted: false,
    holders: 0,
    mountedNow: null,
  });
}

/** What is stored: a toolchain, the agent's login folder, databases and logs, and what this PC keeps (sample sizes). */
function sampleData(): unknown {
  const GB = (n: number): string => (n / 1e9).toFixed(1) + ' GB';
  const entry = (area: string, name: string, bytes: number, target: string | null) => ({
    area,
    name,
    path: 'F:\\AgentData\\' + (area === 'host' ? name : area + '\\' + name),
    bytes,
    size: bytes < 1e6 ? (bytes / 1e3).toFixed(1) + ' KB' : GB(bytes),
    target,
  });
  return showData.output.parse({
    dataPath: 'F:\\AgentData',
    storageRoot: 'F:\\',
    totalBytes: 9.6e9,
    total: '9.6 GB',
    storageShare: '<- sandbox storage (9.6 GB of it)',
    areaTotals: { tools: '6.4 GB', databases: '1.2 GB', state: '1.9 GB', logs: '48 KB', host: '4.1 KB' },
    entries: [
      entry('tools', 'rust', 4.6e9, 'tools/rust'),
      entry('tools', 'node', 1.8e9, 'tools/node'),
      entry('databases', 'postgres-18', 1.2e9, 'databases/postgres-18'),
      entry('state', 'claude', 1.9e9, 'state/claude'),
      entry('logs', 'logs', 48_000, 'logs'),
      entry('host', 'accounts', 4096, null),
    ],
    disks: [
      {
        drive: 'C:\\',
        totalBytes: 512e9,
        freeBytes: 210e9,
        usedBytes: 302e9,
        holdsStorage: false,
        used: '302 GB',
        usedPercent: 59,
        free: '210 GB',
        total: '512 GB',
      },
      {
        drive: 'F:\\',
        totalBytes: 1000e9,
        freeBytes: 620e9,
        usedBytes: 380e9,
        holdsStorage: true,
        used: '380 GB',
        usedPercent: 38,
        free: '620 GB',
        total: '1.0 TB',
      },
    ],
  });
}

/** The agents as settings and the sandbox say them: two built in (one ready), two added (one ready). */
function sampleAgents(): unknown {
  return listAgents.output.parse({
    folder: 'F:\\AgentProjects\\windows-sandbox',
    defaultAgent: 'claude',
    agents: [
      { name: 'claude', ready: true, isDefault: true, removable: false },
      { name: 'codex', ready: true, isDefault: false, removable: false },
      { name: 'gemini', ready: false, isDefault: false, removable: true },
      { name: 'aider', ready: false, isDefault: false, removable: true },
    ],
  });
}

/** Sample projects: this folder's project and a root's (mapped), one not mapped, and one excluded. */
function sampleProjects(running: boolean): unknown {
  const inSandbox = (name: string, how: string): string | null => (running ? name + ' (' + how + ')' : null);
  return listProjects.output.parse({
    all: false,
    roots: ['F:\\AgentProjects'],
    exclude: ['F:\\AgentProjects\\old-demo'],
    projects: [
      {
        folder: 'F:\\AgentProjects\\windows-sandbox',
        here: true,
        known: true,
        root: 'F:\\AgentProjects',
        excluded: false,
        mappedAtStart: true,
        running: inSandbox('windows-sandbox', 'launch'),
      },
      {
        folder: 'F:\\AgentProjects\\mw2-agent',
        here: false,
        known: true,
        root: 'F:\\AgentProjects',
        excluded: false,
        mappedAtStart: true,
        running: inSandbox('mw2-agent', 'root'),
      },
      {
        folder: 'F:\\Code\\scratch',
        here: false,
        known: true,
        root: null,
        excluded: false,
        mappedAtStart: false,
        running: null,
      },
      {
        folder: 'F:\\AgentProjects\\old-demo',
        here: false,
        known: true,
        root: null,
        excluded: true,
        mappedAtStart: false,
        running: null,
      },
    ],
  });
}

/** The last check: a few results of each kind, the doctor rows, the setup and a log (nothing here is run). */
function sampleHealth(): unknown {
  const at = new Date(Date.now() - 3 * MINUTE).toISOString();
  return lastHealth.output.parse({
    last: {
      at,
      mode: 'repair',
      checks: [
        {
          id: 'pc-edition',
          group: 'This PC',
          name: 'Windows edition',
          status: 'ok',
          detail: 'Windows 11 Pro',
          fixable: false,
        },
        {
          id: 'install-pointers',
          group: 'Install',
          name: 'Install pointers',
          status: 'fixed',
          detail: 'the command points at the new version',
          applied: { done: 'pointed the command at 1.11.0', before: 'points at 1.9.2', after: 'points at 1.11.0' },
          fixable: false,
        },
        {
          id: 'stale-run',
          group: 'Data folder',
          name: 'Stale run folders',
          status: 'needs-you',
          detail: 'two folders from a sandbox that did not close',
          means: 'they take space and can confuse the next start',
          fix: 'stop the sandbox, then run sandbox repair again',
          lines: ['run-20261012-0931', 'run-20261013-1744'],
          fixable: false,
        },
        {
          id: 'proxy',
          group: 'Network',
          name: 'GitHub',
          status: 'warn',
          detail: 'no answer within 20 seconds',
          means: 'downloads of tools may fail',
          fix: 'check your VPN or proxy',
          fixable: false,
        },
      ],
      summary: { total: 4, ok: 1, fixed: 1, warn: 1, needsYou: 1, skipped: 0, fixable: 0 },
      details: [
        ['Windows Sandbox', 'available'],
        ['Config file', 'F:\\AgentProjects\\config.json'],
        ['Projects running', 'windows-sandbox (launch)'],
      ],
      setup: {
        checks: [
          { name: 'Windows edition', status: 'ok', detail: 'Pro' },
          { name: 'Windows Sandbox feature', status: 'action', detail: 'turned off' },
          { name: 'Virtualization', status: 'ok', detail: 'on' },
        ],
        canEnable: true,
        error: null,
      },
      log: 'C:\\AgentData\\logs\\repair-20261016-093012.log',
    },
  });
}

const LOG_DIR = 'C:\\AgentData\\logs';

/** The engines and their checks (what engine.status returns): HCS is missing its features on this sample PC. */
function sampleEngines(): unknown {
  const capabilities = {
    desktop: true,
    gpu: true,
    clipboard: true,
    audio: true,
    video: true,
    printers: true,
    liveFolderAdd: true,
    attachedDisks: false,
    multipleInstances: true,
    hvsocket: false,
  };
  return engineStatus.output.parse({
    engine: 'windows-sandbox',
    engines: [
      {
        id: 'windows-sandbox',
        inUse: true,
        capabilities,
        check: { available: true, reasons: [], fixes: [] },
      },
      {
        id: 'hcs',
        inUse: false,
        capabilities: {
          ...capabilities,
          desktop: false,
          gpu: false,
          clipboard: false,
          audio: false,
          video: false,
          printers: false,
          liveFolderAdd: false,
          multipleInstances: true,
          hvsocket: true,
        },
        check: {
          available: false,
          reasons: ['The Containers feature is not turned on.', 'No Server Core image is on this PC.'],
          fixes: [
            'Enable-WindowsOptionalFeature -Online -FeatureName Containers -All',
            'Pull the Server Core image with Docker Desktop, or set AGENT_SANDBOX_HCS_IMAGE to a folder with one.',
          ],
        },
      },
    ],
  });
}

/** The sandbox's log files, newest first, and a crash report (what logs.list returns). */
function sampleLogs(): unknown {
  return listLogs.output.parse({
    folder: LOG_DIR,
    files: [
      {
        name: 'guest-2026-10-16.log',
        path: LOG_DIR + '\\guest-2026-10-16.log',
        bytes: 182400,
        modified: Date.now() - MINUTE,
      },
      {
        name: 'daemon-2026-10-16.log',
        path: LOG_DIR + '\\daemon-2026-10-16.log',
        bytes: 9216,
        modified: Date.now() - 12 * MINUTE,
      },
      {
        name: 'bootstrap-2026-10-14.log',
        path: LOG_DIR + '\\bootstrap-2026-10-14.log',
        bytes: 2048,
        modified: Date.now() - 2 * 24 * 60 * MINUTE,
      },
    ],
    crash: true,
  });
}

/** The end of one log (what logs.tail returns): plausible sandbox lines, one of them very long. */
function sampleLogTail(input: { readonly name?: string }): unknown {
  const name = input.name ?? 'guest-2026-10-16.log';
  if (name === CRASH)
    return tailLog.output.parse({
      name: CRASH,
      file: LOG_DIR + '\\crashes\\crash-2026-10-14-0912.txt',
      text: 'Crash report (preview)\nThis PC stopped responding at 09:02 and was restarted at 09:14.\n',
      next: 0,
    });
  const lines = Array.from({ length: 40 }, (_, i) =>
    i === 17
      ? '16:02:11 [daemon] session claude-4f2 env ' + 'PATH=C:\\nvm;C:\\Program Files\\Git\\cmd;'.repeat(6)
      : '16:' + String(i).padStart(2, '0') + ':11 [guest] ' + (i % 3 ? 'ok' : 'checked') + ' item ' + i,
  );
  return tailLog.output.parse({
    name,
    file: LOG_DIR + '\\' + name,
    text: lines.join('\n') + '\n',
    next: 0,
  });
}

/** A plausible audit log: two agents' sessions, the sandbox's own setup, a commit each, a guard finding. */
function sampleAuditLog(dir: string): AuditLog {
  const log = new AuditLog(dir, { days: 7, maxMb: 100 });
  const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * MINUTE).toISOString();
  const claude = { s: SESSIONS[0].id, ag: 'claude', pj: 'windows-sandbox', sv: 'p' as const };
  const codex = { s: 'mva7codex2k91x', ag: 'codex', pj: 'mw2-agent', sv: 'p' as const };
  const git = 'C:\\AgentData\\tools\\git\\cmd\\git.exe';
  const node = 'C:\\nvm\\nodejs\\node.exe';
  const ws = 'F:\\AgentProjects\\windows-sandbox';
  const mw = 'F:\\AgentProjects\\mw2-agent';
  const proc = (m: number, p: string, c: string, who: object, n?: number): AuditEvent => ({
    t: at(m),
    k: 'proc',
    p,
    c,
    pp: node,
    ...who,
    ...(n ? { n } : {}),
  });
  const file = (m: number, p: string, w: string, who: object): AuditEvent => ({
    t: at(m),
    k: 'file',
    a: 'change',
    p,
    w,
    ...who,
  });
  log.append([
    { t: at(95), k: 'note', p: 'sandbox started; audit: programs, files, commits, sessions' },
    proc(94, 'C:\\AgentData\\tools\\uv\\uv.exe', 'uv tool install aider-chat', {}),
    { t: at(90), k: 'session', a: 'start', p: 'claude', w: SESSIONS[0].cwd, c: claude.s, ...claude, sv: undefined },
    proc(88, git, 'git status --short', claude),
    proc(87, node, 'node dist/bin/agent-sandbox.js self-test audit', claude, 2),
    file(80, 'src/host/audit/collect.ts', ws, claude),
    file(79, 'src/app/features/audit/audit.def.ts', ws, claude),
    proc(70, 'C:\\nvm\\nodejs\\npm.cmd', 'npm run build', claude),
    {
      t: at(66),
      k: 'session',
      a: 'start',
      p: 'codex',
      w: 'C:\\Projects\\mw2-agent',
      c: codex.s,
      ...codex,
      sv: undefined,
    },
    proc(64, 'C:\\Users\\WDAGUtilityAccount\\.cargo\\bin\\cargo.exe', 'cargo build --release', codex, 3),
    file(60, 'src/main.rs', mw, { ...codex, sv: 't' }),
    proc(52, git, 'git commit -m "Audit: link programs to their session"', claude),
    {
      t: at(52),
      k: 'commit',
      a: 'commit',
      p: 'Audit: link programs to their session',
      h: 'a3f9c2e81b7d4c60a1e2f3b4c5d6e7f8a9b0c1d2',
      au: 'Josh <josh@example.com>',
      w: ws,
      ...claude,
    },
    proc(40, git, 'git push --set-upstream origin https://***@github.com/example/mw2-agent.git', codex),
    { t: at(38), k: 'guard', p: 'hook: a pre-push hook added inside the sandbox was neutralised' },
    proc(30, 'C:\\Users\\WDAGUtilityAccount\\.cargo\\bin\\cargo.exe', 'cargo test', codex, 4),
    {
      t: at(28),
      k: 'commit',
      a: 'commit',
      p: 'Fix the map loader',
      h: '7be0d41c9a2f4e3b8c1d0e9f8a7b6c5d4e3f2a1b',
      au: 'Josh <josh@example.com>',
      w: mw,
      ...codex,
    },
    {
      t: at(20),
      k: 'session',
      a: 'end',
      p: 'codex',
      w: 'C:\\Projects\\mw2-agent',
      c: codex.s + ' exit 0',
      ...codex,
      sv: undefined,
    },
    proc(5, node, 'node dist/bin/agent-sandbox.js self-test app', claude),
    { t: at(4), k: 'remote', p: 'sessions.restart', a: 'ok', au: "device Josh's iPhone" },
    { t: at(3), k: 'remote', p: 'settings.set', a: 'refused', au: 'Windows user DESKTOP-JOSH\\sam' },
  ]);
  return log;
}

const ACCESS_FINGERPRINT =
  '3A:7F:01:C2:9B:44:E8:15:6D:A0:2B:93:CC:71:58:0E:F4:12:9A:BD:63:07:E5:2C:48:D9:B1:76:0A:3F:C8:E2';

/** Remote access: LAN mode on, two devices, one Windows sign-in, a code waiting. */
function sampleAccess(): unknown {
  const at = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();
  return {
    lan: {
      enabled: true,
      running: true,
      address: 'https://192.168.1.20:47801',
      fingerprint: ACCESS_FINGERPRINT,
      problem: null,
      network: 'Home Wi-Fi',
    },
    windowsSignIn: true,
    users: [
      { name: 'sam', role: 'view' },
      { name: 'OFFICE\\kim', role: 'control' },
    ],
    rememberDays: 30,
    devices: [
      {
        id: '4f2c9a7e1b3d5f60',
        name: "Josh's iPhone",
        role: 'control',
        address: '192.168.1.42',
        createdAt: at(-24 * 6),
        expiresAt: at(24 * 24),
        lastSeen: at(-0.2),
      },
      {
        id: '9d1e0b2a7c4f6e83',
        name: 'Kitchen tablet',
        role: 'view',
        address: '192.168.1.57',
        createdAt: at(-24 * 20),
        expiresAt: at(24 * 10),
        lastSeen: at(-30),
      },
    ],
    windows: [{ id: '1a2b3c4d5e6f7a8b', user: 'DESKTOP-JOSH\\sam', createdAt: at(-3), expiresAt: at(24 * 30 - 3) }],
    pending: { role: 'view', expiresAt: at(0.06) },
    codeVoided: false,
  };
}

/** The real features where they only touch the temp folder, sample data for the rest. */
function previewRpc(ctx: AppContext, state: { running: boolean; vpnLogin: 'none' | 'saved' }): RpcHost {
  const auditDir = path.join(ctx.storageRoot, 'audit', 'preview');
  const audit = sampleAuditLog(auditDir);
  const sample = async (id: string, input: unknown, io: OperationIO): Promise<unknown> => {
    switch (id) {
      case 'audit.list':
        // The real listing over a sample log in the temp folder.
        return auditListing(
          audit,
          { enabled: true, days: 7, maxMb: 100 },
          listAudit.input.parse(input ?? {}),
          auditDir,
        );
      case 'sandbox.status':
        return sampleStatus(state.running);
      case 'access.status':
        return sampleAccess();
      case 'access.allowDevice':
        return {
          code: 'K7QD-M2XP',
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          role: (input as { role?: string } | null)?.role ?? 'view',
          address: 'https://192.168.1.20:47801',
          fingerprint: ACCESS_FINGERPRINT,
        };
      case 'vpn.status':
        return vpnStatus.output.parse({
          enabled: true,
          provider: 'nordvpn',
          protocol: 'udp',
          country: 'Netherlands',
          killSwitch: true,
          login: state.vpnLogin,
          loginSavedAt: state.vpnLogin === 'saved' ? '2026-10-14T09:30:00.000Z' : null,
          running: state.running
            ? {
                level: 'ok',
                text: 'VPN up (nl1234.nordvpn.com), the sandbox appears as 185.1.2.3 (this PC: 81.4.5.6).',
              }
            : null,
        });
      case 'vpn.login':
        // The preview asks the two questions like the real operation and keeps nothing of the answers.
        io.log('NordVPN needs its service credentials, not your usual login. To get them:', 'muted');
        if ((await io.secret({ title: 'Service user name' })) === undefined) cancelled();
        if ((await io.secret({ title: 'Service password' })) === undefined) cancelled();
        state.vpnLogin = 'saved';
        return { message: 'Saved. Turn the VPN on with: sandbox config set vpn.enabled true' };
      case 'vpn.logout':
        if (!(await io.confirm({ title: 'Delete the saved VPN login?', yes: 'Delete', danger: true }))) cancelled();
        state.vpnLogin = 'none';
        return { deleted: true, message: 'The saved VPN login is deleted.' };
      case 'health.last':
        return sampleHealth();
      case 'health.check':
        io.progress('Checking this PC');
        return {
          summary: { total: 4, ok: 1, fixed: 0, warn: 1, needsYou: 1, skipped: 0, fixable: 1 },
          changed: false,
          log: null,
        };
      case 'health.repair':
        io.log('Repair will change:', 'accent');
        io.log('  1. Install pointers: point the command at the new version');
        if (!(await io.confirm({ title: 'Fix this problem?', yes: 'Fix', danger: true }))) cancelled();
        return {
          summary: { total: 4, ok: 2, fixed: 1, warn: 1, needsYou: 0, skipped: 0, fixable: 0 },
          changed: false,
          log: null,
        };
      case 'health.enableSandbox':
        if (
          !(await io.confirm({
            title: 'Turn on Windows Sandbox?',
            lines: ['Windows asks for admin permission, then you restart Windows to finish.'],
            yes: 'Turn on',
            danger: true,
          }))
        )
          cancelled();
        return { message: 'Done. Restart Windows to finish. (preview: nothing was changed)' };
      case 'engine.status':
        return sampleEngines();
      case 'engine.leftovers':
        return { available: true, message: 'No HCS systems of yours are running.', systems: [] };
      case 'logs.list':
        return sampleLogs();
      case 'logs.tail':
        return sampleLogTail(input as { readonly name?: string });
      case 'sessions.list':
        return sampleSessions(state.running);
      case 'agents.list':
        return sampleAgents();
      case 'agents.start':
        return { session: SESSIONS[0].id, message: 'Started claude in windows-sandbox (preview: nothing started).' };
      case 'agents.makeDefault':
        return { message: 'codex is the default agent (preview: nothing was changed).' };
      case 'agents.remove':
        if (!(await io.confirm({ title: 'Remove aider?', yes: 'Remove', danger: true, implied: true }))) cancelled();
        return { message: 'Removed aider (preview: nothing was changed).' };
      case 'agents.add':
        return { name: 'preview', message: 'Added preview (preview: nothing was saved).' };
      case 'accounts.list':
        return sampleAccounts();
      case 'accounts.remove':
        if (!(await io.confirm({ title: 'Remove the saved account?', yes: 'Remove', danger: true }))) cancelled();
        return { message: 'Removed account (preview: nothing was changed).' };
      case 'accounts.use':
        return { lines: ['Sandbox now uses "work" (dev@example.com) (preview: nothing was changed).'] };
      case 'accounts.save':
      case 'accounts.default':
      case 'accounts.rename':
        return { name: 'preview', message: 'Done (preview: nothing was changed).' };
      case 'sandbox.stop':
        if (!(await io.confirm({ title: 'Stop the sandbox?', yes: 'Stop', danger: true }))) cancelled();
        io.progress('Stopping the sandbox');
        await new Promise((r) => setTimeout(r, 800));
        state.running = false;
        return { message: 'The sandbox is stopped (preview).' };
      case 'sandbox.show':
      case 'sandbox.hide':
        return { message: 'Done (preview: nothing was changed).' };
      case 'sessions.restart':
        return { message: 'Restarted (preview: nothing was changed).', restarted: 0 };
      case 'projects.list':
        return sampleProjects(state.running);
      case 'projects.add':
        return { message: 'Added F:\\Code\\scratch to your projects. (preview: nothing was saved)' };
      case 'projects.remove':
        if (!(await io.confirm({ title: 'Forget scratch?', yes: 'Forget', danger: true, implied: true }))) cancelled();
        return { message: 'Removed F:\\Code\\scratch from your projects (preview: nothing was changed).' };
      case 'projects.include':
      case 'projects.exclude':
        return { message: 'Excluded F:\\AgentProjects\\old-demo. (preview: nothing was changed)' };
      case 'projects.all':
        return { message: 'Mapping all projects at every start is on. (preview: nothing was changed)' };
      case 'projects.roots':
        if (
          !(await io.confirm({ title: 'Remove the root AgentProjects?', yes: 'Remove', danger: true, implied: true }))
        )
          cancelled();
        return { message: 'Removed the project root F:\\AgentProjects. (preview: nothing was changed)' };
      case 'projects.choose': {
        const picked = await io.checklist({
          title: 'Projects mapped at every start, so they open without a restart:',
          choices: [
            { value: 'windows-sandbox', label: 'F:\\AgentProjects\\windows-sandbox  (this folder)' },
            { value: 'mw2-agent', label: 'F:\\AgentProjects\\mw2-agent' },
            { value: 'scratch', label: 'F:\\Code\\scratch' },
          ],
          checked: ['windows-sandbox', 'mw2-agent'],
        });
        if (picked === undefined) cancelled();
        return { message: picked.length + ' project(s) mapped at every start (preview: nothing was changed).' };
      }
      case 'updates.status':
        return sampleUpdates();
      // Fakes only: the preview never checks GitHub, installs, or switches anything on this PC.
      case 'updates.update': {
        const u = input as { check?: boolean; rollback?: boolean; auto?: 'on' | 'off' };
        if (u.rollback) {
          if (
            !(await io.confirm({
              title: 'Go back from version 1.4.3 to version 1.4.2?',
              lines: ['Takes effect the next time you start it.'],
              yes: 'Go back',
              danger: true,
            }))
          )
            cancelled();
          return { line: 'Went back to version 1.4.2. (preview: nothing was changed)', latest: null };
        }
        if (u.auto)
          return { line: 'Automatic updates are ' + u.auto + '. (preview: nothing was changed)', latest: null };
        if (u.check)
          return { line: 'Version 1.5.0 is available (you have 1.4.3). Run: sandbox update', latest: '1.5.0' };
        if (!(await io.confirm({ title: 'Install the newest version if there is one?', yes: 'Install', danger: true })))
          cancelled();
        return { line: 'You have the newest version (1.4.3). (preview: nothing was installed)', latest: null };
      }
      case 'updates.migrate':
        return { line: 'Updated: 2026-10-unpin-config-defaults. (preview: nothing was changed)' };
      case 'data.show':
        return sampleData();
      case 'storage.show':
        return sampleStorage();
      case 'storage.containedStatus':
        return sampleContained();
      case 'storage.change': {
        // The real flow asks for the folder (the browser), then move or switch; the preview asks the same questions.
        const picked = await io.path({
          title: 'Choose the folder for your saved data',
          lines: ['Now: F:\\AgentSandbox (8.9 GB).'],
          pathKind: 'dir',
          initial: 'F:\\',
        });
        if (picked === undefined) cancelled();
        const how = await io.choose({
          title: 'Move your data to ' + picked + '?',
          lines: ['From: F:\\AgentSandbox', 'Size: 8.9 GB', 'Time: a few seconds (same drive, nothing is copied)'],
          choices: [
            { value: 'move', label: 'Move data' },
            { value: 'use', label: 'Switch without moving' },
            { value: 'cancel', label: 'Cancel' },
          ],
        });
        if (how === undefined || how === 'cancel') cancelled();
        return { message: 'Done (preview: nothing was moved or switched).' };
      }
      case 'storage.move':
        if (!(await io.confirm({ title: 'Move your data to F:\\Sandbox?', yes: 'Move' }))) cancelled();
        return { message: 'Moved (preview: nothing was moved).' };
      case 'storage.use':
        if (!(await io.confirm({ title: 'Use F:\\Sandbox from now on, without moving your data?', yes: 'Use' })))
          cancelled();
        return { message: 'Your data is now looked for in F:\\Sandbox (preview: nothing was changed).' };
      case 'storage.containedOn':
        if (!(await io.confirm({ title: 'Turn contained storage on?', yes: 'Turn on' }))) cancelled();
        return { message: 'Contained storage is on (preview: nothing was changed).' };
      case 'storage.containedOff':
        if (!(await io.confirm({ title: 'Turn contained storage off?', yes: 'Turn off', danger: true }))) cancelled();
        return { message: 'Contained storage is off (preview: nothing was changed).' };
      case 'data.clean':
      case 'data.prune':
        if (!(await io.confirm({ title: 'Delete the chosen data?', yes: 'Delete', danger: true, implied: true })))
          cancelled();
        return { message: 'Removed (preview: nothing was deleted).', freedBytes: 0, removed: true };
      case 'apps.request':
        // The real operation opens a browser on this PC; the preview only shows the address it would open.
        return {
          url: 'https://github.com/JoshDiDuca/windows-development-sandbox/issues/new (preview: nothing opened)',
        };
      default:
        return undefined;
    }
  };
  const kinds: Record<string, 'operation' | 'query'> = {
    'sandbox.status': 'query',
    'sessions.list': 'query',
    'settings.list': 'query',
    'vpn.status': 'query',
    'vpn.login': 'operation',
    'vpn.logout': 'operation',
    'sandbox.stop': 'operation',
    'sandbox.show': 'operation',
    'sandbox.hide': 'operation',
    'sessions.restart': 'operation',
    'agents.list': 'query',
    'agents.start': 'operation',
    'agents.makeDefault': 'operation',
    'agents.remove': 'operation',
    'agents.add': 'operation',
    'accounts.list': 'query',
    'accounts.save': 'operation',
    'accounts.use': 'operation',
    'accounts.default': 'operation',
    'accounts.rename': 'operation',
    'accounts.remove': 'operation',
    'settings.set': 'operation',
    'settings.reset': 'operation',
    'files.browse': 'query',
    'apps.list': 'query',
    'apps.toggle': 'operation',
    'apps.setCustom': 'operation',
    'apps.request': 'operation',
    'projects.list': 'query',
    'projects.add': 'operation',
    'projects.remove': 'operation',
    'projects.include': 'operation',
    'projects.exclude': 'operation',
    'projects.all': 'operation',
    'projects.roots': 'operation',
    'projects.choose': 'operation',
    'health.last': 'query',
    'health.check': 'operation',
    'health.repair': 'operation',
    'health.enableSandbox': 'operation',
    'data.show': 'query',
    'updates.status': 'query',
    'updates.update': 'operation',
    'updates.migrate': 'operation',
    'storage.show': 'query',
    'storage.containedStatus': 'query',
    'storage.change': 'operation',
    'storage.move': 'operation',
    'storage.use': 'operation',
    'storage.containedOn': 'operation',
    'storage.containedOff': 'operation',
    'data.clean': 'operation',
    'data.prune': 'operation',
    'logs.list': 'query',
    'logs.tail': 'query',
    'engine.status': 'query',
    'engine.leftovers': 'query',
    'audit.list': 'query',
    'access.status': 'query',
    'access.allowDevice': 'operation',
    'access.revoke': 'operation',
    'access.revokeAll': 'operation',
    'access.lanOn': 'operation',
    'access.lanOff': 'operation',
  };
  return {
    kind: (id) => kinds[id],
    need: (id) => (kinds[id] ? 'view' : undefined),
    liveMs: (id) => (id === 'sandbox.status' || id === 'sessions.list' ? 2500 : id === 'logs.tail' ? 1000 : undefined),
    run: async (id, input, io) =>
      id !== 'apps.request' && (id.startsWith('settings.') || id.startsWith('apps.') || id === 'files.browse')
        ? runDefinition(id, ctx, input, io)
        : ((await sample(id, input, io)) ?? {}),
  };
}

async function main(): Promise<void> {
  const portArg = process.argv.indexOf('--port');
  const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 47900;
  const packageRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')),
    '../../..',
  );
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-web-preview-'));
  const project = path.join(temp, 'project');
  fs.mkdirSync(project);
  const configPath = path.join(temp, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      sandbox: { memoryMb: 16384, vGpu: true },
      web: { enabled: true },
      apps: { install: ['lazygit', 'bruno', 'chrome'] },
    }),
  );
  // Apps: three of the catalogue are downloaded already (the marker a finished download leaves in the data folder).
  const dataPath = path.join(temp, 'data');
  for (const id of ['lazygit', 'bruno', 'sysinternals']) {
    const marker = path.join(dataPath, 'tools', 'apps', id);
    fs.mkdirSync(marker, { recursive: true });
    fs.writeFileSync(path.join(marker, '.agent-sandbox-app'), id);
  }
  const ctx = {
    loaded: { configPath },
    options: { workspace: project },
    storageRoot: path.join(temp, 'storage'),
    dataPath,
  } as unknown as AppContext;
  const state: { running: boolean; vpnLogin: 'none' | 'saved' } = { running: true, vpnLogin: 'none' };
  const ptyPort = await startFakePty();
  const backend: WebBackend = {
    info: () =>
      Promise.resolve({
        sandbox: state.running ? 'running' : 'stopped',
        owner: null,
        canUse: true,
        harnesses: ['claude', 'codex', 'gemini', 'opencode'],
        defaultHarness: 'claude',
        projects: [
          { name: 'windows-sandbox', guest: 'C:\\Projects\\AgentProjects\\windows-sandbox' },
          { name: 'mw2-agent', guest: 'C:\\Projects\\AgentProjects\\mw2-agent' },
        ],
      }),
    sessions: () => Promise.resolve(state.running ? SESSIONS.map((s, i) => webSession(s, i)) : []),
    endpoint: (id) =>
      SESSIONS.some((s) => s.id === id) ? { addresses: ['127.0.0.1'], port: ptyPort, token: 'preview' } : null,
  };
  const server = new WebServer({
    port,
    token: TOKEN,
    backend,
    staticRoot: path.join(packageRoot, 'dist', 'web'),
    rpc: previewRpc(ctx, state),
    onStop: () => process.exit(0),
  });
  await server.start();
  console.log('Web UI preview (sample data; settings in ' + configPath + '):');
  console.log('http://127.0.0.1:' + server.port + '/#k=' + TOKEN);
}

void main();
