// Flutter, Dart and React Native: toolchain hints from file contents: a pubspec.yaml with a flutter: section
// (flutter) or without (dart); package.json depending on react-native or expo. Files are found by name and
// size-checked before they are read (the project may be hostile). Not available yet: no hints.
import type { Toolchains } from '../../../core/types.js';
import type { ToolchainHints } from './hint.js';

export function mobileHints(_root: string, _settings: Toolchains): ToolchainHints {
  return {};
}
