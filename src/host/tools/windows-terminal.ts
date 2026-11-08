// Windows Terminal for the sandbox window. The host downloads the portable build once into persistent storage, so
// logon.cmd can open it the moment the sandbox logs in (no PowerShell window first).
import fs from 'node:fs';
import path from 'node:path';
import { downloader, githubAsset } from '../../shared/download/index.js';
import { safeRemove, writeFileAtomic } from '../../shared/io/index.js';
import { assertTestWritable } from '../test-guard.js';
import { hostDataFolder, hostDataRoot } from '../storage/index.js';
import { applyEdits, modify } from 'jsonc-parser';
import { z } from 'zod';
import { assertNoLinks, errMsg, fileExists, parseJsonc, writeJson } from '../../core/util/index.js';

export function terminalDir(dataPath: string): string {
  return path.join(hostDataFolder(dataPath, 'tools'), 'terminal');
}
export function terminalExe(dataPath: string): string {
  return path.join(terminalDir(dataPath), 'WindowsTerminal.exe');
}

/**
 * Sandbox-friendly defaults; only written when there is no settings.json yet (first download), so edits made inside
 * the sandbox stick, also across a refresh (which keeps the settings folder).
 */
const SETTINGS = {
  $schema: 'https://aka.ms/terminal-profiles-schema',
  theme: 'dark',
  firstWindowPreference: 'defaultProfile',
  confirmCloseAllTabs: false,
  // Copied the moment the mouse is released, so an agent's redraw cannot clear the selection first.
  copyOnSelect: true,
  copyFormatting: 'none',
  // New tabs pick up the PATH and variables the runner writes machine-wide after the window opened.
  compatibility: { reloadEnvironmentVariables: true },
  warning: { confirmCloseAllTabs: false, largePaste: false, multiLinePaste: false },
  profiles: {
    defaults: { font: { face: 'Cascadia Mono' }, startingDirectory: '%AGENT_WORKSPACE%', closeOnExit: 'graceful' },
  },
};

/** Our own profile id, so the profile is found again (and user edits to it are kept) on later launches. */
export const PWSH_PROFILE_GUID = '{5f3a6c1e-7d2b-4e8a-9c41-0b6d2a8f7e93}';
/** pwsh.exe as the sandbox sees it (toolchains/pwsh.ts installs it to tools\pwsh). */
const GUEST_PWSH = 'C:\\AgentData\\tools\\pwsh\\pwsh.exe';

const MAX_SETTINGS_BYTES = 1024 * 1024;
const TerminalSettingsSchema = z.looseObject({
  profiles: z
    .union([
      z.array(z.looseObject({ guid: z.string().optional() })),
      z.looseObject({ list: z.array(z.looseObject({ guid: z.string().optional() })).optional() }),
    ])
    .optional(),
});

/**
 * settings.json with the "PowerShell 7" profile shown when `visible`, else hidden (never deleted: a user's tweaks to it
 * survive turning pwsh off and on). Pure: returns null when nothing changes.
 */
export function withPwshProfile(
  settings: z.output<typeof TerminalSettingsSchema>,
  visible: boolean,
): z.output<typeof TerminalSettingsSchema> | null {
  const profiles = Array.isArray(settings.profiles) ? { list: settings.profiles } : { ...settings.profiles };
  const list = [...(profiles.list ?? [])];
  const at = list.findIndex((p) => p.guid?.toLowerCase() === PWSH_PROFILE_GUID);
  if (at === -1 && !visible) return null;
  if (at === -1)
    list.push({
      guid: PWSH_PROFILE_GUID,
      name: 'PowerShell 7',
      commandline: '"' + GUEST_PWSH + '" -NoLogo',
      icon: GUEST_PWSH,
      hidden: false,
    });
  else if ((list[at].hidden === true) === !visible) return null;
  else list[at] = { ...list[at], hidden: !visible };
  return { ...settings, profiles: { ...profiles, list } };
}

/** settings.json that makes new tabs read the current environment; null when it already does. Pure. */
export function withReloadEnvironment(
  settings: z.output<typeof TerminalSettingsSchema>,
): z.output<typeof TerminalSettingsSchema> | null {
  const compatibility = settings.compatibility as { reloadEnvironmentVariables?: unknown } | undefined;
  if (compatibility?.reloadEnvironmentVariables === true) return null;
  return { ...settings, compatibility: { ...compatibility, reloadEnvironmentVariables: true } };
}

/** settings.json that copies on select; null when the user already chose (true or false). Pure. */
export function withCopyOnSelect(
  settings: z.output<typeof TerminalSettingsSchema>,
): z.output<typeof TerminalSettingsSchema> | null {
  if ('copyOnSelect' in settings) return null;
  return { ...settings, copyOnSelect: true };
}

/**
 * Shows the PowerShell 7 profile once pwsh is installed in this data folder (and `allowed`, i.e. toolchains.pwsh is
 * not off), hides it otherwise. settings.json is written by the sandbox too: read with a size cap, through no links,
 * shape-checked, only rewritten when the profile changes or a default switch is missing (reload the environment,
 * copy on select; a value the user set stays); a file that does not parse is left alone.
 */
export function syncPwshProfile(dataPath: string, allowed: boolean): void {
  const file = path.join(terminalDir(dataPath), 'settings', 'settings.json');
  assertTestWritable(file);
  assertNoLinks(hostDataRoot(dataPath), file);
  if (!fileExists(file) || fs.statSync(file).size > MAX_SETTINGS_BYTES) return;
  const visible = allowed && fileExists(path.join(hostDataFolder(dataPath, 'tools'), 'pwsh', 'pwsh.exe'));
  let parsed: z.output<typeof TerminalSettingsSchema>;
  const text = fs.readFileSync(file, 'utf8');
  try {
    const result = TerminalSettingsSchema.safeParse(parseJsonc<unknown>(text, file));
    if (!result.success) return;
    parsed = result.data;
  } catch {
    return;
  }
  const withProfile = withPwshProfile(parsed, visible);
  if (withProfile) {
    const reloaded = withReloadEnvironment(withProfile) ?? withProfile;
    writeJson(file, withCopyOnSelect(reloaded) ?? reloaded);
    return;
  }
  // Only default switches are missing: set those values in the text, so comments and the layout stay.
  const missing: [string[], boolean][] = [];
  if (withReloadEnvironment(parsed)) missing.push([['compatibility', 'reloadEnvironmentVariables'], true]);
  if (withCopyOnSelect(parsed)) missing.push([['copyOnSelect'], true]);
  if (missing.length === 0) return;
  let edited = text;
  for (const [at, value] of missing)
    edited = applyEdits(edited, modify(edited, at, value, { formattingOptions: { insertSpaces: true, tabSize: 4 } }));
  writeFileAtomic(file, edited);
}

export async function ensureTerminal(
  dataPath: string,
  refresh: boolean,
  options: { pwsh?: boolean } = {},
): Promise<{ exe: string | null; message: string }> {
  const result = await installTerminal(dataPath, refresh);
  if (result.exe) {
    // The profile is a nicety: a settings problem never costs the sandbox its terminal.
    try {
      syncPwshProfile(dataPath, options.pwsh ?? false);
    } catch (e) {
      return { ...result, message: result.message + ' (PowerShell 7 profile not updated: ' + errMsg(e) + ')' };
    }
  }
  return result;
}

const installTerminal = async (
  dataPath: string,
  refresh: boolean,
): Promise<{ exe: string | null; message: string }> => {
  const exe = terminalExe(dataPath);
  const dir = terminalDir(dataPath);
  assertTestWritable(dir);
  const settings = path.join(dir, 'settings');
  // downloader.archive replaces tools\terminal: the portable settings folder waits here meanwhile (and goes back also
  // when the download fails). One still parked from an interrupted earlier run is the one to keep.
  const parked = path.join(hostDataFolder(dataPath, 'tools'), 'terminal-settings.parked');
  assertNoLinks(hostDataRoot(dataPath), settings);
  assertNoLinks(hostDataRoot(dataPath), parked);
  if (fileExists(exe) && !refresh) return { exe, message: 'cached' };
  try {
    if (fs.existsSync(settings)) {
      safeRemove(parked, path.dirname(parked));
      fs.renameSync(settings, parked);
    }
    try {
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const asset = await githubAsset(
        'microsoft/terminal',
        new RegExp('^Microsoft\\.WindowsTerminal_[\\d.]+_' + arch + '\\.zip$'),
      );
      await downloader.archive(asset.url, dir, {
        sha256: asset.sha256,
        locate: 'WindowsTerminal.exe',
        fileName: asset.name,
      });
      fs.writeFileSync(path.join(dir, '.portable'), '');
      return { exe, message: 'downloaded ' + asset.name };
    } finally {
      if (fs.existsSync(parked)) {
        fs.mkdirSync(dir, { recursive: true });
        safeRemove(settings, path.dirname(settings));
        fs.renameSync(parked, settings);
      }
      const settingsFile = path.join(settings, 'settings.json');
      assertNoLinks(hostDataRoot(dataPath), settingsFile);
      if (fileExists(path.join(dir, '.portable')) && !fs.existsSync(settingsFile)) writeJson(settingsFile, SETTINGS);
    }
  } catch (e) {
    return {
      exe: null,
      message: 'download failed, the sandbox will use a plain PowerShell window (' + errMsg(e) + ')',
    };
  }
};
