// Expo: EXPO_TOKEN for eas-cli in the agent's sessions. Not available yet: the sign-in is not used.
import type { Payload } from '../../../shared/accounts/index.js';
import { notAvailableYet, type GuestAdapter } from '../adapter.js';

export const expoAdapter: GuestAdapter<'expo'> = {
  kind: 'expo',
  apply(_p: Payload<'expo'>) {
    return notAvailableYet('expo');
  },
};
