// sbx-steam: log in to SteamCMD, download apps and workshop items, upload builds and workshop items. Not available yet.
import { notAvailableYet, type DevTool } from './devtool.js';

export const steamTool: DevTool = {
  name: 'steam',
  summary: 'log in to SteamCMD, download apps and workshop items, upload builds and workshop items',
  run: () => notAvailableYet('steam'),
};
