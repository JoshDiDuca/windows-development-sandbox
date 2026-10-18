/** Private, carrier-grade NAT (Tailscale and similar live here), link-local and multicast ranges. */
export const PRIVATE_V4 = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '224.0.0.0/4',
];
export const PRIVATE_V6 = ['fc00::/7', 'fe80::/10', 'ff00::/8'];
export const RULE_NAMES = [
  'AgentSandbox-Block-Private',
  'AgentSandbox-Block-IPv6-Local',
  'AgentSandbox-Block-SMB',
  'AgentSandbox-Gateway-TCP',
  'AgentSandbox-Gateway-UDP',
];

export function isIPv4(ip: string): boolean {
  const parts = ip.split('.');
  return parts.length === 4 && parts.every((p: string) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
export function ipToInt(ip: string): number {
  if (!isIPv4(ip)) throw new Error('Invalid IPv4 address: ' + ip);
  const p = ip.split('.').map(Number);
  return p[0] * 16777216 + p[1] * 65536 + p[2] * 256 + p[3];
}
export function intToIp(n: number): string {
  return [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');
}
export function cidrToRange(cidr: string): [number, number] {
  const [ip, bits] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  const start = Math.floor(ipToInt(ip) / size) * size;
  return [start, start + size - 1];
}
export function subtractIps(ranges: [number, number][], ips: string[]): [number, number][] {
  let result: [number, number][] = ranges.map((r: [number, number]) => [r[0], r[1]] as [number, number]);
  for (const ip of ips) {
    const n = ipToInt(ip);
    const next: [number, number][] = [];
    for (const [start, end] of result) {
      if (n < start || n > end) {
        next.push([start, end]);
        continue;
      }
      if (n > start) next.push([start, n - 1]);
      if (n < end) next.push([n + 1, end]);
    }
    result = next;
  }
  return result;
}
export function formatRange(range: [number, number]): string {
  return range[0] === range[1] ? intToIp(range[0]) : intToIp(range[0]) + '-' + intToIp(range[1]);
}
export function isPrivateV4(ip: string): boolean {
  const n = ipToInt(ip);
  return PRIVATE_V4.some((c: string) => {
    const [s, e] = cidrToRange(c);
    return n >= s && n <= e;
  });
}

export function parseDefaultGateways(routePrint: string): string[] {
  const found: string[] = [];
  for (const line of routePrint.split(/\r?\n/)) {
    const m = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s/.exec(line);
    if (m && isIPv4(m[1])) found.push(m[1]);
  }
  return found;
}
/** The IPv4 servers in a dns.getServers() list ('8.8.8.8', '8.8.8.8:1053', '[::1]:53'); IPv6 ones are dropped. */
export function ipv4DnsServers(servers: string[]): string[] {
  return servers.map((s: string) => s.replace(/:\d+$/, '')).filter(isIPv4);
}

/**
 * Fallback only: the "DNS Servers" label is English, so this finds nothing on localised Windows (dns.getServers()
 * does).
 */
export function parseDnsServers(ipconfigAll: string): string[] {
  const found: string[] = [];
  let inDns = false;
  for (const line of ipconfigAll.split(/\r?\n/)) {
    if (/DNS Servers/i.test(line)) {
      inDns = true;
      for (const m of line.matchAll(/(\d{1,3}(?:\.\d{1,3}){3})/g)) if (isIPv4(m[1])) found.push(m[1]);
    } else if (inDns && /^\s+\d{1,3}(?:\.\d{1,3}){3}\s*$/.test(line)) {
      found.push(line.trim());
    } else {
      inDns = false;
    }
  }
  return found;
}

/**
 * netsh argument lists. Private ranges are blocked EXCEPT DNS/DHCP to the sandbox's own gateway, so name resolution
 * keeps working.
 */
export function buildFirewallCommands(exemptIps: string[]): string[][] {
  const exempt = [...new Set(exemptIps.filter((ip: string) => isIPv4(ip) && isPrivateV4(ip)))];
  const v4 = subtractIps(PRIVATE_V4.map(cidrToRange), exempt).map(formatRange);
  const add = (name: string, extra: string[]): string[] => [
    'advfirewall',
    'firewall',
    'add',
    'rule',
    'name=' + name,
    'dir=out',
    'action=block',
    'enable=yes',
    'profile=any',
    ...extra,
  ];
  const commands: string[][] = [];
  for (const name of RULE_NAMES) commands.push(['advfirewall', 'firewall', 'delete', 'rule', 'name=' + name]);
  commands.push(['advfirewall', 'set', 'allprofiles', 'state', 'on']);
  commands.push(add('AgentSandbox-Block-Private', ['protocol=any', 'remoteip=' + v4.join(',')]));
  commands.push(add('AgentSandbox-Block-IPv6-Local', ['protocol=any', 'remoteip=' + PRIVATE_V6.join(',')]));
  commands.push(add('AgentSandbox-Block-SMB', ['protocol=tcp', 'remoteport=135,139,445']));
  if (exempt.length > 0) {
    commands.push(
      add('AgentSandbox-Gateway-TCP', ['protocol=tcp', 'remoteip=' + exempt.join(','), 'remoteport=1-52,54-65535']),
    );
    commands.push(
      add('AgentSandbox-Gateway-UDP', [
        'protocol=udp',
        'remoteip=' + exempt.join(','),
        'remoteport=1-52,54-66,69-65535',
      ]),
    );
  }
  return commands;
}

export const ATTACH_RULE = 'AgentSandbox-Attach';

/**
 * True when a Windows path has an 8.3 short name in it (`C:\Users\WDAGUT~1\...`). netsh refuses `program=` paths
 * like that ("The application name could not be resolved"), so they are expanded first.
 */
export function hasShortName(file: string): boolean {
  return file.split(/[/\\]/).some((part) => /~\d/.test(part));
}

/** Inbound rule for ptyhost only, and only from the sandbox's own subnet (where the host's Hyper-V adapter is). */
export function attachRuleCommands(ptyHostExe: string): string[][] {
  return [
    ['advfirewall', 'firewall', 'delete', 'rule', 'name=' + ATTACH_RULE],
    [
      'advfirewall',
      'firewall',
      'add',
      'rule',
      'name=' + ATTACH_RULE,
      'dir=in',
      'action=allow',
      'enable=yes',
      'profile=any',
      'protocol=tcp',
      'remoteip=LocalSubnet',
      'program=' + ptyHostExe,
    ],
  ];
}
