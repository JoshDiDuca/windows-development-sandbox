// Unity licence and sign-in: a placeholder until that work lands; it checks only that the suite runs.
import type { Suite } from './support/suite.js';

export const unityAccountsSuite: Suite = {
  name: 'unity-accounts',
  title: 'Unity licence and sign-in (pending)',
  run: (t) => {
    t.check(true, 'unity-accounts: pending');
  },
};
