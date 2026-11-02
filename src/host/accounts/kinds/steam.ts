// Steam: SteamCMD's cached login (config\config.vdf and the ssfn sentry files) from a steamcmd folder on this PC
// (`sandbox account import steam --from C:\steamcmd`); no password is ever kept. `--from` may also name steamcmd.exe
// or the config.vdf itself. Without it, C:\steamcmd is looked in.
import fs from 'node:fs';
import path from 'node:path';
import { readSteamCmdLogin, type SteamPayload } from '../../../shared/accounts/index.js';
import type { HostSource, PcEnv } from '../source.js';

/** Where SteamCMD usually is on a PC (its own folder: it has no installer). */
export const PC_STEAMCMD_DIR = 'C:\\steamcmd';

/** The SteamCMD folder a --from path names: the folder, its steamcmd.exe, or its config\config.vdf. */
export function steamCmdFolderOf(from: string): string {
  const full = path.resolve(from);
  let isFile = false;
  try {
    isFile = fs.statSync(full).isFile();
  } catch {
    return full;
  }
  if (!isFile) return full;
  const dir = path.dirname(full);
  return path.basename(full).toLowerCase() === 'config.vdf' && path.basename(dir).toLowerCase() === 'config'
    ? path.dirname(dir)
    : dir;
}

export const steamSource: HostSource<'steam'> = {
  fromPc(_pc: PcEnv, from?: string): SteamPayload | null {
    return readSteamCmdLogin(from ? steamCmdFolderOf(from) : PC_STEAMCMD_DIR);
  },
  summary: (p) => p.account,
};
