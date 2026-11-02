// Toolchain hints from file contents, one module per area: what file names alone cannot tell (core/detect MARKERS).
import type { Toolchains } from '../../../core/types.js';
import { androidHints } from './android.js';
import { engineHints } from './engines.js';
import { fivemHints } from './fivem.js';
import type { ToolchainHints } from './hint.js';
import { mobileHints } from './mobile.js';
import { steamHints } from './steam.js';

export type { ToolchainHints } from './hint.js';

const AREAS: readonly ((root: string, settings: Toolchains) => ToolchainHints)[] = [
  steamHints,
  engineHints,
  fivemHints,
  androidHints,
  mobileHints,
];

/** Every area's hints for this project; the first reason found for a toolchain wins. A failing area adds none. */
export function areaHints(root: string, settings: Toolchains): ToolchainHints {
  const all: ToolchainHints = {};
  for (const area of AREAS) {
    let found: ToolchainHints = {};
    try {
      found = area(root, settings);
    } catch {
      // A file that cannot be read gives no hint; the toolchain stays as its settings and markers say.
    }
    for (const [name, reason] of Object.entries(found) as [keyof ToolchainHints, string][])
      if (reason && !all[name]) all[name] = reason;
  }
  return all;
}
