// Epic Games: the handed-over sign-in goes into the launcher's GameUserSettings.ini before anyone opens it (its other
// settings are kept, and the file keeps the encoding it had: the launcher often writes UTF-16). The watch reads it
// back to notice when the launcher renews it, or when you sign in here the first time.
import fs from 'node:fs';
import path from 'node:path';
import {
  epicSettingsFile,
  MAX_EPIC_INI_BYTES,
  readEpicLogin,
  withEpicLogin,
  type EpicPayload,
} from '../../../shared/accounts/index.js';
import { decodeText, encodeText, readBoundedFile } from '../../../shared/io/index.js';
import { localAppData, type GuestAdapter } from '../adapter.js';

function settingsFile(): string {
  return epicSettingsFile(localAppData());
}

export const epicAdapter: GuestAdapter<'epic'> = {
  kind: 'epic',
  apply(p: EpicPayload) {
    const file = settingsFile();
    const bytes = readBoundedFile(file, MAX_EPIC_INI_BYTES);
    const read = bytes ? decodeText(bytes) : { text: '', encoding: 'utf8' as const };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodeText(withEpicLogin(read.text, p), read.encoding));
    return { summary: 'Epic Games Launcher: signed in with your saved sign-in' };
  },
  current() {
    const bytes = readBoundedFile(settingsFile(), MAX_EPIC_INI_BYTES);
    return bytes ? readEpicLogin(decodeText(bytes).text) : null;
  },
};
