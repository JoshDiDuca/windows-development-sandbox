// Godot (toolchains.godot): the official build (and its .NET build) from godot-builds with its SHA512-SUMS,
// self-contained in tools\godot\<version>, godot on PATH, export templates, the Android SDK and JDK in its editor
// settings. Not available yet.
import type { Toolchains } from '../../../core/types.js';
import { notAvailableYet } from '../not-yet.js';
import type { ToolCtx } from '../step.js';
import type { ToolEnv } from '../tool-env.js';

export async function setupGodot(env: ToolEnv, _config: Toolchains['godot'], _ctx: ToolCtx): Promise<void> {
  notAvailableYet(env, 'Godot');
}
