// The web UI's server: login and cookie, the Host / Origin / CSRF checks, static files that cannot leave their folder,
// sessions without tokens, the terminal bridge against a fake ptyhost on loopback (the real address check is the
// backend's, so the fake is only reachable here), and the RPC socket of the shared core against a fake RpcHost.
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { cancelled, type RpcHost, type ServerMessage } from '../app/kernel/index.js';
import { webSession } from '../cli/services/index.js';
import type { SessionStatus } from '../core/types.js';
import { fail } from '../core/util/index.js';
import {
  cookieValue,
  csrfOk,
  hostAllowed,
  originAllowed,
  sameSecret,
  StaticFiles,
  WebAuth,
  WebServer,
  WebStore,
  type WebBackend,
} from '../host/web/index.js';
import { encodeFrame, FrameReader, FrameType, type Endpoint } from '../shared/pty/index.js';
import { CSRF_HEADER, CSRF_VALUE, parseClientMessage, type WebSession } from '../shared/web/index.js';
import type { Suite } from './support/suite.js';

const TOKEN = 'a'.repeat(64);
const ATTACH_TOKEN = 'SECRET-ATTACH-TOKEN';

interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** One HTTP request with exactly the headers given (Host included). */
function send(
  port: number,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers: { Host: '127.0.0.1:' + port, ...headers } },
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

/** A ptyhost stand-in: records what the bridge sends, plays output, ends with EXIT when it gets the letter x. */
class FakePtyHost {
  readonly hellos: Buffer[] = [];
  readonly inputs: Buffer[] = [];
  readonly resizes: Buffer[] = [];
  pings = 0;
  closed = 0;
  private readonly server: net.Server;
  private readonly open = new Set<net.Socket>();
  port = 0;

  constructor() {
    this.server = net.createServer((socket) => {
      this.open.add(socket);
      const reader = new FrameReader();
      socket.on('error', () => undefined);
      socket.on('close', () => this.closed++);
      socket.on('data', (chunk) => {
        for (const frame of reader.push(chunk)) {
          if (frame.type === FrameType.Hello) {
            this.hellos.push(frame.payload);
            // Output with a clipboard write (OSC 52) inside: the bridge must drop that part.
            socket.write(encodeFrame(FrameType.Output, Buffer.from('hello \x1b]52;c;ZXZpbA==\x07world')));
          } else if (frame.type === FrameType.Input) {
            this.inputs.push(frame.payload);
            if (frame.payload.toString() === 'x') {
              const code = Buffer.alloc(4);
              code.writeInt32LE(3, 0);
              socket.write(encodeFrame(FrameType.Exit, code));
            }
          } else if (frame.type === FrameType.Resize) this.resizes.push(frame.payload);
          else if (frame.type === FrameType.Ping) this.pings++;
        }
      });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) =>
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as net.AddressInfo).port;
        resolve();
      }),
    );
  }

  stop(): void {
    this.server.close();
    for (const socket of this.open) socket.destroy();
  }
}

/** What a browser tab sees on the terminal socket. */
class Tab {
  readonly texts: string[] = [];
  readonly binary: Buffer[] = [];
  closeCode: number | null = null;
  opened = false;
  failed = false;
  readonly socket: WebSocket;

  constructor(url: string, headers: Record<string, string>) {
    this.socket = new WebSocket(url, { headers });
    this.socket.on('open', () => (this.opened = true));
    this.socket.on('unexpected-response', () => (this.failed = true));
    this.socket.on('error', () => (this.failed = true));
    this.socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) this.binary.push(data);
      else this.texts.push(data.toString('utf8'));
    });
    this.socket.on('close', (code: number) => (this.closeCode = code));
  }
}

/** A stand-in for the shared core: one operation that reports, asks and may fail, and one live query. */
function fakeRpc(): { host: RpcHost; ran: string[]; live: { value: number } } {
  const ran: string[] = [];
  const live = { value: 1 };
  const host: RpcHost = {
    kind: (id) => (id === 'test.work' ? 'operation' : id === 'test.live' ? 'query' : undefined),
    liveMs: (id) => (id === 'test.live' ? 50 : undefined),
    run: async (id, input, io) => {
      ran.push(id);
      if (id === 'test.live') return { value: live.value };
      const how = (input ?? {}) as { fail?: boolean; bug?: boolean };
      io.progress('Working');
      io.log('one line', 'muted');
      if (!(await io.confirm({ title: 'Go on?' }))) cancelled();
      if (how.fail) fail('It broke.', 'Fix it like this.');
      if (how.bug) throw new Error('internal detail C:\\Users\\secret');
      return { done: true };
    },
  };
  return { host, ran, live };
}

/** The server's messages on an RPC socket, parsed. */
function rpcMessages(tab: Tab): ServerMessage[] {
  return tab.texts.map((text) => JSON.parse(text) as ServerMessage);
}

const session = (id: string, attach?: SessionStatus['attach']): SessionStatus => ({
  id,
  launchId: 'launch1',
  harness: 'claude',
  cwd: 'C:\\Projects\\app',
  phase: 'running',
  message: 'running\x1b[31m',
  updatedAt: '2026-01-01T00:00:00.000Z',
  startedAt: '2026-01-01T00:00:00.000Z',
  ...(attach ? { attach } : {}),
});

export const webSuite: Suite = {
  name: 'web',
  title: 'web UI server: login, Host / Origin / CSRF checks, static files, sessions, terminal bridge',
  run: async (t) => {
    t.section('the token and the cookie');
    t.check(
      sameSecret(TOKEN, TOKEN) && !sameSecret(TOKEN, 'b'.repeat(64)) && !sameSecret(TOKEN, ''),
      'secrets compare',
    );
    let clock = 1000;
    const auth = new WebAuth(TOKEN, () => clock);
    const bad = auth.login('nope');
    t.check(!bad.ok && bad.status === 401, 'a wrong token is refused');
    t.check(!auth.login(42).ok && !auth.login({}).ok, 'a token that is not text is refused');
    const good = auth.login(TOKEN);
    t.check(good.ok, 'the right token logs in');
    const cookie = good.ok ? good.cookie : '';
    t.check(auth.signedIn('x=1; sbxweb=' + cookie), 'the cookie signs in');
    t.check(
      !auth.signedIn('sbxweb=' + cookie.replace(/.$/, (c) => (c === '0' ? '1' : '0'))) && !auth.signedIn(undefined),
      'another cookie does not',
    );
    clock += 13 * 60 * 60 * 1000;
    t.check(!auth.signedIn('sbxweb=' + cookie), 'a cookie unused for 12 hours expires');
    const limited = new WebAuth(TOKEN, () => clock);
    for (let i = 0; i < 8; i++) limited.login('wrong');
    const locked = limited.login(TOKEN);
    t.check(!locked.ok && locked.status === 429, 'too many wrong tokens lock logging in, even for the right one');
    clock += 61 * 1000;
    t.check(limited.login(TOKEN).ok, 'the lock ends after a minute');
    t.equal(cookieValue('a=1; sbxweb=abc; b=2'), 'abc', 'the cookie is found among others');

    t.section('Host, Origin and CSRF checks');
    t.check(
      hostAllowed('127.0.0.1:47800', 47800) && hostAllowed('localhost:47800', 47800),
      'loopback names are allowed',
    );
    t.check(
      !hostAllowed('evil.example:47800', 47800) &&
        !hostAllowed('127.0.0.1:1', 47800) &&
        !hostAllowed(undefined, 47800) &&
        !hostAllowed('127.0.0.1.evil.example:47800', 47800),
      'any other Host is refused (DNS rebinding)',
    );
    t.check(
      originAllowed('http://127.0.0.1:47800', '127.0.0.1:47800', 47800) &&
        !originAllowed('http://evil.example', '127.0.0.1:47800', 47800) &&
        !originAllowed(undefined, '127.0.0.1:47800', 47800) &&
        !originAllowed('http://localhost:47800', '127.0.0.1:47800', 47800),
      'the Origin must be the page itself',
    );
    t.check(csrfOk({ [CSRF_HEADER]: CSRF_VALUE }) && !csrfOk({}) && !csrfOk({ [CSRF_HEADER]: '0' }), 'the CSRF header');

    t.section('browser messages');
    t.check(parseClientMessage('{"t":"resize","cols":80,"rows":24}')?.t === 'resize', 'a resize is read');
    t.check(
      [
        'nope',
        '{"t":"resize","cols":0,"rows":24}',
        '{"t":"resize","cols":80.5,"rows":24}',
        '{"t":"resize","cols":80,"rows":99999}',
        '{"t":"input","data":"x"}',
        'null',
      ].every((m) => parseClientMessage(m) === null),
      'garbage, odd numbers and unknown kinds are refused',
    );

    t.section('static files');
    const root = t.dir('web-root');
    t.write(path.join(root, 'index.html'), '<!doctype html><title>x</title>');
    t.write(path.join(root, 'main-ABCD1234.js'), 'console.log(1)');
    t.write(path.join(root, 'notes.exe'), 'MZ');
    t.write(path.join(t.temp, 'secret.txt'), 'TOP SECRET');
    const files = new StaticFiles(root);
    t.check(files.find('/')?.type.startsWith('text/html') === true, '/ is the app');
    t.check(files.find('/main-ABCD1234.js')?.immutable === true, 'a hashed file may be cached for good');
    t.check(files.find('/some/page')?.file === path.join(root, 'index.html'), 'a page of the app is the app');
    t.check(
      [
        '/../secret.txt',
        '/%2e%2e/secret.txt',
        '/a/../../secret.txt',
        '/..%2fsecret.txt',
        '/..\\secret.txt',
        '/x%00.js',
      ].every((p) => files.find(p) === null),
      'paths that leave the folder find nothing',
    );
    t.check(
      files.find('/notes.exe') === null && files.find('/missing.js') === null,
      'unknown types and missing files find nothing',
    );

    t.section('sessions never carry a token');
    const attach = { addresses: ['127.0.0.1'], port: 1234, token: ATTACH_TOKEN };
    const shown = JSON.stringify(webSession(session('s1', attach), 2));
    t.excludes(shown, ATTACH_TOKEN, 'the attach token is not in what the browser gets');
    t.excludes(shown, '1234', 'nor the port');
    t.excludes(shown, '\x1b', 'text from the sandbox is made safe');

    t.section('the server');
    const fake = new FakePtyHost();
    await fake.start();
    const endpoint: Endpoint = { addresses: ['127.0.0.1'], port: fake.port, token: ATTACH_TOKEN };
    const listed: WebSession = webSession(session('abc123'), 0);
    const backend: WebBackend = {
      info: () =>
        Promise.resolve({
          sandbox: 'running',
          owner: null,
          canUse: true,
          harnesses: ['claude'],
          defaultHarness: 'claude',
          projects: [],
        }),
      sessions: () => Promise.resolve([listed]),
      endpoint: (id) => (id === 'abc123' ? endpoint : null),
    };
    let stopped = false;
    const rpc = fakeRpc();
    const server = new WebServer({
      port: 0,
      token: TOKEN,
      backend,
      staticRoot: root,
      rpc: rpc.host,
      onStop: () => (stopped = true),
      heartbeatMs: 200,
    });
    await server.start();
    const { port } = server;
    const origin = 'http://127.0.0.1:' + port;
    const json = { 'Content-Type': 'application/json' };
    const ajax = { ...json, Origin: origin, [CSRF_HEADER]: CSRF_VALUE };
    try {
      const page = await send(port, 'GET', '/');
      t.check(
        page.status === 200 && page.headers['content-type']?.startsWith('text/html') === true,
        'the app is served',
      );
      t.includes(
        String(page.headers['content-security-policy']),
        "script-src 'self'",
        'the page has a CSP without inline scripts',
      );
      t.check(
        !String(page.headers['content-security-policy']).includes("script-src 'self' 'unsafe-inline'") &&
          page.headers['x-content-type-options'] === 'nosniff' &&
          page.headers['x-frame-options'] === 'DENY',
        'and the other protective headers',
      );
      t.equal(
        (await send(port, 'GET', '/', { Host: 'evil.example:' + port })).status,
        421,
        'a foreign Host name is refused',
      );
      t.equal((await send(port, 'GET', '/..%2f..%2fsecret.txt')).status, 404, 'a path out of the folder is a 404');
      t.equal(
        (await send(port, 'GET', '/%2e%2e/secret.txt')).status,
        404,
        'an encoded path out of the folder is a 404',
      );
      t.equal((await send(port, 'POST', '/', {}, 'x')).status, 405, 'the files take only GET');
      t.equal((await send(port, 'GET', '/api/sessions')).status, 401, 'the API needs the login');
      t.equal((await send(port, 'GET', '/api/health')).status, 200, 'health needs none');

      const noCsrf = await send(
        port,
        'POST',
        '/api/login',
        { ...json, Origin: origin },
        JSON.stringify({ token: TOKEN }),
      );
      t.equal(noCsrf.status, 403, 'login without the CSRF header is refused');
      const foreign = await send(
        port,
        'POST',
        '/api/login',
        { ...ajax, Origin: 'http://evil.example' },
        JSON.stringify({ token: TOKEN }),
      );
      t.equal(foreign.status, 403, 'login from another origin is refused');
      const noOrigin = await send(
        port,
        'POST',
        '/api/login',
        { ...json, [CSRF_HEADER]: CSRF_VALUE },
        JSON.stringify({ token: TOKEN }),
      );
      t.equal(noOrigin.status, 403, 'login without an Origin is refused');
      t.equal(
        (await send(port, 'POST', '/api/login', ajax, JSON.stringify({ token: 'wrong' }))).status,
        401,
        'a wrong token',
      );
      t.equal(
        (await send(port, 'POST', '/api/login', { ...ajax, 'Content-Type': 'text/plain' }, '{}')).status,
        415,
        'JSON only',
      );
      const login = await send(port, 'POST', '/api/login', ajax, JSON.stringify({ token: TOKEN }));
      const setCookie = String(login.headers['set-cookie']?.[0] ?? '');
      t.check(
        login.status === 200 && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie),
        'the right token gets a safe cookie',
      );
      const Cookie = setCookie.split(';')[0];

      const list = await send(port, 'GET', '/api/sessions', { Cookie });
      t.check(list.status === 200 && JSON.parse(list.body).length === 1, 'a signed-in browser lists sessions');
      t.excludes(list.body, ATTACH_TOKEN, 'the list has no attach token');
      t.equal((await send(port, 'GET', '/api/info', { Cookie })).status, 200, 'and reads the info');
      t.equal(
        (await send(port, 'POST', '/api/sessions', { ...json, Cookie }, '{}')).status,
        404,
        'starting an agent is an operation now: there is no POST /api/sessions',
      );

      t.section('the terminal bridge');
      const url = 'ws://127.0.0.1:' + port + '/api/sessions/abc123/terminal?cols=100&rows=40';
      const attempts = [
        new Tab(url, { Cookie }),
        new Tab(url, { Origin: 'http://evil.example', Cookie }),
        new Tab(url, { Origin: origin }),
        new Tab('ws://127.0.0.1:' + port + '/api/sessions/nosuch/terminal', { Origin: origin, Cookie }),
      ];
      await t.waitFor(() => attempts.every((a) => a.failed), 5000);
      t.check(
        attempts.every((a) => !a.opened && a.failed),
        'no Origin, a foreign Origin, no cookie and an unknown session are all refused',
      );
      t.check(fake.hellos.length === 0, 'and the session was never contacted');

      const tab = new Tab(url, { Origin: origin, Cookie });
      await t.waitFor(() => tab.binary.length > 0, 5000);
      t.check(tab.texts.includes('{"t":"ready"}'), 'the browser is told when it is connected');
      const hello = fake.hellos[0];
      t.check(
        hello !== undefined &&
          hello.readInt16LE(0) === 100 &&
          hello.readInt16LE(2) === 40 &&
          hello.subarray(5).toString() === ATTACH_TOKEN,
        'HELLO carries the attach token and the size',
      );
      const output = Buffer.concat(tab.binary).toString();
      t.check(output.includes('hello ') && output.includes('world'), 'output is relayed as binary');
      t.excludes(output, ']52', 'and a clipboard write (OSC 52) in it is dropped');
      tab.socket.send(Buffer.from('abc'));
      tab.socket.send(JSON.stringify({ t: 'resize', cols: 90, rows: 30 }));
      await t.waitFor(() => fake.inputs.length > 0 && fake.resizes.length > 0, 5000);
      t.check(fake.inputs[0]?.toString() === 'abc', 'keystrokes are forwarded as INPUT');
      t.check(
        fake.resizes[0]?.readInt16LE(0) === 90 && fake.resizes[0]?.readInt16LE(2) === 30,
        'a resize is forwarded',
      );
      tab.socket.send(Buffer.from('x'));
      await t.waitFor(() => tab.closeCode !== null, 5000);
      t.check(tab.texts.includes('{"t":"exit","code":3}'), 'EXIT reaches the browser with its code');
      t.equal(tab.closeCode, 1000, 'and the socket closes cleanly');

      const rude = new Tab(url, { Origin: origin, Cookie });
      await t.waitFor(() => rude.binary.length > 0, 5000);
      rude.socket.send('this is not json');
      await t.waitFor(() => rude.closeCode !== null, 5000);
      t.equal(rude.closeCode, 1008, 'a browser that sends garbage is closed');

      const leaving = new Tab(url, { Origin: origin, Cookie });
      await t.waitFor(() => leaving.binary.length > 0, 5000);
      leaving.socket.close();
      await t.waitFor(() => fake.closed >= 3, 5000);
      t.check(fake.closed >= 3, 'closing the browser side closes the connection to the session');

      t.section('the RPC socket');
      const rpcUrl = 'ws://127.0.0.1:' + port + '/api/rpc';
      const refusedRpc = [
        new Tab(rpcUrl, { Cookie }),
        new Tab(rpcUrl, { Origin: 'http://evil.example', Cookie }),
        new Tab(rpcUrl, { Origin: origin }),
      ];
      await t.waitFor(() => refusedRpc.every((a) => a.failed), 5000);
      t.check(
        refusedRpc.every((a) => !a.opened),
        'the RPC socket needs the cookie and this page as its Origin, like the terminal',
      );
      const browser = new Tab(rpcUrl, { Origin: origin, Cookie });
      await t.waitFor(() => browser.opened, 5000);
      const reply = (id: string, kind: ServerMessage['t']): ServerMessage | undefined =>
        rpcMessages(browser).find((m) => m.id === id && m.t === kind);
      browser.socket.send(JSON.stringify({ t: 'call', id: 'c1', op: 'test.work', input: {} }));
      await t.waitFor(() => reply('c1', 'ask'), 5000);
      t.check(
        reply('c1', 'progress') !== undefined && reply('c1', 'log') !== undefined,
        'a call streams its progress and log lines before it asks',
      );
      browser.socket.send(JSON.stringify({ t: 'answer', id: 'c1', value: true }));
      await t.waitFor(() => reply('c1', 'result'), 5000);
      t.equal(reply('c1', 'result'), { t: 'result', id: 'c1', output: { done: true } }, 'the answer lets it finish');

      browser.socket.send(JSON.stringify({ t: 'call', id: 'c2', op: 'test.work', input: {} }));
      await t.waitFor(() => reply('c2', 'ask'), 5000);
      browser.socket.send(JSON.stringify({ t: 'answer', id: 'c2', value: 'yes please' }));
      await t.waitFor(() => reply('c2', 'error'), 5000);
      const declinedCall = reply('c2', 'error');
      t.check(
        declinedCall?.t === 'error' && declinedCall.error.kind === 'cancelled',
        'an answer of the wrong kind counts as no: nothing changes',
      );

      browser.socket.send(JSON.stringify({ t: 'call', id: 'c3', op: 'test.work', input: { fail: true } }));
      browser.socket.send(JSON.stringify({ t: 'call', id: 'c4', op: 'test.work', input: { bug: true } }));
      await t.waitFor(() => reply('c3', 'ask') && reply('c4', 'ask'), 5000);
      browser.socket.send(JSON.stringify({ t: 'answer', id: 'c3', value: true }));
      browser.socket.send(JSON.stringify({ t: 'answer', id: 'c4', value: true }));
      await t.waitFor(() => reply('c3', 'error') && reply('c4', 'error'), 5000);
      t.equal(
        reply('c3', 'error'),
        { t: 'error', id: 'c3', error: { kind: 'user', message: 'It broke.', fix: 'Fix it like this.' } },
        'a failure arrives as its message and fix',
      );
      t.equal(
        reply('c4', 'error'),
        { t: 'error', id: 'c4', error: { kind: 'bug', message: 'Something went wrong.' } },
        "a bug's details stay on this PC",
      );

      const before = rpc.ran.length;
      browser.socket.send(JSON.stringify({ t: 'call', id: 'c5', op: 'sandbox.notThere', input: {} }));
      await t.waitFor(() => reply('c5', 'error'), 5000);
      const unknown = reply('c5', 'error');
      t.check(
        unknown?.t === 'error' && unknown.error.kind === 'invalid' && rpc.ran.length === before,
        'an operation that is not allowed on the web is never run',
      );

      browser.socket.send(JSON.stringify({ t: 'subscribe', id: 's1', query: 'test.live', input: {} }));
      await t.waitFor(() => reply('s1', 'data'), 5000);
      rpc.live.value = 2;
      await t.waitFor(() => rpcMessages(browser).filter((m) => m.id === 's1' && m.t === 'data').length === 2, 5000);
      const updates = rpcMessages(browser).filter((m) => m.id === 's1' && m.t === 'data');
      t.equal(
        updates.map((m) => (m.t === 'data' ? m.output : null)),
        [{ value: 1 }, { value: 2 }],
        'a live query sends its result, then again only when it changed',
      );
      browser.socket.send(JSON.stringify({ t: 'unsubscribe', id: 's1' }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const reads = rpc.ran.filter((id) => id === 'test.live').length;
      await new Promise((resolve) => setTimeout(resolve, 200));
      t.equal(rpc.ran.filter((id) => id === 'test.live').length, reads, 'unsubscribing stops the reads');

      browser.socket.send(JSON.stringify({ t: 'call', id: 'bad id!', op: 'test.work', input: {} }));
      await t.waitFor(() => browser.closeCode !== null, 5000);
      t.equal(browser.closeCode, 1008, 'a message that does not fit the schema closes the socket');

      const leaver = new Tab(rpcUrl, { Origin: origin, Cookie });
      await t.waitFor(() => leaver.opened, 5000);
      const runs = rpc.ran.length;
      leaver.socket.send(JSON.stringify({ t: 'call', id: 'c1', op: 'test.work', input: {} }));
      await t.waitFor(() => leaver.texts.some((m) => m.includes('"ask"')), 5000);
      leaver.socket.close();
      await t.waitFor(() => leaver.closeCode !== null, 5000);
      t.check(rpc.ran.length === runs + 1, 'a browser that leaves mid-question answers no (the call ends)');

      t.section('connections never pile up');
      const tabs: Tab[] = [];
      for (let i = 0; i < 9; i++) {
        const tab = new Tab(rpcUrl, { Origin: origin, Cookie });
        tabs.push(tab);
        await t.waitFor(() => tab.opened || tab.failed, 5000);
      }
      await t.waitFor(() => server.openSockets('rpc') <= 8, 5000);
      t.check(
        tabs.every((tab) => tab.opened) && server.openSockets('rpc') === 8,
        'a new page always connects: at the limit the oldest connection makes room',
        'open: ' + server.openSockets('rpc'),
      );
      t.check(
        [browser, ...tabs].some((tab) => tab.closeCode === 4000),
        'the oldest is closed with "replaced by a newer page"',
      );
      for (const tab of tabs) tab.socket.close();

      const silent = new WebSocket(rpcUrl, { headers: { Origin: origin, Cookie }, autoPong: false });
      let silentClosed = false;
      silent.on('close', () => (silentClosed = true));
      silent.on('error', () => undefined);
      await t.waitFor(() => silent.readyState === WebSocket.OPEN, 5000);
      await t.waitFor(() => silentClosed, 3000);
      t.check(silentClosed, 'a page that stops answering pings (gone without closing) is dropped');

      t.section('stopping');
      t.equal(
        (await send(port, 'POST', '/api/stop', { ...json, Cookie }, '{}')).status,
        403,
        'stop needs CSRF and Origin too',
      );
      t.equal(
        (await send(port, 'POST', '/api/stop', { ...ajax, Cookie }, '{}')).status,
        200,
        'a signed-in browser can stop it',
      );
      await t.waitFor(() => stopped, 3000);
      t.check(stopped, 'the server is told to stop');
    } finally {
      await server.stop();
      fake.stop();
    }

    t.section('the state file');
    const store = new WebStore(t.dir('web-state'), () => undefined);
    store.write({ pid: 1234, port: 47800, token: TOKEN, startedAt: '2026-01-01T00:00:00.000Z' });
    t.equal(store.read()?.port, 47800, 'pid, port and token are kept');
    t.write(path.join(store.dir, 'server.json'), '{"pid":1,"port":1,"token":"short","startedAt":"x"}');
    t.check(store.read() === null, 'a state file that does not fit the schema is ignored');
    store.clear();
    t.check(store.read() === null, 'and it can be removed');
  },
};
