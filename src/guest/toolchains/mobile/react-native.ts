// React Native / Expo (toolchains.reactNative): the Android SDK and JDK for Android builds, eas-cli as a global npm
// package. Not available yet.
import type { Toolchains } from '../../../core/types.js';
import { notAvailableYet } from '../not-yet.js';
import type { ToolCtx } from '../step.js';
import type { ToolEnv } from '../tool-env.js';

export async function setupReactNative(env: ToolEnv, _config: Toolchains['reactNative'], _ctx: ToolCtx): Promise<void> {
  notAvailableYet(env, 'React Native');
}
