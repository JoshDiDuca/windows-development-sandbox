// The browser's end of one terminal: a WebSocket to the server with reconnect (growing waits). Binary messages from the
// server are terminal output, text messages are JSON status; keystrokes go the other way as binary.
import { parseServerMessage } from './messages';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'failed';

export interface ConnectionEvents {
  state(state: ConnectionState, detail?: string): void;
  output(bytes: Uint8Array): void;
  /** A fresh connection: the terminal clears itself, the session draws the screen again. */
  reset(): void;
}

const WAITS_MS = [500, 1000, 2000, 4000, 8000];

export class TerminalConnection {
  private socket: WebSocket | null = null;
  private timer: number | undefined;
  private attempt = 0;
  private closed = false;
  private finished = false;
  private suspended = false;
  private size = { cols: 120, rows: 30 };

  constructor(
    private readonly sessionId: string,
    private readonly events: ConnectionEvents,
  ) {}

  open(cols: number, rows: number): void {
    this.size = { cols, rows };
    this.connect();
  }

  private connect(): void {
    this.events.state(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url =
      scheme +
      '//' +
      location.host +
      '/api/sessions/' +
      this.sessionId +
      '/terminal?cols=' +
      this.size.cols +
      '&rows=' +
      this.size.rows;
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data instanceof ArrayBuffer) {
        this.events.output(new Uint8Array(event.data));
        return;
      }
      const message = typeof event.data === 'string' ? parseServerMessage(event.data) : null;
      if (!message) return;
      if (message.t === 'ready') {
        this.attempt = 0;
        this.events.reset();
        this.events.state('connected');
      } else if (message.t === 'exit') {
        this.finished = true;
        this.events.state('ended', 'The agent exited (code ' + message.code + ').');
      } else if (message.t === 'error') {
        this.finished = true;
        this.events.state('failed', message.message);
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closed || this.finished || this.suspended) return;
      const wait = WAITS_MS[Math.min(this.attempt, WAITS_MS.length - 1)];
      this.attempt++;
      this.events.state('reconnecting');
      this.timer = window.setTimeout(() => this.connect(), wait);
    };
  }

  send(bytes: Uint8Array): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(bytes);
  }

  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ t: 'resize', cols, rows }));
  }

  /** A hidden page lets go of the session for now (no reconnect); resume() connects again and the screen comes back. */
  suspend(): void {
    if (this.closed || this.finished) return;
    this.suspended = true;
    window.clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
  }

  resume(): void {
    if (!this.suspended || this.closed || this.finished) return;
    this.suspended = false;
    this.attempt = 0;
    this.connect();
  }

  /** Detach: closes the socket and never reconnects. The session keeps running in the sandbox. */
  close(): void {
    this.closed = true;
    window.clearTimeout(this.timer);
    this.socket?.close(1000);
    this.socket = null;
  }
}
