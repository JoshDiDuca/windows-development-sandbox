// OpenVPN Community for the sandbox: one checksummed MSI from the publisher, installed silently (it brings the driver).
// The sandbox is new at every boot, so the install runs each time; the MSI itself is cached in the persistent tools
// folder. downloads.requireChecksum is honoured by the downloader (this entry has a checksum, so it always passes).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { downloader, spawnAsync } from '../../shared/download/index.js';
import { SYSTEM } from '../../shared/system.js';
import { dryRun, isWin, toolsDir } from '../runtime/paths.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log, warn } from '../runtime/log.js';
import { scriptOutput } from '../runtime/process.js';
import { OPENVPN_MSI } from '../../shared/vpn/download.js';

/** Where the MSI puts the program. */
export function openvpnExe(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.ProgramFiles ?? 'C:\\Program Files', 'OpenVPN', 'bin', 'openvpn.exe');
}

export function openvpnDownload(arch: string = process.arch): { file: string; sha256: string; url: string } {
  const entry = arch === 'arm64' ? OPENVPN_MSI.arm64 : OPENVPN_MSI.x64;
  return { ...entry, url: OPENVPN_MSI.base + entry.file };
}

/**
 * Windows Sandbox cannot answer WMI questions about services (a class whose provider is missing), and installers that
 * ask (OpenVPN's MSI does) fail with 1603: the dead class is removed first (repair-wmi-services.ps1). Never throws.
 */
export function repairServiceQueries(): void {
  const did = scriptOutput('repair-wmi-services.ps1');
  if (did === 'removed') log('VPN: repaired the Windows service queries installers use (a Windows Sandbox gap).');
  else if (did !== 'absent' && did !== 'kept') warn('VPN: could not check the Windows service queries installers use.');
}

const hasHash = (file: string, sha256: string): boolean =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === sha256;

/** Installs OpenVPN unless it is there; returns the path of openvpn.exe. Throws with the reason when it cannot. */
export async function ensureOpenVpn(): Promise<string> {
  const exe = openvpnExe();
  if (!isWin || dryRun) return exe;
  if (exists(exe)) return exe;
  const dl = openvpnDownload();
  const msi = path.join(mkdirp(path.join(toolsDir, 'downloads')), dl.file);
  // The tools folder lasts between sandboxes and the agent can write it: a cached file is trusted only by its hash.
  if (!exists(msi) || !hasHash(msi, dl.sha256)) {
    log('VPN: downloading OpenVPN ' + OPENVPN_MSI.version + ' (about 6 MB)');
    await downloader.file(dl.url, msi, dl.sha256);
  }
  repairServiceQueries();
  log('VPN: installing OpenVPN');
  const logFile = path.join(toolsDir, 'downloads', 'openvpn-install.log');
  const code = await spawnAsync(SYSTEM.msiexec(), ['/i', msi, '/qn', '/norestart', '/l*v', logFile], {
    stdio: 'ignore',
  });
  // 3010: installed, a restart is wanted (nothing here needs one).
  if (code !== 0 && code !== 3010)
    throw new Error('The OpenVPN installer failed (exit ' + code + '). Its log: ' + logFile);
  if (!exists(exe)) throw new Error('OpenVPN was installed but ' + exe + ' is missing. The installer log: ' + logFile);
  return exe;
}
