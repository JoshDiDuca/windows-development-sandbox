// A preview of the web UI for working on it: the real server and app, the real settings feature against a config file
// in a temp folder, and sample data for the sandbox and its sessions (a stand-in terminal plays a short agent screen).
// Nothing on this PC is read or changed. Run: npm run web:preview [-- --port 47900], then open the printed address.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AppContext } from '../../app/context.js';
import { sandboxStatus } from '../../app/features/sandbox/index.js';
import { vpnStatus } from '../../app/features/vpn/index.js';
import { listSessions } from '../../app/features/sessions/index.js';
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

/** The real features where they only touch the temp folder, sample data for the rest. */
function previewRpc(ctx: AppContext, state: { running: boolean; vpnLogin: 'none' | 'saved' }): RpcHost {
  const sample = async (id: string, io: OperationIO): Promise<unknown> => {
    switch (id) {
      case 'sandbox.status':
        return sampleStatus(state.running);
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
      case 'sessions.list':
        return sampleSessions(state.running);
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
    'settings.set': 'operation',
    'settings.reset': 'operation',
    'files.browse': 'query',
  };
  return {
    kind: (id) => kinds[id],
    liveMs: (id) => (id === 'sandbox.status' || id === 'sessions.list' ? 2500 : undefined),
    run: async (id, input, io) =>
      id.startsWith('settings.') || id === 'files.browse'
        ? runDefinition(id, ctx, input, io)
        : ((await sample(id, io)) ?? {}),
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
  fs.writeFileSync(configPath, JSON.stringify({ sandbox: { memoryMb: 16384, vGpu: true }, web: { enabled: true } }));
  const ctx = {
    loaded: { configPath },
    options: { workspace: project },
    storageRoot: path.join(temp, 'storage'),
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
    create: () => Promise.resolve(webSession(SESSIONS[0], 0)),
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
