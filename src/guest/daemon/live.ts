// The daemon's live-folder handler with the real bind filter (BindMount.exe, compiled from sandbox\csharp each boot and
// run by path) and its state on the sandbox's own disk, in a folder only administrators and SYSTEM may use.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SYSTEM } from '../../shared/system.js';
import { ensureCompiled } from '../runtime/csc.js';
import { isWin, localDir, run, testMode } from '../runtime/paths.js';
import { session } from '../runtime/session.js';
import { warn } from '../runtime/log.js';
import { LiveFolderHandler, type BindPort } from './live-folders.js';

const BIND_TIMEOUT_MS = 30000;
/** A test (it names its own local folder) never touches C:\ProgramData of the machine it runs on. */
const testing = Boolean(process.env.AGENT_DAEMON_STATE_DIR || process.env.AGENT_LOCAL_DIR);
const stateDir =
  process.env.AGENT_DAEMON_STATE_DIR ??
  (process.env.AGENT_LOCAL_DIR
    ? path.join(localDir, 'daemon-state')
    : path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'AgentSandboxDaemon'));

function bindMount(args: string[]): number {
  const r = spawnSync(ensureCompiled('bindmount'), args, {
    windowsHide: true,
    timeout: BIND_TIMEOUT_MS,
    encoding: 'utf8',
  });
  return r.status ?? 1;
}

const realBind: BindPort = {
  map: (folder, share, readOnly) => bindMount(['map', folder, share, ...(readOnly ? [] : ['rw'])]),
  unmap: (folder) => bindMount(['unmap', folder]),
  mapped: (folder) => bindMount(['mapped', folder]),
};

/** The state folder, made administrator-only (inside a real sandbox; a test names its own temp folder). */
function protectStateDir(): void {
  fs.mkdirSync(stateDir, { recursive: true });
  if (!isWin || testMode || testing) return;
  spawnSync(
    SYSTEM.icacls(),
    [stateDir, '/inheritance:r', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F'],
    {
      windowsHide: true,
      timeout: BIND_TIMEOUT_MS,
    },
  );
}

export const liveFolders = new LiveFolderHandler({
  run,
  stateFile: path.join(stateDir, 'live-folders.json'),
  launchId: session.launchId,
  bind: realBind,
  log: warn,
});

/** At daemon start: the folder protected, the boot's key taken in, the recorded mappings made again. */
export function startLiveFolders(key: string | undefined): void {
  protectStateDir();
  if (key) liveFolders.setKey(key);
  const again = liveFolders.reapply();
  if (again) warn('Live folders: ' + again + ' shown again after the daemon restarted.');
}
