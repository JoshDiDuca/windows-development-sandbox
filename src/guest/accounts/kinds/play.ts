// Google Play: the service account key in secretDir('play') for the publishing tools. Not available yet: the sign-in
// is not used.
import type { Payload } from '../../../shared/accounts/index.js';
import { notAvailableYet, type GuestAdapter } from '../adapter.js';

export const playAdapter: GuestAdapter<'play'> = {
  kind: 'play',
  apply(_p: Payload<'play'>) {
    return notAvailableYet('play');
  },
};
