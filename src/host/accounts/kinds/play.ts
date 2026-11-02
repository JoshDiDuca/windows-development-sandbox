// Google Play: a service account key file (JSON) you name. Not available yet.
import type { Payload } from '../../../shared/accounts/index.js';
import { notAvailableYet, type HostSource } from '../source.js';

export const playSource: HostSource<'play'> = {
  fromFile(_bytes: Buffer, _answers: Readonly<Record<string, string>>): Payload<'play'> {
    return notAvailableYet('play');
  },
  summary: () => null,
};
