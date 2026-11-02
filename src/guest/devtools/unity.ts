// sbx-unity: install editors, list them, build with -executeMethod, the licence status. Not available yet.
import { notAvailableYet, type DevTool } from './devtool.js';

export const unityTool: DevTool = {
  name: 'unity',
  summary: 'install editors, list them, build with -executeMethod, the licence status',
  run: () => notAvailableYet('unity'),
};
