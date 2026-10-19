// Who is at the other end of a web UI request when other Windows users and devices may come in
// (docs/design/remote-access.md). The web server asks the gate for the caller of every request and socket; the gate
// serves the routes of remote sign-in (/api/pair on the LAN listener, /api/login/once on loopback), answers knocks on
// the Windows sign-in pipe, runs the LAN listener, and closes sockets whose access ended. Each listener accepts a fixed
// set of credentials: loopback the owner's token cookie and Windows sign-ins (both bound to the Windows user of the
// connection when the helper runs), the LAN listener only device credentials.
import crypto from 'node:crypto';
import type http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import type { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';
import { callerLabel, type Caller } from '../../app/kernel/index.js';
import type { WebRemote } from '../../core/schema/web.js';
import { safeText } from '../../core/util/index.js';
import { cookieValue } from '../web/index.js';
import type { AccessStore } from './access-store.js';
import { networkProblem, type NetworkProfile } from './firewall.js';
import {
  chooseLanAddress,
  isLoopbackIPv4,
  lanPeerProblem,
  lanUrl,
  plainIPv4,
  privateAddresses,
  type Interfaces,
  type LanAddress,
} from './lan.js';
import type { TlsStore } from './tls-store.js';
import { knockProblem, type Knock, type WindowsAccount, type WindowsHelper } from './windows-helper.js';

export const WINDOWS_COOKIE = 'sbxwin';
/** `__Host-`: the browser keeps it only with Secure, Path=/ and no Domain. */
export const DEVICE_COOKIE = '__Host-sbxdev';
/** A Windows user's one-time link is good for this long. */
export const ONCE_LIFETIME_MS = 60_000;
/** Wrong device codes per address per minute. */
export const MAX_WRONG_PER_ADDRESS = 5;
const MINUTE_MS = 60_000;
const RECHECK_MS = 30_000;
const DAY_S = 86_400;
const MAX_DEVICE_NAME = 40;
const MAX_ONCE = 32;

/** One line of the audit log about a remote action. */
export interface RemoteAuditEntry {
  readonly who: string;
  readonly what: string;
  readonly outcome: 'ok' | 'refused' | 'failed';
}

/** How the LAN listener hands requests and upgrades to the web server. */
export interface LanHandlers {
  readonly request: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  readonly upgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
}

/** One RPC call as the socket saw it. */
export interface CallRecord {
  readonly caller: Caller;
  readonly op: string;
  readonly kind: 'operation' | 'query';
  readonly outcome: 'ok' | 'refused' | 'failed';
}

/** What a route needs from the server (body parsing, answers, the same-site check). */
export interface RouteIO {
  body(): Promise<unknown>;
  json(status: number, body: unknown, headers?: http.OutgoingHttpHeaders): void;
  requireSameSite(): void;
}

export interface LanState {
  readonly running: boolean;
  readonly url: string | null;
  readonly fingerprint: string | null;
  readonly notAfter: string | null;
  /** Why it is not running although it is on. */
  readonly problem: string | null;
}

export interface GateOptions {
  readonly store: AccessStore;
  /** The remote settings as they are now (read again by the caller when the file changes). */
  readonly settings: () => WebRemote;
  /** The owner's SID ('' when unknown: Windows sign-in stays off). */
  readonly ownerSid: string;
  /** null: no helper here (no csc): no Windows sign-in, the owner's cookie unbound as before. */
  readonly helper: WindowsHelper | null;
  readonly audit: (entry: RemoteAuditEntry) => void;
  readonly tls?: TlsStore;
  /** The network an address is on (get-network-profile.ps1); tests pass a fake. */
  readonly profile?: (address: string) => Promise<NetworkProfile>;
  readonly interfaces?: () => Interfaces;
  readonly now?: () => number;
  /** The loopback port (for the one-time link a Windows user gets). */
  readonly port: () => number;
}

interface Tracked {
  readonly ws: WebSocket;
  readonly check: () => Promise<Caller | null>;
  current: Caller | null;
}

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The Set-Cookie value of a remembered credential. */
export function credentialCookie(name: string, value: string, days: number, secure: boolean): string {
  return (
    name +
    '=' +
    value +
    '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' +
    days * DAY_S +
    (secure ? '; Secure' : '')
  );
}

/** A device name as shown on the PC: printable, trimmed, at most 40 characters. */
export function deviceName(value: unknown): string {
  const text = typeof value === 'string' ? safeText(value).replace(/\s+/g, ' ').trim() : '';
  return text.slice(0, MAX_DEVICE_NAME) || 'A device';
}

export class RemoteGate {
  private readonly peers = new WeakMap<net.Socket, Promise<WindowsAccount | null>>();
  private readonly once = new Map<string, { account: WindowsAccount; expires: number }>();
  private readonly wrong = new Map<string, number[]>();
  private readonly tracked = new Set<Tracked>();
  private roles: { key: string; bySid: Promise<Map<string, WebRemote['users'][number]['role']>> } | undefined;
  private lan: { server: https.Server; bound: LanAddress; port: number; fingerprint: string; notAfter: string } | null =
    null;
  private lanProblem: string | null = null;
  private handlers: LanHandlers | undefined;
  private lanListener: (state: LanState) => void = () => undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(private readonly o: GateOptions) {
    this.now = o.now ?? Date.now;
    o.helper?.onKnock((k) => this.knock(k));
  }


  /** The account at the other end of this loopback connection (asked once per TCP connection). */
  private peer(socket: net.Socket): Promise<WindowsAccount | null> {
    const helper = this.o.helper;
    if (!helper) return Promise.resolve(null);
    let known = this.peers.get(socket);
    if (!known) {
      known = helper.peer({
        localAddress: plainIPv4(socket.localAddress),
        localPort: socket.localPort ?? 0,
        remoteAddress: plainIPv4(socket.remoteAddress),
        remotePort: socket.remotePort ?? 0,
      });
      this.peers.set(socket, known);
    }
    return known;
  }

  private sameSid(a: string, b: string): boolean {
    return a.toUpperCase() === b.toUpperCase();
  }

  /** The role of a Windows user, by SID (names in the settings are turned into SIDs by Windows). */
  private async roleOf(sid: string): Promise<'view' | 'control' | null> {
    const settings = this.o.settings();
    if (!settings.windowsSignIn || !this.o.helper) return null;
    const key = JSON.stringify(settings.users);
    if (this.roles?.key !== key) {
      const helper = this.o.helper;
      const bySid = (async () => {
        const map = new Map<string, 'view' | 'control'>();
        for (const u of settings.users) {
          const account = await helper.lookup(u.name);
          if (account && !map.has(account.sid.toUpperCase())) map.set(account.sid.toUpperCase(), u.role);
        }
        return map;
      })();
      this.roles = { key, bySid };
    }
    return (await this.roles.bySid).get(sid.toUpperCase()) ?? null;
  }

  /** The LAN listener got this socket (TLS); everything else is loopback. */
  isLan(socket: net.Socket): boolean {
    return (socket as net.Socket & { encrypted?: boolean }).encrypted === true;
  }

  /**
   * The caller of a request on either listener. `ownerCookie`: the request carries the owner's token cookie (checked
   * by the server's WebAuth). Null: nobody we let in.
   */
  async caller(req: http.IncomingMessage, ownerCookie: boolean): Promise<Caller | null> {
    const socket = req.socket;
    if (this.isLan(socket)) {
      if (!this.lan || !this.o.settings().lan.enabled) return null;
      const device = this.o.store.device(cookieValue(req.headers.cookie, DEVICE_COOKIE));
      if (!device) return null;
      this.o.store.seen(device.id);
      return { kind: 'device', id: device.id, name: device.name, role: device.role };
    }
    if (!isLoopbackIPv4(plainIPv4(socket.remoteAddress))) return null;
    if (ownerCookie) {
      // Bound to the owner's own connections when Windows can tell (a cookie taken through another port is useless).
      if (!this.o.helper || !this.o.ownerSid) return { kind: 'owner' };
      const account = await this.peer(socket);
      return account && this.sameSid(account.sid, this.o.ownerSid) ? { kind: 'owner' } : null;
    }
    const grant = this.o.store.windowsGrant(cookieValue(req.headers.cookie, WINDOWS_COOKIE));
    if (!grant) return null;
    const account = await this.peer(socket);
    if (!account || !this.sameSid(account.sid, grant.sid)) return null;
    const role = await this.roleOf(grant.sid);
    return role ? { kind: 'windows', user: grant.user, role } : null;
  }


  private lanHost(): string | null {
    return this.lan ? this.lan.bound.address + ':' + this.lan.port : null;
  }

  /** The Host header a LAN request must carry: exactly <address>:<port> (no names: DNS rebinding fails). */
  lanHostAllowed(host: string | undefined): boolean {
    const expected = this.lanHost();
    return expected !== null && host === expected;
  }

  lanOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
    return this.lanHostAllowed(host) && origin === 'https://' + host;
  }


  /** Serves the remote sign-in routes; false when the path is not one of them. */
  async route(req: http.IncomingMessage, pathname: string, io: RouteIO): Promise<boolean> {
    const lan = this.isLan(req.socket);
    try {
      if (pathname === '/api/pair' && req.method === 'POST') {
        if (!lan) throw new Refused(404, 'Not found.');
        await this.pair(req, io);
        return true;
      }
      if (pathname === '/api/login/once' && req.method === 'POST') {
        if (lan) throw new Refused(404, 'Not found.');
        await this.loginOnce(req, io);
        return true;
      }
      // The LAN listener has no token login and no stop.
      if (lan && (pathname === '/api/login' || pathname === '/api/stop')) throw new Refused(404, 'Not found.');
      return false;
    } catch (e) {
      if (e instanceof Refused) {
        io.json(e.status, { error: e.message });
        return true;
      }
      throw e;
    }
  }

  private tooMany(address: string): boolean {
    const t = this.now();
    const recent = (this.wrong.get(address) ?? []).filter((at) => t - at < MINUTE_MS);
    this.wrong.set(address, recent);
    return recent.length >= MAX_WRONG_PER_ADDRESS;
  }

  private countWrong(address: string): void {
    this.wrong.set(address, [...(this.wrong.get(address) ?? []), this.now()]);
    if (this.wrong.size > 1000) this.wrong.delete(this.wrong.keys().next().value as string);
  }

  private async pair(req: http.IncomingMessage, io: RouteIO): Promise<void> {
    io.requireSameSite();
    const address = plainIPv4(req.socket.remoteAddress);
    const body = (await io.body()) as { code?: unknown; name?: unknown } | null;
    if (!this.o.store.codePending())
      throw new Refused(409, 'No new device is being allowed right now. On the PC, choose "Allow a new device".');
    if (this.tooMany(address)) throw new Refused(429, 'Too many wrong codes. Wait a minute.');
    const name = deviceName(body?.name);
    const result = this.o.store.redeem(body?.code, name, address, this.o.settings().rememberDays);
    if (!result.ok) {
      if (result.reason === 'wrong' || result.reason === 'void') this.countWrong(address);
      this.o.audit({ who: 'device ' + name + ' (' + address + ')', what: 'allow device', outcome: 'refused' });
      throw new Refused(
        result.reason === 'expired' || result.reason === 'none' ? 409 : 403,
        result.reason === 'void'
          ? 'That code is no longer valid. Ask for a new one on the PC.'
          : result.reason === 'wrong'
            ? 'That code is not right.'
            : 'That code has run out. Ask for a new one on the PC.',
      );
    }
    this.o.audit({ who: 'device ' + name + ' (' + address + ')', what: 'allow device', outcome: 'ok' });
    io.json(
      200,
      { ok: true, role: result.device.role },
      { 'Set-Cookie': credentialCookie(DEVICE_COOKIE, result.credential, this.o.settings().rememberDays, true) },
    );
  }

  private async loginOnce(req: http.IncomingMessage, io: RouteIO): Promise<void> {
    io.requireSameSite();
    const body = (await io.body()) as { token?: unknown } | null;
    const token = typeof body?.token === 'string' && /^[0-9a-f]{64}$/.test(body.token) ? body.token : '';
    const key = crypto.createHash('sha256').update(token).digest('hex');
    const entry = this.once.get(key);
    this.once.delete(key);
    if (!entry || entry.expires < this.now()) throw new Refused(401, 'That sign-in link has run out. Run it again.');
    // The link must be used by the same Windows user it was made for.
    const account = await this.peer(req.socket);
    if (!account || !this.sameSid(account.sid, entry.account.sid)) {
      this.o.audit({ who: 'Windows user ' + entry.account.user, what: 'sign in', outcome: 'refused' });
      throw new Refused(403, 'That sign-in link is for another Windows user.');
    }
    const role = await this.roleOf(entry.account.sid);
    if (!role) throw new Refused(403, 'You may not use this web UI.');
    const days = this.o.settings().rememberDays;
    const credential = this.o.store.issueWindows(entry.account.sid, entry.account.user, days);
    this.o.audit({ who: 'Windows user ' + entry.account.user, what: 'sign in', outcome: 'ok' });
    io.json(200, { ok: true, role }, { 'Set-Cookie': credentialCookie(WINDOWS_COOKIE, credential, days, false) });
  }

  /** A knock on the pipe: a one-time link for a Windows user on the list, else the reason. */
  async knock(k: Knock): Promise<string> {
    const who = 'Windows user ' + k.user;
    const refuse = (reason: string): string => {
      this.o.audit({ who, what: 'sign in (' + reason + ')', outcome: 'refused' });
      return 'refused ' + reason;
    };
    if (!this.o.ownerSid) return refuse('the owner is unknown');
    const problem = knockProblem(k, this.o.ownerSid);
    if (problem) return refuse(problem);
    if (!this.o.settings().windowsSignIn) return refuse('Windows sign-in is off');
    const role = await this.roleOf(k.sid);
    if (!role) return refuse('not on the list');
    const t = this.now();
    for (const [key, e] of this.once) if (e.expires < t) this.once.delete(key);
    if (this.once.size >= MAX_ONCE) return refuse('too many sign-ins at once');
    const token = crypto.randomBytes(32).toString('hex');
    this.once.set(crypto.createHash('sha256').update(token).digest('hex'), {
      account: { sid: k.sid, user: k.user },
      expires: t + ONCE_LIFETIME_MS,
    });
    return 'ok ' + token + ' ' + this.o.port() + ' ' + role;
  }


  /** Watches a socket: it is closed when its caller no longer gets in. Returns the caller as it is now, for each use. */
  track(ws: WebSocket, req: http.IncomingMessage, ownerCookie: boolean, first: Caller): () => Caller | null {
    const entry: Tracked = { ws, check: () => this.caller(req, ownerCookie), current: first };
    this.tracked.add(entry);
    ws.on('close', () => this.tracked.delete(entry));
    return () => entry.current;
  }

  /** Checks every socket again (and LAN mode against the settings); closes those whose access ended. */
  async recheck(): Promise<void> {
    const lanOn = this.o.settings().lan.enabled;
    if (this.lan && !lanOn) await this.stopLan(true);
    else if (!this.lan && lanOn && this.handlers) await this.startLan(this.handlers);
    for (const entry of [...this.tracked]) {
      let now: Caller | null = null;
      try {
        now = await entry.check();
      } catch {
        now = null;
      }
      const before = entry.current;
      entry.current = now;
      const downgraded = before && now && before.kind !== 'owner' && now.kind !== 'owner' && before.role !== now.role;
      if (!now || downgraded) {
        entry.current = null;
        entry.ws.close(4001, now ? 'your access changed' : 'signed out');
        this.tracked.delete(entry);
      }
    }
  }


  /** Starts the LAN listener when LAN mode is on and allowed here; else notes why. Devices go when it is off. */
  async startLan(handlers: LanHandlers): Promise<void> {
    this.handlers = handlers;
    const settings = this.o.settings().lan;
    this.lanProblem = null;
    if (!settings.enabled) {
      if (this.o.store.read().devices.length) this.o.store.revokeAll('devices');
      return;
    }
    const interfaces = this.o.interfaces ?? (() => undefined);
    try {
      const bound = chooseLanAddress(settings.address, interfaces());
      if (!this.o.tls || !this.o.profile) throw new Error('LAN mode is not available here.');
      const network = this.o.store.read().network;
      const profile = await this.o.profile(bound.address);
      const problem = networkProblem(profile, network);
      if (problem) throw new Error(problem);
      if (network === null) this.o.store.setNetwork(profile.name);
      const tls = this.o.tls.material(privateAddresses(interfaces()).map((a) => a.address));
      const server = https.createServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' }, handlers.request);
      server.on('upgrade', handlers.upgrade);
      // Before a byte of TLS: only on-link private peers of this adapter, never this PC or a sandbox.
      server.on('connection', (socket: net.Socket) => {
        if (lanPeerProblem(socket.remoteAddress, socket.localAddress, bound, interfaces())) socket.destroy();
      });
      server.headersTimeout = 15000;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ port: settings.port, host: bound.address, exclusive: true }, () => {
          server.off('error', reject);
          resolve();
        });
      });
      this.lan = { server, bound, port: settings.port, fingerprint: tls.fingerprint, notAfter: tls.notAfter };
    } catch (e) {
      this.lanProblem = e instanceof Error ? e.message : String(e);
    }
    this.lanListener(this.lanState());
  }

  /** Told whenever the LAN listener starts, stops or fails (the server's state file says where it is). */
  onLanChange(listener: (state: LanState) => void): void {
    this.lanListener = listener;
  }

  private async stopLan(revoke: boolean): Promise<void> {
    const lan = this.lan;
    this.lan = null;
    if (revoke) this.o.store.revokeAll('devices');
    if (lan) {
      lan.server.closeAllConnections();
      await new Promise<void>((resolve) => lan.server.close(() => resolve()));
    }
    this.lanListener(this.lanState());
  }

  /** An RPC call of someone other than the owner, for the audit log; after an operation, access is checked again. */
  recordCall(e: CallRecord): void {
    if (e.caller.kind === 'owner') return;
    this.o.audit({ who: callerLabel(e.caller), what: e.op, outcome: e.outcome });
    if (e.kind === 'operation') void this.recheck();
  }

  lanState(): LanState {
    return {
      running: this.lan !== null,
      url: this.lan ? lanUrl(this.lan.bound.address, this.lan.port) : null,
      fingerprint: this.lan?.fingerprint ?? null,
      notAfter: this.lan?.notAfter ?? null,
      problem: this.lanProblem,
    };
  }

  /** Starts the periodic check. */
  start(): void {
    this.timer = setInterval(() => void this.recheck(), RECHECK_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.o.helper?.stop();
    await this.stopLan(false);
  }
}
