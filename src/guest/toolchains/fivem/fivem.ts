// FiveM / RedM (toolchains.fivem): FXServer with txAdmin into tools\fivem\artifacts\<build>, txData in state\fivem,
// sbx-fivem. Not available yet.
import type { Toolchains } from '../../../core/types.js';
import { notAvailableYet } from '../not-yet.js';
import type { ToolCtx } from '../step.js';
import type { ToolEnv } from '../tool-env.js';

export async function setupFivem(env: ToolEnv, _config: Toolchains['fivem'], _ctx: ToolCtx): Promise<void> {
  notAvailableYet(env, 'FiveM server');
}
