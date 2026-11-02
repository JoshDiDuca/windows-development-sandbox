// The Steam client (toolchains.steam.client): SteamSetup.exe (Valve-signed) unpacked silently into tools\steam once;
// steam.exe then fetches and updates the rest of itself in place when you start it (sbx-steam client). You sign in to
// it in each sandbox: its login is very likely tied to the Windows user, so it does not carry over.
import fs from 'node:fs';
import path from 'node:path';
import { errMsg } from '../../../core/util/errors.js';
import { moveIntoPlace, spawnAsync, stagingFolder } from '../../../shared/download/index.js';
import { safeRemove } from '../../../shared/io/safe-remove.js';
import { exists } from '../../runtime/fs.js';
import { log } from '../../runtime/log.js';
import { toolsDir } from '../../runtime/paths.js';
import { SIGNERS, signedBy, signedInstaller } from '../installers.js';
import { assertRoom } from '../persisted.js';
import { tool, type ToolEnv } from '../tool-env.js';
import { STEAM_CLIENT_URL, steamClientDir } from './commands.js';

const GB = 1024 ** 3;
/** The client grows to 1-1.5 GB once it has updated itself (games come on top). */
const CLIENT_NEED_BYTES = 2 * GB;
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

/** steam.exe in tools\steam when it is there and Valve-signed, else null. */
export function installedSteamClient(): string | null {
  const exe = path.join(steamClientDir(), 'steam.exe');
  return exists(exe) && signedBy(exe, SIGNERS.valve) ? exe : null;
}

async function installSteamClient(): Promise<string> {
  const dir = steamClientDir();
  const exe = path.join(dir, 'steam.exe');
  if (exists(exe)) {
    if (!signedBy(exe, SIGNERS.valve)) throw new Error('tools\\steam\\steam.exe is not signed by Valve');
    return exe;
  }
  fs.mkdirSync(toolsDir, { recursive: true });
  assertRoom(toolsDir, CLIENT_NEED_BYTES, 'the Steam client', 'Free room on the data disk.');
  const setup = await signedInstaller(
    STEAM_CLIENT_URL,
    path.join(tool('steam-setup'), 'SteamSetup.exe'),
    'the Steam client installer (~2 MB once)',
    SIGNERS.valve,
  );
  const work = stagingFolder(dir);
  fs.mkdirSync(work, { recursive: true });
  try {
    log('Unpacking the Steam client into tools\\steam ...');
    // NSIS: /S silent, /D= the folder (last, unquoted: the staging path has no spaces).
    const code = await spawnAsync(setup, ['/S', '/D=' + work], { timeout: SETUP_TIMEOUT_MS });
    const unpacked = path.join(work, 'steam.exe');
    if (!exists(unpacked)) throw new Error('SteamSetup.exe did not unpack steam.exe (exit code ' + code + ')');
    if (!signedBy(unpacked, SIGNERS.valve)) throw new Error('the unpacked steam.exe is not signed by Valve');
    moveIntoPlace(work, dir);
  } finally {
    if (fs.existsSync(work)) safeRemove(work, path.dirname(work));
  }
  return exe;
}

/** steam.exe ready to start, or null when it could not be set up (the reason is in the log and the summary). */
export async function ensureSteamClient(env: ToolEnv): Promise<string | null> {
  try {
    const exe = await installSteamClient();
    env.summary.push('steam client: tools\\steam (start it with sbx-steam client; sign in there in each sandbox)');
    return exe;
  } catch (e) {
    log('Steam client: not set up: ' + errMsg(e));
    env.summary.push('steam client: not set up (' + errMsg(e) + ')');
    return null;
  }
}
