// Unreal engines and the game-development apps: what an engine folder is, where the sandbox finds engines (this PC
// read-only, the launcher's folder on the data disk, source builds), which one a project builds with, the registry and
// file-association plan, PATH and variables, the launcher's files (LauncherInstalled.dat merge with foreign entries
// kept, .item manifests, GameUserSettings.ini in UTF-16 and UTF-8), the room check, the guide lines, UnrealBuildTool's
// Visual Studio verdict, the vault cache, this PC's discovery (fixtures), the apps catalogue entries and the Unreal
// page. Temp folders and fixtures only: never this machine's registry or launcher.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../core/config/index.js';
import { ConfigSchema } from '../core/schema/index.js';
import { decodeText, encodeText, readBoundedFile } from '../shared/io/index.js';
import {
  chooseEngine,
  ddcVars,
  enginePlaceProblem,
  ENGINE_NEED_BYTES,
  engineAt,
  engineToolDirs,
  engineVars,
  entriesUnder,
  fileAssociationPlan,
  findEngines,
  findUproject,
  hasMcpPlugin,
  installLocationOf,
  itemSizes,
  launcherEntry,
  launcherInstallations,
  mergeLauncherInstalled,
  parseBuildVersion,
  parseEngineAssociation,
  registryPlan,
  restoreItems,
  saveItems,
  setLauncherInstallLocation,
  stableBuildId,
  unrealGuideLines,
  unrealSummaryLine,
  uprojectAssociation,
  vaultDirsFromIni,
  vaultPacks,
  vsVerdict,
  withInstallLocation,
  type EngineFs,
  type UnrealEngine,
  type UnrealStatus,
  type VaultFs,
  type VsSetupReport,
} from '../shared/unreal/index.js';
import { discoverPcInstalls, type PcInstallSource } from '../host/pc-installs/index.js';
import { findEngineFolders, findUnrealInstalls, regValues } from '../host/pc-installs/unreal.js';
import { findEpicGames } from '../host/pc-installs/epic.js';
import { vaultInstalls } from '../host/pc-installs/unreal-vault.js';
import { GAMEDEV_APPS } from '../shared/apps/catalogue-gamedev.js';
import { APPS } from '../shared/apps/index.js';
import { pageActions } from '../app/kernel/index.js';
import { engineFolderProblem, unrealPage, unrealView } from '../app/features/unreal/index.js';
import { pageLines } from '../cli/output/render-view.js';
import { UNREAL_SAMPLE } from './support/unreal-sample.js';
import type { Suite } from './support/suite.js';

const BUILD_VERSION = (major: number, minor: number, patch: number): string =>
  JSON.stringify({
    MajorVersion: major,
    MinorVersion: minor,
    PatchVersion: patch,
    Changelist: 35576357,
    CompatibleChangelist: 35576357,
    IsLicenseeVersion: 0,
    IsPromotedBuild: 1,
    BranchName: '++UE5+Release-' + major + '.' + minor,
  });

/** The real disk under the test's temp folder. */
const DISK: EngineFs = {
  exists: (f) => fs.existsSync(f),
  read: (f, max) => readBoundedFile(f, max),
  list: (d) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  },
};

const VAULT_DISK: VaultFs = {
  exists: (f) => fs.existsSync(f),
  list: DISK.list,
  size: (f) => {
    const s = fs.lstatSync(f, { throwIfNoEntry: false });
    return s?.isFile() ? s.size : null;
  },
  isDir: (d) => fs.lstatSync(d, { throwIfNoEntry: false })?.isDirectory() ?? false,
};

export const enginesSuite: Suite = {
  name: 'engines',
  title: 'Unreal engines (every route), the launcher files, the guide, the Unreal page and the game-development apps',
  run: async (t) => {
    /** A fake engine folder: Build.version, InstalledBuild.txt for an installed build, the tools agents run. */
    const makeEngine = (dir: string, v: [number, number, number], installed: boolean, mcp = false): string => {
      t.write(path.join(dir, 'Engine', 'Build', 'Build.version'), BUILD_VERSION(...v));
      if (installed) t.write(path.join(dir, 'Engine', 'Build', 'InstalledBuild.txt'), '');
      t.write(path.join(dir, 'Engine', 'Build', 'BatchFiles', 'Build.bat'), '@echo off\r\n');
      t.write(path.join(dir, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'), '');
      if (mcp)
        t.write(
          path.join(dir, 'Engine', 'Plugins', 'Experimental', 'ModelContextProtocol', 'ModelContextProtocol.uplugin'),
          '{}',
        );
      return dir;
    };

    t.section('an engine folder');
    t.equal(
      parseBuildVersion('\uFEFF' + BUILD_VERSION(5, 4, 4)),
      { major: 5, minor: 4, patch: 4, changelist: 35576357, branch: '++UE5+Release-5.4' },
      'Build.version is read (with a byte-order mark too)',
    );
    t.equal(parseBuildVersion('{"MajorVersion":"5"}'), null, 'a file that is not a Build.version is no engine');
    const pcEngine = makeEngine(t.dir('PcInstalls', 'unreal', 'UE_5.4'), [5, 4, 4], true);
    const enginesRoot = t.dir('tools', 'unreal', 'engines');
    const launcherEngine = makeEngine(path.join(enginesRoot, 'UE_5.4'), [5, 4, 2], true);
    const dataSource = makeEngine(path.join(enginesRoot, 'UE5-src'), [5, 6, 0], false, true);
    const projectsRoot = t.dir('Projects', 'Work');
    const projectSource = makeEngine(path.join(projectsRoot, 'UnrealEngine'), [5, 5, 1], false);
    t.dir('Projects', 'Work', 'MyGame');
    const installed = engineAt(pcEngine, 'pc', false, DISK)!;
    t.equal(
      [installed.id, installed.build, installed.writable],
      ['UE_5.4', 'installed', false],
      'an installed build (InstalledBuild.txt) is named UE_<major.minor>',
    );
    const source = engineAt(dataSource, 'data', true, DISK)!;
    t.check(
      source.build === 'source' && source.id === stableBuildId(dataSource) && /^\{[0-9A-F-]{36}\}$/.test(source.id),
      'a source build without a registered name gets a GUID made from its folder (the same every boot)',
    );
    t.equal(engineAt(pcEngine, 'pc', false, DISK, '{AAAA}')?.id, 'UE_5.4', "an installed build's name is its version");
    t.equal(
      engineAt(projectSource, 'pc', false, DISK, 'MyBuild')?.id,
      'MyBuild',
      "a source build from this PC keeps its registered name (the project's association still matches)",
    );
    t.equal(engineAt(t.dir('not-an-engine'), 'data', true, DISK), null, 'a folder without Build.version is no engine');

    t.section('every route: this PC, the launcher, the data disk, a project root');
    const engines = findEngines(
      {
        mapped: [{ guest: pcEngine, id: 'UE_5.4' }],
        enginesRoot,
        launcherDirs: [launcherEngine.toLowerCase()],
        projectRoots: [projectsRoot],
      },
      DISK,
    );
    t.equal(
      engines.map((e) => [e.id.startsWith('{') ? 'guid' : e.id, e.origin, e.writable]),
      [
        ['UE_5.4', 'pc', false],
        ['guid', 'data', true],
        ['UE_5.4', 'launcher', true],
        ['guid', 'project', true],
      ],
      "this PC's engine (read-only), the launcher's and a source build on the data disk, a source build in a project root",
    );
    t.equal(
      findEngines(
        {
          mapped: [
            { guest: pcEngine, id: 'UE_5.4' },
            { guest: pcEngine, id: 'UE_5.4' },
          ],
          enginesRoot: t.at('none'),
          launcherDirs: [],
          projectRoots: [],
        },
        DISK,
      ).length,
      1,
      'each folder once',
    );

    t.section("a project's engine");
    t.equal(parseEngineAssociation('5.4'), { kind: 'version', version: '5.4' }, '"5.4" names an installed build');
    t.equal(parseEngineAssociation('5.4.4'), { kind: 'version', version: '5.4' }, '"5.4.4" too');
    t.equal(
      parseEngineAssociation('{2D9FCA5D-4E7B-4C12-8B6E-1A2B3C4D5E6F}'),
      { kind: 'build', id: '{2D9FCA5D-4E7B-4C12-8B6E-1A2B3C4D5E6F}' },
      'a {GUID} names a registered source build',
    );
    t.equal(parseEngineAssociation(''), { kind: 'none' }, 'an empty association names none');
    t.equal(parseEngineAssociation('../x'), { kind: 'none' }, 'a path is no association');
    t.equal(
      uprojectAssociation('{"FileVersion":3,"EngineAssociation":"5.6"}'),
      { kind: 'version', version: '5.6' },
      'read from a .uproject',
    );
    t.equal(uprojectAssociation('not json'), null, 'a .uproject that is not JSON says nothing');
    const pick = (a: Parameters<typeof chooseEngine>[1]): UnrealEngine | null => chooseEngine(engines, a).engine;
    t.equal(
      pick({ kind: 'version', version: '5.4' })?.dir,
      launcherEngine,
      'a version: the writable copy before the read-only one from this PC',
    );
    t.equal(
      chooseEngine([engines[0]], { kind: 'version', version: '5.4' }).engine?.origin,
      'pc',
      "with only this PC's copy, that one",
    );
    t.equal(
      pick({ kind: 'build', id: engines.find((e) => e.origin === 'data')!.id.toLowerCase() })?.dir,
      dataSource,
      'a build id (any case) picks that build',
    );
    t.equal(pick({ kind: 'none' })?.dir, dataSource, 'no association: the newest engine');
    const missing = chooseEngine(engines, { kind: 'version', version: '5.8' });
    t.check(
      missing.engine === null && missing.reason.includes('5.8'),
      'a version that is not here: none, and the reason says which',
    );
    t.equal(chooseEngine([], { kind: 'none' }).reason, 'no engine is installed yet', 'no engines: says so');
    const game = t.dir('Projects', 'Work', 'MyGame');
    t.write(path.join(game, 'MyGame.uproject'), '{}');
    t.equal(findUproject(game, DISK), path.join(game, 'MyGame.uproject'), 'the .uproject in the project folder');
    const nested = t.dir('repo');
    t.write(path.join(nested, 'Game', 'Game.uproject'), '{}');
    t.equal(findUproject(nested, DISK), path.join(nested, 'Game', 'Game.uproject'), 'or one folder down');

    t.section('registration');
    const plan = registryPlan(engines);
    t.equal(
      plan.filter((v) => v.hive === 'HKLM'),
      [
        {
          hive: 'HKLM',
          key: 'SOFTWARE\\EpicGames\\Unreal Engine\\5.4',
          name: 'InstalledDirectory',
          value: launcherEngine,
        },
      ],
      'installed builds: one HKLM ...\\Unreal Engine\\<5.4> InstalledDirectory per version, the writable one',
    );
    t.equal(
      plan.filter((v) => v.hive === 'HKCU').map((v) => [v.key, v.value]),
      [
        ['Software\\Epic Games\\Unreal Engine\\Builds', dataSource],
        ['Software\\Epic Games\\Unreal Engine\\Builds', projectSource],
      ],
      'source builds: a value under HKCU\\Software\\Epic Games\\Unreal Engine\\Builds each',
    );
    const assoc = fileAssociationPlan('C:\\E\\Engine\\Binaries\\Win64\\UnrealVersionSelector.exe');
    t.check(
      assoc.some((v) => v.key === 'Software\\Classes\\.uproject' && v.value === 'Unreal.ProjectFile') &&
        assoc.some(
          (v) =>
            v.key.endsWith('\\shell\\rungenproj\\command') &&
            v.value === '"C:\\E\\Engine\\Binaries\\Win64\\UnrealVersionSelector.exe" /projectfiles "%1"',
        ),
      '.uproject opens with UnrealVersionSelector, with "Generate Visual Studio project files"',
    );
    await t.throws(() => fileAssociationPlan('C:\\a"b.exe'), 'not a program path', 'a path with a quote is refused');

    t.section('PATH, variables, the derived data cache, MCP');
    t.equal(
      engineToolDirs(pcEngine, DISK),
      [path.join(pcEngine, 'Engine', 'Build', 'BatchFiles'), path.join(pcEngine, 'Engine', 'Binaries', 'Win64')],
      'the engine folders that exist go on PATH (Build.bat, RunUAT.bat, UnrealEditor-Cmd.exe)',
    );
    t.equal(
      engineVars(installed),
      { UE_ROOT: pcEngine, UE_ENGINE_DIR: path.join(pcEngine, 'Engine') },
      'UE_ROOT is the engine folder',
    );
    t.equal(
      ddcVars('persisted', 'C:\\AgentData\\tools\\unreal\\ddc'),
      { 'UE-LocalDataCachePath': 'C:\\AgentData\\tools\\unreal\\ddc' },
      'persisted: UE-LocalDataCachePath on the data disk',
    );
    t.equal(ddcVars('local', 'x'), {}, "local: Unreal's own place");
    t.check(!hasMcpPlugin(source, DISK) && !hasMcpPlugin(installed, DISK), 'before 5.8: no editor MCP server');
    const ue58 = engineAt(makeEngine(t.dir('ue58'), [5, 8, 0], true, true), 'pc', false, DISK)!;
    t.check(hasMcpPlugin(ue58, DISK), 'Unreal 5.8 with ModelContextProtocol: the editor MCP server is offered');

    t.section('LauncherInstalled.dat');
    const foreign = {
      InstallLocation: 'D:\\Games\\Fortnite',
      NamespaceId: 'fn',
      ItemId: '4fe75bbc5a674f4f9b356b5c90567da5',
      ArtifactId: 'Fortnite',
      AppVersion: '++Fortnite+Release-30.00-CL-1',
      AppName: 'Fortnite',
      ExtraField: { kept: true },
    };
    const live = {
      ...foreign,
      InstallLocation: launcherEngine,
      NamespaceId: 'ue',
      ItemId: 'e1a',
      ArtifactId: 'UE_5.4',
      AppVersion: '5.4.2-1+++UE5+Release-5.4',
      AppName: 'UE_5.4',
    };
    const existing = '\uFEFF' + JSON.stringify({ InstallationList: [foreign, live], Version: 3 });
    const merged = JSON.parse(mergeLauncherInstalled(existing, [launcherEntry(installed)])) as {
      Version: number;
      InstallationList: { InstallLocation: string; ExtraField?: { kept: boolean } }[];
    };
    t.check(
      merged.Version === 3 &&
        merged.InstallationList[0].ExtraField?.kept === true &&
        merged.InstallationList.some((e) => e.InstallLocation === pcEngine),
      "other apps' entries and the file's own fields stay exactly as they were; this PC's engine is added",
    );
    const again = JSON.parse(mergeLauncherInstalled(JSON.stringify(merged), [launcherEntry(installed)])) as {
      InstallationList: unknown[];
    };
    t.equal(again.InstallationList.length, 3, 'merging twice adds nothing (the same folder is replaced)');
    await t.throws(
      () => mergeLauncherInstalled('{"something":"else"}', []),
      /InstallationList|expected/,
      'a file that is not a LauncherInstalled.dat is never overwritten',
    );
    t.equal(
      (JSON.parse(mergeLauncherInstalled(null, [])) as { InstallationList: unknown[] }).InstallationList,
      [],
      'no file: a new list',
    );
    t.equal(
      entriesUnder(existing, enginesRoot).map((e) => e.ItemId),
      ['e1a'],
      "the entries of the data disk's engines are the ones saved",
    );
    t.equal(
      launcherEntry(installed, { namespaceId: 'ue', itemId: 'real', artifactId: 'UE_5.4', appVersion: 'v' }).ItemId,
      'real',
      "this PC's own ids are used when known",
    );
    t.equal(launcherInstallations('[]'), [], 'a broken file lists nothing');

    t.section('.item manifests');
    const manifests = t.dir('ProgramData', 'Manifests');
    const saved = t.dir('saved', 'Manifests');
    t.write(
      path.join(manifests, 'AAA.item'),
      JSON.stringify({ AppName: 'UE_5.4', InstallLocation: launcherEngine, InstallSize: 1234 }),
    );
    t.write(
      path.join(manifests, 'BBB.item'),
      JSON.stringify({ AppName: 'Fortnite', InstallLocation: 'D:\\Games\\Fortnite' }),
    );
    t.write(path.join(manifests, 'evil..item'), '{}');
    t.equal(
      saveItems(manifests, saved, enginesRoot),
      ['AAA.item'],
      'only the manifests of engines on the data disk are saved',
    );
    t.equal(saveItems(manifests, saved, enginesRoot), [], 'an unchanged manifest is not saved again');
    t.equal(itemSizes(saved).get(launcherEngine.toLowerCase()), 1234, 'the manifest gives the engine its size');
    const fresh = t.dir('ProgramData2', 'Manifests');
    t.write(path.join(fresh, 'BBB.item'), "the launcher's own");
    t.equal(
      restoreItems(saved, fresh, enginesRoot, fs.existsSync),
      [launcherEngine],
      'a new sandbox gets the saved manifests back',
    );
    t.check(
      fs.existsSync(path.join(fresh, 'AAA.item')) &&
        fs.readFileSync(path.join(fresh, 'BBB.item'), 'utf8') === "the launcher's own",
      'what the launcher has is never replaced',
    );
    t.write(path.join(saved, 'GONE.item'), JSON.stringify({ InstallLocation: path.join(enginesRoot, 'UE_9.9') }));
    t.equal(
      restoreItems(saved, t.dir('ProgramData3'), enginesRoot, fs.existsSync).length,
      1,
      'a manifest whose engine folder is gone is not put back',
    );

    t.section('GameUserSettings.ini');
    t.equal(
      withInstallLocation('', 'D:\\E'),
      '[Launcher]\r\nDefaultAppInstallLocation=D:\\E\r\n',
      'an empty file gets the section',
    );
    const ini =
      ';METADATA=(Diff=true, UseCommands=true)\r\n[Launcher]\r\nLastActiveVersion=20.3.7\r\n\r\n[Portal.OSS]\r\nbShouldPrimeEms=False\r\n';
    const set = withInstallLocation(ini, 'C:\\AgentData\\tools\\unreal\\engines');
    t.check(
      set.startsWith(';METADATA') &&
        set.includes(
          '[Launcher]\r\nDefaultAppInstallLocation=C:\\AgentData\\tools\\unreal\\engines\r\nLastActiveVersion',
        ) &&
        set.includes('[Portal.OSS]\r\nbShouldPrimeEms=False'),
      'the value goes into [Launcher]; every other line stays (launcher 20 file)',
    );
    t.equal(withInstallLocation(set, 'C:\\AgentData\\tools\\unreal\\engines'), set, 'setting it again changes nothing');
    t.includes(
      withInstallLocation('[Launcher]\nDefaultAppInstallLocation=C:\\Old\n', 'D:\\New'),
      'DefaultAppInstallLocation=D:\\New\n',
      'an old value is replaced, LF endings kept',
    );
    t.equal(installLocationOf(set), 'C:\\AgentData\\tools\\unreal\\engines', 'and read back');
    const utf16 = t.write(path.join(t.dir('ini'), 'a.ini'), '');
    fs.writeFileSync(utf16, encodeText(ini, 'utf16le'));
    t.check(setLauncherInstallLocation(utf16, 'C:\\X'), 'a UTF-16 file is changed');
    const back = decodeText(fs.readFileSync(utf16));
    t.check(back.encoding === 'utf16le' && installLocationOf(back.text) === 'C:\\X', 'and stays UTF-16 with its mark');
    const bom = t.at('ini', 'b.ini');
    fs.writeFileSync(bom, encodeText(ini, 'utf8bom'));
    setLauncherInstallLocation(bom, 'C:\\Y');
    t.equal(decodeText(fs.readFileSync(bom)).encoding, 'utf8bom', 'a UTF-8 file with a mark keeps its mark');
    t.check(
      setLauncherInstallLocation(t.at('ini', 'new', 'GameUserSettings.ini'), 'C:\\Z'),
      'a missing file is created',
    );

    t.section('room for an engine (never the sandbox disk)');
    const statfs = (gb: number) => () => ({ bavail: gb * 1024 ** 3, bsize: 1 });
    t.equal(
      enginePlaceProblem({ set: true }, enginesRoot, statfs(200)).problem,
      null,
      '200 GB free on the data disk: fine',
    );
    const tight = enginePlaceProblem({ set: true }, enginesRoot, statfs(50));
    t.check(
      tight.problem !== null &&
        tight.problem.includes('50 GB') &&
        tight.problem.includes('60 GB') &&
        tight.freeBytes === 50 * 1024 ** 3,
      'under 60 GB: refused, saying how much is free and needed',
    );
    t.equal(ENGINE_NEED_BYTES, 60 * 1024 ** 3, 'an engine needs 60 GB');
    const unset = enginePlaceProblem({ set: false, error: 'could not write the settings' }, enginesRoot, statfs(500));
    t.check(
      unset.problem?.startsWith('ENGINES WOULD GO ON THE SANDBOX DISK') === true &&
        unset.problem.includes('could not write'),
      "the launcher's folder not set: said loudly",
    );

    t.section('the guide');
    const status: UnrealStatus = {
      updatedAt: 'now',
      engines: [
        {
          id: 'UE_5.4',
          dir: pcEngine,
          version: '5.4.4',
          build: 'installed',
          origin: 'pc',
          writable: false,
          sizeBytes: null,
        },
      ],
      projects: [{ workspace: 'C:\\Projects\\Work\\MyGame', engine: pcEngine, reason: 'the project asks for 5.4' }],
      launcher: {
        installed: true,
        installLocation: enginesRoot,
        problem: null,
        freeBytes: null,
        needBytes: ENGINE_NEED_BYTES,
      },
      visualStudio: { version: '17.14', path: 'C:\\VS', how: 'kept on the data disk', check: 'ok', ok: true },
      debugger: 'C:\\Kits\\Debuggers\\x64\\cdb.exe',
      ddc: { mode: 'persisted', dir: 'C:\\AgentData\\tools\\unreal\\ddc' },
      vaults: ['C:\\PcInstalls\\unreal\\Vault'],
      mcpUrl: 'http://127.0.0.1:8000/mcp',
    };
    const guide = unrealGuideLines(status, [
      { workspace: 'C:\\Projects\\Work\\MyGame', uproject: 'C:\\Projects\\Work\\MyGame\\MyGame.uproject' },
    ]).join('\n');
    for (const needle of [
      'engine UE_5.4 5.4.4',
      '`UE_ROOT` is set',
      'Read-only',
      'Build.bat MyGameEditor Win64 Development -Project="C:\\Projects\\Work\\MyGame\\MyGame.uproject" -WaitMutex -NoHotReload',
      'Build.bat -projectfiles -project=',
      '-ExecCmds="Automation RunTests <filter>;Quit"',
      '-unattended -nullrhi',
      'RunUAT.bat BuildCookRun -project=',
      '-platform=Win64 -clientconfig=Development -build -cook -stage -pak -archive -archivedirectory=',
      'Saved\\Logs',
      'cdb -z "<UEMinidump.dmp>" -c "!analyze -v;q"',
      'C:\\AgentData\\tools\\unreal\\ddc',
      'C:\\PcInstalls\\unreal\\Vault',
      '<Pack>\\data\\Content',
      'ModelContextProtocol.StartServer',
      'sbx-unreal-editor',
    ])
      t.includes(guide, needle, 'the guide says: ' + needle);
    t.excludes(guide, 'sbx-db', 'no wrapper commands: the plain engine tools');
    const none = unrealGuideLines(
      {
        ...status,
        engines: [],
        projects: [{ workspace: 'C:\\P', engine: null, reason: 'no engine is installed yet' }],
        vaults: [],
        mcpUrl: null,
      },
      [{ workspace: 'C:\\P', uproject: null }],
    ).join('\n');
    t.includes(none, 'no engine yet', 'no engine: the guide says how to get one');
    t.includes(none, 'sign in once', 'the launcher sign-in route');
    t.excludes(none, 'Build.bat', 'and gives no build commands');
    t.equal(
      unrealSummaryLine(status, 'C:\\Projects\\Work\\MyGame'),
      'unreal: UE_5.4 5.4.4 (this PC, read-only)',
      'the tools line names the engine',
    );

    t.section("UnrealBuildTool's view of Visual Studio");
    // What sandbox\scripts\get-vs-setup.ps1 reported for Visual Studio kept on the data disk (2026-11-04).
    const report: VsSetupReport = {
      setupError: '',
      instances: [
        {
          instanceId: 'a190d188',
          installationPath: 'C:\\AgentData\\tools\\visualstudio\\persist\\Community',
          installationVersion: '17.14.37827.9',
          productId: 'Microsoft.VisualStudio.Product.Community',
          isComplete: true,
          isLaunchable: true,
          packages: ['Microsoft.VisualStudio.Workload.NativeGame', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'],
          toolchains: [{ version: '14.44.35207', cl: true, link: true }],
        },
      ],
      kitsRoots: [{ where: 'HKLM (64-bit)', path: 'C:\\AgentData\\tools\\visualstudio\\persist\\WindowsKits10\\' }],
      sdks: [
        {
          version: '10.0.22621.0',
          root: 'C:\\AgentData\\tools\\visualstudio\\persist\\WindowsKits10\\',
          windowsH: true,
          kernel32: true,
          ucrt: true,
        },
      ],
    };
    const verdict = vsVerdict(report);
    t.check(
      verdict.ok && verdict.text.includes('MSVC 14.44.35207') && verdict.text.includes('Windows SDK 10.0.22621.0'),
      'the restored copy: found, with MSVC and the Windows SDK',
    );
    t.check(!vsVerdict({ ...report, instances: [] }).ok, 'no instance: not found');
    t.check(
      !vsVerdict({ ...report, instances: [{ ...report.instances[0], packages: [] }] }).ok,
      'no C++ x64 tools: not found',
    );
    t.check(!vsVerdict({ ...report, sdks: [] }).ok, 'no Windows SDK: not found');
    const old = vsVerdict({
      ...report,
      instances: [{ ...report.instances[0], toolchains: [{ version: '14.36.1', cl: true, link: true }] }],
    });
    t.check(!old.ok && old.text.includes('too old'), 'MSVC older than 14.38: too old for Unreal 5.4+');

    t.section("this PC's vault cache (assets)");
    t.equal(
      vaultDirsFromIni(
        '[Launcher]\r\nVaultCacheDirectories=("D:/EpicVault/VaultCache/")\r\n+VaultCacheDirectories=E:\\More\\VaultCache\\\r\n',
      ),
      ['D:\\EpicVault\\VaultCache', 'E:\\More\\VaultCache'],
      'the folders the launcher settings name (array and plain lines, either slash)',
    );
    t.equal(
      vaultDirsFromIni('[Launcher]\r\nDefaultAppInstallLocation=D:\\E\r\n'),
      [],
      'none named: the default is used',
    );
    const vault = t.dir('VaultCache');
    t.write(path.join(vault, 'CityPark', 'data', 'Content', 'Maps', 'Park.umap'), 'x'.repeat(2048));
    t.write(path.join(vault, 'Toolkit', 'data', 'Toolkit.uplugin'), '{}');
    t.write(path.join(vault, 'Toolkit', 'data', 'Source', 'a.cpp'), 'int a;');
    t.dir('VaultCache', '.tmp');
    t.equal(
      vaultPacks(vault, VAULT_DISK).map((p) => [p.name, p.kind, p.partial]),
      [
        ['CityPark', 'content', false],
        ['Toolkit', 'plugin', false],
      ],
      'each pack, content or a code plugin',
    );
    t.equal(vaultPacks(vault, VAULT_DISK)[0].sizeBytes, 2048, 'with its size');
    t.equal(
      vaultInstalls(['C:\\ProgramData\\Epic\\EpicGamesLauncher\\VaultCache', 'D:\\V']).map((v) => [v.kind, v.id]),
      [
        ['unreal-vault', 'Vault'],
        ['unreal-vault', 'Vault2'],
      ],
      'mapped at C:\\PcInstalls\\unreal\\Vault (Vault2 ...)',
    );

    t.section("this PC's engines (fixtures)");
    const pcRoot = t.dir('pc');
    const pcLauncher = makeEngine(path.join(pcRoot, 'Epic Games', 'UE_5.4'), [5, 4, 4], true);
    const pcDefault = makeEngine(path.join(pcRoot, 'Epic Games', 'UE_5.6'), [5, 6, 1], true);
    const pcSource = makeEngine(path.join(pcRoot, 'src', 'UnrealEngine'), [5, 7, 0], false);
    const dat = JSON.stringify({
      InstallationList: [
        foreign,
        {
          InstallLocation: pcLauncher,
          NamespaceId: 'ue',
          ItemId: 'item54',
          ArtifactId: 'UE_5.4',
          AppVersion: '5.4.4-1+++UE5+Release-5.4',
          AppName: 'UE_5.4',
        },
        {
          InstallLocation: path.join(pcRoot, 'gone'),
          NamespaceId: 'ue',
          ItemId: 'x',
          ArtifactId: 'UE_5.3',
          AppVersion: 'v',
          AppName: 'UE_5.3',
        },
      ],
    });
    const reg =
      '\r\nHKEY_CURRENT_USER\\Software\\Epic Games\\Unreal Engine\\Builds\r\n    {2D9FCA5D-4E7B-4C12-8B6E-1A2B3C4D5E6F}    REG_SZ    ' +
      pcSource.replace(/\\/g, '/') +
      '\r\n    Broken    REG_SZ    not-a-path\r\n';
    t.equal(
      regValues(reg).map((v) => v.name),
      ['{2D9FCA5D-4E7B-4C12-8B6E-1A2B3C4D5E6F}', 'Broken'],
      'reg query output is read',
    );
    const files = {
      launcherInstalled: dat,
      builds: reg,
      defaultRoot: path.join(pcRoot, 'Epic Games'),
      list: DISK.list,
      read: DISK.read,
    };
    const pcFound = findUnrealInstalls(files, true);
    t.equal(
      pcFound.map((i) => [i.id, i.version, i.launcher?.itemId ?? null, i.buildId ?? null]),
      [
        ['UE_5.4', '5.4.4', 'item54', null],
        ['src-2D9FCA5D-4E7B-4C12-8B6E-1A2B3C4D5E6F', '5.7.0', null, '{2D9FCA5D-4E7B-4C12-8B6E-1A2B3C4D5E6F}'],
        ['UE_5.6', '5.6.1', null, null],
      ],
      "the launcher's engines (with its ids), the registered source builds, and the default folders",
    );
    t.check(
      pcFound.every((i) => i.host !== path.join(pcRoot, 'gone')),
      'an entry whose folder is gone is left out',
    );
    t.equal(
      findUnrealInstalls(files, ['5.6']).map((i) => i.host),
      [pcDefault],
      'a list maps only those versions',
    );
    t.equal(
      findUnrealInstalls({ ...files, launcherInstalled: null, builds: '' }, true).map((i) => i.id),
      ['UE_5.4', 'UE_5.6'],
      'no LauncherInstalled.dat: the default folders',
    );
    const folders = findEngineFolders({ read: DISK.read }, [pcSource, path.join(pcRoot, 'nothing'), 'relative']);
    t.equal(
      folders.map((f) => [f.id, f.writable]),
      [['dir-UnrealEngine', true]],
      'a registered folder is mapped writable; one without an engine is left out',
    );
    t.equal(
      findEpicGames(dat, true).map((g) => g.id),
      ['Fortnite'],
      "the launcher's games are the epic-game installs (engines are not)",
    );
    t.equal(findEpicGames(dat, ['nothing']), [], 'a list maps only those games');
    t.check(engineFolderProblem(pcSource, DISK.read) === null, 'Register an engine folder accepts an engine folder');
    t.includes(
      engineFolderProblem(pcRoot, DISK.read) ?? '',
      'not an Unreal Engine folder',
      'and refuses one without Build.version',
    );

    t.section('"auto": the engines come along when the sandbox is set up for Unreal');
    const one = (
      kind: 'unreal' | 'unreal-vault',
      setting: PcInstallSource['setting'],
      host: string,
      extra = {},
    ): PcInstallSource => ({
      kind,
      setting,
      find: () => [{ kind, id: kind === 'unreal' ? 'UE_5.4' : 'Vault', name: 'x', host, guest: '', ...extra }],
    });
    const sources = [
      one('unreal', 'unrealEngineFolders', pcSource, { id: 'dir-UnrealEngine', writable: true }),
      one('unreal', 'unrealEngines', pcLauncher),
      one('unreal-vault', 'unrealAssets', vault),
    ];
    const o = { packageRoot: t.packageRoot, storageRoot: t.dir('storage'), sources };
    const PC = { localAppData: '', appData: '', programData: '' };
    t.equal(DEFAULTS.pcInstalls.unrealEngines, 'auto', 'pcInstalls.unrealEngines is "auto" by default');
    t.equal(DEFAULTS.pcInstalls.unrealAssets, 'auto', 'pcInstalls.unrealAssets is "auto" by default');
    const off = discoverPcInstalls(
      { ...DEFAULTS.pcInstalls, unrealEngineFolders: [pcSource] },
      { ...o, unrealOn: false },
      PC,
    );
    t.equal(
      off.mappings.map((m) => m.guest),
      ['C:\\PcInstalls\\unreal\\dir-UnrealEngine'],
      'not set up for Unreal: only the folders you registered',
    );
    const on = discoverPcInstalls(
      { ...DEFAULTS.pcInstalls, unrealEngineFolders: [pcSource] },
      { ...o, unrealOn: true },
      PC,
    );
    t.equal(
      on.mappings.map((m) => [m.guest, m.readOnly]),
      [
        ['C:\\PcInstalls\\unreal\\dir-UnrealEngine', false],
        ['C:\\PcInstalls\\unreal\\UE_5.4', true],
        ['C:\\PcInstalls\\unreal\\Vault', true],
      ],
      "set up for Unreal: this PC's engines and vault read-only, your registered folder writable",
    );
    t.check(
      on.manifest.items.every((i) => !('host' in i)),
      'session.json gets no path of this PC',
    );
    t.check(
      ConfigSchema.shape.pcInstalls.safeParse({ ...DEFAULTS.pcInstalls, unrealEngines: 'auto' }).success,
      'the schema takes "auto"',
    );

    t.section('the game-development apps');
    const ids = APPS.map((a) => a.id);
    t.check(new Set(ids).size === ids.length, 'every app id is used once');
    t.equal(
      GAMEDEV_APPS.map((a) => a.id),
      ['krita', 'inkscape', 'audacity', 'renderdoc', 'f3d', 'imagemagick', 'nomacs'],
      'Krita, Inkscape, Audacity, RenderDoc, then F3D, ImageMagick, nomacs for previews (Blender was there)',
    );
    t.check(ids.includes('blender'), 'Blender is in the catalogue');
    t.check(
      GAMEDEV_APPS.every((a) => a.category === 'gamedev' && a.exe && a.about.length > 20),
      'each is a game-development app with its program',
    );
    const audacity = new RegExp((GAMEDEV_APPS.find((a) => a.id === 'audacity')!.source as { asset: string }).asset);
    t.check(
      audacity.test('audacity-win-4.0.2-x86_64.7z') &&
        audacity.test('audacity-win-3.7.7-64bit.zip') &&
        !audacity.test('audacity-win-4.0.2-arm64.7z'),
      "Audacity's GitHub asset: the x64 build of 3.x and 4.x",
    );

    t.section('the Unreal page');
    const page = unrealPage(UNREAL_SAMPLE);
    t.equal(
      page.sections.map((s) => s.id),
      ['engines', 'pc', 'vault', 'tools', 'settings'],
      'engines, this PC, assets, build tools, settings',
    );
    const ops = pageActions(page).flatMap((a) => (a.kind === 'operation' ? [a.op] : []));
    t.check(
      ['unreal.registerFolder', 'unreal.forgetFolder', 'unreal.openLauncher'].every((op) => ops.includes(op)),
      'register a folder, forget one, open the launcher',
    );
    t.check(
      unrealView.operations.every((op) => ops.includes(op.id)),
      'every operation of the view is on the page',
    );
    const text = pageLines(page).join('\n');
    for (const needle of [
      'UE_5.6',
      'this PC, read-only',
      'C:\\AgentData\\tools\\unreal\\engines\\UE_5.4',
      'CityParkEnvironment',
      'MSVC 14.44.35207',
      'toolchains.unreal.persistEngines',
      'pcInstalls.unrealAssets',
    ])
      t.includes(text, needle, 'the page shows ' + needle);
    t.excludes(text, 'sandbox ', 'no page text tells you to run a command');
    const problem = unrealPage({
      ...UNREAL_SAMPLE,
      launcher: { ...UNREAL_SAMPLE.launcher, problem: 'ENGINES WOULD GO ON THE SANDBOX DISK: x' },
    });
    t.check(
      problem.notice?.tone === 'danger' && problem.notice.text.startsWith('ENGINES WOULD GO'),
      'engines that would go on C: are said loudly at the top',
    );
    const empty = pageLines(unrealPage({ ...UNREAL_SAMPLE, engines: [], projects: [] })).join('\n');
    t.includes(
      empty,
      'Install Unreal Engine on this PC with the Epic Games Launcher',
      'no engine: the page says how to get one',
    );
  },
};
