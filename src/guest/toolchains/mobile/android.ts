// The Android SDK (toolchains.android) in tools\android-sdk: cmdline-tools (SHA-1 from the repository XML), then
// sdkmanager with the licences accepted for the platforms, build-tools, NDK and CMake the project needs; ANDROID_HOME,
// ANDROID_USER_HOME in state\android, AndroidSdkDirectory and JavaSdkDirectory. Flutter, React Native, Godot and Unity
// call ensureAndroidSdk. Not available yet.
import type { Toolchains } from '../../../core/types.js';
import { notAvailableYet } from '../not-yet.js';
import type { ToolCtx } from '../step.js';
import type { ToolEnv } from '../tool-env.js';

export interface AndroidSdkRequest {
  readonly packages: readonly string[];
  readonly ndk?: string | 'auto' | false;
}

export interface AndroidSdk {
  readonly root: string;
  readonly javaHome: string | null;
  readonly installed: readonly string[];
}

/** The SDK with these packages installed. */
export async function ensureAndroidSdk(_env: ToolEnv, _req: AndroidSdkRequest): Promise<AndroidSdk> {
  throw new Error('the Android SDK is not available yet');
}

/** The variables builds need to find the SDK and its JDK. */
export function androidEnv(sdk: AndroidSdk): Record<string, string> {
  return {
    ANDROID_HOME: sdk.root,
    ANDROID_SDK_ROOT: sdk.root,
    ...(sdk.javaHome ? { JAVA_HOME: sdk.javaHome } : {}),
  };
}

export async function setupAndroid(env: ToolEnv, _config: Toolchains['android'], _ctx: ToolCtx): Promise<void> {
  notAvailableYet(env, 'Android SDK');
}
