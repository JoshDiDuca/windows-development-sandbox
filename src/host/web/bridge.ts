// One browser's terminal: a WebSocket on one side, the session's ptyhost (TCP, the attach protocol) on the other. The
// server holds the attach token; the browser only ever sees output. Everything from the browser is bounds-checked and a
// browser that sends garbage is closed.
import type net from 'node:net';
import type { WebSocket, RawData } from 'ws';
import { safeText } from '../../core/util/index.js';
import {
  connect,
  encodeFrame,
  FrameReader,
  FrameType,
  helloFrame,
  OutputFilter,
  PING_INTERVAL_MS,
  resizeFrame,
  type Endpoint,
  type Frame,
} from '../../shared/pty/index.js';
import { parseClientMessage, type ServerMessage } from '../../shared/web/index.js';

/** The browser is slower than the sandbox: past this much waiting to be sent, output is held back in the socket. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const DRAIN_CHECK_MS = 50;
/** A browser that cannot keep up for this long is closed. */
const MAX_STALLED_MS = 60 * 1000;

export class TerminalBridge {
  private socket: net.Socket | null = null;
  private pinger: NodeJS.Timeout | null = null;
  private drain: NodeJS.Timeout | null = null;
  private stalledSince = 0;
  private done = false;
  private readonly filter = new OutputFilter();
  private readonly reader = new FrameReader();

  constructor(
    private readonly ws: WebSocket,
    private readonly endpoint: Endpoint,
    private readonly cols: number,
    private readonly rows: number,
    private readonly dial: (endpoint: Endpoint) => Promise<net.Socket> = connect,
    /** View only: keystrokes and resizes from the browser are dropped here, whatever the page sends. */
    private readonly readOnly: boolean = false,
  ) {}

  /** Connects to the session and starts passing data both ways. */
  async start(): Promise<void> {
    this.ws.on('message', (data: RawData, isBinary: boolean) => this.fromBrowser(data, isBinary));
    this.ws.on('close', () => this.finish());
    this.ws.on('error', () => this.finish());
    let socket: net.Socket;
    try {
      socket = await this.dial(this.endpoint);
    } catch {
      this.tell({ t: 'error', message: 'Could not reach the session in the sandbox.' });
      this.finish(1011, 'unreachable');
      return;
    }
    if (this.done) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.fromSession(chunk));
    socket.on('error', () => this.finish(1011, 'session connection failed'));
    socket.on('close', () => this.finish(1011, 'session connection closed'));
    socket.write(helloFrame(this.endpoint.token, this.cols, this.rows));
    // The session drops a viewer it has not heard from in 15 s.
    this.pinger = setInterval(() => this.socket?.write(encodeFrame(FrameType.Ping)), PING_INTERVAL_MS);
    this.tell({ t: 'ready' });
  }

  private fromBrowser(data: RawData, isBinary: boolean): void {
    if (!this.socket || this.done || this.readOnly) return;
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (isBinary) {
      if (bytes.length) this.socket.write(encodeFrame(FrameType.Input, bytes));
      return;
    }
    const message = parseClientMessage(bytes.toString('utf8'));
    if (!message) {
      this.finish(1008, 'bad message');
      return;
    }
    this.socket.write(resizeFrame(message.cols, message.rows));
  }

  private fromSession(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.reader.push(chunk);
    } catch {
      this.tell({ t: 'error', message: 'The session sent data that could not be read.' });
      this.finish(1011, 'bad frame');
      return;
    }
    for (const frame of frames) {
      if (this.done) return;
      switch (frame.type) {
        case FrameType.Output: {
          const clean = this.filter.push(frame.payload);
          if (clean.length) this.ws.send(clean, { binary: true });
          break;
        }
        case FrameType.Restarting:
          this.tell({ t: 'restarting' });
          break;
        case FrameType.Exit:
          this.tell({ t: 'exit', code: frame.payload.length >= 4 ? frame.payload.readInt32LE(0) : 1 });
          this.finish(1000, 'exit');
          return;
        case FrameType.Error:
          this.tell({ t: 'error', message: safeText(frame.payload.toString('utf8').slice(0, 500)) });
          this.finish(1000, 'error');
          return;
        default:
          break; // status and console frames are for terminals that draw the screen themselves
      }
    }
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) this.hold();
  }

  /** Stops reading from the session until the browser has taken what it was sent. */
  private hold(): void {
    if (this.drain || !this.socket) return;
    this.socket.pause();
    this.stalledSince = Date.now();
    this.drain = setInterval(() => {
      if (this.ws.bufferedAmount <= MAX_BUFFERED_BYTES / 4) {
        if (this.drain) clearInterval(this.drain);
        this.drain = null;
        this.socket?.resume();
      } else if (Date.now() - this.stalledSince > MAX_STALLED_MS) this.finish(1013, 'too slow');
    }, DRAIN_CHECK_MS);
  }

  private tell(message: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message));
  }

  /** Closes both sides (once). */
  private finish(code = 1000, reason = ''): void {
    if (this.done) return;
    this.done = true;
    if (this.pinger) clearInterval(this.pinger);
    if (this.drain) clearInterval(this.drain);
    this.socket?.destroy();
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) this.ws.close(code, reason);
  }
}
