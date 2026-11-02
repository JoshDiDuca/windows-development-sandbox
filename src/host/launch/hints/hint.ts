// The shape every hint module returns: an "auto" toolchain -> why the project uses it (turns it on like a marker file).
import type { AutoToolchain } from '../../../core/detect/index.js';

export type ToolchainHints = Partial<Record<AutoToolchain, string>>;
