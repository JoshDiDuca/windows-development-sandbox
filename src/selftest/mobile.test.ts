// Flutter, Dart, React Native / Expo and App Store Connect. A placeholder until that work lands: it checks only that
// the suite runs.
import type { Suite } from './support/suite.js';

export const mobileSuite: Suite = {
  name: 'mobile',
  title: 'Flutter, Dart, React Native / Expo and App Store Connect (not available yet)',
  run: (t) => {
    t.check(true, 'mobile: not available yet');
  },
};
