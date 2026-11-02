// Steam games of this PC: SteamPath from the registry (reg.exe through system32), libraryfolders.vdf and the app
// manifests. true maps each library's steamapps (C:\PcInstalls\steam\library<N>), a list of app IDs only those games
// (C:\PcInstalls\steam\<appid>). Not available yet: finds nothing.
import type { PcInstall } from '../../shared/paths/index.js';
import type { PcEnv } from '../accounts/index.js';
import type { PcInstallSource } from './source.js';

export const steamInstalls: PcInstallSource = {
  kind: 'steam-game',
  setting: 'steamGames',
  find(_wanted: true | readonly (string | number)[], _pc: PcEnv): PcInstall[] {
    return [];
  },
};
