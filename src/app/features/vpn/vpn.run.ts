// The VPN feature's work: its status (no request to the network when asked not to), saving the login through io.secret
// (the answers are kept only for the save, never returned, logged or shown), and deleting it after a confirmation.
import { requireOnPc } from '../../../cli/commands/context.js';
import { VpnService } from '../../../cli/services/vpn-service.js';
import { implement } from '../../context.js';
import { cancelled } from '../../kernel/index.js';
import { NORD_STEPS, VPN_WARNINGS, vpnLogin, vpnLogout, vpnStatus } from './vpn.def.js';

export const vpnStatusRun = implement(vpnStatus, async (ctx, input) =>
  new VpnService(ctx).report({ tunnel: input.tunnel }),
);

export const vpnLoginRun = implement(vpnLogin, async (ctx, _input, io) => {
  requireOnPc('vpn login');
  const service = new VpnService(ctx);
  if (service.provider === 'wireguard-file')
    return { message: 'A WireGuard config needs no login: the keys are in the file vpn.configFile points to.' };
  const nord = service.provider === 'nordvpn';
  io.log(
    nord
      ? 'NordVPN needs its service credentials, not your usual login. To get them:'
      : 'Type the user name and password your VPN profile asks for.',
  );
  if (nord) NORD_STEPS.forEach((s, i) => io.log('  ' + (i + 1) + '. ' + s));
  io.log('What you type is not shown. It is kept encrypted for your Windows user and never printed.', 'muted');
  // The validators return fixed texts only: what was typed is never echoed back.
  const username = await io.secret({
    title: nord ? 'Service user name' : 'User name',
    validate: (v) => (v.trim() ? true : 'Type the user name.'),
  });
  if (username === undefined) cancelled();
  const password = await io.secret({
    title: nord ? 'Service password' : 'Password',
    validate: (v) => (v ? true : 'Type the password.'),
  });
  if (password === undefined) cancelled();
  service.save({ username, password });
  VPN_WARNINGS.forEach((w) => io.log(w, 'muted'));
  return { message: 'Saved. Turn the VPN on with: sandbox config set vpn.enabled true' };
});

export const vpnLogoutRun = implement(vpnLogout, async (ctx, _input, io) => {
  requireOnPc('vpn logout');
  const service = new VpnService(ctx);
  if (service.loginState() === 'none') return { deleted: false, message: 'No VPN login was saved.' };
  // The CLI never asked before (a typed logout is the answer); the menu and the web still ask.
  const yes = await io.confirm({
    title: 'Delete the saved VPN login?',
    yes: 'Delete',
    danger: true,
    implied: true,
  });
  if (!yes) cancelled();
  service.remove();
  return { deleted: true, message: 'The saved VPN login is deleted.' };
});
