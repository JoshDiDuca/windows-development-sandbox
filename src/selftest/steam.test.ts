// Steam: the VDF parser and its limits, the SteamCMD sign-in from a fake steamcmd folder (host) and back (sandbox),
// SteamCMD's command lines (apps, workshop, builds), the PC's libraries from a fixture libraryfolders.vdf, the SteamCMD
// install (a bad signer, the time limit, nothing private kept on the data disk), room checks with an injected statfs,
// and the build-script hint. Temp folders and fakes only: nothing is downloaded or run.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../core/config/index.js';
import { decideToolchains } from '../core/detect/index.js';
import { HOST_SOURCES } from '../host/accounts/index.js';
import { steamCmdFolderOf } from '../host/accounts/kinds/steam.js';
import { steamHints } from '../host/launch/hints/steam.js';
import { discoverPcInstalls, type PcInstallSource } from '../host/pc-installs/index.js';
import { findSteamInstalls, steamInstalls, steamLibraries } from '../host/pc-installs/steam.js';
import { fingerprint, readSteamCmdLogin } from '../shared/accounts/index.js';
import { encodeText } from '../shared/io/index.js';
import { InstallRecordsSchema } from '../shared/installs.js';
import { PC_INSTALLS_GUEST } from '../shared/paths/index.js';
import { parseVdf, vdfGet, vdfText } from '../shared/vdf.js';
import { steamAdapterFor } from '../guest/accounts/kinds/steam.js';
import { assertAppRoom, installedApps, recordApp } from '../guest/toolchains/steam/apps.js';
import {
  appBuildArgs,
  appUpdateArgs,
  scriptKind,
  withBuildSettings,
  workshopGetArgs,
  workshopPushArgs,
} from '../guest/toolchains/steam/commands.js';
import { fetchSteamCmd, prepareSteamCmd, type SteamCmdDeps } from '../guest/toolchains/steam/steamcmd-install.js';
import type { Suite } from './support/suite.js';

const GB = 1024 ** 3;
const PC = { localAppData: '', appData: '', programData: '' };
const roomy = { statfs: () => ({ bavail: 100 * GB, bsize: 1 }) };
const short = { statfs: () => ({ bavail: GB / 4, bsize: 1 }) };
/** A VDF string as Steam writes paths: backslashes doubled. */
const q = (p: string): string => '"' + p.replace(/\\/g, '\\\\') + '"';

const CONFIG_VDF = `"InstallConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"Accounts"
				{
					"builder_bot"
					{
						"SteamID"		"76561190000000000"
					}
				}
				"ConnectCache"
				{
					"7a2c1b3d1"		"0200000001000000aabbccdd"
				}
			}
		}
	}
}
`;

const APP_BUILD = `"AppBuild"
{
	"AppID" "480" // Spacewar
	"Desc" "nightly"
	"ContentRoot" "..\\content\\"
	"BuildOutput" "..\\output\\"
	"Depots"
	{
		"481" "depot_build_481.vdf"
	}
}
`;

export const steamSuite: Suite = {
  name: 'steam',
  title: 'Steam: the VDF parser, the SteamCMD sign-in, sbx-steam command lines, PC libraries, SteamCMD install',
  run: async (t, f) => {
    t.section('the VDF parser');
    const parsed = parseVdf(
      '\uFEFF// a comment\n"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n' +
        '\t\t"Label" "say \\"hi\\""\n\t}\n\tunquoted value\n\t"cond" "1" [$WIN32]\n}\n',
    );
    t.equal(vdfText(parsed, 'libraryfolders', '0', 'path'), 'C:\\Program Files (x86)\\Steam', 'escaped paths come out');
    t.equal(vdfText(parsed, 'LIBRARYFOLDERS', '0', 'label'), 'say "hi"', 'keys match in any case, quotes unescape');
    t.check(
      vdfText(parsed, 'libraryfolders', 'unquoted') === 'value' && vdfText(parsed, 'libraryfolders', 'cond') === '1',
      'comments, a byte-order mark, unquoted words and [conditions] are handled',
    );
    t.equal(
      vdfText(parseVdf(APP_BUILD, { escapes: false }), 'AppBuild', 'ContentRoot'),
      '..\\content\\',
      'without escapes a hand-written "..\\content\\" stays as written',
    );
    t.equal(
      vdfText(parseVdf('"a" { "k" "first" "K" "second" }'), 'a', 'k'),
      'first',
      'a repeated key keeps the first value',
    );
    const proto = parseVdf('"__proto__" { "polluted" "yes" } "constructor" "x"');
    t.check(
      proto !== null &&
        ({} as Record<string, unknown>).polluted === undefined &&
        vdfGet(proto, '__proto__') !== undefined,
      'a "__proto__" key is a plain key (nothing is polluted)',
    );
    const refused: [string, string, object?][] = [
      ['"a" { "b" "c"', 'an unclosed block'],
      ['"a" "b" }', 'a stray }'],
      ['"a" { "b" "c', 'an unclosed quote'],
      ['"a"', 'a key without a value'],
      ['{ "a" "b" }', 'a block without a key'],
      ['"x" [$WIN32', 'an unclosed condition'],
      ['"a" "' + 'x'.repeat(2000) + '"', 'a text over maxBytes', { maxBytes: 1000 }],
      ['"a" { "b" { "c" "d" } }', 'nesting over maxDepth', { maxDepth: 1 }],
      ['"a" "1" "b" "2" "c" "3"', 'more keys than maxKeys', { maxKeys: 2 }],
    ];
    for (const [text, what, limits] of refused) t.equal(parseVdf(text, limits), null, 'refused: ' + what);
    const deep = '"a" {'.repeat(50_000);
    const flat = '"r" {' + Array.from({ length: 50_000 }, (_, i) => '"k' + i + '" "v"').join(' ') + '}';
    const started = Date.now();
    const deepResult = parseVdf(deep);
    const flatResult = parseVdf(flat);
    t.check(
      deepResult === null && flatResult !== null && Date.now() - started < 5000,
      'deep nesting is refused and 50000 keys parse quickly (no quadratic work)',
      Date.now() - started + ' ms',
    );
    t.equal(parseVdf('"a" "b"', { maxBytes: 3 }), null, 'the size limit holds before anything is parsed');

    t.section('the SteamCMD sign-in: from a steamcmd folder on this PC');
    const pcCmd = t.dir('pc-steamcmd');
    t.write(path.join(pcCmd, 'steamcmd.exe'), 'exe');
    t.write(path.join(pcCmd, 'config', 'config.vdf'), CONFIG_VDF);
    for (let i = 1; i <= 5; i++) {
      t.write(path.join(pcCmd, 'ssfn' + i), 'sentry' + i);
      fs.utimesSync(path.join(pcCmd, 'ssfn' + i), new Date(), new Date(Date.now() - (6 - i) * 60_000));
    }
    t.write(path.join(pcCmd, 'ssfn99'), 'x'.repeat(60 * 1024));
    t.write(path.join(pcCmd, 'ssfnabc'), 'not a sentry');
    const source = HOST_SOURCES.steam;
    const login = source.fromPc!(PC, pcCmd);
    t.check(
      login !== null &&
        login.account === 'builder_bot' &&
        login.configVdf === CONFIG_VDF &&
        login.sentries.length === 4 &&
        login.sentries.map((s) => s.name).join() === 'ssfn2,ssfn3,ssfn4,ssfn5' &&
        Buffer.from(login.sentries[3].base64, 'base64').toString() === 'sentry5',
      'config.vdf and the newest four sentry files are taken (an oversized or misnamed one is not)',
      JSON.stringify(login?.sentries.map((s) => s.name)),
    );
    t.equal(login ? source.summary(login) : null, 'builder_bot', 'its summary is the account name, never the token');
    t.check(
      steamCmdFolderOf(path.join(pcCmd, 'steamcmd.exe')) === pcCmd &&
        steamCmdFolderOf(path.join(pcCmd, 'config', 'config.vdf')) === pcCmd &&
        fingerprint(source.fromPc!(PC, path.join(pcCmd, 'config', 'config.vdf'))) === fingerprint(login),
      '--from may name the folder, its steamcmd.exe or its config.vdf',
    );
    const utf16 = t.dir('pc-steamcmd-utf16');
    fs.mkdirSync(path.join(utf16, 'config'));
    fs.writeFileSync(path.join(utf16, 'config', 'config.vdf'), encodeText(CONFIG_VDF, 'utf16le'));
    t.equal(readSteamCmdLogin(utf16)?.account, 'builder_bot', 'a UTF-16 config.vdf is read too');
    const signedOut = t.dir('pc-steamcmd-out');
    t.write(path.join(signedOut, 'config', 'config.vdf'), CONFIG_VDF.replace(/"ConnectCache"[\s\S]*?\}/, ''));
    t.check(
      source.fromPc!(PC, signedOut) === null && source.fromPc!(PC, t.at('nowhere')) === null,
      'no cached login (or no folder): nothing is taken',
    );
    const big = t.dir('pc-steamcmd-big');
    t.write(path.join(big, 'config', 'config.vdf'), CONFIG_VDF + ' '.repeat(300 * 1024));
    t.equal(readSteamCmdLogin(big), null, 'a config.vdf over 256 KB is refused');

    t.section('the SteamCMD sign-in: in the sandbox');
    const guestCmd = t.dir('guest-steamcmd');
    const adapter = steamAdapterFor(guestCmd);
    const applied = await adapter.apply(login!);
    const back = adapter.current!();
    t.check(
      fs.readFileSync(path.join(guestCmd, 'config', 'config.vdf'), 'utf8') === CONFIG_VDF &&
        fs.readFileSync(path.join(guestCmd, 'ssfn5'), 'utf8') === 'sentry5' &&
        !applied.summary.includes('aabbccdd') &&
        back !== null &&
        fingerprint(back) === fingerprint(login),
      "applied into SteamCMD's folder and read back the same (the watch hands back nothing new)",
    );
    t.write(path.join(guestCmd, 'config', 'config.vdf'), CONFIG_VDF.replace('aabbccdd', 'eeff0011'));
    t.check(
      fingerprint(adapter.current!()) !== fingerprint(login),
      'a renewed login token reads back different (it goes back to the PC)',
    );

    t.section('SteamCMD command lines');
    const dir = 'C:\\AgentData\\tools\\steam-apps\\740';
    t.equal(
      appUpdateArgs({ appId: '740', dir, login: 'anonymous', beta: 'public-beta', validate: true }),
      [
        '+force_install_dir',
        dir,
        '+login',
        'anonymous',
        '+app_update',
        '740',
        '-beta',
        'public-beta',
        'validate',
        '+quit',
      ],
      'app: the folder comes before the login, then the app, its branch and validate',
    );
    t.equal(
      workshopGetArgs({
        appId: '4000',
        items: ['123', '456'],
        dir: 'C:\\AgentData\\cache\\steam-workshop',
        login: 'me',
      }),
      [
        '+force_install_dir',
        'C:\\AgentData\\cache\\steam-workshop',
        '+login',
        'me',
        '+workshop_download_item',
        '4000',
        '123',
        '+workshop_download_item',
        '4000',
        '456',
        '+quit',
      ],
      'workshop get: one download command per item',
    );
    t.equal(
      workshopPushArgs('me', 'C:\\Workspace\\game\\item.vdf'),
      ['+login', 'me', '+workshop_build_item', 'C:\\Workspace\\game\\item.vdf', '+quit'],
      'workshop push: workshop_build_item',
    );
    t.equal(
      appBuildArgs('me', 'C:\\Workspace\\game\\app_build_480.vdf'),
      ['+login', 'me', '+run_app_build', 'C:\\Workspace\\game\\app_build_480.vdf', '+quit'],
      'build: run_app_build',
    );
    const bad: [() => unknown, string][] = [
      [() => appUpdateArgs({ appId: '480 +quit', dir, login: 'me' }), 'an app ID with a command in it'],
      [() => appUpdateArgs({ appId: '0', dir, login: 'me' }), 'app ID 0'],
      [() => appUpdateArgs({ appId: '480', dir, login: 'me +runscript x' }), 'an account with a command in it'],
      [() => appUpdateArgs({ appId: '480', dir, login: 'me', beta: 'a b' }), 'a branch with a space'],
      [() => appUpdateArgs({ appId: '480', dir: 'relative\\dir', login: 'me' }), 'a relative folder'],
      [() => appUpdateArgs({ appId: '480', dir: 'C:\\a "b"', login: 'me' }), 'a folder with a quote'],
      [() => appUpdateArgs({ appId: '480', dir: 'C:\\x +quit', login: 'me' }), 'a folder with " +"'],
      [() => workshopGetArgs({ appId: '480', items: [], dir, login: 'me' }), 'no workshop items'],
      [() => workshopGetArgs({ appId: '480', items: ['12a'], dir, login: 'me' }), 'a bad item ID'],
      [() => workshopPushArgs('anonymous', 'C:\\item.vdf'), 'uploading anonymously'],
      [() => appBuildArgs('me', 'app_build.vdf'), 'a relative script'],
    ];
    for (const [fn, what] of bad)
      await t.throws(fn, /not a|cannot be given|no workshop|needs your Steam/, 'refused: ' + what);
    t.check(
      scriptKind(APP_BUILD) === 'appbuild' &&
        scriptKind('"workshopitem" { "appid" "480" "publishedfileid" "0" }') === 'workshopitem' &&
        scriptKind('"libraryfolders" { }') === null,
      'a script is told by its first block',
    );
    const preview = withBuildSettings(APP_BUILD, { preview: true, desc: 'from the sandbox' });
    const previewRoot = preview ? parseVdf(preview, { escapes: false }) : null;
    t.check(
      vdfText(previewRoot, 'AppBuild', 'Preview') === '1' &&
        vdfText(previewRoot, 'AppBuild', 'Desc') === 'from the sandbox' &&
        vdfText(previewRoot, 'AppBuild', 'ContentRoot') === '..\\content\\',
      '--preview and --desc set Preview and Desc in a copy of the script, the rest unchanged',
    );
    t.check(
      vdfText(parseVdf(withBuildSettings(preview!, { preview: true })!, { escapes: false }), 'AppBuild', 'Preview') ===
        '1' && withBuildSettings('"workshopitem" { }', { preview: true }) === null,
      'an existing Preview is replaced; a workshop script is not a build',
    );
    await t.throws(
      () => withBuildSettings(APP_BUILD, { desc: 'a "quoted" one' }),
      'one line',
      'a description cannot break the script',
    );

    t.section("this PC's Steam libraries");
    const steamRoot = t.dir('pc-steam');
    const lib2 = t.dir('pc-steam-lib2');
    t.write(
      path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t${q(steamRoot)}\n\t\t"apps"\n\t\t{\n\t\t\t"228980"\t\t"1"\n\t\t}\n\t}\n` +
        `\t"1"\n\t{\n\t\t"path"\t\t${q(lib2)}\n\t\t"apps"\n\t\t{\n\t\t\t"480"\t\t"1"\n\t\t}\n\t}\n}\n`,
    );
    t.write(
      path.join(lib2, 'steamapps', 'appmanifest_480.acf'),
      '"AppState"\n{\n\t"appid"\t\t"480"\n\t"name"\t\t"Spacewar"\n\t"installdir"\t\t"Spacewar"\n\t"buildid"\t\t"123"\n}\n',
    );
    t.dir('pc-steam-lib2', 'steamapps', 'common', 'Spacewar');
    t.write(
      path.join(lib2, 'steamapps', 'appmanifest_10.acf'),
      '"AppState" { "appid" "10" "name" "Climber" "installdir" "..\\\\..\\\\Windows" }',
    );
    t.equal(
      steamLibraries(fs.readFileSync(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), 'utf8')).map((l) => [
        l.path,
        l.apps,
      ]),
      [
        [steamRoot, ['228980']],
        [lib2, ['480']],
      ],
      'libraryfolders.vdf: each library and the apps it lists',
    );
    t.equal(
      steamLibraries('"LibraryFolders" { "TimeNextStatsReport" "1" "ContentStatsID" "2" "1" "D:\\\\Games" }').map(
        (l) => l.path,
      ),
      ['D:\\Games'],
      'the old libraryfolders.vdf format too',
    );
    const libraries = findSteamInstalls(steamRoot, true);
    t.check(
      libraries.map((l) => [l.kind, l.id, l.host].join()).join('|') ===
        [
          'steam-library,library1,' + path.join(steamRoot, 'steamapps'),
          'steam-library,library2,' + path.join(lib2, 'steamapps'),
        ].join('|') && libraries.every((l) => !l.name.includes(steamRoot) && !l.name.includes(lib2)),
      "true: every library's steamapps, named without a path of this PC",
    );
    const games = findSteamInstalls(steamRoot, [480, '10', 'abc', 99]);
    t.equal(
      games.map((g) => [g.id, g.name, g.version, g.host]),
      [['480', 'Spacewar', '123', path.join(lib2, 'steamapps', 'common', 'Spacewar')]],
      'a list: only those games, from their manifests (an installdir that climbs out, or an unknown ID, is left out)',
    );
    const fixture: PcInstallSource = { ...steamInstalls, find: (wanted) => findSteamInstalls(steamRoot, wanted) };
    const found = discoverPcInstalls(
      { ...DEFAULTS.pcInstalls, steamGames: [480] },
      { packageRoot: t.packageRoot, storageRoot: f.baseConfig.storage.root, sources: [fixture] },
      PC,
    );
    t.check(
      found.mappings.length === 1 &&
        found.mappings[0].guest === PC_INSTALLS_GUEST + '\\steam\\480' &&
        found.mappings[0].readOnly &&
        !JSON.stringify(found.manifest).includes(lib2),
      'mapped read-only at C:\\PcInstalls\\steam\\480; the manifest holds no path of this PC',
    );

    t.section('installing SteamCMD');
    const tools = t.dir('steam-tools');
    const store = path.join(tools, 'steamcmd');
    const work = t.dir('steam-work');
    let downloads = 0;
    const fake = (signed: (file: string) => boolean, extra: Partial<SteamCmdDeps> = {}): SteamCmdDeps => ({
      ...roomy,
      toolsDir: tools,
      storeDir: store,
      workDir: work,
      signed,
      download: async (_url, file, verify) => {
        downloads++;
        fs.writeFileSync(file + '.part', 'zip');
        try {
          await verify(file + '.part');
          fs.renameSync(file + '.part', file);
        } finally {
          fs.rmSync(file + '.part', { force: true });
        }
      },
      extract: async (_archive, destination) => {
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(path.join(destination, 'steamcmd.exe'), 'steamcmd');
      },
      run: async (_exe, args, cwd) => {
        if (args.join() === '+quit') fs.writeFileSync(path.join(cwd, 'steamclient64.dll'), 'updated');
        return { code: 7, timedOut: false };
      },
      ...extra,
    });
    await t.throws(
      () =>
        fetchSteamCmd(
          store,
          fake(() => false),
        ),
      'not signed by Valve',
      'a steamcmd.exe not signed by Valve is refused',
    );
    t.check(
      !fs.existsSync(store) && !fs.readdirSync(tools).some((n) => n.includes('staging')),
      'and nothing of it is kept',
    );
    downloads = 0;
    await t.throws(
      () =>
        fetchSteamCmd(
          store,
          fake(() => true, short),
        ),
      'it needs',
      'too little room on the data disk: refused before downloading',
    );
    t.equal(downloads, 0, 'nothing was downloaded');

    // The boot applied the sign-in into the working folder before this step (accounts come first).
    t.write(path.join(work, 'config', 'config.vdf'), CONFIG_VDF);
    t.write(path.join(work, 'ssfn5'), 'sentry5');
    const exe = await prepareSteamCmd(fake(() => true));
    t.check(
      exe === path.join(work, 'steamcmd.exe') &&
        fs.readFileSync(path.join(work, 'config', 'config.vdf'), 'utf8') === CONFIG_VDF &&
        fs.existsSync(path.join(store, 'steamclient64.dll')),
      'downloaded once, copied in without touching the sign-in, updated, and the updated binaries kept',
    );
    t.check(
      !fs.existsSync(path.join(store, 'config')) && !fs.existsSync(path.join(store, 'ssfn5')),
      'the kept copy on the data disk never holds config\\ or a sentry file',
    );
    const fresh = t.dir('steam-work-2');
    t.write(path.join(store, 'config', 'config.vdf'), 'planted');
    downloads = 0;
    await prepareSteamCmd(fake(() => true, { workDir: fresh }));
    t.check(
      downloads === 0 && !fs.existsSync(path.join(store, 'config')) && !fs.existsSync(path.join(fresh, 'config')),
      'the next sandbox copies the kept binaries (no download); a config\\ planted there is removed, not copied',
    );
    await t.throws(
      () =>
        prepareSteamCmd(
          fake(() => true, { workDir: t.dir('steam-work-3'), run: async () => ({ code: -1, timedOut: true }) }),
        ),
      'did not finish updating itself',
      'its first-run update has a time limit',
    );
    await t.throws(
      () => prepareSteamCmd(fake((file) => !file.startsWith(t.at('steam-work-4')), { workDir: t.dir('steam-work-4') })),
      'not signed by Valve',
      'a steamcmd.exe that is not Valve-signed is never run',
    );
    t.check(!fs.existsSync(store), 'and the kept copy goes (downloaded again next boot)');

    t.section('apps and room');
    await t.throws(
      () => assertAppRoom(path.join(tools, 'steam-apps', '740'), 5 * GB, 'app 740', short),
      'it needs 5.0 GB',
      'sbx-steam app refuses when the disk is short',
    );
    t.write(
      path.join(tools, 'steam-apps', '740', 'steamapps', 'appmanifest_740.acf'),
      '"AppState" { "appid" "740" "name" "Counter-Strike Global Offensive - Dedicated Server" "installdir" "csgo_ds" }',
    );
    recordApp('740', 123_456, { toolsDir: tools });
    const apps = installedApps({ toolsDir: tools });
    t.check(
      apps.length === 1 &&
        apps[0].name.startsWith('Counter-Strike') &&
        apps[0].sizeBytes === 123_456 &&
        InstallRecordsSchema.safeParse(t.readJson(path.join(tools, 'installs.json'))).success,
      'its size is recorded in tools\\installs.json (sandbox data shows it) and sbx-steam games lists it',
    );

    t.section('the build-script hint');
    const project = t.dir('steam-project');
    t.write(path.join(project, 'tools', 'ContentBuilder', 'scripts', 'app_build_480.vdf'), APP_BUILD);
    t.write(path.join(project, 'node_modules', 'x', 'app_build.vdf'), APP_BUILD);
    const tc = structuredClone(DEFAULTS.toolchains);
    const hints = steamHints(project, tc);
    t.check(
      (hints.steam ?? '').includes('tools/ContentBuilder/scripts/app_build_480.vdf') &&
        decideToolchains(tc, [], [], hints).steam.on,
      'an app_build .vdf a few folders down turns Steam on',
    );
    const other = t.dir('steam-project-2');
    t.write(path.join(other, 'node_modules', 'x', 'app_build.vdf'), APP_BUILD);
    t.write(path.join(other, 'big.vdf'), '"workshopitem" { "title" "' + 'x'.repeat(70 * 1024) + '" }');
    t.write(path.join(other, 'libraryfolders.vdf'), '"libraryfolders" { }');
    t.write(path.join(other, 'item.txt'), '"workshopitem" { }');
    t.equal(steamHints(other, tc), {}, 'skipped folders, oversized files and other .vdf files give no hint');
    const off = structuredClone(tc);
    off.steam.enabled = false;
    t.equal(steamHints(project, off), {}, 'nothing is read when Steam is not "auto"');
  },
};
