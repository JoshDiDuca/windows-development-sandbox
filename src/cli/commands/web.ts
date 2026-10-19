// `sandbox web` (the actions run as definitions in src/app/features/web) and the hidden `sandbox _web`, which is the
// server process itself. The web UI's server runs in the background (as `_web`, like the sync watcher) and keeps
// running when no sandbox does. startWebOnLaunch is the sandbox start's hook.
import fs from 'node:fs';
import path from 'node:path';
import { accessStoreOf } from '../../app/features/access/index.js';
import { currentServer, START_WAIT_MS, webStatus } from '../../app/features/web/index.js';
import { createRpcHost } from '../../app/registry.js';
import { loadConfig } from '../../core/config/index.js';
import { packageVersion } from '../../core/package-info.js';
import type { WebRemote } from '../../core/schema/web.js';
import { sleep, fail } from '../../core/util/index.js';
import { AuditLog } from '../../host/audit/index.js';
import {
  doorPipeName,
  HostToolsHelper,
  networkProfile,
  RemoteGate,
  TlsStore,
  type RemoteAuditEntry,
} from '../../host/remote/index.js';
import { SecretStore } from '../../host/secrets/index.js';
import { currentUserSid } from '../../host/sharing/index.js';
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

/** The remote settings as in the file now (read again at most every 3 seconds; a broken file keeps the last). */
function remoteSettings(ctx: Context): () => WebRemote {
  let last = ctx.loaded.config.web.remote;
  let readAt = Date.now();
  return () => {
    if (Date.now() - readAt < 3000) return last;
    readAt = Date.now();
    try {
      last = loadConfig(ctx.options.config).config.web.remote;
    } catch {
      // A settings file being edited or broken: keep what was read last.
    }
    return last;
  };
}

/** Remote actions go to the audit log of this data set (k: remote), so the Activity page shows who did what. */
function remoteAudit(ctx: Context): (entry: RemoteAuditEntry) => void {
  const { days, maxMb } = ctx.loaded.config.audit;
  const log = new AuditLog(AuditLog.dirFor(ctx.storageRoot, ctx.dataPath), { days, maxMb });
  return (entry) => {
    try {
      log.append([{ t: new Date().toISOString(), k: 'remote', p: entry.what, a: entry.outcome, au: entry.who }]);
    } catch {
      // The audit log is a record, never a reason for a request to fail.
    }
  };
}

/**
 * The gate for other Windows users and devices (docs/design/remote-access.md). The Windows helper is started when it
 * can be built here: then the owner's own cookie is bound to the owner's connections too, and the sign-in pipe is
 * served (it refuses everyone while web.remote.windowsSignIn is off).
 */
function remoteGate(ctx: Context): RemoteGate {
  const secrets = SecretStore.standard();
  let ownerSid = '';
  try {
    ownerSid = currentUserSid();
  } catch {
    // Unknown: Windows sign-in stays off, the owner signs in with the token as before.
  }
  const helper = ownerSid ? HostToolsHelper.start(ctx.storageRoot, doorPipeName(ownerSid)) : null;
  const audit = remoteAudit(ctx);
  helper?.onProblem((text) => audit({ who: 'the web UI', what: 'Windows sign-in: ' + text, outcome: 'failed' }));
  const store = new WebStore(ctx.storageRoot);
  return new RemoteGate({
    store: accessStoreOf(ctx),
    settings: remoteSettings(ctx),
    ownerSid,
    helper,
    audit,
    tls: new TlsStore(store.dir, secrets),
    profile: (address) => networkProfile(address),
    port: () => ctx.loaded.config.web.port,
  });
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
    gate: remoteGate(ctx),
  }).run();
  process.exit(0);
}
