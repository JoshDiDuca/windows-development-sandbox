// 1.24 keeps Visual Studio itself on the data disk, so two Unreal settings are gone: toolchains.unreal.keepInstallFiles
// (the offline install files, which the installer never managed to make in a sandbox) and visualStudio "autosdk" (the
// portable MSVC instead of Visual Studio, which nothing needs now that Visual Studio is put back in seconds). A config
// file that still has them would no longer load: they are removed (the rest and the comments stay).
import _ from 'lodash';
import type { Migration, MigrationContext } from '../migration.js';
import { readFileObject, removeValues, type Json } from './config-file.js';

const KEEP_INSTALL_FILES = ['toolchains', 'unreal', 'keepInstallFiles'];
const VISUAL_STUDIO = ['toolchains', 'unreal', 'visualStudio'];

/** The retired values in a config file. */
export function retiredVsSettings(file: Json): string[][] {
  return [
    ...(_.has(file, KEEP_INSTALL_FILES) ? [KEEP_INSTALL_FILES] : []),
    ...(_.get(file, VISUAL_STUDIO) === 'autosdk' ? [VISUAL_STUDIO] : []),
  ];
}

export const dropVsInstallFiles: Migration = {
  id: '2026-11-drop-vs-install-files',
  introducedIn: '1.24.0',
  scope: 'user',
  needsIdleSandbox: false,
  summary:
    'Removes toolchains.unreal.keepInstallFiles and visualStudio "autosdk": Visual Studio is now kept on the data disk.',

  applies(ctx: MigrationContext): boolean {
    const file = readFileObject(ctx.configPath);
    return file !== null && retiredVsSettings(file).length > 0;
  },

  touches(ctx: MigrationContext): readonly string[] {
    return ctx.configPath ? [ctx.configPath] : [];
  },

  async run(ctx: MigrationContext, note: (line: string) => void): Promise<void> {
    const parsed = readFileObject(ctx.configPath);
    if (ctx.configPath && parsed)
      removeValues(ctx.configPath, retiredVsSettings(parsed), 'No longer needed (Visual Studio is kept)', note);
  },
};
