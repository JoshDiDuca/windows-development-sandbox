// Unity Hub (toolchains.unity.hub): kept on the data disk (tools\unity\hub\3), installed by its signed installer
// unpacked there. For signing in to Unity Personal and installing editors by hand.
import path from 'node:path';
import { runInstaller } from '../../runtime/pools.js';
import { shortcuts } from '../../apps/shortcuts.js';
import { exists } from '../../runtime/fs.js';
import { log } from '../../runtime/log.js';
import { SIGNERS, signedInstaller } from '../installers.js';
import { ensurePersisted } from '../persisted.js';
import { UNITY_DIR } from './unity-status.js';

const HUB_URL = 'https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup.exe';
const HUB_MARKER = 'Unity Hub.exe';
const GB = 1024 ** 3;

/** The Hub's program on the data disk, installed there when it is not (only with `hub` on). */
export async function ensureUnityHub(): Promise<string> {
  const setup = await signedInstaller(
    HUB_URL,
    path.join(UNITY_DIR, 'UnityHubSetup.exe'),
    'Unity Hub (~150 MB once)',
    SIGNERS.unity,
  );
  const installed = await ensurePersisted(
    { name: 'unity/hub', version: '3', needBytes: 2 * GB, marker: HUB_MARKER, what: 'Unity Hub', keepVersions: 1 },
    async (staging) => {
      log('Installing Unity Hub ...');
      const code = await runInstaller(setup, ['/S', '/D=' + staging]);
      if (code !== 0) throw new Error('the Unity Hub installer failed (exit ' + code + ')');
    },
  );
  const exe = path.join(installed.dir, HUB_MARKER);
  if (exists(exe)) shortcuts([{ name: 'Unity Hub', exe }]);
  return exe;
}
