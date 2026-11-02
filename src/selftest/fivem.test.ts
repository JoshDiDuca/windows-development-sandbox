// FiveM / RedM: server builds from the versions API (a saved copy of its answer), the signature rule that stands in
// for checksums, the Cfx.re key's cfg on the sandbox's own disk, how sbx-fivem serve starts FXServer (RedM, txAdmin,
// oxmysql), the resource scaffolds, the toolchain hints and the modding apps.
import fs from 'node:fs';
import path from 'node:path';
import { fakeIO } from '../app/kernel/index.js';
import { loginServiceFlow } from '../app/features/accounts/index.js';
import { DEFAULTS } from '../core/config/index.js';
import { HOST_SOURCES, ServiceAccountStore } from '../host/accounts/index.js';
import { fivemHints } from '../host/launch/hints/fivem.js';
import { SecretStore } from '../host/secrets/index.js';
import { applyServiceAccounts, readDelivered } from '../guest/accounts/apply.js';
import { accountsRoot } from '../guest/accounts/adapter.js';
import { cfxAdapter, cfxSecretsFile, cfxSecretsText } from '../guest/accounts/kinds/cfx.js';
import {
  ARTIFACTS_PAGE,
  artifactSetting,
  artifactTrust,
  chooseArtifact,
  parseArtifactsPage,
  parseVersions,
  pickArtifact,
} from '../guest/toolchains/fivem/artifacts.js';
import {
  csNamespace,
  initServerFolder,
  RESOURCE_LANGS,
  resourceHome,
  scaffoldResource,
  templateFiles,
  withEnsure,
} from '../guest/toolchains/fivem/scaffold.js';
import { GAME_PORT, mysqlConnectionString, servePlan, TXADMIN_PORT } from '../guest/toolchains/fivem/serve-plan.js';
import { APPS } from '../shared/apps/index.js';
import { MODDING_APPS } from '../shared/apps/catalogue-modding.js';
import { Downloader } from '../shared/download/index.js';
import type { Suite } from './support/suite.js';

const KEY = 'cfxk_PlantedFivemKey_0123456789abcdef';
const STEAM = '0123456789ABCDEF0123456789ABCDEF';
const ROCKSTAR = 'CN="Rockstar Games, Inc.", O="Rockstar Games, Inc.", L=New York, S=New York, C=US';

const allFiles = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .map((f) => path.join(dir, f))
        .filter((f) => fs.statSync(f).isFile())
    : [];

export const fivemSuite: Suite = {
  name: 'fivem',
  title: 'FiveM / RedM: server builds, the Cfx.re key, sbx-fivem serve, scaffolds, hints, modding apps',
  run: async (t) => {
    const fixtures = path.join(t.packageRoot, 'src', 'selftest', 'fixtures', 'fivem');
    const versionsJson: unknown = JSON.parse(fs.readFileSync(path.join(fixtures, 'versions.json'), 'utf8'));
    const pageHtml = fs.readFileSync(path.join(fixtures, 'artifacts-page.txt'), 'utf8');

    t.section('server builds (versions API)');
    const channels = parseVersions(versionsJson);
    t.check(
      channels.recommended.build === 35245 &&
        channels.latest.build === 38182 &&
        channels.optional.build === 7290 &&
        channels.critical.build === 7290 &&
        channels.recommended.url.endsWith('/35245-6efb47dff473c0e2a12fb50b08d74c0eb24a50d5/server.zip') &&
        channels.recommended.txAdmin === '8.1.1' &&
        channels.latest.txAdmin === '8.1.2',
      'the versions API gives each channel its build, its server.zip and its txAdmin',
    );
    await t.throws(
      () =>
        parseVersions({
          ...(versionsJson as object),
          latest_download: 'https://evil.example/38182/server.zip',
        }),
      '',
      'a download anywhere but runtime.fivem.net is refused',
    );
    await t.throws(() => parseVersions({ recommended: '1' }), '', 'an answer of another shape is refused');
    const page = parseArtifactsPage(pageHtml);
    t.check(
      page.length === 4 &&
        page[0]!.build === 38182 &&
        page.every((a) => a.url.startsWith(ARTIFACTS_PAGE) && a.url.endsWith('/server.zip')) &&
        page.some((a) => a.build === 38164 && a.url.includes('38164-c7a8db730dbaaf1519221ac63e179e2f3af48d55')),
      'the artifacts page gives the Windows builds (newest first, as server.zip), not Linux or other servers',
      JSON.stringify(page),
    );
    t.check(
      artifactSetting('recommended') === 'recommended' &&
        artifactSetting('38164') === 38164 &&
        artifactSetting('newest') === null &&
        artifactSetting('1e3') === null,
      'a setting is a channel or a build number',
    );
    t.check(
      chooseArtifact('recommended', channels)?.build === 35245 &&
        chooseArtifact('latest', channels)?.build === 38182 &&
        chooseArtifact('optional', channels)?.build === 7290 &&
        chooseArtifact('7290', channels)?.url === channels.optional.url &&
        chooseArtifact('38164', channels) === null &&
        chooseArtifact('38164', channels, page)?.build === 38164,
      'recommended / latest / optional pick their channel; a pinned build is a channel build or one on the page',
    );
    let pageAsked = 0;
    const sources = {
      versions: () => Promise.resolve(versionsJson),
      page: () => {
        pageAsked++;
        return Promise.resolve(pageHtml);
      },
    };
    const rec = await pickArtifact('recommended', sources);
    const pinned = await pickArtifact('38164', sources);
    const unknown = await pickArtifact('12', sources);
    t.check(
      rec?.build === 35245 && pinned?.build === 38164 && unknown === null && pageAsked === 2,
      'pickArtifact reads the page only for a pinned build that no channel names; an unknown build is null',
    );
    t.equal(await pickArtifact('soon', sources), null, 'a setting that names nothing is null');

    t.section('no checksums: the signature rule');
    t.equal(artifactTrust(true, ROCKSTAR), 'signed', 'requireChecksum on: a valid Rockstar Games signature passes');
    t.equal(artifactTrust(false, ROCKSTAR), 'signed', 'and without it too');
    t.equal(artifactTrust(true, ''), 'refused', 'requireChecksum on: unsigned (or tampered) is refused');
    t.equal(artifactTrust(false, ''), 'unsigned-allowed', 'requireChecksum off: unsigned is used with a warning');
    t.equal(
      artifactTrust(true, 'CN="Rockstar Games, Inc. Mods", O=Somebody Else, C=US'),
      'refused',
      'a look-alike signer is not Rockstar Games',
    );
    t.equal(artifactTrust(true, 'CN=Valve Corp., O=Valve Corp., C=US'), 'refused', 'another vendor is not enough');
    const strict = new Downloader();
    strict.requireChecksum = true;
    await t.throws(
      () => strict.file(channels.recommended.url, t.at('fivem-dl', 'server.zip'), null),
      'requireChecksum',
      'requireChecksum: a build without the signature check is refused before anything downloads',
    );
    t.check(!fs.existsSync(t.at('fivem-dl', 'server.zip')), 'and nothing is written');

    t.section('the Cfx.re key');
    const parsed = HOST_SOURCES.cfx.fromAnswers!({ licenseKey: KEY, steamWebApiKey: STEAM.toLowerCase() });
    t.check(
      parsed.licenseKey === KEY && parsed.steamWebApiKey === STEAM,
      'typed: the key and the Steam Web API key (upper-cased)',
    );
    t.check(
      !HOST_SOURCES.cfx.fromPc && !HOST_SOURCES.cfx.fromFile && HOST_SOURCES.cfx.fromAnswers !== undefined,
      'the key is only typed (nothing on the PC to take it from)',
    );
    await t.throws(
      () => HOST_SOURCES.cfx.fromAnswers!({ licenseKey: 'cfxk_x" +exec evil.cfg "' }),
      'not a Cfx.re server key',
      'a key with quotes or spaces is refused (it could not break out of its cfg line anyway)',
    );
    const summary = HOST_SOURCES.cfx.summary(parsed) ?? '';
    t.check(!summary.includes(KEY) && !summary.includes(STEAM), 'the summary never holds the key');
    const store = new ServiceAccountStore(t.dir('fivem-store'), SecretStore.memory());
    const saved = await loginServiceFlow(fakeIO([KEY, '']).io, 'cfx', { store, share: false });
    t.check(
      store.read('cfx')?.licenseKey === KEY &&
        !saved.message.includes(KEY) &&
        saved.message.includes('accounts.cfx.share'),
      'sandbox account login cfx saves it sealed, says how to share it, never shows it',
    );

    const oldLocal = process.env.LOCALAPPDATA;
    const local = t.dir('fivem-local');
    const project = t.dir('fivem-project');
    const data = t.dir('fivem-data');
    process.env.LOCALAPPDATA = local;
    try {
      const env = await applyServiceAccounts(
        { cfx: { licenseKey: KEY, steamWebApiKey: STEAM } },
        { root: accountsRoot() },
      );
      const cfg = cfxSecretsFile();
      const text = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';
      t.check(
        cfg === path.join(local, 'AgentSandbox', 'accounts', 'cfx', 'server-secrets.cfg') &&
          text.includes('sv_licenseKey "' + KEY + '"') &&
          text.includes('set steam_webApiKey "' + STEAM + '"'),
        "boot writes the key to a cfg in the sandbox's own folder (%LOCALAPPDATA%\\AgentSandbox\\accounts\\cfx)",
        cfg,
      );
      const leaks = [...allFiles(project), ...allFiles(data), ...allFiles(path.join(local, 'AgentSandbox'))].filter(
        (f) => f !== cfg && fs.readFileSync(f, 'utf8').includes(KEY),
      );
      t.check(
        !leaks.length && !Object.values(env).some((v) => v.includes(KEY)),
        'the key is nowhere else: not in the project, the data folder, delivered.json or the agent environment',
        leaks.join(', '),
      );
      t.check(!JSON.stringify(readDelivered(accountsRoot())).includes(KEY), 'delivered.json holds only a fingerprint');
      t.check(
        (await cfxAdapter.apply({ licenseKey: KEY })).summary.includes('sbx-fivem serve') &&
          !fs.readFileSync(cfg, 'utf8').includes('steam_webApiKey'),
        'without a Steam Web API key its line is left out',
      );
      t.check(
        cfxSecretsText({ licenseKey: KEY })
          .split('\r\n')
          .filter((l) => l && !l.startsWith('#')).length === 1,
        'the cfg is one setting per line, nothing else',
      );
    } finally {
      if (oldLocal === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = oldLocal;
    }

    t.section('sbx-fivem serve');
    const secrets = 'C:\\Users\\WDAGUtilityAccount\\AppData\\Local\\AgentSandbox\\accounts\\cfx\\server-secrets.cfg';
    const base = {
      artifactDir: 'C:\\AgentData\\tools\\fivem\\artifacts\\35245',
      serverDir: 'C:\\Workspace\\server',
      game: 'gta5' as const,
      txAdmin: false,
      secretsCfg: secrets,
      txData: 'C:\\AgentData\\state\\fivem\\txData',
      mysqlPort: null,
    };
    const plain = servePlan(base);
    const execs = plain.args.flatMap((a, i) => (a === '+exec' ? [plain.args[i + 1]] : []));
    t.check(
      plain.exe === 'C:\\AgentData\\tools\\fivem\\artifacts\\35245\\FXServer.exe' &&
        plain.cwd === base.serverDir &&
        execs.join('|') === secrets.split('\\').join('/') + '|server.cfg' &&
        plain.args.includes('citizen_dir') &&
        !plain.args.includes('gamename') &&
        !plain.args.join(' ').includes('cfxk_'),
      "plain: FXServer by its full path, +exec the key's cfg first and then server.cfg, from the server folder",
      JSON.stringify(plain.args),
    );
    t.equal(
      plain.ports,
      [{ port: GAME_PORT, protocol: 'Both', name: 'FiveM server' }],
      'plain: opens 30120 (TCP and UDP) in the sandbox firewall',
    );
    const redm = servePlan({ ...base, game: 'rdr3' });
    const g = redm.args.indexOf('gamename');
    t.check(g > 0 && redm.args[g - 1] === '+set' && redm.args[g + 1] === 'rdr3', 'RedM: +set gamename rdr3');
    t.check(
      redm.args.indexOf('gamename') < redm.args.indexOf('+exec'),
      'and before the cfgs (they can still change it)',
    );
    const noKey = servePlan({ ...base, secretsCfg: null });
    t.check(noKey.args.filter((a) => a === '+exec').length === 1, 'no key handed over: only server.cfg');
    const withDb = servePlan({ ...base, mysqlPort: 3307 });
    const m = withDb.args.indexOf('mysql_connection_string');
    t.check(
      m > 0 &&
        withDb.args[m + 1] === mysqlConnectionString(3307) &&
        withDb.args[m + 1] === 'mysql://root@127.0.0.1:3307/fivem?charset=utf8mb4' &&
        m < withDb.args.indexOf('+exec'),
      "oxmysql: mysql_connection_string points at the sandbox's MariaDB, set before server.cfg (a line there wins)",
    );
    const tx = servePlan({ ...base, txAdmin: true, game: 'rdr3', mysqlPort: 3306 });
    t.check(
      !tx.args.includes('+exec') &&
        tx.env.TXHOST_DATA_PATH === base.txData &&
        tx.env.TXHOST_TXA_PORT === String(TXADMIN_PORT) &&
        tx.env.TXHOST_GAME_NAME === 'redm' &&
        tx.env.TXHOST_DEFAULT_DBPORT === '3306' &&
        !Object.keys(tx.env).includes('TXHOST_DEFAULT_CFXKEY') &&
        tx.ports.some((p) => p.port === TXADMIN_PORT && p.protocol === 'TCP') &&
        tx.ports.some((p) => p.port === GAME_PORT),
      'txAdmin: no +exec, txData in state\\fivem through TXHOST_*, RedM recipes, the database, ports 30120 and 40120; the key is never prefilled',
      JSON.stringify(tx),
    );

    t.section('scaffolds');
    const templates = path.join(t.packageRoot, 'sandbox', 'templates', 'fivem');
    const server = t.dir('fivem-server');
    t.equal(
      initServerFolder(templates, server, 'myserver', 'gta5'),
      ['server.cfg', 'resources\\[local]'],
      'init writes server.cfg and resources\\[local]',
    );
    const cfgText = fs.readFileSync(path.join(server, 'server.cfg'), 'utf8');
    t.check(
      !/^\s*(sv_licenseKey|set\s+steam_webApiKey)/m.test(cfgText) &&
        cfgText.includes('endpoint_add_udp "0.0.0.0:30120"') &&
        !cfgText.includes('{{'),
      'the server.cfg template sets no key (only comments name it) and listens on 30120',
    );
    t.equal(initServerFolder(templates, server, 'myserver', 'gta5'), [], 'init again changes nothing');
    t.equal(resourceHome(server), path.join(server, 'resources', '[local]'), 'resources go in resources\\[local]');
    t.equal(resourceHome(project), project, 'outside a server folder: in the folder itself');
    for (const lang of RESOURCE_LANGS) {
      const made = scaffoldResource({ templates, lang, name: 'my-' + lang, into: resourceHome(server), game: 'gta5' });
      const texts = made.files.map((f) => fs.readFileSync(path.join(made.dir, f), 'utf8'));
      const manifest = fs.readFileSync(path.join(made.dir, 'fxmanifest.lua'), 'utf8');
      t.check(
        made.files.length >= 3 &&
          texts.every((x) => !x.includes('{{')) &&
          manifest.includes("game 'gta5'") &&
          manifest.includes("name 'my-" + lang + "'") &&
          !manifest.includes('rdr3_warning'),
        lang + ': a resource with its manifest, every placeholder filled',
        made.files.join(', '),
      );
    }
    const cs = fs.readFileSync(path.join(resourceHome(server), 'my-cs', 'Client', 'ClientMain.cs'), 'utf8');
    t.check(
      cs.includes('namespace MyCs.Client') &&
        fs.readFileSync(path.join(resourceHome(server), 'my-cs', 'fxmanifest.lua'), 'utf8').includes('.net.dll'),
      'C#: a namespace from the name, and a manifest that loads the *.net.dll builds',
    );
    t.check(
      templateFiles(path.join(templates, 'ts')).includes(path.join('src', 'client', 'client.ts')),
      'TypeScript: client and server sources with a build script',
    );
    const red = scaffoldResource({ templates, lang: 'lua', name: 'redres', into: project, game: 'rdr3' });
    const redManifest = fs.readFileSync(path.join(red.dir, 'fxmanifest.lua'), 'utf8');
    t.check(
      redManifest.includes("game 'rdr3'") && redManifest.includes('rdr3_warning'),
      "RedM: game 'rdr3' and its prerelease acknowledgement",
    );
    await t.throws(
      () => scaffoldResource({ templates, lang: 'lua', name: 'redres', into: project, game: 'rdr3' }),
      'already exists',
      'an existing resource is never overwritten',
    );
    await t.throws(
      () => scaffoldResource({ templates, lang: 'lua', name: '..\\escape', into: project, game: 'gta5' }),
      'not a resource name',
      'a name with a path in it is refused',
    );
    t.equal(csNamespace('9lives_mod-x'), 'R9livesModX', 'C# namespaces never start with a digit');
    const ensured = withEnsure('ensure chat\n', 'my-lua');
    t.check(
      ensured === 'ensure chat\nensure my-lua\n' &&
        withEnsure(ensured!, 'my-lua') === null &&
        withEnsure('ensure my-luax', 'my-lua') !== null,
      'new adds ensure <name> to server.cfg once',
    );

    t.section('hints');
    const hinted = t.dir('fivem-hints');
    t.write(
      path.join(hinted, 'resources', '[local]', 'shop', 'fxmanifest.lua'),
      "fx_version 'cerulean'\nclient_script 'client.lua'\n",
    );
    const settings = structuredClone(DEFAULTS.toolchains);
    const h1 = fivemHints(hinted, settings);
    t.check(
      (h1.fivem ?? '').includes('resources/[local]/shop/fxmanifest.lua') && h1.dotnet === undefined,
      'a resource 3 folders down turns fivem on (a Lua one not dotnet)',
      JSON.stringify(h1),
    );
    t.write(
      path.join(hinted, 'resources', '[local]', 'bank', 'fxmanifest.lua'),
      "fx_version 'cerulean'\nclient_script 'Client/bin/Release/**/publish/*.net.dll'\n",
    );
    t.check((fivemHints(hinted, settings).dotnet ?? '').includes('C#'), 'a manifest loading *.net.dll turns dotnet on');
    const csproj = t.dir('fivem-hints-cs');
    t.write(
      path.join(csproj, 'res', '__resource.lua'),
      "resource_manifest_version '44febabe-d386-4d18-afbe-5e627f4af937'\n",
    );
    t.write(path.join(csproj, 'res', 'Server', 'Server.csproj'), '<Project />');
    t.check(Boolean(fivemHints(csproj, settings).dotnet), 'so does a .csproj in the resource (or one folder below)');
    const deep = t.dir('fivem-hints-deep');
    t.write(path.join(deep, 'a', 'b', 'c', 'd', 'fxmanifest.lua'), '');
    t.write(path.join(deep, 'node_modules', 'x', 'fxmanifest.lua'), '');
    t.equal(fivemHints(deep, settings), {}, 'deeper than 3 folders, or under node_modules: no hint');
    t.equal(
      fivemHints(hinted, { ...settings, fivem: { ...settings.fivem, enabled: false } }),
      {},
      'fivem off: no hints',
    );

    t.section('modding apps');
    t.check(
      ['lua-language-server', 'stylua', 'selene'].every((id) => APPS.some((a) => a.id === id)) &&
        MODDING_APPS.every((a) => 'github' in a.source && a.cli === true) &&
        !APPS.some((a) => a.id === 'codewalker'),
      'lua-language-server, StyLua and selene are in the catalogue (GitHub releases with their published SHA-256); CodeWalker is not (no download to check)',
    );
  },
};
