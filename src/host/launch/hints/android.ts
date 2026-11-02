// Android: toolchain hints from file contents: Gradle's com.android plugin or an AndroidManifest.xml up to 3 folders
// down, and <UseMaui> (android, dotnet). Files are found by name and size-checked before they are read (the project
// may be hostile). Not available yet: no hints.
import type { Toolchains } from '../../../core/types.js';
import type { ToolchainHints } from './hint.js';

export function androidHints(_root: string, _settings: Toolchains): ToolchainHints {
  return {};
}
