// The VPN: its settings, whether a login is saved (never its values), the running tunnel, and saving or deleting the
// login. Pure: schemas, labels and the view; vpn.run.ts does the work. The login itself is never an input or an output.
import { z } from 'zod';
import {
  action,
  defineOperation,
  defineQuery,
  defineView,
  type Fact,
  type Note,
  type Page,
  type Section,
} from '../../kernel/index.js';
import { setSetting } from '../settings/settings.def.js';

const ProviderSchema = z
  .enum(['nordvpn', 'openvpn-file', 'wireguard-file'])
  .describe('Which VPN (setting vpn.provider)');
const LoginStateSchema = z
  .enum(['none', 'saved', 'unreadable'])
  .describe('Whether a login is saved and can be opened by you');

/** The warnings every VPN user must see (alpha): on every surface. */
export const VPN_WARNINGS: readonly string[] = [
  'The VPN is an alpha: a tunnel carrying traffic is not confirmed yet (docs/vpn.md lists what still needs checking).',
  'The agent in the sandbox can read the VPN login (a service login you can revoke) and can turn the tunnel off, because it is the administrator there.',
  'Free VPNs see all your traffic: use one you trust.',
];

/** The steps to get the NordVPN service credentials, in the words of Nord Account (shown before asking). */
export const NORD_STEPS: readonly string[] = [
  'Sign in at https://my.nordaccount.com with your usual NordVPN e-mail and password.',
  'Open NordVPN, then "Set up NordVPN manually" (under Advanced settings).',
  'Verify your e-mail if it asks, then copy the "Service credentials": a user name and a password.',
  'These are NOT your account password. You can revoke them in the same place whenever you like.',
];

export const VpnStatusSchema = z.object({
  enabled: z.boolean().describe('The VPN is on (setting vpn.enabled)'),
  provider: ProviderSchema,
  protocol: z.enum(['udp', 'tcp']).describe('udp or tcp (setting vpn.protocol)'),
  country: z.string().describe('The NordVPN country; empty = the best server anywhere'),
  killSwitch: z.boolean().describe('No internet when the tunnel fails (setting vpn.killSwitch)'),
  login: LoginStateSchema,
  loginSavedAt: z.string().nullable().describe('When the login was saved (the date and time, never the login)'),
  running: z
    .object({
      level: z.enum(['ok', 'warn', 'bad']).describe('How the tunnel is doing'),
      text: z.string().describe('What the sandbox reported'),
    })
    .nullable()
    .describe("The running sandbox's tunnel, when one runs with the VPN on"),
});
export type VpnStatus = z.output<typeof VpnStatusSchema>;

export const vpnStatus = defineQuery({
  id: 'vpn.status',
  title: 'VPN',
  summary: 'the VPN settings, whether a login is saved, and the running tunnel',
  input: z.object({
    tunnel: z
      .boolean()
      .default(true)
      .describe('also ask the running sandbox how its tunnel is doing (one request to api.ipify.org)'),
  }),
  output: VpnStatusSchema,
  cli: { name: 'vpn', action: 'status', json: true },
});

export const vpnLogin = defineOperation({
  id: 'vpn.login',
  title: 'Save the VPN login…',
  summary: 'save the VPN login (typed hidden, kept encrypted, never printed)',
  input: z.object({}).strict(),
  output: z.object({ message: z.string().describe('What happened') }),
  text: (o) => o.message,
  cli: { name: 'vpn', action: 'login' },
});

export const vpnLogout = defineOperation({
  id: 'vpn.logout',
  title: 'Delete the VPN login',
  summary: 'delete the saved VPN login',
  input: z.object({}).strict(),
  output: z.object({
    deleted: z.boolean().describe('A login was saved and is gone'),
    message: z.string().describe('What happened'),
  }),
  danger: true,
  text: (o) => o.message,
  cli: { name: 'vpn', action: 'logout' },
});

const PROVIDER_TEXT: Readonly<Record<VpnStatus['provider'], string>> = {
  nordvpn: 'NordVPN',
  'wireguard-file': 'your own WireGuard .conf',
  'openvpn-file': 'your own .ovpn file',
};

const LOGIN_TEXT: Readonly<Record<VpnStatus['login'], string>> = {
  none: 'not saved',
  saved: 'saved (encrypted)',
  unreadable: 'cannot be read',
};

const LOGIN_TONE: Readonly<Record<VpnStatus['login'], Fact['tone']>> = {
  none: 'warn',
  saved: 'ok',
  unreadable: 'danger',
};

const RUNNING_TONE: Readonly<Record<'ok' | 'warn' | 'bad', Fact['tone']>> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'danger',
};

/** The Settings row of the menu (label, hint, description), from the status. Pure. */
export function vpnLoginRowOf(s: VpnStatus): { label: string; hint: string; description: string } {
  if (s.provider === 'wireguard-file')
    return {
      label: 'VPN login',
      hint: 'not needed',
      description: 'A WireGuard file carries its own keys (vpn.configFile): there is no login to set.',
    };
  return {
    label: s.provider === 'nordvpn' ? 'Set NordVPN login…' : 'Set VPN login…',
    hint: s.login === 'saved' ? 'saved' : s.login === 'unreadable' ? 'cannot be read' : 'not saved',
    description:
      'The login the VPN uses (for NordVPN the service credentials from Nord Account > NordVPN > Set up NordVPN manually, not your account password). Typed hidden, kept encrypted for your Windows user, never shown. ' +
      VPN_WARNINGS.join(' '),
  };
}

/** The status page: the facts, the next step (command line only), the warnings and the login actions. */
export function vpnPage(s: VpnStatus): Page {
  const wireguard = s.provider === 'wireguard-file';
  const savedDate = s.loginSavedAt ? '  ' + s.loginSavedAt.slice(0, 10) : '';
  const facts: Fact[] = [
    s.enabled
      ? { id: 'vpn', label: 'VPN', value: 'on', tone: 'ok' }
      : { id: 'vpn', label: 'VPN', value: 'off (applies from the next start)', tone: 'muted' },
    { id: 'provider', label: 'Provider', value: PROVIDER_TEXT[s.provider] },
    { id: 'protocol', label: 'Protocol', value: s.protocol },
    { id: 'country', label: 'Country', value: s.country || 'best available' },
    s.killSwitch
      ? { id: 'killSwitch', label: 'Kill switch', value: 'on (no internet if the tunnel fails)' }
      : { id: 'killSwitch', label: 'Kill switch', value: 'off', tone: 'warn' },
    wireguard
      ? { id: 'login', label: 'Login', value: 'not needed (the keys are in your config)', tone: 'muted' }
      : { id: 'login', label: 'Login', value: LOGIN_TEXT[s.login] + savedDate, tone: LOGIN_TONE[s.login] },
    ...(s.running
      ? [
          {
            id: 'running',
            label: 'Running now',
            value: s.running.text,
            tone: RUNNING_TONE[s.running.level],
          } satisfies Fact,
        ]
      : []),
  ];
  const notes: Note[] = [
    ...(!wireguard && s.login === 'none'
      ? [{ text: 'Next: sandbox vpn login', tone: 'muted' as const, only: 'cli' as const }]
      : []),
    ...(s.login === 'unreadable'
      ? [
          {
            text: 'Only the Windows user that saved it can read it. Save it again: sandbox vpn login',
            tone: 'muted' as const,
          },
        ]
      : []),
    ...VPN_WARNINGS.map((text) => ({ text, tone: 'warn' as const })),
  ];
  // Turning it on or off is the vpn.enabled setting (it applies from the next start).
  const toggle = action(
    setSetting,
    { scope: 'user', key: 'vpn.enabled', value: !s.enabled },
    { label: s.enabled ? 'Turn the VPN off' : 'Turn the VPN on', verb: s.enabled ? 'turn off' : 'turn on', key: 'o' },
  );
  const actions = [
    toggle,
    ...(wireguard
      ? []
      : [
          action(vpnLogin, {}, { key: 'v', verb: 'save login' }),
          ...(s.login !== 'none' ? [action(vpnLogout, {}, { key: 'x', verb: 'delete login' })] : []),
        ]),
  ];
  const section: Section = { id: 'vpn', facts, notes, actions };
  return { title: 'VPN', sections: [section] };
}

export const vpnView = defineView({
  id: 'vpn',
  title: 'VPN',
  summary: "The sandbox's VPN: whether it is on, the saved login, and the tunnel.",
  queries: { status: vpnStatus },
  operations: [vpnLogin, vpnLogout, setSetting],
  build: ({ status }) => vpnPage(status),
});
