// Epic Games: this PC's launcher sign-in ("Remember me" in its GameUserSettings.ini, often UTF-16). Taking it signs
// the launcher on this PC out the first time a sandbox uses it (a sign-in works in one place at a time).
import path from 'node:path';
import {
  epicSettingsFile,
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
    const bytes = readBoundedFile(epicSettingsFile(localAppData), MAX_EPIC_INI_BYTES);
    return bytes ? readEpicLogin(decodeText(bytes).text) : null;
  },
  summary: () => null,
};
