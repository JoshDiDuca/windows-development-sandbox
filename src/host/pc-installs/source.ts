// One kind of install this PC may have (Steam games, Epic games, Unreal engines, Unity editors): how to find them.
import type { PcInstall } from '../../shared/paths/index.js';
import type { PcEnv } from '../accounts/index.js';

export interface PcInstallSource {
  readonly kind: PcInstall['kind'];
  /** The settings key that turns it on (pcInstalls.<setting>). */
  readonly setting: 'steamGames' | 'epicGames' | 'unrealEngines' | 'unityEditors';
  /** What is installed: everything (true) or the ones listed. Bounded reads only (registry, manifests). */
  find(wanted: true | readonly (string | number)[], pc: PcEnv): PcInstall[];
}
