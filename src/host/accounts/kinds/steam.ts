// Steam: SteamCMD's cached login (config\config.vdf and the ssfn sentry files) from a steamcmd folder on this PC
// (`sandbox account import steam --from C:\steamcmd`); no password is ever kept. Not available yet.
import type { Payload } from '../../../shared/accounts/index.js';
import { notAvailableYet, type HostSource, type PcEnv } from '../source.js';

export const steamSource: HostSource<'steam'> = {
  fromPc(_pc: PcEnv, _from?: string): Payload<'steam'> | null {
    return notAvailableYet('steam');
  },
  summary: () => null,
};
