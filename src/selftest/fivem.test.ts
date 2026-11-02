// FiveM / RedM: server builds, the Cfx.re key, sbx-fivem. A placeholder until that work lands: it checks only that
// the suite runs.
import type { Suite } from './support/suite.js';

export const fivemSuite: Suite = {
  name: 'fivem',
  title: 'FiveM / RedM: server builds, the Cfx.re key, sbx-fivem (not available yet)',
  run: (t) => {
    t.check(true, 'fivem: not available yet');
  },
};
