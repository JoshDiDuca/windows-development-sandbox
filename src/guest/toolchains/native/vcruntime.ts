// The Visual C++ runtime (vcruntime140.dll & co.) that PHP and other native tools need.
import fs from 'node:fs';
import path from 'node:path';
import { runInstaller } from '../../runtime/pools.js';
import { dryRun } from '../../runtime/paths.js';
import { exists } from '../../runtime/fs.js';
import { log } from '../../runtime/log.js';
import { downloadFile } from '../install.js';
import { SIGNERS, signedBy } from '../installers.js';
import { tool, type ToolEnv } from '../tool-env.js';

const VC_REDIST = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
/** 1638: a newer version is already installed; 3010: installed, a restart would finish it (not needed for the DLLs). */
const OK_EXIT_CODES: readonly number[] = [0, 1638, 3010];

/** Downloads the installer ahead of `setupVcRuntime` (nothing when the runtime or the installer is there). */
export async function fetchVcRuntime(): Promise<void> {
  const system32 = path.join(process.env.WINDIR ?? 'C:\Windows', 'System32');
  const installer = tool('vcredist', 'vc_redist.x64.exe');
  if (exists(installer) || exists(path.join(system32, 'vcruntime140.dll'))) return;
  await downloadFile(VC_REDIST, installer);
}

/**
 * A real installer (it writes to System32), so it runs on every boot; the installer itself is kept in persistent
 * storage and only run when Microsoft's signature on it checks out. Resolves true when this call ran the installer.
 * Only the "Visual C++ runtime" step reports it (`summary`); PHP calls it again just to be sure.
 */
export async function setupVcRuntime(env: ToolEnv, summary = true): Promise<boolean> {
  if (dryRun) {
    log('(dry run) would install the Visual C++ runtime');
    return false;
  }
  const system32 = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32');
  const missing = !exists(path.join(system32, 'vcruntime140.dll')) || !exists(path.join(system32, 'msvcp140.dll'));
  if (missing) {
    const installer = tool('vcredist', 'vc_redist.x64.exe');
    if (!exists(installer)) {
      log('Downloading the Visual C++ runtime (~25 MB once) ...');
      await downloadFile(VC_REDIST, installer);
    }
    if (!signedBy(installer, SIGNERS.microsoft)) {
      fs.rmSync(installer, { force: true });
      throw new Error('vc_redist.x64.exe is not signed by Microsoft; deleted it (it is downloaded again next boot)');
    }
    log('Installing the Visual C++ runtime ...');
    const code = await runInstaller(installer, ['/install', '/quiet', '/norestart']);
    if (!OK_EXIT_CODES.includes(code ?? -1) || !exists(path.join(system32, 'vcruntime140.dll')))
      throw new Error('the Visual C++ runtime installer failed (exit ' + code + ')');
  }
  if (summary) env.summary.push('vc++ runtime: installed');
  return missing;
}
