// Every migration, oldest first. A new one is appended here; a shipped one is never edited or reordered.
import type { Migration } from './migration.js';
import { clipboardMode } from './migrations/clipboard-mode.js';
import { dropVsInstallFiles } from './migrations/drop-vs-install-files.js';
import { followMachineStorage } from './migrations/follow-machine-storage.js';
import { pinStorageRoot } from './migrations/pin-storage-root.js';
import { unpinConfigDefaults } from './migrations/unpin-config-defaults.js';

export const MIGRATIONS: readonly Migration[] = [
  unpinConfigDefaults,
  followMachineStorage,
  pinStorageRoot,
  dropVsInstallFiles,
  clipboardMode,
];
