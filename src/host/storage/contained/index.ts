export { CONTAINED_FOLDERS, containedMappings, containedPaths, setNameOf, type ContainedFolder } from './layout.js';
export type { ContainedPaths } from './layout.js';
export { ContainedStorage, type ContainedDeps, type HolderId, type ReleaseResult } from './contained-storage.js';
export { ScriptDiskPort, spawnRunner, type DiskPort, type MountRequest, type ScriptOutcome } from './disk-port.js';
export {
  HELPER_PIPE,
  HelperAnswerSchema,
  HelperDiskPort,
  helperApplies,
  HelperRequestSchema,
  pipeConnector,
  readAnswer,
  samePaths,
  type PipeConnector,
  type PipeResult,
} from './helper-port.js';
export { containedAvailability, containedFacts, type ContainedFacts } from './check.js';
export { hostDataFolder, hostDataRoot } from './resolve.js';
export { writeContainedSetting } from './setting.js';
export {
  addHolder,
  diagnose,
  markMounted,
  mountedSets,
  staleMountNote,
  pruneHolders,
  removeHolder,
  setStateOf,
  StateFile,
  type ContainedDiagnosis,
  type MountReality,
} from './state.js';
export { assertTargetsFree, planTransfer, runTransfer, type TransferPlan, type TransferResult } from './transfer.js';
