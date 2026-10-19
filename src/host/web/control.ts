// Talking to a running web server from the CLI: is it up, its address (with the token fragment), and stopping it. The
// state file says where it is and holds the token, so only you (and SYSTEM / Administrators) can do any of this.
import crypto from 'node:crypto';
import http from 'node:http';
import { CSRF_HEADER, CSRF_VALUE } from '../../shared/web/index.js';
import type { WebStore, WebState } from './state.js';

export interface WebStatus {
  readonly running: boolean;
  readonly state: WebState | null;
}

function request(
  state: WebState,
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<http.IncomingMessage & { text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: state.port,
        method,
        path,
        timeout: 3000,
        headers: {
          Origin: 'http://127.0.0.1:' + state.port,
          [CSRF_HEADER]: CSRF_VALUE,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (text.length < 4096) text += chunk;
        });
        res.on('end', () => resolve(Object.assign(res, { text })));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

export class WebControl {
  constructor(private readonly store: WebStore) {}

  /**
   * Running means the state file exists and its port answers as OUR server: it proves it holds the token (an HMAC of
   * a fresh challenge), so the token link is never handed to another program that took the port.
   */
  async status(): Promise<WebStatus> {
    const state = this.store.read();
    if (!state) return { running: false, state: null };
    try {
      const challenge = crypto.randomBytes(16).toString('hex');
      const res = await request(state, 'GET', '/api/health?challenge=' + challenge);
      const expected = crypto.createHmac('sha256', state.token).update(challenge).digest('hex');
      const proof = (safeJson(res.text) as { proof?: unknown } | null)?.proof;
      const proven =
        typeof proof === 'string' &&
        proof.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
      return { running: res.statusCode === 200 && proven, state };
    } catch {
      return { running: false, state };
    }
  }

  /** http://127.0.0.1:<port>/#k=<token>: the fragment never goes to the server. */
  url(state: WebState): string {
    return 'http://127.0.0.1:' + state.port + '/#k=' + state.token;
  }

  /** Signs in with the token and asks the server to stop. False when it does not answer. */
  async stop(state: WebState): Promise<boolean> {
    try {
      const login = await request(state, 'POST', '/api/login', { token: state.token });
      const cookie = (login.headers['set-cookie'] ?? [])[0]?.split(';')[0];
      if (login.statusCode !== 200 || !cookie) return false;
      return (await request(state, 'POST', '/api/stop', {}, cookie)).statusCode === 200;
    } catch {
      return false;
    }
  }

  /** The state file of a server that is gone. */
  clear(): void {
    this.store.clear();
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
