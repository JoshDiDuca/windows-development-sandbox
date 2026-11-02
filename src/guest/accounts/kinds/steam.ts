// Steam: SteamCMD's cached login goes into C:\SteamCMD\config (config.vdf and the ssfn sentry files), and comes back
// when SteamCMD renews it. Not available yet: the sign-in is not used.
import type { Payload } from '../../../shared/accounts/index.js';
import { notAvailableYet, type GuestAdapter } from '../adapter.js';

export const steamAdapter: GuestAdapter<'steam'> = {
  kind: 'steam',
  apply(_p: Payload<'steam'>) {
    return notAvailableYet('steam');
  },
};
