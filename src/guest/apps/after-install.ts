import fs from 'node:fs';
import path from 'node:path';
import type { AppEntry } from '../../shared/apps/index.js';
import { SYSTEM } from '../../shared/system.js';
import { errMsg } from '../../core/util/errors.js';
import { takePendingComet } from '../accounts/kinds/comet.js';
import { restoreCometSignIn } from '../browser/comet.js';
import { log, warn } from '../runtime/log.js';
import { execAsync } from '../runtime/process.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { arch, tool } from '../toolchains/tool-env.js';

/** The Sysinternals tools whose EULA is accepted up front (each asks once otherwise). */
const SYSINTERNALS_TOOLS = [
  'Process Explorer',
  'Process Monitor',
  'Autoruns',
  'TCPView',
  'PsExec',
  'PsList',
  'PsKill',
  'Handle',
  'ListDLLs',
  'Sigcheck',
  'Strings',
  'VMMap',
  'RAMMap',
  'DebugView',
  'Disk2vhd',
  'Du',
  'ZoomIt',
] as const;

/** Your saved Comet sign-in (handed over at boot) goes into Comet's profile now that Comet is there. */
async function restoreComet(exe: string): Promise<void> {
  const pending = takePendingComet();
  if (!pending) return;
  try {
    const written = await restoreCometSignIn(exe, pending);
    log('Comet: your saved sign-in is in its profile (' + written + ' cookies).');
  } catch (e) {
    warn('Comet: your saved sign-in could not be put into its profile (' + errMsg(e) + '); sign in again in Comet.');
  }
}

/** Settings an app needs on every boot (the sandbox's registry is new each time), and files next to its program. */
export async function afterInstall(entry: AppEntry, exe: string): Promise<void> {
  const dir = path.dirname(exe);
  if (entry.needs?.includes('mesa')) {
    const mesa = tool('mesa', arch === 'arm64' ? 'arm64' : 'x64');
    for (const dll of ['opengl32.dll', 'libgallium_wgl.dll', 'dxil.dll']) {
      if (exists(path.join(mesa, dll)) && !exists(path.join(dir, dll)))
        fs.copyFileSync(path.join(mesa, dll), path.join(dir, dll));
    }
  }
  // Godot and Sublime keep their settings next to the program instead of in the profile, which is wiped on close.
  if (entry.id === 'godot' && !exists(path.join(dir, '._sc_'))) fs.writeFileSync(path.join(dir, '._sc_'), '');
  if (entry.id === 'sublime') mkdirp(path.join(dir, 'Data'));
  if (entry.id === 'comet') await restoreComet(exe);
  if (entry.id === 'sysinternals') {
    for (const name of SYSINTERNALS_TOOLS) {
      await execAsync(
        SYSTEM.reg(),
        ['add', 'HKCU\\Software\\Sysinternals\\' + name, '/v', 'EulaAccepted', '/t', 'REG_DWORD', '/d', '1', '/f'],
        { stdio: 'ignore' },
      ).catch(() => undefined);
    }
  }
}
