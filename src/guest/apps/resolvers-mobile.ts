// Where the latest version of the mobile apps (catalogue-mobile.ts) is, when it is not a plain GitHub release. None
// yet.
import type { Download } from './resolvers.js';

export const MOBILE_RESOLVERS: Readonly<Record<string, () => Promise<Download>>> = {};
