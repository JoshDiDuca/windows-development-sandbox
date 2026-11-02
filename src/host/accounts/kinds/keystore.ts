// Android upload keystore: the .jks you name, with its passwords and key alias typed. Not available yet.
import type { Payload } from '../../../shared/accounts/index.js';
import { notAvailableYet, type HostSource } from '../source.js';

export const keystoreSource: HostSource<'keystore'> = {
  fromFile(_bytes: Buffer, _answers: Readonly<Record<string, string>>): Payload<'keystore'> {
    return notAvailableYet('keystore');
  },
  summary: () => null,
};
