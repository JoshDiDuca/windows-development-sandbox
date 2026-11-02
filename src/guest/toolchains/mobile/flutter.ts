// Flutter (toolchains.flutter): the release from releases_windows.json (SHA-256) for .fvmrc or the channel, precache,
// the Android SDK, Visual Studio Build Tools for Windows desktop. Not available yet.
import type { Toolchains } from '../../../core/types.js';
import { notAvailableYet } from '../not-yet.js';
import type { ToolCtx } from '../step.js';
import type { ToolEnv } from '../tool-env.js';

export async function setupFlutter(env: ToolEnv, _config: Toolchains['flutter'], _ctx: ToolCtx): Promise<void> {
  notAvailableYet(env, 'Flutter');
}
