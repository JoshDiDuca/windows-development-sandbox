// SteamCMD: steamcmd.zip from Valve's CDN (no checksum published: steamcmd.exe must be Valve-signed), its binaries
// kept in tools\steamcmd and copied to C:\SteamCMD each boot (its config\ holds the login, which never sits on the
// data disk). The work itself is in steamcmd-install.ts; this file gives it the sandbox's log and signer check.
import { errMsg } from '../../../core/util/errors.js';
import { log } from '../../runtime/log.js';
import { SIGNERS, signedBy } from '../installers.js';
import type { ToolEnv } from '../tool-env.js';
import { prepareSteamCmd } from './steamcmd-install.js';

export { STEAMCMD_DIR } from './commands.js';

/** steamcmd.exe ready to run; throws with the reason when it cannot be set up. */
export function installSteamCmd(): Promise<string> {
  return prepareSteamCmd({ signed: (file) => signedBy(file, SIGNERS.valve), log });
}

/** steamcmd.exe ready to run, or null when it could not be set up (the reason is in the log and the summary). */
export async function ensureSteamCmd(env: ToolEnv): Promise<string | null> {
  try {
    return await installSteamCmd();
  } catch (e) {
    log('SteamCMD: not set up: ' + errMsg(e));
    env.summary.push('steamcmd: not set up (' + errMsg(e) + ')');
    return null;
  }
}
