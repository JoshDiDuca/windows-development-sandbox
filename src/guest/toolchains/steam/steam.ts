// Steam (toolchains.steam): SteamCMD in C:\SteamCMD each boot (binaries kept in tools\steamcmd), steamcmd on PATH,
// the Steam client when asked, STEAMWORKS_SDK from sdkFolder, and a word on the PC's Steam libraries mapped read-only.
import fs from 'node:fs';
import path from 'node:path';
import type { Toolchains } from '../../../core/types.js';
import { hasCachedLogin, readSteamAccountFile, steamConfigFile } from '../../../shared/accounts/kinds/steam.js';
import { readBoundedFile } from '../../../shared/io/bounded.js';
import { log } from '../../runtime/log.js';
import { dryRun } from '../../runtime/paths.js';
import { projectWorkspace } from '../../runtime/project-context.js';
import type { ToolCtx } from '../step.js';
import type { ToolEnv } from '../tool-env.js';
import { ensureSteamClient, installedSteamClient } from './client.js';
import { STEAMCMD_DIR } from './commands.js';
import { installSteamCmd } from './steamcmd.js';

function signedInAs(): string | null {
  const bytes = readBoundedFile(steamConfigFile(STEAMCMD_DIR), 256 * 1024);
  if (!bytes || !hasCachedLogin(bytes.toString('utf8'))) return null;
  return readSteamAccountFile(STEAMCMD_DIR) ?? 'your account';
}

/** STEAMWORKS_SDK from toolchains.steam.sdkFolder (relative to the project), when the folder is there. */
function sdkFolder(env: ToolEnv, setting: string): void {
  if (!setting.trim()) return;
  const dir = path.resolve(projectWorkspace(), setting.trim());
  let ok = false;
  try {
    ok = fs.statSync(dir).isDirectory();
  } catch {
    // Not there: said below.
  }
  if (!ok) {
    log('Steamworks SDK: ' + dir + ' is not there (toolchains.steam.sdkFolder); STEAMWORKS_SDK is not set');
    env.summary.push('steamworks sdk: ' + dir + ' not found');
    return;
  }
  env.vars.STEAMWORKS_SDK = dir;
  env.summary.push('steamworks sdk: STEAMWORKS_SDK=' + dir);
}

export async function setupSteam(env: ToolEnv, config: Toolchains['steam'], ctx: ToolCtx): Promise<void> {
  if (dryRun) {
    log('(dry run) would set up SteamCMD' + (config.client ? ' and the Steam client' : ''));
    return;
  }
  const exe = await installSteamCmd();
  // Appended: C:\SteamCMD also holds Steam's own DLLs, which must not shadow a game's.
  env.append.push(STEAMCMD_DIR);
  env.vars.STEAMCMD = exe;
  const user = signedInAs();
  env.summary.push(
    'steamcmd: C:\\SteamCMD, ' + (user ? 'signed in as ' + user : 'not signed in (sbx-steam login <account>)'),
  );
  sdkFolder(env, config.sdkFolder);
  const fromPc = ctx.pcInstalls.items.filter((i) => i.kind === 'steam-game' || i.kind === 'steam-library');
  if (fromPc.length)
    env.summary.push(
      'steam: ' + fromPc.length + " of this PC's games or libraries, read-only in C:\\PcInstalls\\steam",
    );
  if (!config.client) return;
  if (ctx.duringSession && !installedSteamClient()) {
    env.summary.push('steam client: restart the sandbox to install it');
    return;
  }
  await ensureSteamClient(env);
}
