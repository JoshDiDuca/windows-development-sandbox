export { type InstallScope, InstallLayout, compareVersions, VERSION_PATTERN, NODE_PATTERN } from './layout.js';
export { shimText, readBins, writeShims, removeStaleShims, REMOVED_COMMANDS } from './shims.js';
export { InstallRecordFile, InstallRecordSchema, type InstallRecord } from './install-record.js';
export { UpdateTask } from './scheduled-task.js';
export {
  machineInstall,
  userInstall,
  managedInstalls,
  describeCopy,
  hiddenInstallLine,
  takeHiddenInstallNotice,
} from './copies.js';
