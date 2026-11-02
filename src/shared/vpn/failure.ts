// Why an OpenVPN run failed, from its log: a stable code (what the host acts on) and a plain sentence. Pure.
export const VPN_FAILURE_CODES = ['auth', 'unreachable', 'driver', 'timeout', 'other'] as const;
export type VpnFailureCode = (typeof VPN_FAILURE_CODES)[number];

export interface VpnFailure {
  readonly code: VpnFailureCode;
  readonly reason: string;
}

/** What the log says went wrong, or null when it says nothing (yet). */
export function classifyFailure(text: string): VpnFailure | null {
  if (/AUTH_FAILED/i.test(text))
    return {
      code: 'auth',
      reason: 'the VPN refused the login (for NordVPN use the service credentials, not your account password)',
    };
  if (/TLS Error: TLS key negotiation failed|TLS handshake failed/i.test(text))
    return {
      code: 'unreachable',
      reason: 'it could not reach the VPN server (the network blocks it, or the server is down)',
    };
  if (
    /All wintun adapters on this system are in use|Cannot open TUN\/TAP|Could not create Wintun|ovpn-dco.*(error|failed)/i.test(
      text,
    )
  )
    return { code: 'driver', reason: 'the network driver for the tunnel could not be used' };
  if (/Exiting due to fatal error/i.test(text)) return { code: 'other', reason: 'OpenVPN stopped with an error' };
  return null;
}

/** The plain words for a code, for the page ("login refused by NordVPN"). */
export const FAILURE_TEXT: Readonly<Record<VpnFailureCode, string>> = {
  auth: 'login refused by the VPN',
  unreachable: 'the VPN server could not be reached',
  driver: 'the tunnel driver could not be used',
  timeout: 'the tunnel did not come up in time',
  other: 'the VPN failed',
};
