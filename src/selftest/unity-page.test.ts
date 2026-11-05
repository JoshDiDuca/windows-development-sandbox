// The Unity page: a placeholder until that work lands; it checks only that the suite runs.
import type { Suite } from './support/suite.js';

export const unityPageSuite: Suite = {
  name: 'unity-page',
  title: 'The Unity page (pending)',
  run: (t) => {
    t.check(true, 'unity-page: pending');
  },
};
