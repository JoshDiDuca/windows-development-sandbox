// The web feature's work: the server in the background (start, open) and stopping it, and whether it runs. The login
// token lives in the state file and in the address the browser opens; no output, log, progress line or error carries
// it. The server itself (`sandbox _web`) stays in cli/commands/web.ts.
import path from 'node:path';
import { packageVersion } from '../../../core/package-info.js';
import { fail, sleep } from '../../../core/util/index.js';
import { requireOnPc } from '../../../cli/commands/context.js';
import { spawnDetached } from '../../../host/sandbox/index.js';
import { openBrowser, WebControl, WebStore, type WebState } from '../../../host/web/index.js';
import type { OperationIO } from '../../kernel/index.js';
import { implement, type AppContext } from '../../context.js';
import { openWeb, startWeb, stopWeb, webStatus } from './web.def.js';

export const START_WAIT_MS = 15000;

function controlOf(ctx: AppContext): WebControl {
  return new WebControl(new WebStore(ctx.storageRoot));
}

/**
 * The running server when it is this version's. A server of another version (one left running across an update) is
 * stopped, so the page and the server always match; a state file without a server is removed.
 */
export async function currentServer(control: WebControl): Promise<WebState | null> {
  const before = await control.status();
  if (before.running && before.state && before.state.version === packageVersion()) return before.state;
  if (before.running && before.state) {
    await control.stop(before.state);
    for (const started = Date.now(); Date.now() - started < START_WAIT_MS; await sleep(300))
      if (!(await control.status()).running) break;
  }
  if (before.state) control.clear();
  return null;
}

interface Started {
  readonly port: number;
  readonly message: string;
  /** It was already running (the message is then the only thing to say). */
  readonly wasRunning: boolean;
}

/** Starts the background server (when it is not running) and waits until it answers. */
async function startServer(ctx: AppContext, io: OperationIO, control: WebControl): Promise<Started> {
  const running = await currentServer(control);
  if (running)
    return {
      port: running.port,
      message: 'The web UI is already running on port ' + running.port + '.',
      wasRunning: true,
    };
  const { config } = ctx.loaded;
  if (!config.web.enabled)
    io.log('web.enabled is off: this starts the web UI for now only. Set it to true in Settings to keep it allowed.');
  io.progress('Starting the web UI');
  const configFile = ctx.options.config;
  spawnDetached(ctx.entry, ['_web', ...(configFile ? ['--config', path.resolve(configFile)] : [])]);
  for (const started = Date.now(); Date.now() - started < START_WAIT_MS; await sleep(300)) {
    const now = await control.status();
    if (now.running && now.state) {
      io.log('The web UI is running at http://127.0.0.1:' + now.state.port + '/ (this PC only).');
      return { port: now.state.port, message: 'Open it already signed in with: sandbox web open', wasRunning: false };
    }
  }
  return fail(
    'The web UI did not start.',
    'Run sandbox _web to see why (the port ' + config.web.port + ' may be taken: change web.port).',
  );
}

/** Whether the web UI runs, and its address without the token. Never returns the state (it holds the token). */
export const webStatusRun = implement(webStatus, async (ctx) => {
  requireOnPc('web');
  const { running, state } = await controlOf(ctx).status();
  const port = running && state ? state.port : null;
  return { running, port, address: port ? 'http://127.0.0.1:' + port + '/' : null };
});

export const startWebRun = implement(startWeb, async (ctx, _input, io) => {
  requireOnPc('web');
  const started = await startServer(ctx, io, controlOf(ctx));
  return { port: started.port, message: started.message };
});

export const openWebRun = implement(openWeb, async (ctx, _input, io) => {
  requireOnPc('web');
  const control = controlOf(ctx);
  const started = await startServer(ctx, io, control);
  if (started.wasRunning) io.log(started.message);
  const { state } = await control.status();
  if (!state) return fail('The web UI stopped right away.', 'Run sandbox web start again.');
  openBrowser(control.url(state));
  return { message: 'Opened in your browser.' };
});

export const stopWebRun = implement(stopWeb, async (ctx) => {
  requireOnPc('web');
  const control = controlOf(ctx);
  const { running, state } = await control.status();
  if (!state) return { stopped: false, message: 'The web UI is not running.' };
  if (!running || (await control.stop(state))) control.clear();
  else return fail('The web UI did not stop.', 'End the process ' + state.pid + ' in Task Manager.');
  return { stopped: true, message: 'The web UI stopped.' };
});
