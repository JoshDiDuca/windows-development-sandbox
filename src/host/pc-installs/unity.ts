// Unity editors of this PC: Unity Hub's secondaryInstallPath.json and its default folder
// (C:\PcInstalls\unity\<version>). Not available yet: finds nothing.
import type { PcInstall } from '../../shared/paths/index.js';
import type { PcEnv } from '../accounts/index.js';
import type { PcInstallSource } from './source.js';

export const unityInstalls: PcInstallSource = {
  kind: 'unity',
  setting: 'unityEditors',
  find(_wanted: true | readonly (string | number)[], _pc: PcEnv): PcInstall[] {
    return [];
  },
};
