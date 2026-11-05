// The Perplexity desktop app (a Microsoft Store package, Electron inside) in this sandbox: the profile folder it runs
// with, the command line of its shortcut, and its sign-in over the DevTools port, the way Comet's is kept
// (browser/comet.ts): only the allow-listed perplexity.ai cookies are read (Network.getCookies) and written back
// (Storage.setCookies). The profile is on the sandbox's own disk: its cookie key is sealed to this sandbox's Windows
// user, which is why the sign-in is not copied from the PC. No runtime imports: the sign-in adapter and the self-test
// load this file.
import fs from 'node:fs';
import path from 'node:path';
import { cookiesToRestore, type CometPayload } from '../../shared/accounts/kinds/comet.js';
import { PERPLEXITY_DESKTOP_PACKAGE } from '../../shared/apps/catalogue-agents-web.js';
import { localAppData } from '../accounts/adapter.js';
import { connect, readCometSignIn } from './comet.js';

/** The app's profile: on the sandbox's own disk, wiped with it. */
export function perplexityAppProfileDir(): string {
  return path.join(localAppData(), 'AgentSandbox', 'perplexity-app-profile');
}

/**
 * The powershell.exe arguments of the app's shortcut: start-store-app.ps1 with the package, the profile and a free
 * DevTools port (0). `script` is the full path of the script in the launch folder.
 */
export function perplexityAppShortcutArgs(script: string, profile: string = perplexityAppProfileDir()): string {
  return [
    '-NoLogo',
    '-NoProfile',
    '-WindowStyle',
    'Hidden',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    '"' + script + '"',
    '-PackageName',
    PERPLEXITY_DESKTOP_PACKAGE,
    '-UserDataDir',
    '"' + profile + '"',
    '-Port',
    '0',
  ].join(' ');
}

/** The sign-in the running app holds now, or null (not running with this profile, no page, signed out). */
export function readAppSignIn(profile: string = perplexityAppProfileDir()): Promise<CometPayload | null> {
  return readCometSignIn(profile);
}

/** Writes the sign-in into the running app; false when the app is not running with this profile. */
export async function restoreAppSignIn(
  payload: CometPayload,
  profile: string = perplexityAppProfileDir(),
): Promise<boolean> {
  const cookies = cookiesToRestore(payload, Math.floor(Date.now() / 1000));
  if (!cookies.length) return true;
  if (!fs.existsSync(path.join(profile, 'DevToolsActivePort'))) return false;
  const cdp = await connect(profile);
  if (!cdp) return false;
  try {
    await cdp.call('Storage.setCookies', { cookies });
    return true;
  } finally {
    cdp.close();
  }
}
