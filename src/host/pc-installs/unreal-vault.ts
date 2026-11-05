// The Epic Games Launcher's vault cache of this PC (pcInstalls.unrealAssets): the Fab and Marketplace packs you
// downloaded, mapped read-only at C:\PcInstalls\unreal\Vault (Vault2 ... for more folders), so what you download on the
// PC is in the sandbox at once. Its folders come from the launcher's settings (shared/unreal/vault.ts), else the
// default one; only folders that exist are mapped.
import fs from 'node:fs';
import path from 'node:path';
import { epicSettingsFiles, MAX_EPIC_INI_BYTES } from '../../shared/accounts/index.js';
import { decodeText, readBoundedFile } from '../../shared/io/index.js';
import type { PcInstall } from '../../shared/paths/index.js';
import { defaultVaultDir, vaultDirsFromIni, type VaultFs } from '../../shared/unreal/index.js';
import type { PcEnv } from '../accounts/index.js';
import type { PcInstallSource } from './source.js';

const MAX_VAULTS = 4;

/** The vault cache folders of this PC: the ones its launcher settings name, else the default. */
export function vaultDirs(pc: Pick<PcEnv, 'localAppData' | 'programData'>, isDir: (dir: string) => boolean): string[] {
  const named = pc.localAppData
    ? epicSettingsFiles(pc.localAppData).flatMap((file) => {
        const bytes = readBoundedFile(file, MAX_EPIC_INI_BYTES);
        return bytes ? vaultDirsFromIni(decodeText(bytes).text) : [];
      })
    : [];
  const all = [...named, defaultVaultDir(pc.programData)];
  return all
    .filter((d, i) => all.findIndex((o) => o.toLowerCase() === d.toLowerCase()) === i)
    .filter(isDir)
    .slice(0, MAX_VAULTS);
}

/** The vault folders as installs to map (read-only). */
export function vaultInstalls(dirs: readonly string[]): PcInstall[] {
  return dirs.map((dir, i) => ({
    kind: 'unreal-vault',
    id: i ? 'Vault' + (i + 1) : 'Vault',
    name: 'Epic Games Launcher vault cache' + (i ? ' ' + (i + 1) : ''),
    host: dir,
    guest: '',
  }));
}

const isDir = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/** This PC's disk for vaultPacks (bounded lists). */
export const PC_VAULT_FS: VaultFs = {
  exists: (file) => fs.existsSync(file),
  list: (dir) => {
    try {
      return fs.readdirSync(dir).slice(0, 5000);
    } catch {
      return []; // Not a folder: nothing in it.
    }
  },
  size: (file) => {
    try {
      const s = fs.lstatSync(file);
      return s.isFile() ? s.size : null;
    } catch {
      return null;
    }
  },
  isDir: (dir) => {
    try {
      return fs.lstatSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
};

export const unrealVault: PcInstallSource = {
  kind: 'unreal-vault',
  setting: 'unrealAssets',
  find(_wanted: true | readonly (string | number)[], pc: PcEnv): PcInstall[] {
    return vaultInstalls(vaultDirs(pc, isDir)).map((v) => ({ ...v, host: path.win32.normalize(v.host) }));
  },
};
