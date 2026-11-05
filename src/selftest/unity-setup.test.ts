// Unity set-up on the data disk: a placeholder until that work lands; it checks only that the suite runs.
import type { Suite } from './support/suite.js';

export const unitySetupSuite: Suite = {
  name: 'unity-setup',
  title: 'Unity set-up on the data disk (pending)',
  run: (t) => {
    t.check(true, 'unity-setup: pending');
  },
};
