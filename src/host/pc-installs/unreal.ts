// Unreal Engine versions of this PC: LauncherInstalled.dat and HKCU\Software\Epic Games\Unreal Engine\Builds
// (C:\PcInstalls\unreal\<UE_x>). Not available yet: finds nothing.
import type { PcInstall } from '../../shared/paths/index.js';
import type { PcEnv } from '../accounts/index.js';
import type { PcInstallSource } from './source.js';

export const unrealInstalls: PcInstallSource = {
  kind: 'unreal',
  setting: 'unrealEngines',
  find(_wanted: true | readonly (string | number)[], _pc: PcEnv): PcInstall[] {
    return [];
  },
};
