// Where Steam things live in the sandbox and the SteamCMD command lines sbx-steam runs. Every value that goes on a
// SteamCMD command line is checked first (an app or item ID is digits, a branch or account name a plain word, a
// script a full path to an existing file): `+` starts a new SteamCMD command, so nothing else may reach it. No runtime
// imports: the self-test loads this file.
import fs from 'node:fs';
import path from 'node:path';
import { STEAM_ACCOUNT } from '../../../shared/accounts/kinds/steam.js';
import { parseVdf } from '../../../shared/vdf.js';
import { dataDir, toolsDir } from '../../runtime/paths.js';

/** Where SteamCMD runs from in the sandbox (its own disk: its config\ holds the login). */
export const STEAMCMD_DIR = 'C:\\SteamCMD';
/** Valve publishes no checksum for it: steamcmd.exe inside must be Valve-signed. */
export const STEAMCMD_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';
export const STEAM_CLIENT_URL = 'https://steamcdn-a.akamaihd.net/client/installer/SteamSetup.exe';

/** SteamCMD's binaries, kept between sandboxes (never its config\ or sentry files). */
export function steamCmdStore(tools: string = toolsDir): string {
  return path.join(tools, 'steamcmd');
}
/** Games and dedicated servers that sbx-steam app downloads: tools\steam-apps\<appid>. */
export function steamAppsRoot(tools: string = toolsDir): string {
  return path.join(tools, 'steam-apps');
}
export function steamAppDir(appId: string, tools: string = toolsDir): string {
  return path.join(steamAppsRoot(tools), checkAppId(appId));
}
/** Workshop items that sbx-steam workshop get downloads (a cache on the data disk). */
export function workshopCache(data: string = dataDir): string {
  return path.join(data, 'cache', 'steam-workshop');
}
/** Where a downloaded workshop item is. */
export function workshopItemDir(cache: string, appId: string, item: string): string {
  return path.join(cache, 'steamapps', 'workshop', 'content', checkAppId(appId), checkItemId(item));
}
/** The Steam client (toolchains.steam.client), which updates itself in place. */
export function steamClientDir(tools: string = toolsDir): string {
  return path.join(tools, 'steam');
}

function checked(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) throw new Error('not a ' + what + ': ' + JSON.stringify(value.slice(0, 80)));
  return value;
}
export const checkAppId = (v: string): string => checked(v, /^[1-9]\d{0,9}$/, 'Steam app ID');
export const checkItemId = (v: string): string => checked(v, /^[1-9]\d{0,19}$/, 'workshop item ID');
export const checkBranch = (v: string): string => checked(v, /^[A-Za-z0-9._-]{1,64}$/, 'branch name');
/** A Steam account name, or "anonymous" (dedicated servers and free tools). */
export const checkLogin = (v: string): string => checked(v, STEAM_ACCOUNT, 'Steam account name');

/** A full path SteamCMD can take as one value: no quotes, no `+` at the start of a part, no line breaks. */
export function checkPathValue(p: string, what: string): string {
  if (!path.isAbsolute(p) || /["\r\n\0]/.test(p) || /(^|[\\/ ])\+/.test(p))
    throw new Error(what + ' cannot be given to SteamCMD: ' + JSON.stringify(p.slice(0, 200)));
  return p;
}

export interface AppUpdate {
  readonly appId: string;
  readonly dir: string;
  readonly login: string;
  readonly beta?: string;
  readonly validate?: boolean;
}

/** Downloads or updates an app (a game, a dedicated server) into a folder. force_install_dir comes before login. */
export function appUpdateArgs(o: AppUpdate): string[] {
  return [
    '+force_install_dir',
    checkPathValue(o.dir, 'The folder'),
    '+login',
    checkLogin(o.login),
    '+app_update',
    checkAppId(o.appId),
    ...(o.beta ? ['-beta', checkBranch(o.beta)] : []),
    ...(o.validate ? ['validate'] : []),
    '+quit',
  ];
}

export interface WorkshopGet {
  readonly appId: string;
  readonly items: readonly string[];
  readonly dir: string;
  readonly login: string;
  readonly validate?: boolean;
}

/** Downloads workshop items of an app into <dir>\steamapps\workshop\content\<app>\<item>. */
export function workshopGetArgs(o: WorkshopGet): string[] {
  if (!o.items.length) throw new Error('no workshop item given');
  if (o.items.length > 100) throw new Error('at most 100 workshop items at once');
  const app = checkAppId(o.appId);
  return [
    '+force_install_dir',
    checkPathValue(o.dir, 'The folder'),
    '+login',
    checkLogin(o.login),
    ...o.items.flatMap((item) => [
      '+workshop_download_item',
      app,
      checkItemId(item),
      ...(o.validate ? ['validate'] : []),
    ]),
    '+quit',
  ];
}

/** Uploads a workshop item described by a workshop_item .vdf (a real account: not anonymous). */
export function workshopPushArgs(login: string, script: string): string[] {
  if (login === 'anonymous') throw new Error('uploading needs your Steam account, not anonymous');
  return ['+login', checkLogin(login), '+workshop_build_item', checkPathValue(script, 'The script'), '+quit'];
}

/** Uploads a build described by an app_build .vdf (ContentBuilder). */
export function appBuildArgs(login: string, script: string): string[] {
  if (login === 'anonymous') throw new Error('uploading needs your Steam account, not anonymous');
  return ['+login', checkLogin(login), '+run_app_build', checkPathValue(script, 'The script'), '+quit'];
}

/** Signs in (SteamCMD asks for the password and the Steam Guard code itself) and keeps the login. */
export function loginArgs(login: string): string[] {
  if (login === 'anonymous') throw new Error('anonymous needs no sign-in');
  return ['+login', checkLogin(login), '+quit'];
}

/** At most this much of a build or workshop script is read. */
export const MAX_SCRIPT_BYTES = 256 * 1024;

/** What a SteamCMD script is: its root block ("AppBuild" or "workshopitem"), or null. */
export function scriptKind(text: string): 'appbuild' | 'workshopitem' | null {
  const root = parseVdf(text, { maxBytes: MAX_SCRIPT_BYTES, escapes: false });
  const first = root ? Object.keys(root)[0]?.toLowerCase() : undefined;
  return first === 'appbuild' || first === 'workshopitem' ? first : null;
}

/** An app_build script's text with Preview on and/or a description (null when it is not an app_build script). */
export function withBuildSettings(
  text: string,
  o: { readonly preview?: boolean; readonly desc?: string },
): string | null {
  if (scriptKind(text) !== 'appbuild') return null;
  if (o.desc !== undefined && !/^[^"\r\n\\]{1,200}$/.test(o.desc))
    throw new Error('a build description is one line of at most 200 characters, without quotes or backslashes');
  let out = text;
  const set = (key: string, value: string): void => {
    const existing = new RegExp('"' + key + '"[ \\t]+"[^"\\r\\n]*"', 'i');
    if (existing.test(out)) {
      out = out.replace(existing, '"' + key + '" "' + value + '"');
      return;
    }
    const at = out.toLowerCase().indexOf('"appbuild"');
    const brace = at < 0 ? -1 : out.indexOf('{', at);
    if (brace < 0) throw new Error('the app_build script has no AppBuild block');
    out = out.slice(0, brace + 1) + '\n\t"' + key + '" "' + value + '"' + out.slice(brace + 1);
  };
  if (o.preview) set('Preview', '1');
  if (o.desc !== undefined) set('Desc', o.desc);
  return out;
}

/** The script's text (bounded), or an error a person can act on. */
export function readScript(file: string): string {
  let size: number;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    throw new Error('cannot read ' + file + ' (missing, a link, or not a file)');
  }
  if (size > MAX_SCRIPT_BYTES) throw new Error(file + ' is bigger than ' + MAX_SCRIPT_BYTES / 1024 + ' KB');
  return fs.readFileSync(file, 'utf8');
}
