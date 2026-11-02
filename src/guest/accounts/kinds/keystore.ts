// Android upload keystore: the .jks in secretDir('keystore') and the signing variables for Gradle. Not available yet:
// the sign-in is not used.
import type { Payload } from '../../../shared/accounts/index.js';
import { notAvailableYet, type GuestAdapter } from '../adapter.js';

export const keystoreAdapter: GuestAdapter<'keystore'> = {
  kind: 'keystore',
  apply(_p: Payload<'keystore'>) {
    return notAvailableYet('keystore');
  },
};
