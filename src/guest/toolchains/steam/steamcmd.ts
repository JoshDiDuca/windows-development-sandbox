// SteamCMD: steamcmd.zip from Valve's CDN (no checksum published: steamcmd.exe must be Valve-signed), its binaries
// kept in tools\steamcmd and copied to C:\SteamCMD each boot (its config\ holds the login, which never sits on the
// data disk). Not available yet.
import type { ToolEnv } from '../tool-env.js';

/** Where SteamCMD runs from in the sandbox (its own disk). */
export const STEAMCMD_DIR = 'C:\\SteamCMD';

/** steamcmd.exe ready to run, or null when it could not be set up. */
export async function ensureSteamCmd(_env: ToolEnv): Promise<string | null> {
  return null;
}
