// WireGuard for the sandbox: one checksummed MSI from the publisher (installed silently, it brings wireguard.exe and
// wg.exe), the checked config in a file that exists only while the tunnel service starts, and a wait for the
// tunnel. The config holds the private key: it is written from the one-shot secrets file and deleted as soon as the
// service has it (or has failed). The kill switch is applied by the caller BEFORE this runs.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloader, spawnAsync } from '../../shared/download/index.js';
import { SYSTEM } from '../../shared/system.js';
import { WIREGUARD_MSI } from '../../shared/vpn/download.js';
import { handshakeDone, serviceRunning } from '../../shared/vpn/wireguard.js';
import { dryRun, isWin, toolsDir } from '../runtime/paths.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log } from '../runtime/log.js';
import { repairServiceQueries } from './openvpn.js';
import type { TunnelOutcome } from './tunnel.js';

/** The tunnel's name: the config file is sandbox.conf and the Windows service WireGuardTunnel$sandbox. */
export const WIREGUARD_TUNNEL = 'sandbox';

export function wireguardDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.ProgramFiles ?? 'C:\\Program Files', 'WireGuard');
}

export function wireguardExe(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(wireguardDir(env), 'wireguard.exe');
}

export function wireguardDownload(arch: string = process.arch): { file: string; sha256: string; url: string } {
  const entry = arch === 'arm64' ? WIREGUARD_MSI.arm64 : WIREGUARD_MSI.x64;
  return { ...entry, url: WIREGUARD_MSI.base + entry.file };
}

const hasHash = (file: string, sha256: string): boolean =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === sha256;

/** Installs WireGuard unless it is there; returns the path of wireguard.exe. Throws with the reason when it cannot. */
export async function ensureWireguard(): Promise<string> {
  const exe = wireguardExe();
  if (!isWin || dryRun) return exe;
  if (exists(exe)) return exe;
  const dl = wireguardDownload();
  const msi = path.join(mkdirp(path.join(toolsDir, 'downloads')), dl.file);
  // The tools folder lasts between sandboxes and the agent can write it: a cached file is trusted only by its hash.
  if (!exists(msi) || !hasHash(msi, dl.sha256)) {
    log('VPN: downloading WireGuard ' + WIREGUARD_MSI.version + ' (about 3 MB)');
    await downloader.file(dl.url, msi, dl.sha256);
  }
  repairServiceQueries();
  log('VPN: installing WireGuard');
  const logFile = path.join(toolsDir, 'downloads', 'wireguard-install.log');
  // DO_NOT_LAUNCH: the installer would otherwise start the manager window.
  const code = await spawnAsync(
    SYSTEM.msiexec(),
    ['/i', msi, '/qn', '/norestart', 'DO_NOT_LAUNCH=1', '/l*v', logFile],
    {
      stdio: 'ignore',
    },
  );
  if (code !== 0 && code !== 3010)
    throw new Error('The WireGuard installer failed (exit ' + code + '). Its log: ' + logFile);
  if (!exists(exe))
    throw new Error('WireGuard was installed but ' + exe + ' is missing. The installer log: ' + logFile);
  return exe;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function output(file: string, args: string[]): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, text: String(stdout) + String(stderr) });
    });
  });
}

const serviceName = (): string => 'WireGuardTunnel$' + WIREGUARD_TUNNEL;

const hasAdapter = (ip: string): boolean =>
  Object.values(os.networkInterfaces()).some((list) => (list ?? []).some((i) => i.address === ip));

/** Takes the tunnel away again (a failed tunnel must not leave a route into nothing). Never throws. */
export async function removeWireguardTunnel(exe: string): Promise<void> {
  try {
    await output(exe, ['/uninstalltunnelservice', WIREGUARD_TUNNEL]);
  } catch {
    // Nothing installed, nothing to remove.
  }
}

export interface WireguardOptions {
  readonly exe: string;
  /** The checked config text (private key inside). */
  readonly config: string;
  /** The tunnel's own IPv4 address from the config's Address. */
  readonly tunnelIp: string;
  readonly timeoutMs?: number;
}

/**
 * Installs the tunnel service from a config file that is deleted when the service has it, and waits until the service
 * runs and its adapter has the tunnel address. Removes the service again when that fails.
 */
export async function startWireguardTunnel(o: WireguardOptions): Promise<TunnelOutcome> {
  const root = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Temp');
  const dir = fs.mkdtempSync(path.join(fs.existsSync(root) ? root : os.tmpdir(), 'sbx-wg-'));
  const file = path.join(dir, WIREGUARD_TUNNEL + '.conf');
  fs.writeFileSync(file, o.config, 'utf8');
  const fail = async (message: string): Promise<TunnelOutcome> => {
    await removeWireguardTunnel(o.exe);
    return { ok: false, message };
  };
  try {
    const install = await output(o.exe, ['/installtunnelservice', file]);
    if (install.code !== 0) return await fail('WireGuard could not install the tunnel (exit ' + install.code + ')');
    const deadline = Date.now() + (o.timeoutMs ?? 60000);
    for (;;) {
      const state = await output(SYSTEM.sc(), ['query', serviceName()]);
      if (serviceRunning(state.text) && hasAdapter(o.tunnelIp)) {
        return { ok: true, message: 'the tunnel service is running', tunnelIp: o.tunnelIp };
      }
      if (/STOPPED/i.test(state.text) || /1060/.test(state.text))
        return await fail('the WireGuard tunnel service stopped (check the config: keys, address, endpoint)');
      if (Date.now() > deadline)
        return await fail('the WireGuard tunnel did not start in time (the network driver may not work here)');
      await sleep(500);
    }
  } finally {
    // The service has read the file by now (or never will): the private key is not left on disk.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Waits for the server to answer: the first handshake. `poke` sends some traffic through the tunnel (a handshake only
 * starts when there is something to send, unless PersistentKeepalive is set). Without wg.exe the check is skipped.
 */
export async function waitForHandshake(
  exe: string,
  poke: () => Promise<unknown>,
  timeoutMs = 30000,
): Promise<TunnelOutcome> {
  const wg = path.join(path.dirname(exe), 'wg.exe');
  if (!exists(wg)) return { ok: true, message: 'the tunnel service is running (no wg.exe to check the handshake)' };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await poke().catch(() => undefined);
    const shown = await output(wg, ['show', WIREGUARD_TUNNEL, 'latest-handshakes']);
    if (shown.code === 0 && handshakeDone(shown.text)) return { ok: true, message: 'the server answered' };
    if (Date.now() > deadline)
      return {
        ok: false,
        message: 'the VPN server did not answer (check the endpoint, the keys and that its UDP port is reachable)',
      };
    await sleep(1000);
  }
}
