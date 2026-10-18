// One browser's RPC socket (/api/rpc): it calls the shared core's operations and queries by id, answers their
// questions, and subscribes to live queries. Every message is checked against the kernel's schemas (anything else
// closes the socket); only definitions the RpcHost allows on the web run; a bug's details never leave this PC.
import type { RawData, WebSocket } from 'ws';
import {
  ANSWER_SCHEMAS,
  ClientMessageSchema,
  MAX_OPEN_PER_SOCKET,
  ioFromAsker,
  toWireError,
  type Answer,
  type ClientMessage,
  type Question,
  type RpcHost,
  type ServerMessage,
} from '../../app/kernel/index.js';
import { LiveHub } from './live.js';

/** A call waiting for the browser's answer to its question. */
interface Waiting {
  readonly question: Question;
  readonly resolve: (answer: Answer) => void;
}

/** A live query this socket watches: the hub's stop function. */
type Subscription = () => void;

/** What a question gets when the browser goes away before answering: no. */
function declined(q: Question): Answer {
  return q.kind === 'confirm' ? false : undefined;
}

export class RpcSession {
  private readonly calls = new Map<string, Waiting | null>();
  private readonly subscriptions = new Map<string, Subscription>();
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly host: RpcHost,
    /** Shared by every socket of the server (one poll per query); a socket of its own by default. */
    private readonly live: LiveHub = new LiveHub(host),
  ) {}

  start(): void {
    this.ws.on('message', (data: RawData, binary: boolean) => this.receive(data, binary));
    this.ws.on('close', () => this.close());
    this.ws.on('error', () => this.close());
  }

  private send(message: ServerMessage): void {
    if (!this.closed && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message));
  }

  /** A browser that sends something that is not one of our messages is closed. */
  private refuse(): void {
    this.ws.close(1008, 'bad message');
    this.close();
  }

  private receive(data: RawData, binary: boolean): void {
    if (binary) return this.refuse();
    let value: unknown;
    try {
      value = JSON.parse(data.toString());
    } catch {
      return this.refuse();
    }
    const parsed = ClientMessageSchema.safeParse(value);
    if (!parsed.success) return this.refuse();
    this.handle(parsed.data);
  }

  private handle(m: ClientMessage): void {
    switch (m.t) {
      case 'call':
        return this.call(m.id, m.op, m.input);
      case 'answer':
        return this.answer(m.id, m.value);
      case 'subscribe':
        return this.subscribe(m.id, m.query, m.input);
      case 'unsubscribe':
        return this.unsubscribe(m.id);
    }
  }

  /** The id is free and the socket has room for one more call or subscription. */
  private admit(id: string): boolean {
    if (this.calls.has(id) || this.subscriptions.has(id)) {
      this.send({ t: 'error', id, error: { kind: 'invalid', message: 'That id is in use.' } });
      return false;
    }
    if (this.calls.size + this.subscriptions.size >= MAX_OPEN_PER_SOCKET) {
      this.send({ t: 'error', id, error: { kind: 'invalid', message: 'Too many at once.' } });
      return false;
    }
    return true;
  }

  private call(id: string, op: string, input: unknown): void {
    if (!this.admit(id)) return;
    if (!this.host.kind(op)) {
      this.send({ t: 'error', id, error: { kind: 'invalid', message: 'There is no ' + op + ' here.' } });
      return;
    }
    this.calls.set(id, null);
    const io = ioFromAsker(
      (question) =>
        new Promise((resolve) => {
          if (this.closed) return resolve(declined(question) as never);
          this.calls.set(id, { question, resolve: resolve as (answer: Answer) => void });
          this.send({ t: 'ask', id, question });
        }),
      {
        progress: (text) => this.send({ t: 'progress', id, text }),
        log: (text, tone) => this.send({ t: 'log', id, text, ...(tone ? { tone } : {}) }),
      },
    );
    this.host
      .run(op, input, io)
      .then(
        (output) => this.send({ t: 'result', id, output }),
        (e: unknown) => this.send({ t: 'error', id, error: toWireError(e) }),
      )
      .finally(() => {
        this.calls.delete(id);
        // An operation may have changed what the live queries show: they read again now.
        if (this.host.kind(op) === 'operation') this.live.poke();
      });
  }

  private answer(id: string, value: unknown): void {
    const waiting = this.calls.get(id);
    if (!waiting) return;
    const parsed = ANSWER_SCHEMAS[waiting.question.kind].safeParse(value);
    this.calls.set(id, null);
    waiting.resolve(parsed.success ? parsed.data : declined(waiting.question));
  }

  private subscribe(id: string, query: string, input: unknown): void {
    if (!this.admit(id)) return;
    if (this.host.kind(query) !== 'query') {
      this.send({ t: 'error', id, error: { kind: 'invalid', message: 'There is no ' + query + ' here.' } });
      return;
    }
    const stop: Subscription = this.live.watch(query, input, (event) => {
      if (this.subscriptions.get(id) !== stop) return;
      if ('output' in event) this.send({ t: 'data', id, output: event.output });
      else this.send({ t: 'error', id, error: toWireError(event.error) });
    });
    this.subscriptions.set(id, stop);
  }
  private unsubscribe(id: string): void {
    const stop = this.subscriptions.get(id);
    this.subscriptions.delete(id);
    stop?.();
  }

  /** The browser went away: subscriptions stop, and questions still open are answered no. */
  private close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.subscriptions.keys()]) this.unsubscribe(id);
    for (const waiting of this.calls.values()) waiting?.resolve(declined(waiting.question));
  }
}
