// Unreal and Godot: toolchain hints from file contents: Godot's Android export (export_presets.cfg) turns android on,
// its C# (.csproj) dotnet. Files are found by name and size-checked before they are read (the project may be
// hostile). Not available yet: no hints.
import type { Toolchains } from '../../../core/types.js';
import type { ToolchainHints } from './hint.js';

export function engineHints(_root: string, _settings: Toolchains): ToolchainHints {
  return {};
}
