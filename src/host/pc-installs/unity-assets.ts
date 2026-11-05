// The Unity Asset Store downloads of this PC (pcInstalls.unityAssets): its Asset Store-5.x folder, mapped read-only at
// C:\PcInstalls\unity\AssetStore (AssetStore2 for a second one), so a package bought and downloaded on the PC is in
// the sandbox at once. The folders come from ASSETSTORE_CACHE_PATH, else %APPDATA%\Unity; only existing ones count.
import type { PcInstall } from '../../shared/paths/index.js';
import type { PcEnv } from '../accounts/index.js';
import type { PcInstallSource } from './source.js';
import { assetCacheEnv, unityAssetCacheDirs, unityPcFiles } from './unity.js';

/** The Asset Store folders as installs to map. */
export function unityAssetInstalls(dirs: readonly string[]): PcInstall[] {
  return dirs.map((dir, i) => ({
    kind: 'unity-assets',
    id: i ? 'AssetStore' + (i + 1) : 'AssetStore',
    name: 'Unity Asset Store downloads' + (i ? ' ' + (i + 1) : ''),
    host: dir,
    guest: '',
  }));
}

export const unityAssets: PcInstallSource = {
  kind: 'unity-assets',
  setting: 'unityAssets',
  find(_wanted: true | readonly (string | number)[], pc: PcEnv): PcInstall[] {
    return unityAssetInstalls(unityAssetCacheDirs(unityPcFiles(pc), assetCacheEnv(pc)));
  },
};
