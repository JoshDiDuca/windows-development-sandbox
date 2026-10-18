// `sandbox vpn [status|login|logout]`: the VPN login (kept encrypted on this PC, never printed) and what the VPN is
// doing.
import { askSecret } from '../../core/prompt.js';
import { fail } from '../../core/util/index.js';
import { c, nextStep, printJson, table } from '../output/index.js';
import { NORD_STEPS, VpnService } from '../services/vpn-service.js';
import { requireOnPc, type Context } from './context.js';

const LOGIN_TEXT = {
  none: c.yellow('not saved'),
  saved: c.green('saved (encrypted)'),
  unreadable: c.red('cannot be read'),
};

/** The warnings every VPN user must see. */
export const VPN_WARNINGS: readonly string[] = [
  'The VPN is an alpha: not yet tried on a real PC (docs/vpn.md lists what still needs checking).',
  'The agent in the sandbox can read the VPN login (a service login you can revoke) and can turn the tunnel off, because it is the administrator there.',
  'Free VPNs see all your traffic: use one you trust.',
];

async function status(ctx: Context): Promise<number> {
  const report = await new VpnService(ctx).report();
  if (printJson(ctx, report)) return 0;
  table([
    ['VPN', report.enabled ? c.green('on') : 'off  (turn on: sandbox config set vpn.enabled true)'],
    [
      'Provider',
      report.provider === 'nordvpn'
        ? 'NordVPN'
        : report.provider === 'wireguard-file'
          ? 'your own WireGuard .conf'
          : 'your own .ovpn file',
    ],
    ['Protocol', report.protocol],
    ['Country', report.country || 'best available'],
    ['Kill switch', report.killSwitch ? 'on (no internet if the tunnel fails)' : c.yellow('off')],
    [
      'Login',
      report.provider === 'wireguard-file'
        ? c.dim('not needed (the keys are in your config)')
        : LOGIN_TEXT[report.login] + (report.loginSavedAt ? c.dim('  ' + report.loginSavedAt.slice(0, 10)) : ''),
    ],
    ...(report.running ? [['Running now', report.running.text]] : []),
  ]);
  if (report.provider !== 'wireguard-file' && report.login === 'none') nextStep('sandbox vpn login');
  if (report.login === 'unreadable')
    console.log(c.dim('Only the Windows user that saved it can read it. Save it again: sandbox vpn login'));
  for (const w of VPN_WARNINGS) console.log(c.dim(w));
  return 0;
}

async function login(ctx: Context): Promise<number> {
  requireOnPc('vpn login');
  const service = new VpnService(ctx);
  if (service.provider === 'wireguard-file') {
    console.log('A WireGuard config needs no login: the keys are in the file vpn.configFile points to.');
    return 0;
  }
  const nord = service.provider === 'nordvpn';
  console.log(
    nord
      ? 'NordVPN needs its service credentials, not your usual login. To get them:'
      : 'Type the user name and password your VPN profile asks for.',
  );
  if (nord) NORD_STEPS.forEach((s, i) => console.log('  ' + (i + 1) + '. ' + s));
  console.log(c.dim('What you type is not shown. It is kept encrypted for your Windows user and never printed.\n'));
  const fix = 'Run sandbox vpn login in a terminal.';
  const username = await askSecret(nord ? 'Service user name' : 'User name', fix);
  const password = await askSecret(nord ? 'Service password' : 'Password', fix);
  service.save({ username, password });
  console.log(c.green('Saved.') + ' Turn the VPN on with: sandbox config set vpn.enabled true');
  for (const w of VPN_WARNINGS) console.log(c.dim(w));
  return 0;
}

function logout(ctx: Context): number {
  requireOnPc('vpn logout');
  console.log(new VpnService(ctx).remove() ? 'The saved VPN login is deleted.' : 'No VPN login was saved.');
  return 0;
}

export function vpn(ctx: Context): Promise<number> | number {
  const action = ctx.options.positionals[0] ?? 'status';
  switch (action) {
    case 'status':
      return status(ctx);
    case 'login':
      return login(ctx);
    case 'logout':
      return logout(ctx);
    default:
      return fail('Unknown VPN action "' + action + '".', 'Use: sandbox vpn status | login | logout');
  }
}
