export { generateSandbox } from './generate.js';
export { decideProjectToolchains } from './toolchains.js';
export { hostToolsOf, logonEnv } from './session-file.js';
export {
  cappedMemoryMb,
  decideMemory,
  GUEST,
  memoryNote,
  residentCapMb,
  residentNote,
  resolveMemoryMb,
} from './wsb-file.js';
export { GENTLE_NOTE, vgpuSource, vgpuWarning } from './risk-notes.js';
export { buildLaunchPlan, buildWsb } from './launch-plan.js';
export { MAX_BOOT_PROJECTS, planBootProjects, shownByRoot, type BootProjects } from './boot-projects.js';
export { databaseCatalog, planDatabases } from './database-plan.js';
export { msvcHint, projectEntries, readProjectFiles, uvHint } from './project-scan.js';
export { hostDatabases, pcLanguages } from './pc-scan.js';
export { collectMappings } from './mappings.js';
export { RUNTIME_FILES, copyRuntime, gitIdentity, stageGitIdentity, stageHooks, stageScripts } from './stage.js';
