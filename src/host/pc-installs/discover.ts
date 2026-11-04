// pcInstalls: this PC's games, engines and editors, found by each kind's source and mapped under C:\PcInstalls
// (nothing is copied): read-only, apart from the engine folders you registered (pcInstalls.unrealEngineFolders).
// Every folder is checked like any other mapping (never a whole drive, a user profile or this tool's own folders) and
// must exist. Yours only: these settings are never in a project file. pcInstalls.unrealEngines "auto" maps the
// engines when this launch sets the sandbox up for Unreal.
import type { Config, ResolvedMapping } from '../../core/types.js';
import { assertSafeMapping } from '../../core/safe-paths.js';
import { dirExists, errMsg } from '../../core/util/index.js';
import { pcInstallGuest, type PcInstall, type PcInstallManifest } from '../../shared/paths/index.js';
import { pcEnv, type PcEnv } from '../accounts/index.js';
import { epicInstalls } from './epic.js';
import type { PcInstallSource } from './source.js';
import { steamInstalls } from './steam.js';
import { unityInstalls } from './unity.js';
import { unrealFolders, unrealInstalls } from './unreal.js';
import { unrealVault } from './unreal-vault.js';

export type PcInstalls = Config['pcInstalls'];

/** At most this many installs are mapped (each one is a mapping in the .wsb). */
export const MAX_PC_INSTALLS = 40;

export const PC_INSTALL_SOURCES: readonly PcInstallSource[] = [
  steamInstalls,
  epicInstalls,
  unrealFolders,
  unrealInstalls,
  unrealVault,
  unityInstalls,
];

export interface DiscoverOptions {
  readonly packageRoot: string;
  readonly storageRoot: string;
  readonly sources?: readonly PcInstallSource[];
  /** This launch sets the sandbox up for Unreal ("auto" maps this PC's engines and vault cache then). */
  readonly unrealOn?: boolean;
}

export interface DiscoveredInstalls {
  readonly mappings: ResolvedMapping[];
  readonly manifest: PcInstallManifest;
  readonly notes: string[];
}

/** What a setting asks for: false (nothing), true (everything) or a list; "auto" follows the Unreal toolchain. */
function wantedOf(s: PcInstalls, setting: PcInstallSource['setting'], unrealOn: boolean): boolean | (string | number)[] {
  const value = s[setting];
  return value === 'auto' ? unrealOn : value;
}

export function discoverPcInstalls(s: PcInstalls, o: DiscoverOptions, pc: PcEnv = pcEnv()): DiscoveredInstalls {
  const mappings: ResolvedMapping[] = [];
  const items: Omit<PcInstall, 'host'>[] = [];
  const notes: string[] = [];
  for (const source of o.sources ?? PC_INSTALL_SOURCES) {
    const wanted = wantedOf(s, source.setting, o.unrealOn === true);
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
        // Once each: a folder you registered (writable, listed first) is not mapped again read-only.
        const same = (m: ResolvedMapping): boolean =>
          m.guest.toLowerCase() === guest.toLowerCase() || m.host.toLowerCase() === install.host.toLowerCase();
        if (mappings.some(same)) continue;
        if (!dirExists(install.host)) {
          notes.push('pcInstalls: ' + install.name + ' is not there any more (' + install.host + ').');
          continue;
        }
        assertSafeMapping(install.host, o.packageRoot, o.storageRoot);
        const writable = install.writable === true;
        mappings.push({
          host: install.host,
          guest,
          readOnly: !writable,
          label: writable ? 'this PC, writable' : 'this PC, read-only',
        });
        const { host: _host, ...shown } = install;
        items.push({ ...shown, guest });
      } catch (e) {
        notes.push('pcInstalls: ' + install.name + ' is not mapped: ' + errMsg(e));
      }
    }
    if (Array.isArray(wanted) && found.length < wanted.length)
      notes.push(
        'pcInstalls.' +
          source.setting +
          (source.setting === 'unrealEngineFolders'
            ? ': some of the listed folders are missing or hold no engine (Engine\\Build\\Build.version).'
            : ': some of the listed ones are not installed on this PC.'),
      );
  }
  return { mappings, manifest: { items }, notes };
}
