// The background process behind `sandbox web start`: starts the server, records pid, port and token in the private
// state file, and removes it again when the server stops.
import type { RpcHost } from '../../app/kernel/index.js';
import type { RemoteGate } from '../remote/index.js';
import { fail } from '../../core/util/index.js';
import { keepTasklistFresh } from '../sandbox/index.js';
import type { WebBackend } from './backend.js';
import { newToken } from './auth.js';
import { WebServer } from './server.js';
import { WebStore } from './state.js';

export interface WebRunOptions {
  readonly storageRoot: string;
  readonly port: number;
  readonly backend: WebBackend;
  readonly rpc?: RpcHost;
  readonly staticRoot: string;
  /** This program's version, kept in the state file. */
  readonly version: string;
  /** End after this long with no browser (sooner with no sandbox): WebServerOptions.idleExitMs. */
  readonly idleExitMs?: number;
  /** Other Windows users and devices (docs/design/remote-access.md); none: the owner only. */
  readonly gate?: RemoteGate;
}

export class WebRunner {
  private readonly store: WebStore;

  constructor(private readonly options: WebRunOptions) {
    this.store = new WebStore(options.storageRoot);
  }

  private lanOf(gate: RemoteGate): { url: string | null; fingerprint: string | null; problem: string | null } {
    const lan = gate.lanState();
    return { url: lan.url, fingerprint: lan.fingerprint, problem: lan.problem };
  }

  /** Runs until stopped (from the browser, the CLI, or a signal). */
  async run(): Promise<void> {
    const token = newToken();
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    const gate = this.options.gate;
    const server = new WebServer({
      gate,
      port: this.options.port,
      token,
      backend: this.options.backend,
      rpc: this.options.rpc,
      staticRoot: this.options.staticRoot,
      idleExitMs: this.options.idleExitMs,
      onStop: stop,
    });
    try {
      await server.start();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE')
        fail(
          'Port ' + this.options.port + ' is taken by another program.',
          'Pick another with the web.port setting, then run sandbox web start again.',
        );
      throw e;
    }
    this.store.write({
      pid: process.pid,
      port: server.port,
      token,
      startedAt: new Date().toISOString(),
      version: this.options.version,
      ...(gate ? { lan: this.lanOf(gate) } : {}),
    });
    gate?.onLanChange(() => {
      const now = this.store.read();
      if (now && now.pid === process.pid) this.store.write({ ...now, lan: this.lanOf(gate) });
    });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    // Every browser's status reads share one process list instead of each running tasklist.
    const stopTasklist = keepTasklistFresh();
    try {
      await stopped;
    } finally {
      stopTasklist();
      this.store.clear();
      await server.stop();
    }
  }
}
