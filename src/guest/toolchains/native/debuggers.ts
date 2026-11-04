// The Windows SDK's Debugging Tools (cdb, windbg, kd) for reading Unreal crash dumps: not part of the SDK Visual Studio
// installs, so the Windows SDK installer (downloaded once into tools\visualstudio, Microsoft's signature checked) adds
// only that feature into the SDK the registry names (KitsRoot10). Visual Studio kept on the data disk has its SDK
// there, so the debuggers are installed once and come back with it (~45 s, 370 MB).
import path from 'node:path';
import { SYSTEM } from '../../../shared/system.js';
import { runInstaller } from '../../runtime/pools.js';
import { execOutput } from '../../runtime/process.js';
import { exists } from '../../runtime/fs.js';
import { log } from '../../runtime/log.js';
import { SIGNERS, signedInstaller } from '../installers.js';
import { tool } from '../tool-env.js';

/** The Windows SDK 10.0.22621 installer (the SDK version Visual Studio's Unreal components install). */
const SDK_SETUP_URL = 'https://go.microsoft.com/fwlink/?linkid=2311806';
const SDK_SETUP = tool('visualstudio', 'winsdksetup-22621.exe');

/** KitsRoot10 from the registry (64-bit view), or null. */
export function kitsRoot(): string | null {
  const out = execOutput(SYSTEM.reg(), [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots',
    '/v',
    'KitsRoot10',
    '/reg:64',
  ]);
  const m = /KitsRoot10\s+REG_SZ\s+(.+)$/im.exec(out);
  return m ? m[1].trim() : null;
}

/** The debuggers' x64 folder when cdb.exe is in it, else null. */
export function debuggersDir(root = kitsRoot()): string | null {
  if (!root) return null;
  const dir = path.join(root, 'Debuggers', 'x64');
  return exists(path.join(dir, 'cdb.exe')) ? dir : null;
}

/** The debuggers' folder, installed with the SDK installer when missing; null when there is no SDK to add them to. */
export async function ensureDebuggers(): Promise<string | null> {
  const root = kitsRoot();
  if (!root) return null;
  const have = debuggersDir(root);
  if (have) return have;
  const setup = await signedInstaller(
    SDK_SETUP_URL,
    SDK_SETUP,
    'the Windows SDK installer, for its debuggers (~1.5 MB, then ~100 MB)',
    SIGNERS.microsoft,
  );
  log('Installing the Windows SDK debuggers (cdb, windbg) into ' + root + ' ...');
  const code = await runInstaller(setup, [
    '/features',
    'OptionId.WindowsDesktopDebuggers',
    '/quiet',
    '/norestart',
    '/ceip',
    'off',
  ]);
  const dir = debuggersDir(root);
  if (!dir) throw new Error('the Windows SDK installer did not add the debuggers (exit ' + code + ')');
  return dir;
}
