export type { SandboxEngine } from './engine.js';
export type {
  EngineCapabilities,
  EngineCheck,
  EngineId,
  EnginePlan,
  LaunchDevices,
  LaunchPlan,
  RunningSandbox,
} from './types.js';
export { engineFor, engineReports, openEngine, type EngineReport } from './registry.js';
export { WindowsSandboxEngine } from './windows-sandbox/engine.js';
export { wsbText } from './windows-sandbox/wsb-text.js';
export { HcsEngine, HCS_CAPABILITIES, hcsStartEnabled } from './hcs/engine.js';
export { checkHcs, realHcsProbes, type HcsProbes } from './hcs/check.js';
export {
  lookForLeftovers,
  stopLeftovers,
  LEFTOVER_DEPS,
  type LeftoverDeps,
  type LeftoverLook,
  type LeftoverOutcome,
  type LeftoverSystem,
} from './hcs/leftovers.js';
export {
  LiveFolders,
  ScriptLivePort,
  clearLiveRecord,
  realLiveFolders,
  liveRecordFile,
  LIVE_FOLDERS_WARNING,
  type LiveRecord,
  type LiveShare,
  type LiveShareRequest,
  type LiveOutcome,
  type ElevatedLivePort,
  type LiveRunner,
} from './hcs/live-folders.js';
