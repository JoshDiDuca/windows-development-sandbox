// The kill switch as netsh argument lists (pure, so it is tested without a firewall). Windows Sandbox has its own
// "Container: allow outbound" rule (any program, any address), so blocking outbound by default alone stops nothing:
// the kill switch is made of BLOCK rules, which beat every allow rule. Phase 1 runs BEFORE the tunnel starts: every
// public IPv4 address except the VPN servers, global IPv6 and DNS are blocked (private ranges are the LAN block's).
// Phase 2 runs once the tunnel is up: the same block rules are narrowed in place (`set rule`, never a moment without
// them) to every local address except the tunnel's own, so what goes through the tunnel (DNS included) passes.
import { isIPv4 } from '../network/firewall-rules.js';

export const VPN_RULE_PREFIX = 'AgentSandbox-VPN-';

export interface KillSwitchServer {
  readonly ip: string;
  readonly port: number;
  readonly proto: 'udp' | 'tcp';
}

const rule = (name: string, extra: string[]): string[] => [
  'advfirewall',
  'firewall',
  'add',
  'rule',
  'name=' + VPN_RULE_PREFIX + name,
  'dir=out',
  'action=allow',
  'enable=yes',
  'profile=any',
  ...extra,
];

const drop = (name: string): string[] => [
  'advfirewall',
  'firewall',
  'delete',
  'rule',
  'name=' + VPN_RULE_PREFIX + name,
];

const block = (name: string, extra: string[]): string[] => [
  'advfirewall',
  'firewall',
  'add',
  'rule',
  'name=' + VPN_RULE_PREFIX + name,
  'dir=out',
  'action=block',
  'enable=yes',
  'profile=any',
  ...extra,
];

/** The block rules: IPv4 to the internet, global IPv6, and DNS anywhere (over udp and tcp). */
const BLOCK_RULES = ['Block-Internet', 'Block-IPv6', 'Block-DNS-UDP', 'Block-DNS-TCP'] as const;

/** The rule names phase 1 and 2 may create (the servers get a number each). */
export function ruleNames(serverCount: number): string[] {
  return [
    ...BLOCK_RULES,
    'Loopback',
    'DHCP',
    'Host',
    'Tunnel',
    ...Array.from({ length: Math.max(serverCount, 0) }, (_v, i) => 'Server-' + (i + 1)),
  ];
}

/** IPv4 ranges that are not the internet (this host, private, shared, link-local, multicast, reserved, broadcast). */
const NOT_INTERNET: readonly (readonly [string, string])[] = [
  ['0.0.0.0', '0.255.255.255'],
  ['10.0.0.0', '10.255.255.255'],
  ['100.64.0.0', '100.127.255.255'],
  ['127.0.0.0', '127.255.255.255'],
  ['169.254.0.0', '169.254.255.255'],
  ['172.16.0.0', '172.31.255.255'],
  ['192.168.0.0', '192.168.255.255'],
  ['224.0.0.0', '255.255.255.255'],
];

const LAST_IPV4 = 0xffffffff;

function ipNumber(ip: string): number {
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

function ipText(n: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');
}

/** Every IPv4 address except the given ranges, as a netsh address list ("a-b,c-d"). */
export function ipv4Except(excluded: readonly (readonly [number, number])[]): string {
  const sorted = [...excluded].sort((a, b) => a[0] - b[0]);
  const out: string[] = [];
  let next = 0;
  for (const [from, to] of sorted) {
    if (from > next) out.push(ipText(next) + '-' + ipText(from - 1));
    next = Math.max(next, to + 1);
  }
  if (next <= LAST_IPV4) out.push(ipText(next) + '-' + ipText(LAST_IPV4));
  return out.join(',');
}

/** The internet's IPv4 addresses without the VPN servers: what the kill switch blocks. */
export function internetExcept(servers: readonly KillSwitchServer[]): string {
  const ranges = NOT_INTERNET.map(([a, b]): [number, number] => [ipNumber(a), ipNumber(b)]);
  for (const s of cleanServers(servers)) ranges.push([ipNumber(s.ip), ipNumber(s.ip)]);
  return ipv4Except(ranges);
}

/** Servers worth a rule: valid IPv4 addresses and ports, each endpoint once. */
export function cleanServers(servers: readonly KillSwitchServer[]): KillSwitchServer[] {
  const seen = new Set<string>();
  return servers.filter((s) => {
    const key = s.proto + ':' + s.ip + ':' + s.port;
    if (!isIPv4(s.ip) || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Phase 1: the block rules first (they hold whatever else allows), then outbound blocked by default, then what the
 * tunnel and the attach channel need. `ptyHostExe` must be the long form of the path (netsh refuses 8.3 names).
 */
export function killSwitchCommands(servers: readonly KillSwitchServer[], ptyHostExe: string | null): string[][] {
  const list = cleanServers(servers);
  return [
    ...ruleNames(Math.max(list.length, 8)).map(drop),
    ['advfirewall', 'set', 'allprofiles', 'state', 'on'],
    block('Block-Internet', ['protocol=any', 'remoteip=' + internetExcept(list)]),
    block('Block-IPv6', ['protocol=any', 'remoteip=2000::/3']),
    block('Block-DNS-UDP', ['protocol=udp', 'remoteport=53']),
    block('Block-DNS-TCP', ['protocol=tcp', 'remoteport=53']),
    ['advfirewall', 'set', 'allprofiles', 'firewallpolicy', 'blockinbound,blockoutbound'],
    rule('Loopback', ['protocol=any', 'remoteip=127.0.0.0/8']),
    rule('DHCP', ['protocol=udp', 'localport=68', 'remoteport=67']),
    ...(ptyHostExe ? [rule('Host', ['protocol=any', 'remoteip=LocalSubnet', 'program=' + ptyHostExe])] : []),
    ...list.map((s, i) =>
      rule('Server-' + (i + 1), ['protocol=' + s.proto, 'remoteip=' + s.ip, 'remoteport=' + s.port]),
    ),
  ];
}

/**
 * Phase 2: everything that leaves from the tunnel's own address goes (it is inside the tunnel). The IPv4 block rules
 * are changed in place to every other local address, so they never stop applying to the normal connection. Global
 * IPv6 stays blocked (the tunnel is IPv4).
 */
export function tunnelCommands(tunnelIp: string): string[][] {
  if (!isIPv4(tunnelIp)) throw new Error('Not an IPv4 address: ' + tunnelIp);
  const n = ipNumber(tunnelIp);
  const notTunnel = ipv4Except([[n, n]]);
  return [
    ...(['Block-Internet', 'Block-DNS-UDP', 'Block-DNS-TCP'] as const).map((name) => [
      'advfirewall',
      'firewall',
      'set',
      'rule',
      'name=' + VPN_RULE_PREFIX + name,
      'new',
      'localip=' + notTunnel,
    ]),
    drop('Tunnel'),
    rule('Tunnel', ['protocol=any', 'localip=' + tunnelIp]),
  ];
}

/** Takes the kill switch away again: its rules go and outbound traffic is allowed by default as before. */
export function removeKillSwitchCommands(): string[][] {
  return [
    ...ruleNames(64).map(drop),
    ['advfirewall', 'set', 'allprofiles', 'firewallpolicy', 'blockinbound,allowoutbound'],
  ];
}

/** The tunnel's own IPv4 address from OpenVPN's log (its "net_addr_v4_add" or "ifconfig" line), or null. */
export function tunnelAddressFromLog(log: string): string | null {
  const add = /net_addr_v4_add:\s*(\d{1,3}(?:\.\d{1,3}){3})\/\d+/.exec(log);
  if (add && isIPv4(add[1])) return add[1];
  const ifconfig =
    /(?:ifconfig|ip addr add|Notified TAP-Windows driver to set a DHCP IP\/netmask of)\s+(\d{1,3}(?:\.\d{1,3}){3})/i.exec(
      log,
    );
  return ifconfig && isIPv4(ifconfig[1]) ? ifconfig[1] : null;
}
