// The VPN setting (inside the sandbox only; the login is not a setting: it is kept encrypted by `sandbox vpn login`).
import { z } from 'zod';

export const VPN_PROVIDERS = ['nordvpn', 'openvpn-file', 'wireguard-file'] as const;

export const VpnSchema = z.strictObject({
  enabled: z
    .boolean()
    .describe(
      "(Alpha: not yet tried on a real PC) Send the sandbox's traffic through a VPN. Only the sandbox: your PC's own connection is untouched. Needs a saved login first (sandbox vpn login). The agent in the sandbox can read that login and can turn the tunnel off (it is the administrator there).",
    ),
  provider: z
    .enum(VPN_PROVIDERS)
    .describe(
      'nordvpn: a recommended NordVPN server is picked at every launch. openvpn-file: your own .ovpn file (configFile). wireguard-file: your own WireGuard .conf (configFile), e.g. from your company.',
    ),
  protocol: z.enum(['udp', 'tcp']).describe('udp is faster; tcp gets through networks that block udp.'),
  country: z
    .string()
    .regex(/^([A-Za-z][A-Za-z .'-]{0,39})?$/, 'a country name or code like uk or Germany')
    .describe('nordvpn: the country of the server, e.g. uk, us or Germany. Empty = the best server anywhere.'),
  configFile: z
    .string()
    .describe(
      "openvpn-file / wireguard-file: the .ovpn or .conf file on this PC (an .ovpn has its certificates inside it). Files that run programs (script-security, up, down, plugin, PostUp ...) are refused. A WireGuard file holds your private key: it is read when a sandbox starts and handed over in a one-shot file. A project's file can never set this.",
    ),
  killSwitch: z
    .boolean()
    .describe(
      'Block all traffic that does not go through the tunnel: when the tunnel cannot start, the sandbox stays offline instead of using your normal connection. A project can only turn this on, never off.',
    ),
});

export type VpnProvider = (typeof VPN_PROVIDERS)[number];
