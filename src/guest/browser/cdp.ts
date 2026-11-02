// A small client of the Chrome DevTools Protocol (CDP) for a Chromium browser in this sandbox (Comet): the WebSocket
// handshake and frames over a plain TCP socket to 127.0.0.1 (Node 22.0.0 has no stable WebSocket), JSON calls with
// ids, nothing else. Everything the browser sends is bounded: the handshake's headers, each frame and each message.
// The port comes from the profile's DevToolsActivePort file (the browser starts with --remote-debugging-port=0 or a
// fixed port). No runtime imports: the self-test drives it over a fake socket.
import crypto from 'node:crypto';
import net from 'node:net';
import type { Duplex } from 'node:stream';

/** The largest message accepted from the browser (its whole cookie jar can be big). */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_TIMEOUT_MS = 10_000;

export const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

/** Where a browser's DevTools listen: its port on 127.0.0.1 and the browser target's path. */
export interface DevToolsEndpoint {
  readonly port: number;
  readonly path: string;
}

/** The DevToolsActivePort file's two lines (port, then /devtools/browser/<id>), or null when it is not that. */
export function parseDevToolsActivePort(text: string): DevToolsEndpoint | null {
  const [portLine = '', pathLine = ''] = text.slice(0, 512).split(/\r?\n/);
  if (!/^\d{1,5}$/.test(portLine.trim())) return null;
  const port = Number(portLine.trim());
  const target = pathLine.trim();
  if (port < 1 || port > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9-]{1,64}$/.test(target)) return null;
  return { port, path: target };
}

/** One WebSocket frame. A client's frames are masked (`mask` given); a server's never are. */
export function encodeFrame(opcode: number, payload: Buffer, mask: Buffer | null = crypto.randomBytes(4)): Buffer {
  const len = payload.length;
  const head: number[] = [0x80 | (opcode & 0x0f)];
  const maskBit = mask ? 0x80 : 0;
  if (len < 126) head.push(maskBit | len);
  else if (len < 65536) head.push(maskBit | 126, (len >> 8) & 0xff, len & 0xff);
  else {
    head.push(maskBit | 127, 0, 0, 0, 0);
    head.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  }
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([Buffer.from(head), mask.subarray(0, 4), body]);
}

export interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

/**
 * Cuts a byte stream into frames. Refuses (throws) reserved bits, unknown opcodes, a control frame that is long or
 * split, a frame bigger than `maxBytes`, and masking the wrong way round (`masked`: what the other side must do).
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(
    private readonly maxBytes: number = MAX_MESSAGE_BYTES,
    private readonly masked: boolean = false,
  ) {}

  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames: Frame[] = [];
    for (let frame = this.next(); frame; frame = this.next()) frames.push(frame);
    return frames;
  }

  private next(): Frame | null {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    if (b[0] & 0x70) throw new Error('DevTools: a frame with reserved bits set');
    const opcode = b[0] & 0x0f;
    if (![0, 1, 2, 8, 9, 10].includes(opcode)) throw new Error('DevTools: an unknown frame type (' + opcode + ')');
    const isMasked = (b[1] & 0x80) !== 0;
    if (isMasked !== this.masked) throw new Error('DevTools: a frame masked the wrong way');
    let len = b[1] & 0x7f;
    let at = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      at = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      if (b.readUInt32BE(2) !== 0) throw new Error('DevTools: a frame bigger than ' + this.maxBytes + ' bytes');
      len = b.readUInt32BE(6);
      at = 10;
    }
    if (opcode >= 8 && (len > 125 || !fin)) throw new Error('DevTools: a control frame that is long or split');
    if (len > this.maxBytes) throw new Error('DevTools: a frame bigger than ' + this.maxBytes + ' bytes');
    const maskAt = at;
    if (isMasked) at += 4;
    if (b.length < at + len) return null;
    let payload = Buffer.from(b.subarray(at, at + len));
    if (isMasked) {
      const mask = b.subarray(maskAt, maskAt + 4);
      payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i & 3]));
    }
    this.buffer = b.subarray(at + len);
    return { fin, opcode, payload };
  }
}

/** The Sec-WebSocket-Accept a server must answer to `key` (RFC 6455). */
export function acceptFor(key: string): string {
  return crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
}

/** Parses the server's handshake answer: the bytes after it, or throws when it is not a switch to WebSocket. */
export function readHandshake(head: Buffer, key: string): { rest: Buffer } | null {
  const end = head.indexOf('\r\n\r\n');
  if (end < 0) {
    if (head.length > MAX_HEADER_BYTES) throw new Error('DevTools: the handshake answer is too long');
    return null;
  }
  const lines = head.subarray(0, end).toString('latin1').split('\r\n');
  if (!/^HTTP\/1\.1 101\b/.test(lines[0] ?? ''))
    throw new Error('DevTools: refused the connection (' + (lines[0] ?? '') + ')');
  const accept = lines
    .slice(1)
    .map((l) => /^sec-websocket-accept:\s*(\S+)\s*$/i.exec(l)?.[1])
    .find((v) => v !== undefined);
  if (accept !== acceptFor(key)) throw new Error('DevTools: the handshake answer does not match');
  return { rest: head.subarray(end + 4) };
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** One connection to a browser's DevTools: call() sends a command and resolves with its result. */
export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly reader = new FrameReader();
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private closed = false;

  private constructor(private readonly socket: Duplex) {}

  /** Connects to the endpoint on 127.0.0.1 (never another host). */
  static open(endpoint: DevToolsEndpoint, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<CdpConnection> {
    const socket = net.connect({ host: '127.0.0.1', port: endpoint.port });
    return CdpConnection.over(socket, endpoint, timeoutMs);
  }

  /** The handshake over a socket that is connecting or connected (the self-test gives a fake one). */
  static over(
    socket: Duplex,
    endpoint: DevToolsEndpoint,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<CdpConnection> {
    const key = crypto.randomBytes(16).toString('base64');
    return new Promise((resolve, reject) => {
      let head = Buffer.alloc(0);
      const timer = setTimeout(() => fail(new Error('DevTools: no answer within ' + timeoutMs + ' ms')), timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', fail);
        socket.off('close', onClose);
      };
      const fail = (e: Error): void => {
        cleanup();
        socket.destroy();
        reject(e);
      };
      const onClose = (): void => fail(new Error('DevTools: the connection closed during the handshake'));
      const onData = (chunk: Buffer): void => {
        try {
          head = Buffer.concat([head, chunk]);
          const done = readHandshake(head, key);
          if (!done) return;
          cleanup();
          const connection = new CdpConnection(socket);
          connection.listen();
          if (done.rest.length) connection.onBytes(done.rest);
          resolve(connection);
        } catch (e) {
          fail(e instanceof Error ? e : new Error(String(e)));
        }
      };
      socket.on('data', onData);
      socket.on('error', fail);
      socket.on('close', onClose);
      socket.write(
        'GET ' +
          endpoint.path +
          ' HTTP/1.1\r\nHost: 127.0.0.1:' +
          endpoint.port +
          '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' +
          key +
          '\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
  }

  private listen(): void {
    this.socket.on('data', (chunk: Buffer) => this.onBytes(chunk));
    this.socket.on('error', (e: Error) => this.shut(e));
    this.socket.on('close', () => this.shut(new Error('DevTools: the connection closed')));
  }

  private onBytes(chunk: Buffer): void {
    try {
      for (const frame of this.reader.push(chunk)) this.onFrame(frame);
    } catch (e) {
      this.shut(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private onFrame(frame: Frame): void {
    if (frame.opcode === OPCODE.ping) {
      this.send(OPCODE.pong, frame.payload);
      return;
    }
    if (frame.opcode === OPCODE.pong) return;
    if (frame.opcode === OPCODE.close) {
      this.shut(new Error('DevTools: the browser closed the connection'));
      return;
    }
    if (frame.opcode !== OPCODE.continuation && this.fragments.length)
      throw new Error('DevTools: a new message before the last one ended');
    if (frame.opcode === OPCODE.continuation && !this.fragments.length)
      throw new Error('DevTools: a continuation without a message');
    this.fragmentBytes += frame.payload.length;
    if (this.fragmentBytes > MAX_MESSAGE_BYTES) throw new Error('DevTools: a message bigger than ' + MAX_MESSAGE_BYTES);
    this.fragments.push(frame.payload);
    if (!frame.fin) return;
    const text = Buffer.concat(this.fragments).toString('utf8');
    this.fragments = [];
    this.fragmentBytes = 0;
    this.onMessage(text);
  }

  private onMessage(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return; // Not JSON: nothing waits for it.
    }
    if (typeof message !== 'object' || message === null) return;
    const m = message as { id?: unknown; result?: unknown; error?: { message?: unknown } };
    if (typeof m.id !== 'number') return; // An event: not asked for.
    const waiting = this.pending.get(m.id);
    if (!waiting) return;
    this.pending.delete(m.id);
    clearTimeout(waiting.timer);
    if (m.error) waiting.reject(new Error('DevTools: ' + String(m.error.message ?? 'the call failed').slice(0, 300)));
    else waiting.resolve(m.result ?? {});
  }

  private send(opcode: number, payload: Buffer): void {
    if (!this.closed) this.socket.write(encodeFrame(opcode, payload));
  }

  private shut(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.socket.destroy();
  }

  /** Sends a command (to a page's session in flat mode when `sessionId` is given) and waits for its result. */
  call<T = unknown>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    o: { readonly sessionId?: string; readonly timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('DevTools: the connection is closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('DevTools: ' + method + ' did not answer'));
      }, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      const body = { id, method, params, ...(o.sessionId ? { sessionId: o.sessionId } : {}) };
      this.send(OPCODE.text, Buffer.from(JSON.stringify(body), 'utf8'));
    });
  }

  /** Closes the connection (the browser keeps running). */
  close(): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(OPCODE.close, Buffer.alloc(0)));
    } catch {
      // Already gone: nothing to tell the browser.
    }
    this.shut(new Error('DevTools: the connection is closed'));
  }
}
