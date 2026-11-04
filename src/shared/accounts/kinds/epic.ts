// The Epic Games Launcher's saved sign-in ("Remember me"): the Data value of the [RememberMe] section of its
// GameUserSettings.ini. Pure text handling for the host (taking this PC's) and the sandbox (writing it in at boot,
// noticing when the launcher renews it). Read line by line: the sandbox may have written the file. The file is often
// UTF-16: callers decode it with shared/io/text.ts and write it back in the encoding they read.
import { EpicPayloadSchema } from '../payloads.js';
import type { Payload } from '../payloads.js';

/** At most this much of a GameUserSettings.ini is read. */
export const MAX_EPIC_INI_BYTES = 1024 * 1024;
const SECTION = '[rememberme]';

export type EpicPayload = Payload<'epic'>;

/** GameUserSettings.ini under a LocalAppData folder (the PC's or the sandbox's), where launchers before 17 keep it. */
export function epicSettingsFile(localAppData: string): string {
  return localAppData + '\\EpicGamesLauncher\\Saved\\Config\\Windows\\GameUserSettings.ini';
}

/**
 * Every GameUserSettings.ini the launcher may read, newest place first: launcher 17 and later (20.3 checked) keep it in
 * Config\WindowsEditor, older ones in Config\Windows.
 */
export function epicSettingsFiles(localAppData: string): string[] {
  return [localAppData + '\\EpicGamesLauncher\\Saved\\Config\\WindowsEditor\\GameUserSettings.ini', epicSettingsFile(localAppData)];
}

const isHeader = (line: string): boolean => line.trimStart().startsWith('[');

/** The saved sign-in in an ini text, or null (none, turned off, or not the expected shape). */
export function readEpicLogin(ini: string): EpicPayload | null {
  let inSection = false;
  let enabled = true;
  let data: string | null = null;
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    if (isHeader(line)) {
      inSection = line.toLowerCase() === SECTION;
      continue;
    }
    if (!inSection) continue;
    const at = line.indexOf('=');
    if (at < 0) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (key === 'enable') enabled = value.toLowerCase() === 'true';
    else if (key === 'data') data = value;
  }
  if (!enabled || !data) return null;
  const parsed = EpicPayloadSchema.safeParse({ data });
  return parsed.success ? parsed.data : null;
}

/** The ini text with its [RememberMe] section replaced by this sign-in (the other sections are kept). */
export function withEpicLogin(ini: string, login: EpicPayload): string {
  const kept: string[] = [];
  let inSection = false;
  for (const line of ini.split(/\r?\n/)) {
    if (isHeader(line)) inSection = line.trim().toLowerCase() === SECTION;
    if (!inSection) kept.push(line);
  }
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const section = ['[RememberMe]', 'Enable=True', 'Data=' + EpicPayloadSchema.parse(login).data];
  return [...kept, ...(kept.length ? [''] : []), ...section, ''].join('\r\n');
}
