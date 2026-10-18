// `sandbox web` (the actions run as definitions in src/app/features/web) and the hidden `sandbox _web`, which is the
// server process itself. The web UI's server runs in the background (as `_web`, like the sync watcher) and keeps
// running when no sandbox does. startWebOnLaunch is the sandbox start's hook.
import fs from 'node:fs';
import path from 'node:path';
import { currentServer, START_WAIT_MS, webStatus } from '../../app/features/web/index.js';
import { createRpcHost } from '../../app/registry.js';
import { packageVersion } from '../../core/package-info.js';
import { sleep, fail } from '../../core/util/index.js';
import { IDLE_EXIT_MS, openBrowser, WebControl, WebRunner, WebStore } from '../../host/web/index.js';
import { spawnDetached } from '../../host/sandbox/index.js';
import { WebService } from '../services/index.js';
import { definitionHandler } from '../operations/index.js';
import type { Context } from './context.js';

function controlOf(ctx: Context): WebControl {
  return new WebControl(new WebStore(ctx.storageRoot));
}

/**
 * At a sandbox start, with web.enabled: the web UI is started in the background when it is not running, and with
 * web.openOnLaunch opened in the browser, signed in. Never stops the launch: a problem is one line.
 */
export async function startWebOnLaunch(ctx: Context): Promise<void> {
  const { web: settings } = ctx.loaded.config;
  if (!settings.enabled) return;
  try {
    const control = controlOf(ctx);
    let state = await currentServer(control);
    if (!state) {
      const configFile = ctx.options.config;
      spawnDetached(ctx.entry, ['_web', ...(configFile ? ['--config', path.resolve(configFile)] : [])]);
      for (const started = Date.now(); !state && Date.now() - started < START_WAIT_MS; await sleep(300)) {
        const now = await control.status();
        if (now.running && now.state) state = now.state;
      }
    }
    if (!state) {
      console.log(
        'The web UI did not start (port ' + settings.port + ' may be taken: change web.port). Try: sandbox web start',
      );
      return;
    }
    if (settings.openOnLaunch) {
      openBrowser(control.url(state));
      console.log('The web UI is open in your browser (http://127.0.0.1:' + state.port + '/).');
    } else
      console.log('The web UI is at http://127.0.0.1:' + state.port + '/ (open it signed in with: sandbox web open).');
  } catch (e) {
    console.log('The web UI could not be started: ' + (e instanceof Error ? e.message : String(e)));
  }
}

/** `sandbox web` with no action is `sandbox web status` (the actions run as definitions). */
export async function web(ctx: Context): Promise<number> {
  return (await definitionHandler(webStatus)(ctx)) ?? 0;
}

/** Body of the background process (`sandbox _web`): runs until stopped. */
export async function webServer(ctx: Context): Promise<void> {
  const staticRoot = path.join(ctx.packageRoot, 'dist', 'web');
  if (!fs.existsSync(path.join(staticRoot, 'index.html')))
    fail('The web app is not built (' + staticRoot + ').', 'Run npm run build in the install folder.');
  await new WebRunner({
    storageRoot: ctx.storageRoot,
    port: ctx.loaded.config.web.port,
    backend: new WebService(ctx),
    rpc: createRpcHost(ctx),
    staticRoot,
    version: packageVersion(),
    idleExitMs: IDLE_EXIT_MS,
  }).run();
  process.exit(0);
}
