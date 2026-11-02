// Android: the SDK, signing keys, Google Play, Kotlin. A placeholder until that work lands: it checks only that the
// suite runs.
import type { Suite } from './support/suite.js';

export const androidSuite: Suite = {
  name: 'android',
  title: 'Android: the SDK, signing keys, Google Play, Kotlin (not available yet)',
  run: (t) => {
    t.check(true, 'android: not available yet');
  },
};
