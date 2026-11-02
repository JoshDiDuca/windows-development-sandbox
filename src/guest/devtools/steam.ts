// sbx-steam: log in to SteamCMD, download apps and workshop items, upload builds and workshop items, list games, start
// the Steam client. SteamCMD runs from C:\SteamCMD (set up at boot); it asks for the password and the Steam Guard code
// itself, and keeps only its login token (never the password or a Steam Guard secret).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  readSteamAccountFile,
  steamAccounts,
  steamConfigFile,
  STEAM_ACCOUNT_FILE,
} from '../../shared/accounts/kinds/steam.js';
import { spawnAsync } from '../../shared/download/index.js';
import { readBoundedFile } from '../../shared/io/bounded.js';
import { session } from '../runtime/session.js';
import { errMsg } from '../../core/util/errors.js';
import {
  appBuildArgs,
  appUpdateArgs,
  checkAppId,
  loginArgs,
  readScript,
  scriptKind,
  steamAppDir,
  STEAMCMD_DIR,
  steamClientDir,
  workshopCache,
  workshopGetArgs,
  workshopItemDir,
  workshopPushArgs,
  withBuildSettings,
} from '../toolchains/steam/commands.js';
import {
  assertAppRoom,
  DEFAULT_APP_NEED_BYTES,
  folderSize,
  installedApps,
  recordApp,
} from '../toolchains/steam/apps.js';
import type { DevTool } from './devtool.js';

const GB = 1024 ** 3;
const USAGE = [
  'Usage: sbx-steam <command>',
  '  login <account>                      sign in to SteamCMD (it asks for the password and Steam Guard code)',
  '  app <appid> [--beta <branch>] [--dir <folder>] [--validate] [--anonymous] [--need-gb <n>]',
  '                                       download or update a game or dedicated server (tools\\steam-apps\\<appid>)',
  '  workshop get <appid> <item>... [--validate] [--anonymous]',
  '                                       download workshop items (cache\\steam-workshop on the data disk)',
  '  workshop push <workshop_item.vdf>    upload a workshop item',
  '  build <app_build.vdf> [--preview] [--desc <text>]',
  '                                       upload a build with ContentBuilder (--preview: check it, upload nothing)',
  "  games                                what is downloaded here and this PC's games mapped read-only",
  '  client                               start the Steam client (toolchains.steam.client)',
  'Options: --user <account> uses another signed-in account.',
].join('\n');

const VALUE_FLAGS = new Set(['--beta', '--dir', '--user', '--need-gb', '--desc']);
const BOOLEAN_FLAGS = new Set(['--validate', '--anonymous', '--preview']);

interface Parsed {
  readonly words: string[];
  readonly values: Map<string, string>;
  readonly flags: Set<string>;
}

function parse(args: readonly string[]): Parsed {
  const words: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      const v = args[++i];
      if (v === undefined) throw new Error(a + ' needs a value');
      values.set(a, v);
    } else if (BOOLEAN_FLAGS.has(a)) flags.add(a);
    else if (a.startsWith('--')) throw new Error('unknown option ' + a);
    else words.push(a);
  }
  return { words, values, flags };
}

const steamcmd = (): string => path.join(STEAMCMD_DIR, 'steamcmd.exe');

function requireSteamCmd(): string {
  if (!fs.existsSync(steamcmd()))
    throw new Error('SteamCMD is not set up in this sandbox (toolchains.steam: see the boot log for why)');
  return steamcmd();
}

/** The account SteamCMD has a login for here, or null. */
function knownAccount(): string | null {
  const fromFile = readSteamAccountFile(STEAMCMD_DIR);
  if (fromFile) return fromFile;
  const bytes = readBoundedFile(steamConfigFile(STEAMCMD_DIR), 256 * 1024);
  return bytes ? (steamAccounts(bytes.toString('utf8'))[0] ?? null) : null;
}

function account(p: Parsed, anonymousOk: boolean): string {
  if (p.flags.has('--anonymous')) return 'anonymous';
  const name = p.values.get('--user') ?? knownAccount();
  if (name) return name;
  if (anonymousOk) {
    console.log('Not signed in: using anonymous (enough for dedicated servers and free tools).');
    return 'anonymous';
  }
  throw new Error('not signed in: run sbx-steam login <account> first');
}

/** Runs SteamCMD in the terminal (it asks there when it needs to); its exit code. */
async function steamCmd(args: string[]): Promise<number> {
  return spawnAsync(requireSteamCmd(), args, { cwd: STEAMCMD_DIR, stdio: 'inherit', windowsHide: false });
}

const gb = (bytes: number | null): string => (bytes === null ? 'size unknown' : (bytes / GB).toFixed(2) + ' GB');

async function login(p: Parsed): Promise<number> {
  const name = p.words[1] ?? p.values.get('--user');
  if (!name) throw new Error('Usage: sbx-steam login <account name>');
  const code = await steamCmd(loginArgs(name));
  if (code !== 0) return code;
  fs.mkdirSync(path.join(STEAMCMD_DIR, 'config'), { recursive: true });
  fs.writeFileSync(path.join(STEAMCMD_DIR, 'config', STEAM_ACCOUNT_FILE), name, 'utf8');
  console.log(
    'Signed in as ' +
      name +
      '. SteamCMD keeps the login in C:\\SteamCMD\\config (this sandbox only). With accounts.steam.share on, the PC keeps it, encrypted, for the next sandboxes; no password is kept.',
  );
  return 0;
}

async function app(p: Parsed): Promise<number> {
  const appId = checkAppId(p.words[1] ?? '');
  const given = p.values.get('--dir');
  const dir = given ? path.resolve(given) : steamAppDir(appId);
  const needGb = Number(p.values.get('--need-gb') ?? DEFAULT_APP_NEED_BYTES / GB);
  if (!Number.isFinite(needGb) || needGb < 0 || needGb > 10_000) throw new Error('--need-gb takes a number of GB');
  assertAppRoom(dir, needGb * GB, 'app ' + appId);
  fs.mkdirSync(dir, { recursive: true });
  const beta = p.values.get('--beta');
  const code = await steamCmd(
    appUpdateArgs({
      appId,
      dir,
      login: account(p, true),
      ...(beta ? { beta } : {}),
      validate: p.flags.has('--validate'),
    }),
  );
  const size = folderSize(dir);
  if (!given) recordApp(appId, size);
  console.log('App ' + appId + ' is in ' + dir + ' (' + gb(size) + ').');
  return code;
}

async function workshop(p: Parsed): Promise<number> {
  const verb = p.words[1];
  if (verb === 'get') {
    const appId = checkAppId(p.words[2] ?? '');
    const items = p.words.slice(3);
    const cache = workshopCache();
    assertAppRoom(cache, GB, 'workshop items');
    fs.mkdirSync(cache, { recursive: true });
    const code = await steamCmd(
      workshopGetArgs({ appId, items, dir: cache, login: account(p, true), validate: p.flags.has('--validate') }),
    );
    for (const item of items) {
      const dir = workshopItemDir(cache, appId, item);
      console.log(item + ': ' + (fs.existsSync(dir) ? dir : 'not downloaded'));
    }
    return code;
  }
  if (verb === 'push') {
    const script = path.resolve(p.words[2] ?? '');
    if (scriptKind(readScript(script)) !== 'workshopitem')
      throw new Error(script + ' is not a workshop_item script (its first block is not "workshopitem")');
    return steamCmd(workshopPushArgs(account(p, false), script));
  }
  throw new Error('Usage: sbx-steam workshop get <appid> <item>... | workshop push <workshop_item.vdf>');
}

async function build(p: Parsed): Promise<number> {
  const script = path.resolve(p.words[1] ?? '');
  const text = readScript(script);
  if (scriptKind(text) !== 'appbuild')
    throw new Error(script + ' is not an app_build script (its first block is not "AppBuild")');
  const login = account(p, false);
  const desc = p.values.get('--desc');
  if (!p.flags.has('--preview') && desc === undefined) return steamCmd(appBuildArgs(login, script));
  // A copy beside the script (its relative paths stay right) with Preview / Desc set; removed afterwards.
  const changed = withBuildSettings(text, {
    preview: p.flags.has('--preview'),
    ...(desc !== undefined ? { desc } : {}),
  });
  const copy = path.join(path.dirname(script), path.basename(script, '.vdf') + '.sbx-' + process.pid + '.vdf');
  fs.writeFileSync(copy, changed ?? text, 'utf8');
  try {
    return await steamCmd(appBuildArgs(login, copy));
  } finally {
    fs.rmSync(copy, { force: true });
  }
}

function games(): number {
  const apps = installedApps();
  console.log(apps.length ? 'Downloaded here (tools\\steam-apps):' : 'Nothing downloaded with sbx-steam app yet.');
  for (const a of apps) console.log('  ' + a.appId + '  ' + a.name + '  ' + gb(a.sizeBytes) + '  ' + a.dir);
  const pc = (session.pcInstalls?.items ?? []).filter((i) => i.kind === 'steam-game' || i.kind === 'steam-library');
  if (pc.length) {
    console.log("This PC's, read-only (pcInstalls.steamGames):");
    for (const i of pc) console.log('  ' + i.id + '  ' + i.name + '  ' + i.guest);
    console.log(
      '  Steam cannot update or run a game from a read-only folder: sbx-steam app <appid> makes a copy here.',
    );
  }
  return 0;
}

function client(): number {
  if (!session.toolchains.steam.client) {
    console.error('The Steam client is off: set toolchains.steam.client to true and restart the sandbox.');
    return 1;
  }
  const exe = path.join(steamClientDir(), 'steam.exe');
  if (!fs.existsSync(exe)) {
    console.error('The Steam client is not set up (see the boot log).');
    return 1;
  }
  spawn(exe, [], { cwd: steamClientDir(), detached: true, stdio: 'ignore' }).unref();
  console.log(
    'Starting the Steam client (it updates itself the first time). Sign in to it here: its sign-in is tied to this sandbox and does not carry over to the next one.',
  );
  return 0;
}

export const steamTool: DevTool = {
  name: 'steam',
  summary: 'log in to SteamCMD, download apps and workshop items, upload builds and workshop items',
  async run(args) {
    let p: Parsed;
    try {
      p = parse(args);
    } catch (e) {
      console.error('sbx-steam: ' + errMsg(e) + '\n' + USAGE);
      return 2;
    }
    switch (p.words[0]) {
      case 'login':
        return login(p);
      case 'app':
        return app(p);
      case 'workshop':
        return workshop(p);
      case 'build':
        return build(p);
      case 'games':
        return games();
      case 'client':
        return client();
      case undefined:
      case 'help':
        console.log(USAGE);
        return p.words[0] ? 0 : 2;
      default:
        console.error('sbx-steam: unknown command ' + p.words[0] + '\n' + USAGE);
        return 2;
    }
  },
};
