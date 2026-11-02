// sbx-fivem: start the FiveM / RedM server, pick a server build, make a new resource. Not available yet.
import { notAvailableYet, type DevTool } from './devtool.js';

export const fivemTool: DevTool = {
  name: 'fivem',
  summary: 'start the FiveM / RedM server, pick a server build, make a new resource',
  run: () => notAvailableYet('fivem'),
};
