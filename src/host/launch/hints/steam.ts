// Steam: toolchain hints from file contents: a .vdf with "AppBuild" or "workshopitem" turns toolchains.steam on.
// Files are found by name and size-checked before they are read (the project may be hostile). Not available yet: no
// hints.
import type { Toolchains } from '../../../core/types.js';
import type { ToolchainHints } from './hint.js';

export function steamHints(_root: string, _settings: Toolchains): ToolchainHints {
  return {};
}
