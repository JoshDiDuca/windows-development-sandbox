// The Steam client (toolchains.steam.client): SteamSetup.exe (Valve-signed) unpacked into tools\steam, which updates
// itself; you sign in to it in each sandbox (its login is very likely tied to the Windows user). Not available yet.
import type { ToolEnv } from '../tool-env.js';

/** steam.exe ready to start, or null when it could not be set up. */
export async function ensureSteamClient(_env: ToolEnv): Promise<string | null> {
  return null;
}
