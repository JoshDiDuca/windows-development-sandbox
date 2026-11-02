// Unity (toolchains.unity): the editor version of ProjectVersion.txt from the release API (SRI integrity), the signed
// installer unpacked into tools\unity\<version>, its modules, Unity Hub when asked. Not available yet.
import type { Toolchains } from '../../../core/types.js';
import { notAvailableYet } from '../not-yet.js';
import type { ToolCtx } from '../step.js';
import type { ToolEnv } from '../tool-env.js';

export async function setupUnity(env: ToolEnv, _config: Toolchains['unity'], _ctx: ToolCtx): Promise<void> {
  notAvailableYet(env, 'Unity');
}
