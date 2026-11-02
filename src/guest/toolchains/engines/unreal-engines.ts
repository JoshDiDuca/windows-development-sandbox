// Unreal engines: the Epic Games Launcher's install folder in tools\unreal\engines (persistEngines), its manifests
// and LauncherInstalled.dat restored every boot, engines from pcInstalls listed, the derived data cache in
// tools\unreal\ddc (UE-LocalDataCachePath). Not available yet.
import type { Toolchains } from '../../../core/types.js';
import { notAvailableYet } from '../not-yet.js';
import type { ToolCtx } from '../step.js';
import type { ToolEnv } from '../tool-env.js';

export async function setupUnrealEngines(env: ToolEnv, _config: Toolchains['unreal'], _ctx: ToolCtx): Promise<void> {
  notAvailableYet(env, 'Unreal engines');
}
