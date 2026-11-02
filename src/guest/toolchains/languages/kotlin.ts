// Kotlin (toolchains.java.kotlin): kotlinc from JetBrains' releases (checked against its digest) in tools\kotlin, on
// PATH. Gradle builds fetch their own Kotlin. Not available yet.
import { notAvailableYet } from '../not-yet.js';
import type { ToolCtx } from '../step.js';
import type { ToolEnv } from '../tool-env.js';

export async function setupKotlin(env: ToolEnv, _ctx: ToolCtx): Promise<void> {
  notAvailableYet(env, 'Kotlin');
}
