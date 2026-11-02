// Epic Games Launcher games of this PC: the manifests in %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item
// (C:\PcInstalls\epic\<AppName>). Not available yet: finds nothing.
import type { PcInstall } from '../../shared/paths/index.js';
import type { PcEnv } from '../accounts/index.js';
import type { PcInstallSource } from './source.js';

export const epicInstalls: PcInstallSource = {
  kind: 'epic-game',
  setting: 'epicGames',
  find(_wanted: true | readonly (string | number)[], _pc: PcEnv): PcInstall[] {
    return [];
  },
};
