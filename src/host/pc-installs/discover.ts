// pcInstalls: this PC's games, engines and editors, found by each kind's source and mapped read-only under
// C:\PcInstalls (nothing is copied). Every folder is checked like any other mapping (never a whole drive, a user
// profile or this tool's own folders) and must exist. Yours only: these settings are never in a project file.
import type { Config, ResolvedMapping } from '../../core/types.js';
import { assertSafeMapping } from '../../core/safe-paths.js';
import { dirExists, errMsg } from '../../core/util/index.js';
import { pcInstallGuest, type PcInstall, type PcInstallManifest } from '../../shared/paths/index.js';
import { pcEnv, type PcEnv } from '../accounts/index.js';
import { epicInstalls } from './epic.js';
import type { PcInstallSource } from './source.js';
import { steamInstalls } from './steam.js';
import { unityInstalls } from './unity.js';
import { unrealInstalls } from './unreal.js';

export type PcInstalls = Config['pcInstalls'];

/** At most this many installs are mapped (each one is a mapping in the .wsb). */
export const MAX_PC_INSTALLS = 40;

export const PC_INSTALL_SOURCES: readonly PcInstallSource[] = [
  steamInstalls,
  epicInstalls,
  unrealInstalls,
  unityInstalls,
];

export interface DiscoverOptions {
  readonly packageRoot: string;
  readonly storageRoot: string;
  readonly sources?: readonly PcInstallSource[];
}

export interface DiscoveredInstalls {
  readonly mappings: ResolvedMapping[];
  readonly manifest: PcInstallManifest;
  readonly notes: string[];
}

export function discoverPcInstalls(s: PcInstalls, o: DiscoverOptions, pc: PcEnv = pcEnv()): DiscoveredInstalls {
  const mappings: ResolvedMapping[] = [];
  const items: Omit<PcInstall, 'host'>[] = [];
  const notes: string[] = [];
  for (const source of o.sources ?? PC_INSTALL_SOURCES) {
    const wanted = s[source.setting];
    if (wanted === false || (Array.isArray(wanted) && !wanted.length)) continue;
    let found: PcInstall[] = [];
    try {
      found = source.find(wanted, pc);
    } catch (e) {
      notes.push('pcInstalls.' + source.setting + ': could not look on this PC (' + errMsg(e) + ').');
      continue;
    }
    for (const install of found) {
      if (mappings.length >= MAX_PC_INSTALLS) {
        notes.push('pcInstalls: only the first ' + MAX_PC_INSTALLS + ' installs are mapped.');
        break;
      }
      try {
        const guest = pcInstallGuest(install.kind, install.id);
        if (mappings.some((m) => m.guest.toLowerCase() === guest.toLowerCase())) continue;
        if (!dirExists(install.host)) {
          notes.push('pcInstalls: ' + install.name + ' is not there any more (' + install.host + ').');
          continue;
        }
        assertSafeMapping(install.host, o.packageRoot, o.storageRoot);
        mappings.push({ host: install.host, guest, readOnly: true, label: 'this PC, read-only' });
        const { host: _host, ...shown } = install;
        items.push({ ...shown, guest });
      } catch (e) {
        notes.push('pcInstalls: ' + install.name + ' is not mapped: ' + errMsg(e));
      }
    }
    if (Array.isArray(wanted) && found.length < wanted.length)
      notes.push('pcInstalls.' + source.setting + ': some of the listed ones are not installed on this PC.');
  }
  return { mappings, manifest: { items }, notes };
}
