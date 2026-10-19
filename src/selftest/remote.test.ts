// Remote access (docs/design/remote-access.md): the access list (one-time codes, sealed token hashes, expiry,
// revocation), roles failing closed on every RPC call, Windows sign-in with a fake helper (bound cookies, refusals),
// device sign-in on the LAN listener (cookies, limits, what each listener accepts), the LAN address and peer rules, the
// certificate, the firewall script's checks (dry run), the server identity check, and that a repo cannot turn any of
// it on.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { OPERATIONS, QUERIES } from '../app/features/defs.js';
import { controlSettingAccess } from '../app/features/settings/index.js';
import { accessNeeded, allows, OWNER, type Caller, type RpcHost } from '../app/kernel/index.js';
import { createRpcHost } from '../app/registry.js';
import { DEFAULTS } from '../core/config/index.js';
import { normalizeOverrides } from '../core/local-config/overrides.js';
import type { WebRemote } from '../core/schema/web.js';
import { AuditLog } from '../host/audit/index.js';
import {
  AccessStore,
  addRuleRequest,
  applyFirewall,
  checkFirewall,
  chooseLanAddress,
  CODE_MAX_WRONG,
  deviceName,
  FIREWALL_RULE_NAME,
  isPrivateIPv4,
  knockProblem,
  lanPeerProblem,
  makeCertificate,
  networkProblem,
  normalizeCode,
  parseDoorAnswer,
  parseHelperLine,
  RemoteGate,
  removeRuleRequest,
  spawnRunner,
  TlsStore,
  type Interfaces,
  type Knock,
  type RemoteAuditEntry,
  type RouteIO,
  type WindowsAccount,
  type WindowsHelper,
} from '../host/remote/index.js';
import { SecretStore } from '../host/secrets/index.js';
import { WebControl, WebServer, WebStore, type WebBackend } from '../host/web/index.js';
import { CSRF_HEADER, CSRF_VALUE } from '../shared/web/index.js';
import type { Suite } from './support/suite.js';

const TOKEN = 'b'.repeat(64);
const OWNER_SID = 'S-1-5-21-1-2-3-1001';
const BOB_SID = 'S-1-5-21-1-2-3-1002';
const MALLORY_SID = 'S-1-5-21-1-2-3-1003';
const BOB: WindowsAccount = { sid: BOB_SID, user: 'PC\\bob' };
const DAY = 86_400_000;

/** A Windows helper stand-in: whoever the test says is at the other end of the next connection. */
class FakeHelper implements WindowsHelper {
  current: WindowsAccount | null = null;
  readonly names: Record<string, WindowsAccount> = { bob: BOB, alice: { sid: OWNER_SID, user: 'PC\\alice' } };
  peer(): Promise<WindowsAccount | null> {
    return Promise.resolve(this.current);
  }
  lookup(name: string): Promise<WindowsAccount | null> {
    return Promise.resolve(this.names[name.toLowerCase().replace(/^pc\\/, '')] ?? null);
  }
  onKnock(): void {}
  onProblem(): void {}
  stop(): void {}
}

const backend: WebBackend = {
  info: () =>
    Promise.resolve({
      sandbox: 'stopped',
      owner: null,
      canUse: false,
      harnesses: [],
      defaultHarness: 'claude',
      projects: [],
    }),
  sessions: () => Promise.resolve([]),
  endpoint: () => null,
};

interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** One request on its own connection (no keep-alive: the peer check is per connection). */
function send(
  port: number,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, agent: false, headers: { Host: '127.0.0.1:' + port, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function sameSite(port: number): Record<string, string> {
  return { Origin: 'http://127.0.0.1:' + port, [CSRF_HEADER]: CSRF_VALUE, 'Content-Type': 'application/json' };
}

function remoteSettings(over: Partial<WebRemote> = {}): WebRemote {
  return { ...structuredClone(DEFAULTS.web.remote), ...over };
}

/** A fake host: one control operation, one owner operation, one query. */
function fakeHost(): { host: RpcHost; ran: string[] } {
  const ran: string[] = [];
  const need = (id: string) =>
    id === 'test.work'
      ? ('control' as const)
      : id === 'test.admin'
        ? ('owner' as const)
        : id === 'test.read'
          ? ('view' as const)
          : undefined;
  return {
    ran,
    host: {
      kind: (id) => (id === 'test.read' ? 'query' : need(id) ? 'operation' : undefined),
      liveMs: () => undefined,
      need,
      run: async (id) => {
        ran.push(id);
        return { ok: true };
      },
    },
  };
}

/** Opens an RPC socket, sends one call, returns the first answer for it (or the close code). */
async function rpcCall(
  port: number,
  cookie: string,
  op: string,
): Promise<{ t?: string; message?: string; closed?: number }> {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/api/rpc', {
    headers: { Cookie: cookie, Origin: 'http://127.0.0.1:' + port },
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ t: 'timeout' }), 4000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'call', id: 'c1', op, input: {} })));
    ws.on('message', (data: Buffer) => {
      const m = JSON.parse(data.toString()) as { t: string; error?: { message: string } };
      clearTimeout(timer);
      resolve({ t: m.t, message: m.error?.message });
      ws.close();
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      resolve({ closed: res.statusCode });
    });
    ws.on('error', () => undefined);
  });
}

/** A fake request on the LAN listener (a TLS socket from `address`). */
function lanRequest(address: string, headers: Record<string, string> = {}, method = 'POST'): http.IncomingMessage {
  return {
    method,
    headers: {
      host: '192.168.1.20:47801',
      origin: 'https://192.168.1.20:47801',
      [CSRF_HEADER]: CSRF_VALUE,
      ...headers,
    },
    socket: { encrypted: true, remoteAddress: address, localAddress: '192.168.1.20' },
  } as unknown as http.IncomingMessage;
}

interface Answered {
  status: number;
  body: unknown;
  headers: http.OutgoingHttpHeaders;
}

function routeIO(body: unknown, out: { last?: Answered }): RouteIO {
  return {
    body: () => Promise.resolve(body),
    json: (status, b, headers = {}) => (out.last = { status, body: b, headers }),
    requireSameSite: () => undefined,
  };
}

const IFACES: Interfaces = {
  'Wi-Fi': [
    { address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
  ],
  'vEthernet (Default Switch)': [
    { address: '172.30.80.1', netmask: '255.255.240.0', family: 'IPv4', mac: '', internal: false, cidr: null },
  ],
  Ethernet: [{ address: '8.8.4.4', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null }],
} as unknown as Interfaces;

export const remoteSuite: Suite = {
  name: 'remote',
  title: 'remote access: codes, devices, Windows sign-in, roles, LAN rules, certificate, firewall checks',
  run: async (t) => {
    t.section('defaults and repo files');
    const r = DEFAULTS.web.remote;
    t.check(
      !r.windowsSignIn && r.users.length === 0 && !r.lan.enabled && r.rememberDays === 30 && r.lan.address === '',
      'everything remote is off by default (loopback and the token only, as before)',
    );
    const repo = t.dir('repo');
    t.check(
      (await t.thrownMessage(() => normalizeOverrides({ web: { remote: { lan: { enabled: true } } } }, repo, 'x'))) !==
        '' && (await t.thrownMessage(() => normalizeOverrides({ web: { enabled: true } }, repo, 'x'))) !== '',
      "a repo's .sandbox-config.json cannot turn on the web UI, LAN mode or Windows sign-in",
    );

    t.section('the access list: one-time codes and sealed hashes');
    let clock = Date.parse('2026-10-01T00:00:00Z');
    const dir = t.dir('web');
    const store = new AccessStore(dir, SecretStore.memory(), { now: () => clock });
    t.check(
      !store.codePending() && store.redeem('ABCD-EFGH', 'x', '192.168.1.5', 30).ok === false,
      'no code: nothing to redeem',
    );
    const { code } = store.newDeviceCode('control');
    t.check(/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code), 'a code is 8 characters people can read and type');
    t.check(
      normalizeCode(code.slice(0, 4).toLowerCase() + '-' + code.slice(4)) === code,
      'lower case and a dash are fine',
    );
    t.check(
      normalizeCode('O0IL1234') === '00111234' && normalizeCode('ABC') === null && normalizeCode(42) === null,
      'O, I and L read as 0 and 1; junk is no code',
    );
    const fileText = fs.readFileSync(path.join(dir, 'access.json'), 'utf8');
    t.check(
      !fileText.includes(code) && /"sealed": "mem1:/.test(fileText),
      'only a sealed list is written; the code itself is not in it',
    );
    const wrong = store.redeem('ZZZZ-ZZZZ', 'Phone', '192.168.1.5', 30);
    t.check(!wrong.ok && wrong.reason === 'wrong' && store.codePending(), 'a wrong code is refused and the code stays');
    const paired = store.redeem(code, 'Phone', '192.168.1.5', 30);
    t.check(
      paired.ok && paired.device.role === 'control',
      'the right code gives a device credential with the chosen role',
    );
    const credential = paired.ok ? paired.credential : '';
    t.check(!store.codePending() && !store.redeem(code, 'Again', '192.168.1.6', 30).ok, 'a code works once');
    const token = credential.split('.')[1] ?? '';
    const sealed = SecretStore.memory().openJson(
      JSON.parse(fs.readFileSync(path.join(dir, 'access.json'), 'utf8')).sealed,
    ) as {
      devices: { tokenHash: string }[];
    };
    t.check(
      !JSON.stringify(sealed).includes(token) &&
        sealed.devices[0]?.tokenHash === crypto.createHash('sha256').update(token).digest('hex'),
      'only the SHA-256 of the device token is kept',
    );
    t.check(store.device(credential)?.name === 'Phone', 'the credential finds its device');
    t.check(
      store.device(credential.replace(/.$/, (c) => (c === '0' ? '1' : '0'))) === null && store.device('junk') === null,
      'a changed or malformed credential finds nothing',
    );
    store.newDeviceCode('view');
    clock += 6 * 60_000;
    const late = store.redeem('ABCD-EFGH', 'x', '192.168.1.5', 30);
    t.check(!late.ok && !store.codePending(), 'a code runs out after 5 minutes');
    const second = store.newDeviceCode('view');
    for (let i = 0; i < CODE_MAX_WRONG; i++) store.redeem('ZZZZ-ZZZY', 'x', '192.168.1.' + i, 30);
    t.check(
      !store.codePending() && store.read().codeVoided && !store.redeem(second.code, 'x', '192.168.1.9', 30).ok,
      'a code is void after ' + CODE_MAX_WRONG + ' wrong tries, and the PC is told',
    );
    clock += 31 * DAY;
    t.check(store.device(credential) === null, 'a device is signed out after rememberDays (fixed, not renewed by use)');
    const c2 = store.newDeviceCode('view');
    const d2 = store.redeem(c2.code, 'Tablet', '192.168.1.7', 30);
    const cred2 = d2.ok ? d2.credential : '';
    t.check(d2.ok && store.revoke(d2.device.id) && store.device(cred2) === null, 'revoking a device ends it');
    const c3 = store.newDeviceCode('view');
    const d3 = store.redeem(c3.code, 'Laptop', '192.168.1.8', 30);
    const win = store.issueWindows(BOB_SID, 'PC\\bob', 30);
    store.newDeviceCode('view');
    store.revokeAll();
    t.check(
      d3.ok &&
        store.device(d3.credential) === null &&
        store.windowsGrant(win) === null &&
        !store.codePending() &&
        store.read().epoch === 1,
      'revoke all ends every device and Windows sign-in, voids the pending code and moves the epoch',
    );
    const foreign = new AccessStore(dir, SecretStore.dpapi());
    t.check(foreign.read().devices.length === 0, 'a list sealed by another box lets nobody in');

    t.section('roles fail closed');
    t.check(
      accessNeeded({ kind: 'query' }, {}) === 'view' && accessNeeded({ kind: 'operation' }, {}) === 'owner',
      'without a word: a query needs view, an operation needs owner',
    );
    const control = OPERATIONS.filter((d) => accessNeeded(d, {}) === 'control')
      .map((d) => d.id)
      .sort();
    t.equal(
      control.join(),
      [
        'agents.start',
        'apps.request',
        'health.check',
        'sandbox.hideWindow',
        'sandbox.showWindow',
        'sandbox.stop',
        'sessions.restart',
      ].join(),
      'only an explicit short list of operations is open to control',
    );
    t.check(
      OPERATIONS.filter((d) => d.id.startsWith('access.')).every((d) => accessNeeded(d, {}) === 'owner') &&
        QUERIES.filter((d) => d.id === 'access.status' || d.id === 'files.browse').every(
          (d) => accessNeeded(d, {}) === 'owner',
        ),
      "remote access, its list and the folder picker are the owner's",
    );
    t.check(
      controlSettingAccess({ key: 'attach.auto' }) === 'control' &&
        [
          'web.remote.lan.enabled',
          'web.enabled',
          'mappings',
          'secrets.strip',
          'network.blockPrivateRanges',
          'audit.enabled',
          'sharing.otherUsers',
          'storage.root',
          'harnesses.claude.environment',
          'attach',
        ].every((key) => controlSettingAccess({ key }) === 'owner') &&
        controlSettingAccess({ key: 'attach.auto', scope: 'project' }) === 'owner',
      'control may change only harmless settings in the user file; never web.*, folders, secrets, network, audit or sharing',
    );
    const viewer: Caller = { kind: 'device', id: 'x', name: 'x', role: 'view' };
    const controller: Caller = { kind: 'windows', user: 'bob', role: 'control' };
    t.check(
      allows(OWNER, 'owner') &&
        !allows(controller, 'owner') &&
        allows(controller, 'control') &&
        !allows(viewer, 'control') &&
        allows(viewer, 'view'),
      'owner > control > view',
    );
    const realHost = createRpcHost({} as never);
    t.check(
      realHost.need('settings.set', { key: 'web.remote.users' }) === 'owner' &&
        realHost.need('sandbox.status', {}) === 'view',
      'the RPC host says what each call needs',
    );
    t.equal(
      await t.thrownMessage(() =>
        realHost.run('settings.set', { key: 'web.remote.users', value: [] }, undefined as never, controller),
      ),
      'Only the owner of this PC can do that, at the PC.',
      'createRpcHost refuses a call the role does not reach, before it runs',
    );

    t.section('Windows sign-in (fake helper): the pipe, bound cookies, roles on every call');
    const helper = new FakeHelper();
    let settings = remoteSettings({ windowsSignIn: true, users: [{ name: 'bob', role: 'view' }] });
    const audit: RemoteAuditEntry[] = [];
    const gate = new RemoteGate({
      store: new AccessStore(t.dir('web2'), SecretStore.memory()),
      settings: () => settings,
      ownerSid: OWNER_SID,
      helper,
      audit: (e) => audit.push(e),
      port: () => 0,
    });
    const knock = (k: Partial<Knock>): Promise<string> =>
      gate.knock({ sid: BOB_SID, user: 'PC\\bob', integrity: 0x2000, appContainer: false, ...k });
    t.check(
      (await knock({ integrity: 0x1000 })).startsWith('refused') &&
        (await knock({ appContainer: true })).startsWith('refused') &&
        (await knock({ sid: OWNER_SID })).startsWith('refused') &&
        (await knock({ sid: 'S-1-5-18' })).startsWith('refused') &&
        (await knock({ sid: MALLORY_SID, user: 'PC\\mallory' })).startsWith('refused'),
      'low integrity, AppContainers, services, the owner and users not on the list are refused',
    );
    settings = remoteSettings({ windowsSignIn: false, users: [{ name: 'bob', role: 'view' }] });
    t.check(
      (await knock({})).includes('Windows sign-in is off'),
      'with web.remote.windowsSignIn off everyone is refused',
    );
    settings = remoteSettings({ windowsSignIn: true, users: [{ name: 'bob', role: 'view' }] });
    const answer = await knock({});
    const once = /^ok ([0-9a-f]{64}) \d+ view$/.exec(answer)?.[1] ?? '';
    t.check(once !== '', 'a listed user gets a one-time link with their role');
    t.check(
      audit.some((a) => a.outcome === 'refused' && a.who.includes('mallory')),
      'refused knocks are in the audit log',
    );

    const { host, ran } = fakeHost();
    const server = new WebServer({ port: 0, token: TOKEN, backend, staticRoot: t.dir('static'), rpc: host, gate });
    await server.start();
    try {
      const port = server.port;
      helper.current = { sid: MALLORY_SID, user: 'PC\\mallory' };
      const stolen = await send(port, 'POST', '/api/login/once', sameSite(port), JSON.stringify({ token: once }));
      t.check(stolen.status === 403, 'the one-time link only works for the Windows user it was made for');
      const again = await knock({});
      const once2 = /^ok ([0-9a-f]{64})/.exec(again)?.[1] ?? '';
      helper.current = BOB;
      const login = await send(port, 'POST', '/api/login/once', sameSite(port), JSON.stringify({ token: once2 }));
      const setCookie = (login.headers['set-cookie'] ?? [])[0] ?? '';
      t.check(
        login.status === 200 && /^sbxwin=[0-9a-f]{16}\.[0-9a-f]{64};/.test(setCookie),
        'Bob signs in with the link',
      );
      t.check(
        /HttpOnly/.test(setCookie) &&
          /SameSite=Strict/.test(setCookie) &&
          /Max-Age=2592000/.test(setCookie) &&
          !/Secure/.test(setCookie),
        'his cookie: HttpOnly, SameSite=Strict, remembered 30 days (no Secure on plain loopback)',
      );
      const reuse = await send(port, 'POST', '/api/login/once', sameSite(port), JSON.stringify({ token: once2 }));
      t.check(reuse.status === 401, 'the link works once');
      const cookie = setCookie.split(';')[0];
      const me = await send(port, 'GET', '/api/me', { Cookie: cookie });
      t.check(me.status === 200 && JSON.parse(me.body).access === 'view', '/api/me says view');
      helper.current = { sid: MALLORY_SID, user: 'PC\\mallory' };
      t.check(
        (await send(port, 'GET', '/api/me', { Cookie: cookie })).status === 401,
        "Bob's cookie is refused from another Windows user's connection",
      );
      helper.current = BOB;
      const read = await rpcCall(port, cookie, 'test.read');
      const work = await rpcCall(port, cookie, 'test.work');
      const admin = await rpcCall(port, cookie, 'test.admin');
      t.check(read.t === 'result', 'view: a query runs');
      t.check(
        work.t === 'error' && work.message === 'Your access is view only.' && admin.t === 'error',
        'view: operations are refused',
      );
      t.check(!ran.includes('test.work') && !ran.includes('test.admin'), 'a refused call never reaches the host');
      t.check(
        audit.some((a) => a.what === 'test.work' && a.outcome === 'refused' && a.who.includes('bob')),
        'refusals are written to the audit log with who did it',
      );
      t.check(
        (await send(port, 'POST', '/api/stop', { ...sameSite(port), Cookie: cookie }, '{}')).status === 403,
        'only the owner stops the web UI',
      );
      settings = remoteSettings({ windowsSignIn: true, users: [{ name: 'bob', role: 'control' }] });
      const work2 = await rpcCall(port, cookie, 'test.work');
      const admin2 = await rpcCall(port, cookie, 'test.admin');
      t.check(work2.t === 'result' && admin2.t === 'error', 'control: control operations run, owner operations do not');
      t.check(
        audit.some((a) => a.what === 'test.work' && a.outcome === 'ok'),
        'what a remote user did is in the audit log',
      );

      // An open socket ends with the access.
      const ws = new WebSocket('ws://127.0.0.1:' + port + '/api/rpc', {
        headers: { Cookie: cookie, Origin: 'http://127.0.0.1:' + port },
      });
      let closedWith = 0;
      ws.on('close', (c: number) => (closedWith = c));
      ws.on('error', () => undefined);
      await t.waitFor(() => ws.readyState === WebSocket.OPEN, 3000);
      settings = remoteSettings({ windowsSignIn: true, users: [] });
      await gate.recheck();
      await t.waitFor(() => closedWith !== 0, 3000);
      t.check(closedWith === 4001, 'taking a user off the list closes their open pages');
      t.check(
        (await send(port, 'GET', '/api/me', { Cookie: cookie })).status === 401,
        '...and their cookie no longer works',
      );

      helper.current = { sid: OWNER_SID, user: 'PC\\alice' };
      const ownerLogin = await send(port, 'POST', '/api/login', sameSite(port), JSON.stringify({ token: TOKEN }));
      const ownerCookie = ((ownerLogin.headers['set-cookie'] ?? [])[0] ?? '').split(';')[0];
      t.check(
        (await send(port, 'GET', '/api/me', { Cookie: ownerCookie })).status === 200,
        "the owner's token cookie works from the owner's connections",
      );
      helper.current = BOB;
      t.check(
        (await send(port, 'GET', '/api/me', { Cookie: ownerCookie })).status === 401,
        "the owner's cookie is refused from another user's connection (a cookie taken through another port is useless)",
      );
      helper.current = { sid: OWNER_SID, user: 'PC\\alice' };
      t.check((await rpcCall(port, ownerCookie, 'test.admin')).t === 'result', 'the owner may do everything');

      t.section('the server proves who it is (security review #10)');
      const webDir = t.dir('webstate');
      const webStore = new WebStore(webDir, () => undefined);
      webStore.write({ pid: process.pid, port, token: TOKEN, startedAt: new Date().toISOString() });
      t.check((await new WebControl(webStore).status()).running, 'our server answers the challenge with the token');
      const squatter = http.createServer((_q, res) => res.end('{"ok":true}'));
      await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', () => resolve()));
      webStore.write({
        pid: process.pid,
        port: (squatter.address() as net.AddressInfo).port,
        token: TOKEN,
        startedAt: new Date().toISOString(),
      });
      t.check(
        !(await new WebControl(webStore).status()).running,
        'another program on the port is not taken for the web UI (no token link for it)',
      );
      squatter.close();
      const worker = await send(port, 'GET', '/sw.js', { 'Service-Worker': 'script' });
      t.includes(worker.body, 'unregister', 'a service worker someone else registered on this origin is told to go');
    } finally {
      await server.stop();
    }

    t.section('devices on the LAN listener (routes on a fake TLS request)');
    const lanStore = new AccessStore(t.dir('web3'), SecretStore.memory());
    const lanAudit: RemoteAuditEntry[] = [];
    const lanGate = new RemoteGate({
      store: lanStore,
      settings: () => remoteSettings({ lan: { enabled: true, port: 47801, address: '192.168.1.20' } }),
      ownerSid: OWNER_SID,
      helper: null,
      audit: (e) => lanAudit.push(e),
      port: () => 47800,
    });
    const out: { last?: Answered } = {};
    t.check(
      (await lanGate.route(lanRequest('192.168.1.50'), '/api/pair', routeIO({ code: 'ABCD-EFGH' }, out))) &&
        out.last?.status === 409,
      'with no code pending, a device is told to ask on the PC (not counted as a wrong try)',
    );
    const lanCode = lanStore.newDeviceCode('view').code;
    for (let i = 0; i < 5; i++)
      await lanGate.route(lanRequest('192.168.1.66'), '/api/pair', routeIO({ code: 'ZZZZ-ZZZZ' }, out));
    await lanGate.route(lanRequest('192.168.1.66'), '/api/pair', routeIO({ code: lanCode }, out));
    t.check(out.last?.status === 429, 'five wrong codes a minute from one address: that address waits');
    await lanGate.route(
      lanRequest('192.168.1.50'),
      '/api/pair',
      routeIO({ code: lanCode, name: 'Josh\x1b[31m phone' }, out),
    );
    const devCookie = String((out.last?.headers['Set-Cookie'] as string | undefined) ?? '');
    t.check(out.last?.status === 200, 'another address with the right code is let in');
    t.check(
      /^__Host-sbxdev=[0-9a-f]{16}\.[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/.test(
        devCookie,
      ),
      'the device cookie: __Host-, Secure, HttpOnly, SameSite=Strict, the remember time',
    );
    t.equal(lanStore.read().devices[0]?.name, 'Josh phone', 'a device name loses escape sequences');
    t.check(
      deviceName('') === 'A device' && deviceName('x'.repeat(99)).length === 40,
      'device names: a default, at most 40 characters',
    );
    t.check(
      lanAudit.some((a) => a.what === 'allow device' && a.outcome === 'ok'),
      'allowing a device is in the audit log',
    );
    const devValue = devCookie.split(';')[0];
    const lanCaller = await lanGate.caller(lanRequest('192.168.1.50', { cookie: devValue }, 'GET'), false);
    t.check(lanCaller === null, 'a device credential is only taken while the LAN listener runs');
    const loop = {
      headers: { cookie: devValue },
      socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
    } as unknown as http.IncomingMessage;
    t.check((await lanGate.caller(loop, false)) === null, 'the loopback listener never takes a device credential');
    for (const p of ['/api/login', '/api/stop']) {
      await lanGate.route(lanRequest('192.168.1.50'), p, routeIO({}, out));
      t.check(out.last?.status === 404, 'the LAN listener has no ' + p);
    }
    await lanGate.route(loop, '/api/pair', routeIO({ code: 'x' }, out));
    t.check(out.last?.status === 404, 'devices are not allowed through loopback');
    t.check(
      lanGate.lanHostAllowed(undefined) === false &&
        lanGate.lanOriginAllowed('https://192.168.1.20:47801', 'evil:1') === false,
      'with no LAN listener no LAN Host is accepted',
    );

    t.section('LAN mode stays on the local network');
    t.check(
      ['10.0.0.1', '172.16.0.1', '172.31.255.1', '192.168.0.10'].every(isPrivateIPv4) &&
        !['8.8.8.8', '172.32.0.1', '169.254.1.1', '127.0.0.1', '100.64.0.1', '::1', 'fe80::1', 'example'].some(
          isPrivateIPv4,
        ),
      'only 10/8, 172.16/12 and 192.168/16 are private',
    );
    t.equal(
      chooseLanAddress('', IFACES).address,
      '192.168.1.20',
      'empty setting: the private address of a real adapter (not vEthernet, not public)',
    );
    t.includes(
      await t.thrownMessage(() => chooseLanAddress('8.8.4.4', IFACES)),
      '8.8.4.4 is not a private address',
      'a public address is refused, even one of this PC',
    );
    t.check(
      (await t.thrownMessage(() => chooseLanAddress('172.30.80.1', IFACES))) !== '',
      "the sandbox's vEthernet address is refused",
    );
    t.check(
      (await t.thrownMessage(() => chooseLanAddress('192.168.9.9', IFACES))) !== '',
      'an address that is not this PC is refused',
    );
    const bound = { address: '192.168.1.20', netmask: '255.255.255.0', adapter: 'Wi-Fi' };
    t.check(
      lanPeerProblem('192.168.1.50', '192.168.1.20', bound, IFACES) === null,
      'a phone on the same network may connect',
    );
    t.check(
      lanPeerProblem('::ffff:192.168.1.50', '::ffff:192.168.1.20', bound, IFACES) === null,
      'IPv4 written as IPv6 is read as IPv4',
    );
    t.check(
      lanPeerProblem('8.8.8.8', '192.168.1.20', bound, IFACES) !== null &&
        lanPeerProblem('10.1.2.3', '192.168.1.20', bound, IFACES) !== null &&
        lanPeerProblem('192.168.1.20', '192.168.1.20', bound, IFACES) !== null &&
        lanPeerProblem('172.30.80.5', '192.168.1.20', bound, IFACES) !== null &&
        lanPeerProblem('192.168.1.50', '172.30.80.1', bound, IFACES) !== null &&
        lanPeerProblem('fe80::1', '192.168.1.20', bound, IFACES) !== null,
      'public peers, other networks, this PC itself, the sandbox network and other local addresses are dropped',
    );
    t.check(
      networkProblem({ found: true, category: 'Private', name: 'Home' }, 'Home') === null &&
        networkProblem({ found: true, category: 'Public', name: 'Cafe' }, null) !== null &&
        networkProblem({ found: true, category: 'Private', name: 'Cafe' }, 'Home') !== null &&
        networkProblem({ found: false, category: '', name: '' }, null) !== null,
      'LAN mode runs only on a Private network, and only the one it was turned on for',
    );
    const own = os.networkInterfaces();
    const real = Object.values(own)
      .flatMap((l) => l ?? [])
      .find((i) => i.family === 'IPv4' && !i.internal && isPrivateIPv4(i.address));
    if (real) {
      const lanTls = new TlsStore(t.dir('tls'), SecretStore.memory());
      const probeGate = new RemoteGate({
        store: new AccessStore(t.dir('web4'), SecretStore.memory()),
        settings: () =>
          remoteSettings({
            lan: { enabled: true, port: 40000 + Math.floor(Math.random() * 20000), address: real.address },
          }),
        ownerSid: OWNER_SID,
        helper: null,
        audit: () => undefined,
        tls: lanTls,
        profile: () => Promise.resolve({ found: true, category: 'Private', name: 'Test' }),
        port: () => 47800,
      });
      let served = 0;
      await probeGate.startLan({ request: (_q, res) => (served++, res.end('x')), upgrade: () => undefined });
      const state = probeGate.lanState();
      t.check(
        state.running && state.url?.startsWith('https://' + real.address + ':') === true,
        'the LAN listener binds the private address only, over HTTPS',
      );
      const port = Number(state.url?.split(':').pop());
      const refused = await new Promise<boolean>((resolve) => {
        const s = net.connect({ host: real.address, port }, () => s.write('GET / HTTP/1.1\r\n\r\n'));
        s.on('close', () => resolve(true));
        s.on('error', () => resolve(true));
        s.setTimeout(3000, () => resolve(false));
      });
      t.check(refused && served === 0, "a connection from this PC's own address is dropped before any HTTP");
      const loopRefused = await new Promise<boolean>((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port });
        s.on('connect', () => (s.destroy(), resolve(false)));
        s.on('error', () => resolve(true));
      });
      t.check(loopRefused, 'nothing listens on loopback or other addresses on the LAN port');
      await probeGate.stop();
    } else t.skip('no private address here: the live LAN listener check');

    t.section('the certificate');
    const cert = makeCertificate({
      addresses: ['192.168.1.20'],
      dnsNames: ['MYPC'],
      now: Date.parse('2026-10-01T00:00:00Z'),
    });
    const x509 = new crypto.X509Certificate(cert.cert);
    t.check(
      x509.subjectAltName === 'IP Address:192.168.1.20, DNS:MYPC' &&
        !x509.ca &&
        x509.checkIP('192.168.1.20') === '192.168.1.20',
      'SAN with the IP address and the PC name; not a CA',
    );
    t.check(
      Date.parse(x509.validTo) - Date.parse('2026-10-01T00:00:00Z') <= 397 * DAY &&
        x509.fingerprint256 === cert.fingerprint,
      'valid 397 days at most; the fingerprint shown is the real one',
    );
    t.check(
      x509.checkPrivateKey(crypto.createPrivateKey(cert.key)) &&
        x509.verify(x509.publicKey) &&
        (x509.keyUsage ?? []).join() === '1.3.6.1.5.5.7.3.1',
      'self-signed with its key, for server authentication only',
    );
    const tlsDir = t.dir('tls2');
    const tls = new TlsStore(tlsDir, SecretStore.memory());
    const first = tls.material(['192.168.1.20']);
    const kept = tls.material(['192.168.1.21']);
    t.check(
      first.fingerprint === kept.fingerprint,
      'the certificate is kept (a new one would warn on every phone again)',
    );
    t.check(
      !fs.readFileSync(path.join(tlsDir, 'tls.json'), 'utf8').includes('PRIVATE KEY'),
      'its private key is sealed on disk',
    );

    t.section('the firewall script checks everything again (dry run, nothing changes)');
    const node = process.execPath;
    t.check((await t.thrownMessage(() => addRuleRequest(47801, '8.8.8.8'))) !== '', 'no rule for a public address');
    t.check((await t.thrownMessage(() => addRuleRequest(80, '192.168.1.20'))) !== '', 'no rule for a port below 1024');
    const dry = await checkFirewall(addRuleRequest(47801, '192.168.1.20', node));
    const addLine = dry.commands?.[1] ?? '';
    t.check(
      dry.ok &&
        addLine.includes("-DisplayName '" + FIREWALL_RULE_NAME + "'") &&
        addLine.includes('-Profile Private') &&
        addLine.includes('-RemoteAddress LocalSubnet') &&
        addLine.includes('-LocalAddress 192.168.1.20') &&
        addLine.includes('-LocalPort 47801') &&
        addLine.includes('-Direction Inbound'),
      'the rule: inbound TCP to that address and port, from the local subnet, Private networks only',
      JSON.stringify(dry),
    );
    const removeDry = await checkFirewall(removeRuleRequest());
    t.check(removeDry.ok && removeDry.commands?.length === 1, 'removing touches only our rule');
    const bad = async (req: Record<string, unknown>): Promise<boolean> => !(await checkFirewall(req)).ok;
    const base = {
      action: 'add',
      ruleName: FIREWALL_RULE_NAME,
      port: 47801,
      localAddress: '192.168.1.20',
      program: node,
    };
    t.check(await bad({ ...base, ruleName: 'Something else' }), 'the script refuses another rule name');
    t.check(await bad({ ...base, localAddress: '8.8.8.8' }), 'the script refuses a public address');
    t.check(await bad({ ...base, localAddress: '0.0.0.0' }), 'the script refuses 0.0.0.0');
    t.check(await bad({ ...base, port: 445 }), 'the script refuses a low port');
    t.check(
      await bad({ ...base, program: 'C:\\Windows\\System32\\cmd.exe' }),
      'the script refuses a program that is not node.exe',
    );
    const tempNode = t.write(path.join(os.tmpdir(), 'agent-sandbox-test-' + process.pid, 'node.exe'), 'x');
    t.check(await bad({ ...base, program: tempNode }), 'the script refuses a node.exe in a temp folder');
    fs.rmSync(path.dirname(tempNode), { recursive: true, force: true });
    t.check(await bad({ ...base, action: 'disable' }), 'the script refuses another action');
    const tampered = await checkFirewall(addRuleRequest(47801, '192.168.1.20', node), (exe, args, ms) => {
      const file = args[args.indexOf('-Json') + 1];
      fs.writeFileSync(file, JSON.stringify({ ...base, localAddress: '192.168.1.99' }));
      return spawnRunner(exe, args, ms);
    });
    t.check(
      !tampered.ok && tampered.message.includes('changed'),
      'a request file changed after it was written is refused',
    );
    t.check(
      (await t.thrownMessage(() => applyFirewall(removeRuleRequest()))).includes(
        'self-test does not change the Windows Firewall',
      ),
      'the self-test never changes the firewall',
    );

    t.section('helper and door lines');
    t.check(
      parseHelperLine('peer\t3\tok\t' + BOB_SID + '\tPC\\bob')?.kind === 'peer' &&
        parseHelperLine('peer\t3\tnone\tservice session')?.kind === 'peer' &&
        parseHelperLine('door\t1\t' + BOB_SID + '\t8192\t0\tPC\\bob')?.kind === 'door' &&
        parseHelperLine('peer\tx\tok\tnot-a-sid\tbob') === null &&
        parseHelperLine('door\t1\tS-1-5\t8192\t0') === null &&
        parseHelperLine('anything') === null,
      "only the helper's own lines are read, SIDs checked",
    );
    t.check(
      knockProblem({ sid: BOB_SID, user: 'b', integrity: 0x2000, appContainer: false }, OWNER_SID) === null,
      'a normal process of another user may knock',
    );
    const okAnswer = parseDoorAnswer('ok ' + 'c'.repeat(64) + ' 47800 control', 0, 'alice');
    t.check(okAnswer.ok && okAnswer.port === 47800 && okAnswer.role === 'control', 'the door answer is read');
    t.check(
      !parseDoorAnswer('', 3, 'alice').ok &&
        !parseDoorAnswer('', 4, 'alice').ok &&
        !parseDoorAnswer('ok short 47800 view', 0, 'alice').ok &&
        !parseDoorAnswer('ok ' + 'c'.repeat(64) + ' 80 view', 0, 'alice').ok,
      'a squatted pipe, no pipe, or a malformed answer is refused',
    );

    t.section('remote actions in the audit log');
    const log = new AuditLog(t.dir('audit'), { days: 7, maxMb: 10 });
    log.append([{ t: new Date().toISOString(), k: 'remote', p: 'sandbox.stop', a: 'ok', au: 'device Phone' }]);
    const back = log.read({ kinds: ['remote'] });
    t.check(
      back.length === 1 && back[0].au === 'device Phone' && back[0].p === 'sandbox.stop',
      'a remote line is written and read back',
    );
  },
};
