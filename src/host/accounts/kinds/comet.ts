// Comet: nothing to take from this PC. Its sign-in there is sealed to your Windows account (and reading another
// browser's cookies is what password stealers do), so it only ever comes from a sandbox you signed in in.
import { cometSummary } from '../../../shared/accounts/index.js';
import type { HostSource } from '../source.js';

export const cometSource: HostSource<'comet'> = {
  summary: (p) => cometSummary(p),
};
