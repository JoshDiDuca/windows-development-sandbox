// Remote access's work (docs/design/remote-access.md): the access list in <storage>\web\access.json (shared with the
// running web server, which reads it again when it changes and closes the pages of whoever was signed out), the
// remote settings, the firewall rule and the network check of LAN mode. The one-time code is returned once and only
// its hash is kept.
import { requireOnPc } from '../../../cli/commands/context.js';
import { fail } from '../../../core/util/index.js';
import {
  AccessStore,
  addRuleRequest,
  applyFirewall,
  chooseLanAddress,
  lanUrl,
  networkProblem,
  networkProfile,
  removeRuleRequest,
  showCode,
} from '../../../host/remote/index.js';
import { SecretStore } from '../../../host/secrets/index.js';
import { protectPrivateFolder } from '../../../host/sharing/index.js';
import { selfTestRunning } from '../../../host/test-guard.js';
import { WebStore } from '../../../host/web/index.js';
import { implement, type AppContext } from '../../context.js';
import { ConfigFile } from '../settings/index.js';
import { accessStatus, allowDevice, lanOff, lanOn, revokeAccess, revokeAllAccess } from './access.def.js';

/** The access list of this user (the folder is the web state's private one). */
export function accessStoreOf(ctx: AppContext): AccessStore {
  return AccessStore.at(ctx.storageRoot, SecretStore.standard(), {
    // The self-test never changes folder permissions; its storage is a temp folder.
    protect: selfTestRunning() ? undefined : (dir) => protectPrivateFolder(dir),
  });
}

function lanStateOf(ctx: AppContext): { url: string | null; fingerprint: string | null; problem: string | null } {
  const lan = new WebStore(ctx.storageRoot).read()?.lan;
  return { url: lan?.url ?? null, fingerprint: lan?.fingerprint ?? null, problem: lan?.problem ?? null };
}

function setLan(ctx: AppContext, enabled: boolean): void {
  const outcome = ConfigFile.user(ctx.loaded.configPath).set(['web', 'remote', 'lan', 'enabled'], enabled);
  if (typeof outcome === 'object') fail('Could not change web.remote.lan.enabled: ' + outcome.problems.join('; '));
}

export const accessStatusRun = implement(accessStatus, (ctx) => {
  requireOnPc('web');
  const remote = ctx.loaded.config.web.remote;
  const data = accessStoreOf(ctx).read();
  const now = Date.now();
  const alive = (iso: string): boolean => Date.parse(iso) > now;
  const lan = lanStateOf(ctx);
  return {
    lan: {
      enabled: remote.lan.enabled,
      running: remote.lan.enabled && lan.url !== null,
      address: remote.lan.enabled ? lan.url : null,
      fingerprint: remote.lan.enabled ? lan.fingerprint : null,
      problem: remote.lan.enabled ? lan.problem : null,
      network: data.network,
    },
    windowsSignIn: remote.windowsSignIn,
    users: remote.users.map((u) => ({ name: u.name, role: u.role })),
    rememberDays: remote.rememberDays,
    devices: data.devices
      .filter((d) => alive(d.expiresAt))
      .map((d) => ({
        id: d.id,
        name: d.name,
        role: d.role,
        address: d.address,
        createdAt: d.createdAt,
        expiresAt: d.expiresAt,
        lastSeen: d.lastSeen ?? null,
      })),
    windows: data.windows
      .filter((w) => alive(w.expiresAt))
      .map((w) => ({ id: w.id, user: w.user, createdAt: w.createdAt, expiresAt: w.expiresAt })),
    pending: data.code && alive(data.code.expiresAt) ? { role: data.code.role, expiresAt: data.code.expiresAt } : null,
    codeVoided: data.codeVoided,
  };
});

export const allowDeviceRun = implement(allowDevice, (ctx, input) => {
  requireOnPc('web');
  if (!ctx.loaded.config.web.remote.lan.enabled)
    fail('LAN mode is off, so no device on your network can reach the web UI.', 'Turn it on first: sandbox web lan-on');
  const { code, expiresAt } = accessStoreOf(ctx).newDeviceCode(input.role);
  const lan = lanStateOf(ctx);
  return { code: showCode(code), expiresAt, role: input.role, address: lan.url, fingerprint: lan.fingerprint };
});

export const revokeAccessRun = implement(revokeAccess, (ctx, input) => {
  requireOnPc('web');
  if (!accessStoreOf(ctx).revoke(input.id)) fail('There is no device or sign-in ' + input.id + '.', 'See sandbox web devices.');
  return { message: 'Signed out. Its open pages close within half a minute.' };
});

export const revokeAllAccessRun = implement(revokeAllAccess, async (ctx, _input, io) => {
  requireOnPc('web');
  const ok = (await io.confirm({ title: 'Sign out every device and Windows user now?', danger: true, yes: 'Sign out all' }));
  if (!ok) return { message: 'Nothing changed.' };
  accessStoreOf(ctx).revokeAll('everything');
  return { message: 'Everyone is signed out, and a code not used yet is void.' };
});

export const lanOnRun = implement(lanOn, async (ctx, _input, io) => {
  requireOnPc('web');
  const lan = ctx.loaded.config.web.remote.lan;
  const bound = chooseLanAddress(lan.address);
  io.progress('Checking the network');
  const profile = await networkProfile(bound.address);
  const problem = networkProblem(profile, null);
  if (problem)
    fail(problem, 'LAN mode only runs on a network you marked Private (Windows Settings > Network > your network).');
  io.progress('Adding the firewall rule (Windows asks for permission)');
  await applyFirewall(addRuleRequest(lan.port, bound.address));
  accessStoreOf(ctx).setNetwork(profile.name);
  setLan(ctx, true);
  const address = lanUrl(bound.address, lan.port);
  return {
    address,
    message:
      'LAN mode is on for the network "' +
      profile.name +
      '": devices open ' +
      address +
      ' (the running web UI starts listening within half a minute). Next: Allow a new device.',
  };
});

export const lanOffRun = implement(lanOff, async (ctx, _input, io) => {
  requireOnPc('web');
  const ok = (await io.confirm({ title: 'Turn off LAN mode and sign out every device?', danger: true, yes: 'Turn off' }));
  if (!ok) return { message: 'Nothing changed.' };
  setLan(ctx, false);
  const store = accessStoreOf(ctx);
  store.revokeAll('devices');
  store.setNetwork(null);
  io.progress('Removing the firewall rule (Windows asks for permission)');
  await applyFirewall(removeRuleRequest());
  return { message: 'LAN mode is off: the firewall rule is gone and every device is signed out.' };
});
