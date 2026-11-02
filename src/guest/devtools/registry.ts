// Every sbx-<name> helper, and which of them a sandbox gets (the toolchain each one serves is on).
import type { Toolchains } from '../../core/types.js';
import { androidTool } from './android.js';
import type { DevTool } from './devtool.js';
import { fivemTool } from './fivem.js';
import { steamTool } from './steam.js';
import { unityTool } from './unity.js';

export const DEVTOOLS: readonly DevTool[] = [steamTool, fivemTool, unityTool, androidTool];

/** The helpers for the toolchains that are on (resolved by the host; "auto" counts as off here). */
export function devToolsFor(t: Toolchains): DevTool[] {
  return DEVTOOLS.filter((tool) => t[tool.name].enabled === true);
}

export function devToolByName(name: string): DevTool | undefined {
  return DEVTOOLS.find((t) => t.name === name);
}
