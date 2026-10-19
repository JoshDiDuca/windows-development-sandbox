// LAN mode stays on the local network (docs/design/remote-access.md): it listens on one private IPv4 address of a real
// adapter of this PC (never 0.0.0.0, a public address, link-local or a Hyper-V vEthernet adapter, the sandbox's
// network), and every connection is checked again: the peer must be a private address on that adapter's own subnet,
// not this PC itself and not on any vEthernet subnet (listed again at every check: the sandbox's subnet changes every
// boot). Pure apart from os.networkInterfaces, which callers may pass.
import net from 'node:net';
import os from 'node:os';
import { fail } from '../../core/util/index.js';

export type Interfaces = ReturnType<typeof os.networkInterfaces>;

const toInt = (ip: string): number => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0) >>> 0;

/** An IPv4 address in 10/8, 172.16/12 or 192.168/16 (what home and office networks use). Nothing else counts. */
export function isPrivateIPv4(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** 127.0.0.0/8. */
export function isLoopbackIPv4(ip: string): boolean {
  return net.isIPv4(ip) && ip.startsWith('127.');
}

/** Node may report an IPv4 peer as ::ffff:a.b.c.d. */
export function plainIPv4(ip: string | undefined): string {
  const value = ip ?? '';
  return value.startsWith('::ffff:') && net.isIPv4(value.slice(7)) ? value.slice(7) : value;
}

/** The Hyper-V adapters (the sandbox's network, WSL's): never listened on, never trusted as a peer. */
function virtualAdapter(name: string): boolean {
  return /^vEthernet/i.test(name) || /Hyper-V|WSL/i.test(name);
}

export interface LanAddress {
  readonly address: string;
  readonly netmask: string;
  readonly adapter: string;
}

/** This PC's private IPv4 addresses on real adapters. */
export function privateAddresses(interfaces: Interfaces = os.networkInterfaces()): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [adapter, list] of Object.entries(interfaces)) {
    if (virtualAdapter(adapter)) continue;
    for (const i of list ?? [])
      if (i.family === 'IPv4' && !i.internal && isPrivateIPv4(i.address))
        out.push({ address: i.address, netmask: i.netmask, adapter });
  }
  return out;
}

/**
 * The address LAN mode listens on: the configured one when it is one of this PC's private addresses on a real
 * adapter, else (empty setting) the first such address. Fails with the reason for anything else.
 */
export function chooseLanAddress(configured: string, interfaces: Interfaces = os.networkInterfaces()): LanAddress {
  const own = privateAddresses(interfaces);
  if (configured) {
    if (!isPrivateIPv4(configured))
      fail(
        configured + ' is not a private address (10.x, 172.16-31.x, 192.168.x), so the web UI does not listen on it.',
        'LAN mode is for your own network only: set web.remote.lan.address to this PC address on it, or leave it empty.',
      );
    const found = own.find((a) => a.address === configured);
    if (!found)
      fail(
        configured + ' is not an address of a network adapter of this PC.',
        'Leave web.remote.lan.address empty to use this PC address on your network.',
      );
    return found;
  }
  const first = own[0];
  if (!first)
    fail(
      'This PC has no private network address (10.x, 172.16-31.x, 192.168.x) on a network adapter.',
      'Connect it to your home or office network (Wi-Fi or cable), then try again.',
    );
  return first;
}

function sameSubnet(a: string, b: string, netmask: string): boolean {
  const mask = toInt(netmask);
  return mask !== 0 && (toInt(a) & mask) === (toInt(b) & mask);
}

/** Why a LAN peer is refused, or null when it may talk to the LAN listener. */
export function lanPeerProblem(
  peer: string | undefined,
  local: string | undefined,
  bound: LanAddress,
  interfaces: Interfaces = os.networkInterfaces(),
): string | null {
  const ip = plainIPv4(peer);
  if (plainIPv4(local) !== bound.address) return 'reached another address of this PC';
  if (!isPrivateIPv4(ip)) return 'not a private address';
  if (!sameSubnet(ip, bound.address, bound.netmask)) return 'not on the same network';
  for (const [name, list] of Object.entries(interfaces))
    for (const i of list ?? []) {
      if (i.family !== 'IPv4') continue;
      if (i.address === ip) return 'this PC itself (use the address on this PC)';
      if (virtualAdapter(name) && !i.internal && sameSubnet(ip, i.address, i.netmask))
        return 'on a virtual network of this PC (a sandbox)';
    }
  return null;
}

/** https://<address>:<port>, what a phone types. */
export function lanUrl(address: string, port: number): string {
  return 'https://' + address + ':' + port;
}
