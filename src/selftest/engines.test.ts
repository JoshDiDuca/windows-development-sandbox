// Unreal engines, Godot and the game-development apps. A placeholder until that work lands: it checks only that the
// suite runs.
import type { Suite } from './support/suite.js';

export const enginesSuite: Suite = {
  name: 'engines',
  title: 'Unreal engines, Godot and the game-development apps (not available yet)',
  run: (t) => {
    t.check(true, 'engines: not available yet');
  },
};
