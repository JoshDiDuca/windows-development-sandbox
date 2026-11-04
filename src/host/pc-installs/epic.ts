// Epic Games Launcher games of this PC (pcInstalls.epicGames): the InstallationList of its LauncherInstalled.dat
// (%ProgramData%\Epic\UnrealEngineLauncher), engines (UE_x.y) left to unreal.ts. C:\PcInstalls\epic\<AppName>.
import path from 'node:path';
import { readBoundedFile } from '../../shared/io/index.js';
import type { PcInstall } from '../../shared/paths/index.js';
import { launcherInstallations, launcherInstalledFile, MAX_LAUNCHER_FILE_BYTES } from '../../shared/unreal/index.js';
import type { PcEnv } from '../accounts/index.js';
import type { PcInstallSource } from './source.js';

const APP = /^[A-Za-z0-9._-]{1,100}$/;

/** The games a LauncherInstalled.dat lists that `wanted` maps (by app name), each once. */
export function findEpicGames(text: string | null, wanted: true | readonly (string | number)[]): PcInstall[] {
  const names = wanted === true ? null : new Set(wanted.map((w) => String(w).toLowerCase()));
  const found: PcInstall[] = [];
  for (const i of text ? launcherInstallations(text) : []) {
    if (!APP.test(i.appName) || /^\.+$/.test(i.appName) || /^UE_\d/.test(i.appName)) continue;
    if (names && !names.has(i.appName.toLowerCase())) continue;
    if (found.some((f) => f.id.toLowerCase() === i.appName.toLowerCase())) continue;
    found.push({
      kind: 'epic-game',
      id: i.appName,
      name: path.win32.basename(i.installLocation).slice(0, 100) || i.appName,
      ...(i.ids ? { version: i.ids.appVersion.slice(0, 60), launcher: i.ids } : {}),
      host: path.win32.normalize(i.installLocation),
      guest: '',
    });
  }
  return found;
}

export const epicInstalls: PcInstallSource = {
  kind: 'epic-game',
  setting: 'epicGames',
  find(wanted: true | readonly (string | number)[], pc: PcEnv): PcInstall[] {
    const bytes = readBoundedFile(launcherInstalledFile(pc.programData), MAX_LAUNCHER_FILE_BYTES);
    if (!bytes) throw new Error('the Epic Games Launcher has no LauncherInstalled.dat here');
    return findEpicGames(bytes.toString('utf8'), wanted);
  },
};
