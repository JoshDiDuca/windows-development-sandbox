// Unity editors of this PC: Unity Hub's secondaryInstallPath.json, its default folder and editors-v2.json, each mapped
// at C:\PcInstalls\unity\<version>. Not available yet: finds nothing.
import type { PcInstall } from '../../shared/paths/index.js';
import type { PcEnv } from '../accounts/index.js';
import type { PcInstallSource } from './source.js';

/** The files and folders of this PC the search reads (the self-test passes its own). */
export interface UnityPcFiles {
  read(file: string, max: number): Buffer | null;
  isDir(dir: string): boolean;
  list(dir: string): string[];
  readonly appData: string;
  readonly programFiles: string;
}

/** The editors of this PC: all of them (true) or the listed versions. A stub. */
export function findUnityEditorsOnPc(_files: UnityPcFiles, _wanted: true | readonly string[]): PcInstall[] {
  return [];
}

/** The Asset Store download folders of this PC, as roots to map. A stub. */
export function unityAssetCacheDirs(_files: UnityPcFiles, _envValue: string | undefined): string[] {
  return [];
}

export const unityInstalls: PcInstallSource = {
  kind: 'unity',
  setting: 'unityEditors',
  find(_wanted: true | readonly (string | number)[], _pc: PcEnv): PcInstall[] {
    return [];
  },
};
