// What the host says about a running sandbox's VPN, from the status the sandbox writes (run\vpn.json, validated).
import { RunDir, type VpnStatus } from '../../shared/channel/index.js';
import { safeText } from '../../core/util/index.js';
import { fetchBounded, type Fetcher } from './nordvpn.js';

export interface VpnLine {
  readonly level: 'ok' | 'warn' | 'bad';
  readonly text: string;
}

/** This PC's own public address (one small request), or null when it cannot be told. */
export async function hostPublicIp(fetchText: Fetcher = fetchBounded): Promise<string | null> {
  try {
    const ip = (await fetchText('https://api.ipify.org', 64)).trim();
    return /^[0-9a-fA-F.:]{3,45}$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

/** One line for the status the sandbox reported (text from the sandbox is made safe first). */
export function vpnLine(status: VpnStatus | null, hostIp: string | null = null): VpnLine {
  if (!status) return { level: 'warn', text: 'The sandbox has not reported on the VPN.' };
  const message = safeText(status.message).slice(0, 300);
  const leaky = status.killSwitch && status.killSwitchHeld === false;
  if (status.state === 'up') {
    const same = hostIp !== null && status.publicIp === hostIp;
    if (!same && leaky)
      return {
        level: 'warn',
        text:
          'VPN up' +
          (status.publicIp ? ', the sandbox appears as ' + safeText(status.publicIp) : '') +
          ', but the kill switch did not hold: if the tunnel drops, traffic goes out through your normal connection.',
      };
    return same
      ? {
          level: 'bad',
          text:
            "VPN reports up, but the sandbox shows this PC's own address (" +
            hostIp +
            '): the traffic is not going through it.',
        }
      : {
          level: 'ok',
          text:
            'VPN up' +
            (status.server ? ' (' + safeText(status.server) + ')' : '') +
            (status.publicIp ? ', the sandbox appears as ' + safeText(status.publicIp) : '') +
            (hostIp && status.publicIp ? ' (this PC: ' + hostIp + ')' : '') +
            '.',
        };
  }
  if (status.state === 'failed')
    return {
      level: 'bad',
      text:
        'VPN failed: ' +
        message +
        (leaky
          ? ' The kill switch did not hold, so the sandbox is ONLINE through your normal connection, without the VPN.'
          : status.killSwitch
            ? ' The kill switch is on, so the sandbox has no internet.'
            : ' The kill switch is off, so the sandbox uses your normal connection.'),
    };
  return { level: 'warn', text: 'VPN ' + status.state + (message ? ': ' + message : '') };
}

/** The running sandbox's VPN line, or null when its VPN was never on (no status file). */
export function readVpnLine(dataPath: string, hostIp: string | null = null): VpnLine | null {
  const status = new RunDir(dataPath).readVpnStatus();
  return status && status.state !== 'off' ? vpnLine(status, hostIp) : null;
}
