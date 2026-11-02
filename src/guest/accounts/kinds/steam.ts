// Steam: SteamCMD's cached login goes into C:\SteamCMD\config (config.vdf, the account name) and the ssfn sentry files
// beside steamcmd.exe, on the sandbox's own disk, before the Steam step copies SteamCMD's binaries in (that copy never
// touches config\). The watch reads it back when SteamCMD renews it, or after a first `sbx-steam login` here.
import { readSteamCmdLogin, writeSteamCmdLogin, type SteamPayload } from '../../../shared/accounts/kinds/steam.js';
import { STEAMCMD_DIR } from '../../toolchains/steam/commands.js';
import type { GuestAdapter } from '../adapter.js';

/** The adapter for a SteamCMD folder (the self-test passes its own). */
export function steamAdapterFor(steamcmdDir: string): GuestAdapter<'steam'> {
  return {
    kind: 'steam',
    apply(p: SteamPayload) {
      writeSteamCmdLogin(steamcmdDir, p);
      return { summary: 'SteamCMD: signed in as ' + p.account + ' with your saved sign-in' };
    },
    current: () => readSteamCmdLogin(steamcmdDir),
  };
}

export const steamAdapter: GuestAdapter<'steam'> = steamAdapterFor(STEAMCMD_DIR);
