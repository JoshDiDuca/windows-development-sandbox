// App Store Connect: the API key (.p8) you name, with its issuer ID and key ID typed. Not available yet.
import type { Payload } from '../../../shared/accounts/index.js';
import { notAvailableYet, type HostSource } from '../source.js';

export const appstoreSource: HostSource<'appstore'> = {
  fromFile(_bytes: Buffer, _answers: Readonly<Record<string, string>>): Payload<'appstore'> {
    return notAvailableYet('appstore');
  },
  fromAnswers(_answers: Readonly<Record<string, string>>): Payload<'appstore'> {
    return notAvailableYet('appstore');
  },
  summary: () => null,
};
