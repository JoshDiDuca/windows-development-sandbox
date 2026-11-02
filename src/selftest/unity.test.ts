// Unity: editors, modules, the release API and the licence. A placeholder until that work lands: it checks only that
// the suite runs.
import type { Suite } from './support/suite.js';

export const unitySuite: Suite = {
  name: 'unity',
  title: 'Unity: editors, modules, the release API and the licence (not available yet)',
  run: (t) => {
    t.check(true, 'unity: not available yet');
  },
};
