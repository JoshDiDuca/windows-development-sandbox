// Guest firewall: block the host's LAN (keeping DNS/DHCP to the gateway) and let the host reach session ports.
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { relayPort, withBlockedHosts } from '../../shared/network/policy.js';
import {
  attachRuleCommands,
  buildFirewallCommands,
  hasShortName,
  ipv4DnsServers,
  isIPv4,
  parseDefaultGateways,
  parseDnsServers,
} from '../../shared/network/firewall-rules.js';
import { SYSTEM } from '../../shared/system.js';
import { scriptArgs } from '../../shared/scripts.js';
import { dryRun, isWin } from '../runtime/paths.js';
import { log, warn } from '../runtime/log.js';
import { session } from '../runtime/session.js';
import { errMsg } from '../../core/util/errors.js';

const netsh = (args: string[]): { status: number | null; out: string } => {
  const r = spawnSync(SYSTEM.netsh(), args, { encoding: 'utf8', windowsHide: true });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

const discoverExemptIps = (): string[] => {
  if (process.env.AGENT_TEST_EXEMPT) return process.env.AGENT_TEST_EXEMPT.split(',');
  if (!isWin) return [];
  const route = spawnSync(SYSTEM.route(), ['print', '-4'], { encoding: 'utf8', windowsHide: true });
  // The resolver's own list works on every Windows language; `ipconfig /all` (English labels only) is the fallback.
  let servers: string[] = [];
  try {
    servers = ipv4DnsServers(dns.getServers());
  } catch {
    /* fall back below */
  }
  if (!servers.length)
    servers = parseDnsServers(
      spawnSync(SYSTEM.ipconfig(), ['/all'], { encoding: 'utf8', windowsHide: true }).stdout ?? '',
    );
  return [...parseDefaultGateways(route.stdout ?? ''), ...servers];
};

const internetWorks = async (): Promise<boolean> => {
  try {
    return (await fetch('https://nodejs.org', { method: 'HEAD', signal: AbortSignal.timeout(10000) })).status > 0;
  } catch {
    return false;
  }
};

/** The sandbox network can take a few seconds to come up after logon. */
const waitForInternet = async (seconds: number): Promise<boolean> => {
  for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
    if (await internetWorks()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
};

/** What the agent's manifest says about the LAN. */
export type LanState = 'blocked' | 'open' | 'offline';

/** Protections that could not be put in place this boot (shown in the boot summary and the log, never silent). */
const problems: string[] = [];

export function networkProblems(): readonly string[] {
  return problems;
}

/** netsh needs the long form of a path: the sandbox's TEMP is an 8.3 short path (WDAGUT~1). */
const longPath = (file: string): string => {
  if (!hasShortName(file)) return file;
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
};

/**
 * The inbound rule for ptyhost (the attach channel). A rule that cannot be added is a missing protection, so it is
 * tried again a few times and then reported loudly instead of being skipped.
 */
async function applyAttachRule(ptyHostExe: string | null): Promise<void> {
  if (!session.attach.enabled) return;
  if (!ptyHostExe) {
    problems.push('attach: the session host was not built, so the firewall rule for it was not created');
    warn(problems[problems.length - 1]);
    return;
  }
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      run(attachRuleCommands(longPath(ptyHostExe)));
      return;
    } catch (e) {
      last = errMsg(e);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  problems.push('attach: the firewall rule for the session host could not be created (' + last + ')');
  warn('PROTECTION MISSING: ' + problems[problems.length - 1]);
}

export function run(commands: string[][]): void {
  for (const c of commands) {
    const r = netsh(c);
    if (r.status !== 0 && c[2] !== 'delete')
      throw new Error('netsh ' + c.slice(0, 5).join(' ') + ' failed (exit ' + r.status + '): ' + r.out.trim());
  }
}

/**
 * Applies the LAN block. Internet is checked first; if it works before the rules but not after, the rules (not the
 * internet) are the problem, so they are removed and the agent is told the LAN is open. If there is no internet at
 * all, the block stays in place: being offline is never a reason to open the LAN.
 */
export async function applyNetworkPolicy(ptyHostExe: string | null): Promise<LanState> {
  if (!session.networking) {
    log('Networking is disabled for this sandbox.');
    return 'offline';
  }
  const block = session.network.blockPrivateRanges;
  const exempt = block ? discoverExemptIps() : [];
  const lanRules = block ? buildFirewallCommands(exempt) : [];
  const forwardRules = forwardRule();
  const commands = [
    ...lanRules,
    ...(ptyHostExe && session.attach.enabled ? attachRuleCommands(ptyHostExe) : []),
    ...forwardRules,
  ];
  if (isWin && !dryRun) {
    try {
      applyBlockedHosts();
    } catch (e) {
      warn('network.blockHosts could not be applied: ' + errMsg(e));
    }
    try {
      applyDns();
    } catch (e) {
      warn('network.dns could not be applied: ' + errMsg(e));
    }
  }
  if (!block) log('Private-range blocking disabled by config.');
  if (block)
    log(
      'Gateway/DNS addresses kept reachable for DNS only: ' +
        (exempt.length ? [...new Set(exempt)].join(', ') : '(none found)'),
    );
  if (!isWin || dryRun) {
    log('(dry run) firewall plan:');
    for (const c of commands) log('  netsh ' + c.join(' '));
    return block ? 'blocked' : 'open';
  }
  if (commands.length === 0) return 'open';
  const online = block ? await waitForInternet(30) : true;
  // Each group on its own: one failing must not skip the others (or the internet check below).
  const failures: string[] = [];
  try {
    run(lanRules);
  } catch (e) {
    failures.push(errMsg(e));
  }
  await applyAttachRule(ptyHostExe);
  try {
    run(forwardRules);
  } catch (e) {
    problems.push('forwardPorts: the firewall rule for the relays could not be created (' + errMsg(e) + ')');
    warn('PROTECTION MISSING: ' + problems[problems.length - 1]);
  }
  if (failures.length) throw new Error(failures[0]);
  if (!block) return 'open';
  if (online && !(await waitForInternet(15))) {
    run(lanRules.filter((c) => c[2] === 'delete'));
    warn(
      'The LAN block broke internet access in this sandbox, so it was removed: the agent CAN reach your local network this time. Set sandbox.networking to false for hard isolation.',
    );
    return 'open';
  }
  if (!online) warn('No internet detected yet; the LAN block is in place anyway.');
  log(
    'LAN blocked in the guest firewall (10/8, 172.16/12, 192.168/16, 100.64/10, link-local, multicast, IPv6 local, SMB); DNS/DHCP to the gateway allowed.',
  );
  return 'blocked';
}

// ---- the rest of the network settings -----------------------------------------------------------------------------

const FORWARD_RULE = 'AgentSandbox-Forward';
const HOSTS_FILE = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');

/** network.blockHosts: those names go nowhere (the sandbox's hosts file; the registry and files are new every boot). */
const applyBlockedHosts = (): void => {
  const hosts = session.network.blockHosts ?? [];
  if (!hosts.length) return;
  const text = fs.existsSync(HOSTS_FILE) ? fs.readFileSync(HOSTS_FILE, 'utf8') : '';
  fs.writeFileSync(HOSTS_FILE, withBlockedHosts(text, hosts));
  log('Blocked hosts (network.blockHosts): ' + hosts.join(', '));
};

/** network.dns: these servers on every connected adapter. */
const applyDns = (): void => {
  const servers = (session.network.dns ?? []).filter(isIPv4);
  if (!servers.length) return;
  const r = spawnSync(SYSTEM.powershell(), scriptArgs('set-dns-servers.ps1', ['-Servers', servers.join(',')]), {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error('could not set the DNS servers: ' + (r.stderr ?? '').trim().slice(0, 300));
  log('DNS servers (network.dns): ' + servers.join(', '));
};

/**
 * network.forwardPorts: the relays (in the daemon) take connections from the PC only, i.e. the sandbox's own subnet.
 */
const forwardRule = (): string[][] => {
  const forwards = session.network.forwardPorts ?? [];
  return forwards.length
    ? [
        ['advfirewall', 'firewall', 'delete', 'rule', 'name=' + FORWARD_RULE],
        [
          'advfirewall',
          'firewall',
          'add',
          'rule',
          'name=' + FORWARD_RULE,
          'dir=in',
          'action=allow',
          'enable=yes',
          'profile=any',
          'protocol=tcp',
          'remoteip=LocalSubnet',
          'localport=' + forwards.map((_f, i) => relayPort(i)).join(','),
        ],
      ]
    : [];
};
