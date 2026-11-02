// Steam (toolchains.steam): SteamCMD in C:\SteamCMD each boot (binaries kept in tools\steamcmd), steamcmd on PATH,
// the Steam client when asked, STEAMWORKS_SDK from sdkFolder. Not available yet.
import type { Toolchains } from '../../../core/types.js';
import { notAvailableYet } from '../not-yet.js';
import type { ToolCtx } from '../step.js';
import type { ToolEnv } from '../tool-env.js';

export async function setupSteam(env: ToolEnv, _config: Toolchains['steam'], _ctx: ToolCtx): Promise<void> {
  notAvailableYet(env, 'Steam');
}
