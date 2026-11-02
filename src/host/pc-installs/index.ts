// pcInstalls: this PC's games, engines and editors, mapped read-only into sandboxes (host side).
export {
  discoverPcInstalls,
  MAX_PC_INSTALLS,
  PC_INSTALL_SOURCES,
  type DiscoveredInstalls,
  type DiscoverOptions,
  type PcInstalls,
} from './discover.js';
export type { PcInstallSource } from './source.js';
export type { PcInstall, PcInstallManifest } from '../../shared/paths/index.js';
