// A project's .sandbox-config.json: validated against the LocalOverrides schema (a safe subset of settings), applied
// over the user config, and only used once you have approved this exact version of the file.
export { LOCAL_CONFIG_NAME, readLocalConfig } from './file.js';
export {
  normalizeOverrides,
  ON_IS_SAFER,
  OFF_IS_SAFER,
  GIT_STRICTNESS,
  CLIPBOARD_STRICTNESS,
  RANKED,
  DIRECTION_SETTING,
  strictness,
  NEVER_LOOSER,
  loosenedRequests,
  applyOverrides,
  describeOverrides,
  allowRequests,
  outsideMappings,
  insideProject,
} from './overrides.js';
export {
  trustStorePath,
  isTrusted,
  saveTrust,
  allowStorePath,
  allowedAnswer,
  saveAllowed,
  OUTSIDE_FOLDER,
  outsideKey,
} from './trust.js';
export * from './policy.js';
export * from './boot-wants.js';
