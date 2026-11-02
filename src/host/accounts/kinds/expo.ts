// Expo: an access token (EXPO_TOKEN), typed. Not available yet.
import type { Payload } from '../../../shared/accounts/index.js';
import { notAvailableYet, type HostSource } from '../source.js';

export const expoSource: HostSource<'expo'> = {
  fromAnswers(_answers: Readonly<Record<string, string>>): Payload<'expo'> {
    return notAvailableYet('expo');
  },
  summary: () => null,
};
