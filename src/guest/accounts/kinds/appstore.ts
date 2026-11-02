// App Store Connect: the .p8 in secretDir('appstore') and the EXPO_ASC_* variables. Not available yet: the sign-in is
// not used.
import type { Payload } from '../../../shared/accounts/index.js';
import { notAvailableYet, type GuestAdapter } from '../adapter.js';

export const appstoreAdapter: GuestAdapter<'appstore'> = {
  kind: 'appstore',
  apply(_p: Payload<'appstore'>) {
    return notAvailableYet('appstore');
  },
};
