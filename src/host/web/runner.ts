// The background process behind `sandbox web start`: starts the server, records pid, port and token in the private
// state file, and removes it again when the server stops.
import type { RpcHost } from '../../app/kernel/index.js';
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
}

export class WebRunner {
  private readonly store: WebStore;

  constructor(private readonly options: WebRunOptions) {
    this.store = new WebStore(options.storageRoot);
  }

  /** Runs until stopped (from the browser, the CLI, or a signal). */
  async run(): Promise<void> {
    const token = newToken();
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    const server = new WebServer({
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
