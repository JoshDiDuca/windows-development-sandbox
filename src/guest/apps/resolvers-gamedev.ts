// Where the latest version of the game-development apps (catalogue-gamedev.ts) is, when it is not a plain GitHub
// release. None yet.
import type { Download } from './resolvers.js';

export const GAMEDEV_RESOLVERS: Readonly<Record<string, () => Promise<Download>>> = {};
