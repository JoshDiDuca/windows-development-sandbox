// The browser's end of the RPC socket (/api/rpc): calls with their progress, log lines and questions, and
// subscriptions to live queries (sent again after a reconnect). Every message from the server is checked against the
// kernel's schemas; anything else is ignored.
import {
  fromWireError,
  ServerMessageSchema,
  type Answer,
  type Question,
  type ServerMessage,
  type Tone,
} from '../../../src/app/kernel/index';

/** What a call reports while it runs. */
export interface CallHandlers {
  readonly progress?: (text: string) => void;
  readonly log?: (text: string, tone?: Tone) => void;
  /** Answers a question the operation asks (the shell shows a modal). */
  readonly ask: (question: Question) => Promise<Answer>;
}

interface PendingCall {
  readonly handlers: CallHandlers;
  readonly resolve: (output: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** One subscription on the socket, followed by one or more components. */
interface SharedSubscription {
  readonly id: string;
  readonly listeners: Set<{ data: (output: unknown) => void; error: (e: Error) => void }>;
  last: { readonly output: unknown } | undefined;
}

interface Subscription {
  readonly query: string;
  readonly input: unknown;
  readonly data: (output: unknown) => void;
  readonly error: (error: Error) => void;
}

const BASE_WAIT_MS = 500;
const MAX_WAIT_MS = 30_000;
const GIVE_UP_MS = 5 * 60_000;
export type RpcConnectionState = 'connected' | 'reconnecting' | 'offline' | 'signed-out' | 'replaced';

export class RpcClient {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private next = 1;
  /** Only idempotent subscription messages may wait for a connecting socket. Calls must never replay. */
  private readonly queue: { readonly text: string; readonly id?: string }[] = [];
  private readonly calls = new Map<string, PendingCall>();
  private readonly subscriptions = new Map<string, Subscription>();
  /** The subscription each query and input has, with the components that follow it. */
  private readonly shared = new Map<string, SharedSubscription>();
  private readonly listeners = new Set<(state: RpcConnectionState) => void>();
  private hidden = false;
  private terminated: RpcConnectionState | null = null;
  private reconnectSince = 0;
  private reconnectTimer: number | null = null;

  /**
   * The tab was hidden or shown. Hidden: live queries stop (nothing is read for a page nobody sees); the idle socket
   * stays, so the server knows the page is still open and does not end. Shown: live queries start again, fresh.
   */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden) {
      if (this.socket?.readyState === WebSocket.OPEN)
        for (const id of this.subscriptions.keys()) this.send({ t: 'unsubscribe', id });
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN)
      for (const [id, s] of this.subscriptions) this.send({ t: 'subscribe', id, query: s.query, input: s.input });
    else if (this.subscriptions.size) this.connect();
  }

  /** The page is back (from the browser's cache): connects again, with its live queries. */
  resume(): void {
    this.hidden = false;
    this.connect();
  }

  /** Closes the socket without reconnecting (the page is going away). */
  release(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
    this.listeners.forEach((l) => l('reconnecting'));
  }

  /** Called when the socket connects or drops (the shell shows it). */
  onConnection(listener: (state: RpcConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.socket?.readyState === WebSocket.OPEN ? 'connected' : (this.terminated ?? 'reconnecting'));
    return () => this.listeners.delete(listener);
  }

  private connect(): WebSocket {
    if (this.terminated)
      throw new Error(
        this.terminated === 'signed-out' ? 'You have been signed out.' : 'This page was replaced by a newer one.',
      );
    if (this.socket) return this.socket;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(scheme + '//' + location.host + '/api/rpc');
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.reconnectSince = 0;
      this.listeners.forEach((l) => l('connected'));
      // Live queries carry on where they were (not while the tab is hidden).
      if (!this.hidden)
        for (const [id, s] of this.subscriptions) this.send({ t: 'subscribe', id, query: s.query, input: s.input });
      for (const item of this.queue.splice(0)) socket.send(item.text);
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') return;
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = ServerMessageSchema.safeParse(value);
      if (parsed.success) void this.receive(parsed.data);
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.listeners.forEach((l) => l('reconnecting'));
      // A call cannot survive the socket (its questions were answered no on the server).
      for (const call of this.calls.values())
        call.reject(new Error('The connection to the sandbox web server dropped.'));
      this.calls.clear();
      // Never replay a call or answer after the caller has been told it failed.
      this.queue.length = 0;
      if (event.code === 4000 || event.code === 4001) {
        this.terminated = event.code === 4001 ? 'signed-out' : 'replaced';
        this.listeners.forEach((l) => l(this.terminated!));
        return;
      }
      // Retry with jitter, but stop polling after five minutes so abandoned pages go quiet.
      if (!this.reconnectSince) this.reconnectSince = Date.now();
      if (Date.now() - this.reconnectSince >= GIVE_UP_MS) {
        this.listeners.forEach((l) => l('offline'));
        return;
      }
      const ceiling = Math.min(MAX_WAIT_MS, BASE_WAIT_MS * 2 ** Math.min(this.attempt++, 6));
      const wait = Math.round(ceiling * (0.75 + Math.random() * 0.5));
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        try {
          this.connect();
        } catch {
          /* terminated is surfaced to the shell */
        }
      }, wait);
    };
    return socket;
  }

  private send(message: object): void {
    const text = JSON.stringify(message);
    if (this.terminated)
      throw new Error(
        this.terminated === 'signed-out' ? 'You have been signed out.' : 'This page was replaced by a newer one.',
      );
    const socket = this.connect();
    if (socket.readyState === WebSocket.OPEN) socket.send(text);
    else {
      const queued = message as { t?: string; id?: string };
      if (queued.t === 'unsubscribe' || queued.t === 'call' || queued.t === 'answer')
        this.queue.push({ text, ...(queued.id ? { id: queued.id } : {}) });
    }
  }

  private async receive(m: ServerMessage): Promise<void> {
    const sub = this.subscriptions.get(m.id);
    if (sub) {
      if (m.t === 'data') sub.data(m.output);
      if (m.t === 'error') sub.error(fromWireError(m.error));
      return;
    }
    const call = this.calls.get(m.id);
    if (!call) return;
    switch (m.t) {
      case 'progress':
        call.handlers.progress?.(m.text);
        return;
      case 'log':
        call.handlers.log?.(m.text, m.tone);
        return;
      case 'ask': {
        const value = await call.handlers.ask(m.question);
        if (this.calls.has(m.id)) this.send({ t: 'answer', id: m.id, value });
        return;
      }
      case 'result':
        this.calls.delete(m.id);
        call.resolve(m.output);
        return;
      case 'error':
        this.calls.delete(m.id);
        call.reject(fromWireError(m.error));
        return;
    }
  }

  /** Runs an operation (or reads a query once); rejects with the operation's UserError or Cancelled. */
  call(
    id: string,
    input: unknown,
    handlers: CallHandlers,
    timeoutMs = 5 * 60_000,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const callId = 'c' + this.next++;
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        const pending = this.calls.get(callId);
        if (!pending) return;
        this.calls.delete(callId);
        this.dropQueued(callId);
        pending.reject(new Error('Stopped waiting for this request. It may still be running on the PC.'));
      };
      const timeout = window.setTimeout(() => {
        const pending = this.calls.get(callId);
        if (!pending) return;
        this.calls.delete(callId);
        this.dropQueued(callId);
        pending.reject(new Error('This request timed out. Check whether it finished before trying again.'));
      }, timeoutMs);
      const settle = (): void => {
        window.clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      };
      this.calls.set(callId, {
        handlers,
        resolve: (output) => {
          settle();
          resolve(output);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.send({ t: 'call', id: callId, op: id, input });
      } catch (error) {
        this.calls.delete(callId);
        this.dropQueued(callId);
        window.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error('Could not connect to the sandbox web server.'));
      }
    });
  }

  private dropQueued(id: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i].id === id) this.queue.splice(i, 1);
  }

  /**
   * Follows a live query: `data` with every new result. Components that follow the same query and input share one
   * subscription (a newcomer gets the last result at once). Returns the way to stop.
   */
  subscribe(query: string, input: unknown, data: (output: unknown) => void, error: (e: Error) => void): () => void {
    const key = query + '\u0000' + JSON.stringify(input ?? null);
    let shared = this.shared.get(key);
    if (!shared) {
      const s: SharedSubscription = { id: 's' + this.next++, listeners: new Set(), last: undefined };
      shared = s;
      this.shared.set(key, s);
      this.subscriptions.set(s.id, {
        query,
        input,
        data: (output) => {
          s.last = { output };
          for (const l of [...s.listeners]) l.data(output);
        },
        error: (e) => {
          s.last = undefined;
          for (const l of [...s.listeners]) l.error(e);
        },
      });
      // Sent now only on an open socket: a socket still connecting sends every subscription when it opens (queueing it
      // here as well sent it twice, and the server refused the second: "That id is in use").
      if (!this.hidden) {
        const socket = this.connect();
        if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ t: 'subscribe', id: s.id, query, input }));
      }
    } else if (shared.last) data(shared.last.output);
    const listener = { data, error };
    const s = shared;
    s.listeners.add(listener);
    return () => {
      s.listeners.delete(listener);
      if (s.listeners.size) return;
      this.shared.delete(key);
      this.subscriptions.delete(s.id);
      if (this.socket?.readyState === WebSocket.OPEN) this.send({ t: 'unsubscribe', id: s.id });
    };
  }
}
