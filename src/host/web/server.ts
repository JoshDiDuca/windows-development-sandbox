// The web UI's HTTP server: the app's files, a small JSON API for sessions, the terminal WebSocket and the RPC
// WebSocket of the shared core. Loopback only; nothing works without the token's cookie, and Host / Origin / CSRF
// checks keep other sites out (docs/web-ui.md).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { allows, callerAccess, callerLabel, OWNER, type Caller, type RpcHost } from '../../app/kernel/index.js';
import { UserError, safeText } from '../../core/util/index.js';
import type { Endpoint } from '../../shared/pty/index.js';
import { MAX_CLIENT_MESSAGE_BYTES, MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS } from '../../shared/web/index.js';
import { cookieHeader, csrfOk, hostAllowed, originAllowed, WebAuth } from './auth.js';
import type { WebBackend } from './backend.js';
import { TerminalBridge } from './bridge.js';
import { LiveHub } from './live.js';
import { RpcSession } from './rpc.js';
import { StaticFiles } from './static-files.js';
import type { RemoteGate } from '../remote/index.js';

/** No inline script: the page and its script are files from this server. Inline styles are what xterm.js needs. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TERMINALS = 16;
const MAX_RPC_SOCKETS = 8;
/** Every socket is pinged this often; one that has not answered the last ping by the next is dropped. */
const HEARTBEAT_MS = 20_000;
/**
 * The server ends after this long with no browser connected and no request, even while a sandbox runs (sandbox web
 * open and the next launch start it again), so it never sits in memory unused.
 */
export const IDLE_EXIT_MS = 20 * 60_000;
/** ...and sooner when no sandbox runs either: there is nothing to look at. */
export const IDLE_NO_SANDBOX_MS = 5 * 60_000;
const SESSION_PATH = /^\/api\/sessions\/([A-Za-z0-9_-]{1,64})\/terminal$/;
export const RPC_PATH = '/api/rpc';

export interface WebServerOptions {
  /** 0 picks a free port (tests). */
  readonly port: number;
  readonly token: string;
  readonly backend: WebBackend;
  /** The folder of the built app (dist/web). */
  readonly staticRoot: string;
  /** Called when a signed-in browser (or the CLI) asks the server to stop. */
  readonly onStop?: () => void;
  /** How terminals reach a session (tests use a fake on loopback). */
  readonly dial?: (endpoint: Endpoint) => Promise<net.Socket>;
  /** The shared core's operations and queries the browser may run (none: /api/rpc is not served). */
  readonly rpc?: RpcHost;
  /** End by itself (onStop) after this long with no browser, even while a sandbox runs; 0 or missing: never (tests). */
  readonly idleExitMs?: number;
  /** ...or after this long when no sandbox runs either (default IDLE_NO_SANDBOX_MS; tests make it short). */
  readonly idleNoSandboxMs?: number;
  /** Heartbeat period (tests make it short). */
  readonly heartbeatMs?: number;
  /**
   * Other Windows users and paired devices (docs/design/remote-access.md); none: the owner's token only, as before.
   * The gate also serves the LAN listener and closes sockets whose access ended.
   */
  readonly gate?: RemoteGate;
}

/** What a service worker registered on this origin by someone else gets when the browser updates it: gone. */
const UNREGISTER_WORKER =
  "self.addEventListener('install',()=>self.skipWaiting());" +
  "self.addEventListener('activate',(e)=>e.waitUntil(self.registration.unregister()));";

/** A browser's socket: which kind, whether it answered the last ping, and when it was opened. */
interface Tracked {
  readonly kind: 'terminal' | 'rpc';
  readonly opened: number;
  alive: boolean;
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class WebServer {
  private readonly server: http.Server;
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  private readonly auth: WebAuth;
  private readonly files: StaticFiles;
  private readonly tracked = new Map<WebSocket, Tracked>();
  /** One poll per live query for all browsers together. */
  private readonly live: LiveHub | undefined;
  private actualPort = 0;
  private lastUsed = Date.now();
  private lastCheck = Date.now();
  private heartbeat: NodeJS.Timeout | undefined;
  private idleCheck: NodeJS.Timeout | undefined;

  constructor(private readonly options: WebServerOptions) {
    this.auth = new WebAuth(options.token);
    this.files = new StaticFiles(options.staticRoot);
    this.live = options.rpc ? new LiveHub(options.rpc) : undefined;
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on('upgrade', (req, socket, head) => {
      this.lastUsed = Date.now();
      this.upgrade(req, socket, head);
    });
    this.server.headersTimeout = 15000;
    this.server.requestTimeout = 0; // creating a session waits for the agent to start
  }

  get port(): number {
    return this.actualPort;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port, '127.0.0.1', () => {
        this.server.off('error', reject);
        this.actualPort = (this.server.address() as net.AddressInfo).port;
        this.heartbeat = setInterval(() => this.beat(), this.options.heartbeatMs ?? HEARTBEAT_MS);
        this.heartbeat.unref();
        if (this.options.idleExitMs) {
          this.lastCheck = Date.now();
          this.idleCheck = setInterval(() => void this.checkIdle(), this.checkEveryMs());
          this.idleCheck.unref();
        }
        const gate = this.options.gate;
        if (!gate) return resolve();
        gate.start();
        void gate
          .startLan({
            request: (req, res) => void this.handle(req, res),
            upgrade: (req, socket, head) => {
              this.lastUsed = Date.now();
              this.upgrade(req, socket, head);
            },
          })
          .finally(resolve);
      });
    });
  }

  /** How many browser sockets are open, by kind. */
  openSockets(kind: Tracked['kind']): number {
    return [...this.tracked.values()].filter((t) => t.kind === kind).length;
  }

  /**
   * Drops sockets that did not answer the last ping (a tab that went away without closing: sleep, a killed browser),
   * so they never hold a slot or a session connection.
   */
  private beat(): void {
    for (const [ws, t] of this.tracked) {
      if (!t.alive) {
        ws.terminate();
        continue;
      }
      t.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate(); // the socket broke between the check and the ping
      }
    }
  }

  /** No browser has used the server for a while: it ends (sooner when no sandbox runs). */
  private async checkIdle(): Promise<void> {
    const limit = this.options.idleExitMs ?? 0;
    const now = Date.now();
    // A check much later than planned: the PC slept. Its tabs get time to reconnect before anything counts as idle.
    if (now - this.lastCheck > 3 * this.checkEveryMs()) this.lastUsed = now;
    this.lastCheck = now;
    if (!limit || this.tracked.size > 0) return;
    const idle = Date.now() - this.lastUsed;
    if (idle >= limit) return this.options.onStop?.();
    if (idle < this.quietMs()) return;
    try {
      if ((await this.options.backend.info()).sandbox === 'running') return;
    } catch {
      return; // cannot tell: wait for the longer limit
    }
    this.options.onStop?.();
  }

  private checkEveryMs(): number {
    return Math.min(60_000, this.quietMs());
  }

  /** How long unused before it ends when no sandbox runs. */
  private quietMs(): number {
    return Math.min(this.options.idleExitMs ?? 0, this.options.idleNoSandboxMs ?? IDLE_NO_SANDBOX_MS);
  }

  /** Counts a new socket; at the limit, the oldest of its kind makes room (a new tab always works). */
  private track(ws: WebSocket, kind: Tracked['kind'], limit: number): void {
    const same = [...this.tracked.entries()]
      .filter(([, t]) => t.kind === kind)
      .sort((a, b) => a[1].opened - b[1].opened);
    for (const [old] of same.slice(0, Math.max(0, same.length - limit + 1)))
      old.close(4000, 'replaced by a newer page');
    this.tracked.set(ws, { kind, opened: Date.now(), alive: true });
    ws.on('pong', () => {
      const t = this.tracked.get(ws);
      if (t) t.alive = true;
    });
    ws.on('message', () => (this.lastUsed = Date.now()));
    ws.on('close', () => {
      this.tracked.delete(ws);
      this.lastUsed = Date.now();
    });
  }

  stop(): Promise<void> {
    clearInterval(this.heartbeat);
    clearInterval(this.idleCheck);
    for (const client of this.sockets.clients) client.close(1001, 'server stopping');
    this.server.closeAllConnections();
    const gate = this.options.gate?.stop();
    return new Promise((resolve) => this.server.close(() => void Promise.resolve(gate).then(() => resolve())));
  }

  private headers(extra: http.OutgoingHttpHeaders = {}): http.OutgoingHttpHeaders {
    return {
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...extra,
    };
  }

  private json(res: http.ServerResponse, status: number, body: unknown, extra: http.OutgoingHttpHeaders = {}): void {
    res.writeHead(
      status,
      this.headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }),
    );
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.lastUsed = Date.now();
    try {
      if (!this.hostOk(req)) throw new HttpFailure(421, 'Wrong host name.');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) await this.api(req, res, url.pathname);
      else this.serveFile(req, res, url.pathname);
    } catch (e) {
      if (e instanceof HttpFailure) this.json(res, e.status, { error: e.message });
      else if (e instanceof UserError) this.json(res, 409, { error: safeText(e.message).slice(0, 500) });
      else this.json(res, 500, { error: 'Something went wrong.' });
    }
  }

  /** The LAN listener's own address:port, or loopback with our port. */
  private hostOk(req: http.IncomingMessage): boolean {
    const gate = this.options.gate;
    if (gate?.isLan(req.socket)) return gate.lanHostAllowed(req.headers.host);
    return hostAllowed(req.headers.host, this.actualPort);
  }

  private originOk(req: http.IncomingMessage): boolean {
    const gate = this.options.gate;
    if (gate?.isLan(req.socket)) return gate.lanOriginAllowed(req.headers.origin, req.headers.host);
    return originAllowed(req.headers.origin, req.headers.host, this.actualPort);
  }

  /** Who sent the request: the owner's token cookie (loopback only), or whoever the gate lets in. Null: nobody. */
  private async callerOf(req: http.IncomingMessage): Promise<{ caller: Caller | null; ownerCookie: boolean }> {
    const gate = this.options.gate;
    const ownerCookie = !gate?.isLan(req.socket) && this.auth.signedIn(req.headers.cookie);
    if (!gate) return { caller: ownerCookie ? OWNER : null, ownerCookie };
    return { caller: await gate.caller(req, ownerCookie), ownerCookie };
  }

  private serveFile(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpFailure(405, 'Not allowed.');
    if (req.headers['service-worker'] === 'script') {
      res.writeHead(
        200,
        this.headers({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }),
      );
      res.end(UNREGISTER_WORKER);
      return;
    }
    const file = this.files.find(pathname);
    if (!file) throw new HttpFailure(404, 'Not found.');
    const size = fs.statSync(file.file).size;
    res.writeHead(
      200,
      this.headers({
        'Content-Type': file.type,
        'Content-Length': size,
        'Cache-Control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      }),
    );
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file.file).pipe(res);
  }

  /** A call that changes something: the custom header, and an Origin that is this page. */
  private requireSameSite(req: http.IncomingMessage): void {
    if (!csrfOk(req.headers) || !this.originOk(req)) throw new HttpFailure(403, 'Refused.');
  }

  private async api(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    const method = req.method ?? 'GET';
    const { backend } = this.options;
    if (pathname === '/api/health' && method === 'GET') return this.json(res, 200, this.health(req));
    if (
      this.options.gate &&
      (await this.options.gate.route(req, pathname, {
        body: () => this.body(req),
        json: (status, body, headers) => this.json(res, status, body, headers),
        requireSameSite: () => this.requireSameSite(req),
      }))
    )
      return;
    if (pathname === '/api/login' && method === 'POST') {
      this.requireSameSite(req);
      const body = await this.body(req);
      const result = this.auth.login((body as { token?: unknown } | null)?.token);
      if (!result.ok) throw new HttpFailure(result.status, result.status === 429 ? 'Too many tries.' : 'Wrong token.');
      return this.json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(result.cookie) });
    }
    const { caller } = await this.callerOf(req);
    if (!caller) throw new HttpFailure(401, 'Not signed in.');
    if (pathname === '/api/me' && method === 'GET')
      return this.json(res, 200, { kind: caller.kind, who: callerLabel(caller), access: callerAccess(caller) });
    if (pathname === '/api/info' && method === 'GET') return this.json(res, 200, await backend.info());
    if (pathname === '/api/sessions' && method === 'GET') return this.json(res, 200, await backend.sessions());
    if (pathname === '/api/stop' && method === 'POST') {
      this.requireSameSite(req);
      if (caller.kind !== 'owner') throw new HttpFailure(403, 'Only the owner of this PC can stop the web UI.');
      this.json(res, 200, { ok: true });
      setTimeout(() => this.options.onStop?.(), 100);
      return;
    }
    throw new HttpFailure(404, 'Not found.');
  }

  /** A small JSON body (application/json only). */
  private body(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!/^application\/json\b/.test(req.headers['content-type'] ?? ''))
        return reject(new HttpFailure(415, 'Send JSON.'));
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          reject(new HttpFailure(413, 'Too big.'));
        } else chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpFailure(400, 'Not JSON.'));
        }
      });
      req.on('error', reject);
    });
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: string): void => {
      socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\n\r\n');
    };
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = SESSION_PATH.exec(url.pathname);
    const rpc = url.pathname === RPC_PATH ? this.options.rpc : undefined;
    if (!match && !rpc) return refuse('404 Not Found');
    // The Origin must be this page (a page of another site can open WebSockets too) and the cookie is the login.
    if (!this.hostOk(req) || !this.originOk(req)) return refuse('403 Forbidden');
    void this.callerOf(req).then(({ caller, ownerCookie }) => {
      if (!caller) return refuse('401 Unauthorized');
      if (rpc) return this.upgradeRpc(req, socket, head, rpc, caller, ownerCookie);
      if (!match) return refuse('404 Not Found');
      const endpoint = this.options.backend.endpoint(match[1]);
      if (!endpoint) return refuse('404 Not Found');
      const cols = bounded(url.searchParams.get('cols'), MIN_COLS, MAX_COLS, 120);
      const rows = bounded(url.searchParams.get('rows'), MIN_ROWS, MAX_ROWS, 30);
      // View only: the terminal shows, and the bridge drops every keystroke and resize.
      const readOnly = !allows(caller, 'control');
      this.sockets.handleUpgrade(req, socket, head, (ws) => {
        this.track(ws, 'terminal', MAX_TERMINALS);
        this.options.gate?.track(ws, req, ownerCookie, caller);
        void new TerminalBridge(ws, endpoint, cols, rows, this.options.dial, readOnly).start();
      });
    });
  }

  /** The RPC socket (after the same Origin and caller checks as a terminal). */
  private upgradeRpc(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    rpc: RpcHost,
    caller: Caller,
    ownerCookie: boolean,
  ): void {
    this.sockets.handleUpgrade(req, socket, head, (ws) => {
      this.track(ws, 'rpc', MAX_RPC_SOCKETS);
      const gate = this.options.gate;
      const now = gate ? gate.track(ws, req, ownerCookie, caller) : () => caller;
      new RpcSession(ws, rpc, this.live, now, gate ? (entry) => gate.recordCall(entry) : undefined).start();
    });
  }

  /**
   * GET /api/health: alive, and with ?challenge=<hex> on loopback the proof that this server holds the token (an
   * HMAC of the challenge), so the CLI never hands the token link to another program on the port.
   */
  private health(req: http.IncomingMessage): Record<string, unknown> {
    const challenge = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('challenge') ?? '';
    if (this.options.gate?.isLan(req.socket) || !/^[0-9a-f]{32,128}$/.test(challenge)) return { ok: true };
    return { ok: true, proof: crypto.createHmac('sha256', this.options.token).update(challenge).digest('hex') };
  }
}

function bounded(text: string | null, min: number, max: number, fallback: number): number {
  const n = Number(text);
  return text !== null && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
