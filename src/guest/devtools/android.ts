// sbx-android: the SDK, devices, connect to a device over the network. Not available yet.
import { notAvailableYet, type DevTool } from './devtool.js';

export const androidTool: DevTool = {
  name: 'android',
  summary: 'the SDK, devices, connect to a device over the network',
  run: () => notAvailableYet('android'),
};
