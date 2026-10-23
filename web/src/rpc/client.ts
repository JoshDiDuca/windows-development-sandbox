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

const WAITS_MS = [500, 1000, 2000, 4000, 8000];

export class RpcClient {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private next = 1;
  private readonly queue: string[] = [];
  private readonly calls = new Map<string, PendingCall>();
  private readonly subscriptions = new Map<string, Subscription>();
  /** The subscription each query and input has, with the components that follow it. */
  private readonly shared = new Map<string, SharedSubscription>();
  private readonly listeners = new Set<(connected: boolean) => void>();
  private hidden = false;

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
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
    this.listeners.forEach((l) => l(false));
  }

  /** Called when the socket connects or drops (the shell shows it). */
  onConnection(listener: (connected: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private connect(): WebSocket {
    if (this.socket) return this.socket;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(scheme + '//' + location.host + '/api/rpc');
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.listeners.forEach((l) => l(true));
      // Live queries carry on where they were (not while the tab is hidden).
      if (!this.hidden)
        for (const [id, s] of this.subscriptions) this.send({ t: 'subscribe', id, query: s.query, input: s.input });
      for (const text of this.queue.splice(0)) socket.send(text);
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
      this.listeners.forEach((l) => l(false));
      // A call cannot survive the socket (its questions were answered no on the server).
      for (const call of this.calls.values())
        call.reject(new Error('The connection to the sandbox web server dropped.'));
      this.calls.clear();
      // 4000 (a newer page took this one's place) and 4001 (signed out, access changed) are meant: no way back.
      if (event.code === 4000 || event.code === 4001) return;
      // Back again while the page is open, hidden or not (after sleep, or a server restarted by sandbox web open).
      const wait = WAITS_MS[Math.min(this.attempt++, WAITS_MS.length - 1)];
      window.setTimeout(() => this.connect(), wait);
    };
    return socket;
  }

  private send(message: object): void {
    const text = JSON.stringify(message);
    const socket = this.connect();
    if (socket.readyState === WebSocket.OPEN) socket.send(text);
    else this.queue.push(text);
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
        this.send({ t: 'answer', id: m.id, value });
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
  call(id: string, input: unknown, handlers: CallHandlers): Promise<unknown> {
    const callId = 'c' + this.next++;
    return new Promise((resolve, reject) => {
      this.calls.set(callId, { handlers, resolve, reject });
      this.send({ t: 'call', id: callId, op: id, input });
    });
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
