// Cfx.re: a FiveM / RedM server licence key (and an optional Steam Web API key), typed. Not available yet.
import type { Payload } from '../../../shared/accounts/index.js';
import { notAvailableYet, type HostSource } from '../source.js';

export const cfxSource: HostSource<'cfx'> = {
  fromAnswers(_answers: Readonly<Record<string, string>>): Payload<'cfx'> {
    return notAvailableYet('cfx');
  },
  summary: () => null,
};
