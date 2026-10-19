// `sandbox remote`'s line to the owner's web UI (docs/design/remote-access.md): signs in with the one-time token of
// Windows sign-in, then runs the shared core's queries and operations over the RPC socket, as the browser does. What
// the owner's server sends is checked against the kernel's schemas (anything else is dropped) and every text is shown
// through safeText by the menu. The owner's server checks the role of every call.
import http from 'node:http';
import { WebSocket, type RawData } from 'ws';
import {
  fromWireError,
  ServerMessageSchema,
  type Answer,
  type OperationIO,
  type Question,
  type ServerMessage,
} from '../../app/kernel/index.js';
import { fail } from '../../core/util/index.js';
import { CSRF_HEADER, CSRF_VALUE } from '../../shared/web/index.js';

interface Pending {
  readonly io: OperationIO;
  readonly resolve: (output: unknown) => void;
  readonly reject: (e: Error) => void;
}

const CONNECT_TIMEOUT_MS = 10_000;

/** Asks an OperationIO a question that came over the socket. */
function askIO(io: OperationIO, q: Question): Promise<Answer> {
  switch (q.kind) {
    case 'confirm':
      return io.confirm(q);
    case 'choose':
      return io.choose(q);
    case 'checklist':
      return io.checklist(q);
    case 'text':
      return io.text(q);
    case 'secret':
      return io.secret(q);
    case 'path':
      return io.path(q);
  }
}

export class RemoteClient {
  private readonly pending = new Map<string, Pending>();
  private next = 1;

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: RawData, binary: boolean) => {
      if (binary) return;
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        return;
      }
      const parsed = ServerMessageSchema.safeParse(value);
      if (parsed.success) this.receive(parsed.data);
    });
    socket.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('The connection to the web UI closed.'));
      this.pending.clear();
    });
  }

  /** Trades the one-time token for a sign-in cookie, then opens the RPC socket. */
  static async connect(port: number, token: string): Promise<RemoteClient> {
    const origin = 'http://127.0.0.1:' + port;
    const cookie = await new Promise<string>((resolve, reject) => {
      const body = JSON.stringify({ token });
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/login/once',
          timeout: CONNECT_TIMEOUT_MS,
          headers: {
            Origin: origin,
            [CSRF_HEADER]: CSRF_VALUE,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          const value = (res.headers['set-cookie'] ?? [])[0]?.split(';')[0];
          if (res.statusCode === 200 && value) resolve(value);
          else reject(new Error('The web UI did not sign you in (' + res.statusCode + ').'));
        },
      );
      req.on('timeout', () => req.destroy(new Error('The web UI did not answer.')));
      req.on('error', reject);
      req.end(body);
    });
    const socket = new WebSocket('ws://127.0.0.1:' + port + '/api/rpc', {
      headers: { Cookie: cookie, Origin: origin },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
      socket.once('unexpected-response', (_req, res) => reject(new Error('Refused (' + res.statusCode + ').')));
    });
    return new RemoteClient(socket);
  }

  private receive(m: ServerMessage): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    switch (m.t) {
      case 'progress':
        return p.io.progress(m.text);
      case 'log':
        return p.io.log(m.text, m.tone);
      case 'ask':
        void askIO(p.io, m.question).then(
          (value) => this.send({ t: 'answer', id: m.id, value }),
          () => this.send({ t: 'answer', id: m.id, value: m.question.kind === 'confirm' ? false : undefined }),
        );
        return;
      case 'result':
      case 'data':
        this.pending.delete(m.id);
        return p.resolve(m.output);
      case 'error':
        this.pending.delete(m.id);
        return p.reject(fromWireError(m.error));
    }
  }

  private send(message: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  /** Runs a definition on the owner's side (a query or an operation) and returns its output. */
  run(id: string, input: unknown, io: OperationIO): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected to the web UI.'));
    const callId = 'c' + this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(callId, { io, resolve, reject });
      this.send({ t: 'call', id: callId, op: id, input: input ?? {} });
    });
  }

  close(): void {
    this.socket.close(1000);
  }
}

/** Connects, or fails with the reason and what to do. */
export async function remoteClient(port: number, token: string): Promise<RemoteClient> {
  try {
    return await RemoteClient.connect(port, token);
  } catch (e) {
    return fail(
      'Could not reach the web UI on port ' + port + ': ' + (e instanceof Error ? e.message : String(e)),
      'Ask its owner to start it (sandbox web start), then try again.',
    );
  }
}
