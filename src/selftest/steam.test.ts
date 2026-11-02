// Steam: SteamCMD, sbx-steam, the VDF parser, the Steam sign-in and PC libraries. A placeholder until that work
// lands: it checks only that the suite runs.
import type { Suite } from './support/suite.js';

export const steamSuite: Suite = {
  name: 'steam',
  title: 'Steam: SteamCMD, sbx-steam, the VDF parser, the Steam sign-in and PC libraries (not available yet)',
  run: (t) => {
    t.check(true, 'steam: not available yet');
  },
};
