// Epic Games: this PC's launcher sign-in ("Remember me" in its GameUserSettings.ini, often UTF-16; launcher 17+ keeps
// it in Config\WindowsEditor, older ones in Config\Windows). Taking it signs the launcher on this PC out the first time
// a sandbox uses it (a sign-in works in one place at a time).
import path from 'node:path';
import {
  epicSettingsFiles,
  MAX_EPIC_INI_BYTES,
  readEpicLogin,
  type EpicPayload,
} from '../../../shared/accounts/index.js';
import { decodeText, readBoundedFile } from '../../../shared/io/index.js';
import type { HostSource, PcEnv } from '../source.js';

export const epicSource: HostSource<'epic'> = {
  fromPc(pc: PcEnv, from?: string): EpicPayload | null {
    const localAppData = from ? path.resolve(from) : pc.localAppData;
    if (!localAppData) return null;
    for (const file of epicSettingsFiles(localAppData)) {
      const bytes = readBoundedFile(file, MAX_EPIC_INI_BYTES);
      const login = bytes ? readEpicLogin(decodeText(bytes).text) : null;
      if (login) return login;
    }
    return null;
  },
  summary: () => null,
};
