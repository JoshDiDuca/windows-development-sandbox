// The VPN boot step (after the toolchains, before the agent): install OpenVPN, block everything that does not go
// through the tunnel (the kill switch, applied BEFORE the tunnel starts), connect, check, delete the login, report. A
// tunnel that fails never stops the boot: with the kill switch the sandbox stays offline and says so; without it, it
// warns.
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { now } from '../../shared/channel/run-dir.js';
import type { VpnStatus } from '../../shared/channel/schema.js';
import type { SecretsFile } from '../../shared/channel/secrets.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { assertSafeOvpn } from '../../shared/vpn/ovpn.js';
import {
  assertSafeWireguard,
  renderWireguard,
  routesEverything,
  wireguardEndpoints,
  wireguardTunnelAddress,
  type WireguardConfig,
} from '../../shared/vpn/wireguard.js';
import { isIPv4 } from '../../shared/network/firewall-rules.js';
import { killSwitchCommands, tunnelCommands, type KillSwitchServer } from '../../shared/vpn/kill-switch.js';
import { errMsg } from '../../core/util/errors.js';
import { longPath, run as netsh } from '../network/firewall.js';
import { dryRun, isWin, launchDir, run } from '../runtime/paths.js';
import { log, warn } from '../runtime/log.js';
import { session } from '../runtime/session.js';
import { ensureOpenVpn } from './openvpn.js';
import { startTunnel, type TunnelOutcome } from './tunnel.js';
import { ensureWireguard, removeWireguardTunnel, startWireguardTunnel, waitForHandshake } from './wireguard.js';

/** Writes run\vpn.json (what `sandbox vpn status` and the launch show). Never throws. */
export function setVpnStatus(state: VpnStatus['state'], message: string, extra: Partial<VpnStatus> = {}): void {
  try {
    writeJsonAtomic(run.vpnFile, {
      state,
      message: message.slice(0, 1900),
      killSwitch: session.vpn?.killSwitch ?? false,
      updatedAt: now(),
      ...(session.vpn ? { server: session.vpn.server.slice(0, 120) } : {}),
      ...extra,
    });
  } catch (e) {
    warn('Could not write the VPN status: ' + errMsg(e));
  }
}

/** IPv4 addresses of the servers the profile names: names are looked up now, before the kill switch closes DNS. */
async function serverAddresses(
  remotes: readonly { host: string; port: number; proto: 'udp' | 'tcp' }[],
): Promise<KillSwitchServer[]> {
  const out: KillSwitchServer[] = [];
  for (const r of remotes) {
    const ips = isIPv4(r.host)
      ? [r.host]
      : await dns.promises.lookup(r.host, { all: true, family: 4 }).then(
          (all) => all.map((a) => a.address),
          () => [],
        );
    for (const ip of ips) out.push({ ip, port: r.port, proto: r.proto });
  }
  return out;
}

/** The WireGuard peers' endpoints as IPv4 servers (udp), and the config with those addresses in place of host names. */
async function wireguardServers(config: WireguardConfig): Promise<{ servers: KillSwitchServer[]; text: string }> {
  const endpointIps: Record<number, string> = {};
  const servers: KillSwitchServer[] = [];
  const found = wireguardEndpoints(config);
  for (let i = 0; i < found.length; i++) {
    const [ip] = await serverAddresses([{ host: found[i].host, port: found[i].port, proto: 'udp' }]).then((all) =>
      all.map((s) => s.ip),
    );
    if (!ip) throw new Error('the VPN server address could not be found');
    // WireGuard looks the name up itself at start, after the kill switch has closed DNS: give it the address.
    endpointIps[i] = ip;
    servers.push({ ip, port: found[i].port, proto: 'udp' });
  }
  return { servers, text: renderWireguard(config, endpointIps) };
}

/** What the sandbox looks like from outside, through the tunnel (null when it cannot be told quickly). */
async function publicAddress(): Promise<string | null> {
  try {
    const text = (await (await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(10000) })).text()).trim();
    return /^[0-9a-fA-F.:]{3,45}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

const hasAdapter = (ip: string): boolean =>
  Object.values(os.networkInterfaces()).some((list) => (list ?? []).some((i) => i.address === ip));

/** Well-known public addresses a direct connection is tried to, to see that the kill switch holds. */
const PROBE_TARGETS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'] as const;
const PROBE_TIMEOUT_MS = 3000;

function connects(ip: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** True when a direct connection out (before the tunnel exists) fails: the kill switch holds. */
async function directConnectionBlocked(servers: readonly KillSwitchServer[]): Promise<boolean> {
  const targets = PROBE_TARGETS.filter((ip) => !servers.some((s) => s.ip === ip));
  const results = await Promise.all(targets.map((ip) => connects(ip, 443)));
  return !results.some(Boolean);
}

/** The whole step. Returns true when the tunnel is up. */
export async function setupVpn(secrets: SecretsFile, ptyHostExe: string | null): Promise<boolean> {
  const vpn = session.vpn;
  if (!vpn) return true;
  const killSwitch = vpn.killSwitch;
  let blocked = false;
  /** A direct connection was tried after the kill switch and failed: only then is the sandbox said to be offline. */
  let held = false;
  const block = async (servers: KillSwitchServer[]): Promise<void> => {
    if (!isWin || dryRun) {
      blocked = held = true;
      return;
    }
    try {
      netsh(killSwitchCommands(servers, ptyHostExe ? longPath(ptyHostExe) : null));
    } finally {
      blocked = true;
      held = await directConnectionBlocked(servers);
    }
    if (held) log('VPN: kill switch on: nothing leaves the sandbox except through the tunnel (checked).');
    else
      warn(
        'VPN: the kill switch did not hold: a direct connection still got out. If the tunnel drops, traffic leaves through your normal connection.',
      );
  };
  setVpnStatus('starting', 'Starting the VPN');
  try {
    if (!session.networking) throw new Error('networking is off for this sandbox');
    let result: TunnelOutcome;
    let wireguardExe: string | null = null;
    if (vpn.provider === 'wireguard-file') {
      // The config came from the host (through the one-shot file), but it is data like any other: checked again here.
      if (!secrets.wireguardConfig) throw new Error('the WireGuard config did not arrive (start the sandbox again)');
      const config = assertSafeWireguard(secrets.wireguardConfig, vpn.server);
      const exe = await ensureWireguard();
      const { servers, text } = await wireguardServers(config);
      if (killSwitch && !routesEverything(config))
        warn(
          'VPN: AllowedIPs does not include 0.0.0.0/0: with the kill switch on, only the tunnel traffic can leave the sandbox.',
        );
      if (killSwitch) await block(servers);
      if (dryRun || !isWin) {
        log('(dry run) would start the WireGuard tunnel ' + vpn.server);
        setVpnStatus('off', 'dry run');
        return true;
      }
      log('VPN: connecting with ' + vpn.server);
      wireguardExe = exe;
      result = await startWireguardTunnel({ exe, config: text, tunnelIp: wireguardTunnelAddress(config) });
      if (result.ok && result.tunnelIp && killSwitch) netsh(tunnelCommands(result.tunnelIp));
      if (result.ok) result = await waitForHandshake(exe, publicAddress);
    } else {
      const credentials = secrets.vpn;
      if (!credentials) throw new Error('the VPN login did not arrive (start the sandbox again)');
      // The profile came from the host, but it is data like any other: checked again here before OpenVPN reads it.
      const profile = path.join(launchDir, 'vpn', 'server.ovpn');
      const remotes = assertSafeOvpn(fs.readFileSync(profile, 'utf8'), vpn.server);
      const exe = await ensureOpenVpn();
      const servers = await serverAddresses(remotes);
      if (servers.length === 0) throw new Error('the VPN server addresses could not be found');
      if (killSwitch) await block(servers);
      if (dryRun || !isWin) {
        log('(dry run) would start the VPN tunnel to ' + vpn.server);
        setVpnStatus('off', 'dry run');
        return true;
      }
      log('VPN: connecting to ' + vpn.server);
      result = await startTunnel({ exe, profile, username: credentials.username, password: credentials.password });
      if (result.ok && result.tunnelIp && hasAdapter(result.tunnelIp) && killSwitch)
        netsh(tunnelCommands(result.tunnelIp));
    }
    if (!result.ok) {
      if (wireguardExe) await removeWireguardTunnel(wireguardExe);
      throw new Error(result.message);
    }
    if (!result.tunnelIp || !hasAdapter(result.tunnelIp))
      throw new Error('the tunnel reported it was up, but no network adapter with its address appeared');
    const publicIp = await publicAddress();
    log('VPN: up' + (publicIp ? ' (the sandbox appears as ' + publicIp + ')' : '') + '.');
    setVpnStatus('up', 'The tunnel is up', {
      ...(publicIp ? { publicIp } : {}),
      ...(killSwitch ? { killSwitchHeld: held } : {}),
    });
    return true;
  } catch (e) {
    const reason = errMsg(e);
    // Without the kill switch the sandbox keeps its normal connection: the rest of the boot goes on, with a warning.
    try {
      if (killSwitch && !blocked) await block([]);
    } catch (blockError) {
      warn('VPN: could not close the network after the failure: ' + errMsg(blockError));
    }
    // "No internet" is said only when a direct connection was tried and failed.
    const after = !killSwitch
      ? ' The kill switch is off, so this sandbox is using your normal connection.'
      : held
        ? ' The kill switch is on, so this sandbox has NO internet access.'
        : ' The kill switch could NOT close the network, so this sandbox is ONLINE through your normal connection, without the VPN.';
    warn('VPN failed: ' + reason + after);
    setVpnStatus('failed', reason, killSwitch ? { killSwitchHeld: held } : {});
    return false;
  }
}
