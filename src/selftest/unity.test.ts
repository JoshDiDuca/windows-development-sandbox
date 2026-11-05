// Unity: project versions, the editor choice, the release API, the Unity CLI, the editor bridge, the Asset Store cache,
// the status, the guide lines and the licence file helpers (pure; nothing is downloaded or run).
import fs from 'node:fs';
import {
  parseLicenceStatus,
  ulfSummary,
  UnityPayloadSchema,
  unityEntitlementFile,
  unitySummary,
  unityUlfFile,
} from '../shared/accounts/index.js';
import { isKindReady, isToolchainReady } from '../shared/readiness.js';
import {
  assetPackages,
  bridgeOf,
  chooseEditor,
  cliManifestUrl,
  CliManifestSchema,
  COPLAY_PACKAGE,
  COPLAY_PACKAGE_URL,
  compareUnityVersions,
  editorModules,
  editorsAddArgs,
  installArgs,
  installModulesArgs,
  installNeedBytes,
  installPathArgs,
  licenceStatusArgs,
  ORIGIN_LABELS,
  parseProjectVersion,
  pcAssetCacheDirs,
  pickCliBinary,
  pickRelease,
  PIPELINE_PACKAGE,
  releaseUrl,
  supportsPipeline,
  UNITY_CLI_ENV,
  unityCliMcpServer,
  unityGuideLines,
  UnityStatusSchema,
  wantedVersion,
  withBridge,
  type AssetFs,
  type UnityEditor,
  type UnityStatus,
} from '../shared/unity/index.js';
import type { Suite } from './support/suite.js';

const editor = (version: string, origin: 'pc' | 'data', modules: string[] = []): UnityEditor => {
  const root =
    origin === 'pc' ? 'C:\\PcInstalls\\unity\\' + version : 'C:\\AgentData\\tools\\unity\\editors\\' + version;
  return { version, root, exe: root + '\\Editor\\Unity.exe', origin, writable: origin === 'data', modules };
};

const RELEASE = {
  results: [
    {
      version: '6000.0.58f2',
      shortRevision: '92dee566b325',
      downloads: [
        {
          url: 'https://download.unity3d.com/download_unity/92dee566b325/Windows64EditorInstaller/UnitySetup64-6000.0.58f2.exe',
          type: 'EXE',
          integrity: 'md5-AAAAAAAAAAAAAAAAAAAAAA==',
          downloadSize: { value: 4_000_000_000 },
          installedSize: { value: 8_000_000_000 },
          modules: [
            {
              id: 'android',
              downloadSize: { value: 100 },
              installedSize: { value: 200 },
              integrity: 'md5-BBBBBBBBBBBBBBBBBBBBBB==',
              subModules: [
                { id: 'android-sdk-ndk-tools', downloadSize: { value: 10 }, installedSize: { value: 20 } },
                { id: 'android-open-jdk', downloadSize: { value: 1 }, installedSize: { value: 2 } },
              ],
            },
            { id: 'webgl', downloadSize: { value: 50 }, installedSize: { value: 60 } },
          ],
        },
      ],
    },
  ],
};

const SHA = 'a'.repeat(64);

function status(over: Partial<UnityStatus> = {}): UnityStatus {
  return {
    updatedAt: 'now',
    cli: { version: '1.0.0-beta.16', path: 'C:\\AgentData\\tools\\unity\\cli\\1.0.0-beta.16\\unity.exe' },
    editors: [
      { ...editor('6000.0.58f2', 'pc'), modules: [], sizeBytes: null },
      { ...editor('2022.3.40f1', 'data'), modules: [], sizeBytes: null },
    ],
    projects: [
      {
        workspace: 'C:\\Workspace\\G',
        version: '6000.0.58f2',
        editor: 'C:\\PcInstalls\\unity\\6000.0.58f2',
        reason: 'the project asks for 6000.0.58f2',
        bridge: null,
      },
    ],
    licence: { state: 'active', kind: 'personal', detail: 'Personal', user: null },
    assetCache: { mode: 'persisted', dir: 'C:\\AgentData\\tools\\unity\\asset-store' },
    pcAssets: [],
    hub: { installed: false, path: null },
    mcp: null,
    skills: false,
    problem: null,
    ...over,
  };
}

export const unitySuite: Suite = {
  name: 'unity',
  title: 'Unity: editors, the release API, the CLI, the editor bridge, the guide and the licence file',
  run: async (t) => {
    t.section('ProjectVersion.txt');
    t.equal(
      parseProjectVersion('m_EditorVersion: 6000.0.58f2\nm_EditorVersionWithRevision: 6000.0.58f2 (92dee566b325)\n'),
      { version: '6000.0.58f2', changeset: '92dee566b325' },
      'version and changeset',
    );
    t.equal(
      parseProjectVersion('m_EditorVersion: 2022.3.40f1\n'),
      { version: '2022.3.40f1', changeset: null },
      'without a revision',
    );
    t.equal(
      wantedVersion('m_EditorVersion: 2022.3.40f1\n', '6000.0.58f2'),
      { version: '2022.3.40f1', changeset: null },
      "a project's own version wins over the setting",
    );
    t.equal(
      wantedVersion(null, '6000.0.58f2'),
      { version: '6000.0.58f2', changeset: null },
      'the setting is for folders without one',
    );
    t.equal(wantedVersion(null, 'project'), null, '"project" and no file: nothing');
    t.equal(
      parseProjectVersion(
        'm_EditorVersion: 2022.3.40f1\r\nm_EditorVersionWithRevision: 2022.3.40f1 (0123456789ab)\r\n',
      ),
      { version: '2022.3.40f1', changeset: '0123456789ab' },
      'CRLF',
    );
    t.equal(parseProjectVersion('hello\nm_EditorVersion: banana\n'), null, 'garbage');
    t.equal(parseProjectVersion('x'.repeat(70 * 1024) + '\nm_EditorVersion: 6000.0.58f2\n'), null, 'past 64 KB');
    t.equal(parseProjectVersion('\n'.repeat(60) + 'm_EditorVersion: 6000.0.58f2\n'), null, 'past 50 lines');

    t.section('versions');
    t.check(compareUnityVersions('2022.3.9f1', '2022.3.10f1') < 0, 'patch numbers compare as numbers');
    t.check(compareUnityVersions('6000.0.1f1', '2022.3.40f1') > 0, 'newer major is newer');
    t.check(compareUnityVersions('6000.0.1b1', '6000.0.1f1') < 0, 'beta before final');
    t.check(compareUnityVersions('6000.0.1f1', '6000.0.1f1') === 0, 'equal');
    t.check(supportsPipeline('6000.0.58f2') && !supportsPipeline('2022.3.40f1'), 'the pipeline needs Unity 6');

    t.section('chooseEditor');
    const pc = editor('6000.0.58f2', 'pc', ['android']);
    const data = editor('6000.0.58f2', 'data', ['android', 'webgl']);
    const other = editor('2022.3.40f1', 'data');
    const want = { version: '6000.0.58f2', changeset: '92dee566b325' };
    t.equal(
      chooseEditor([pc, data], null, [], true).reason,
      'no ProjectSettings/ProjectVersion.txt',
      'no version file',
    );
    const a = chooseEditor([pc, data], want, ['android'], true);
    t.equal([a.editor?.origin, a.reason], ['pc', 'the project asks for 6000.0.58f2'], 'the PC copy first');
    const b = chooseEditor([pc, data], want, ['android', 'webgl'], true);
    t.equal(
      [b.editor?.origin, b.reason],
      ['data', '6000.0.58f2 from this PC lacks webgl; using the data disk copy'],
      'the PC copy lacks a module',
    );
    const c = chooseEditor([other], want, [], true);
    t.equal(
      [c.editor, c.install, c.reason],
      [null, want, '6000.0.58f2 is not here yet; installing it on the data disk'],
      'install it, never another version',
    );
    const d = chooseEditor([other], want, [], false);
    t.equal(
      [d.editor, d.install, d.reason],
      [
        null,
        null,
        '6000.0.58f2 is not on this PC or the data disk; accept the Unity licence (Unity set-up settings) to install it',
      ],
      'no licence accepted',
    );
    t.equal(chooseEditor([pc], want, ['webgl'], false).editor?.origin, 'pc', 'a PC copy missing modules beats none');

    t.section('editorModules');
    const root = t.dir('editor');
    const engines = ['Editor', 'Data', 'PlaybackEngines'];
    t.dir('editor', ...engines, 'AndroidPlayer');
    t.dir('editor', ...engines, 'windowsstandalonesupport', 'Variations', 'win64_development_il2cpp');
    t.equal(
      editorModules(root, { exists: (f) => fs.existsSync(f), list: (d) => fs.readdirSync(d) }),
      ['android', 'windows-il2cpp'],
      'modules found by their folders',
    );

    t.section('release API');
    t.includes(releaseUrl('6000.0.58f2'), 'version=6000.0.58f2&platform=WINDOWS', 'release url');
    t.includes(releaseUrl('a&b'), 'version=a%26b', 'release url encodes');
    const rel = pickRelease(RELEASE);
    t.equal(rel?.changeset, '92dee566b325', 'changeset');
    t.equal(rel?.editor.integrity, 'md5-AAAAAAAAAAAAAAAAAAAAAA==', 'md5 integrity kept');
    t.equal(rel?.modules[0]?.children, ['android-sdk-ndk-tools', 'android-open-jdk'], 'android children');
    t.equal(pickRelease({ results: [] }), null, 'no result');
    t.equal(pickRelease('nope'), null, 'not an object');
    if (rel) {
      t.equal(installNeedBytes(rel, []), Math.ceil(12_000_000_000 * 1.1), 'editor only');
      t.equal(
        installNeedBytes(rel, ['android']),
        Math.ceil((12_000_000_000 + 100 + 200 + 11 + 22) * 1.1),
        'module and children',
      );
    }

    t.section('Unity CLI');
    t.equal(cliManifestUrl('latest'), 'https://public-cdn.cloud.unity3d.com/hub/prod/cli/latest-beta.json', 'latest');
    t.equal(
      cliManifestUrl('1.0.0-beta.16'),
      'https://public-cdn.cloud.unity3d.com/hub/prod/cli/1.0.0-beta.16/latest.json',
      'pinned',
    );
    await t.throws(() => cliManifestUrl('../x'), 'not a Unity CLI version', 'a bad version');
    const manifest = (filename: string, sha256: string) =>
      CliManifestSchema.parse({ version: '1.0.0-beta.16', binaries: { 'win32-x64': { filename, sha256, size: 44 } } });
    t.equal(
      pickCliBinary(manifest('unity-windows-x64.exe', SHA), 'x64'),
      {
        version: '1.0.0-beta.16',
        url: 'https://public-cdn.cloud.unity3d.com/hub/prod/cli/1.0.0-beta.16/unity-windows-x64.exe',
        sha256: SHA,
        size: 44,
      },
      'the x64 build',
    );
    t.equal(pickCliBinary(manifest('..\\evil.exe', SHA), 'x64'), null, 'a bad file name');
    t.equal(pickCliBinary(manifest('unity-windows-x64.exe', 'abc'), 'x64'), null, 'a bad sha');
    t.equal(pickCliBinary(manifest('unity-windows-x64.exe', SHA), 'arm64'), null, 'no build for this CPU');
    t.equal(
      installArgs('6000.0.58f2', '92dee566b325', ['android'], 'C:\\S'),
      ['install', '6000.0.58f2', '-c', '92dee566b325', '-m', 'android', '--cm', '--download-directory', 'C:\\S'],
      'install args',
    );
    t.equal(
      installArgs('6000.0.58f2', null, [], 'C:\\S'),
      ['install', '6000.0.58f2', '--download-directory', 'C:\\S'],
      'install args, bare',
    );
    t.equal(
      installModulesArgs('6000.0.58f2', ['webgl', 'ios'], 'C:\\S'),
      ['install-modules', '-e', '6000.0.58f2', '-m', 'webgl', 'ios', '--cm', '--download-directory', 'C:\\S'],
      'install-modules args',
    );
    t.equal(installPathArgs('C:\\E'), ['install-path', '--set', 'C:\\E'], 'install-path args');
    t.equal(editorsAddArgs(['C:\\A', 'C:\\B']), ['editors', 'add', 'C:\\A', 'C:\\B'], 'editors add args');
    t.equal(licenceStatusArgs(), ['license', 'status', '--format', 'json'], 'licence status args');

    t.section('MCP');
    t.equal(
      unityCliMcpServer('C:\\u\\unity.exe', 'C:\\Workspace\\G'),
      {
        type: 'stdio',
        command: 'C:\\u\\unity.exe',
        args: ['mcp', '--cli-tools'],
        env: { ...UNITY_CLI_ENV, UNITY_PROJECT_PATH: 'C:\\Workspace\\G' },
      },
      'with a project',
    );
    t.equal(unityCliMcpServer('u', null).env, { ...UNITY_CLI_ENV }, 'without a project');

    t.section('Packages/manifest.json');
    const manifestText =
      JSON.stringify({ dependencies: { 'com.a': '1.0.0', 'com.b': '2.0.0' }, scopedRegistries: [] }, null, 2) + '\n';
    for (const bridge of ['pipeline', 'coplay'] as const) {
      const on = withBridge(manifestText, bridge, true);
      t.equal(bridgeOf(on), bridge, bridge + ' added');
      t.equal(Object.keys(JSON.parse(on).dependencies).slice(0, 2), ['com.a', 'com.b'], bridge + ': order kept');
      t.equal(withBridge(on, bridge, false), manifestText, bridge + ': removed again, byte for byte');
    }
    t.equal(
      JSON.parse(withBridge(manifestText, 'pipeline', true, '0.11.0')).dependencies[PIPELINE_PACKAGE],
      '0.11.0',
      'pipeline version',
    );
    t.equal(
      JSON.parse(withBridge(manifestText, 'coplay', true)).dependencies[COPLAY_PACKAGE],
      COPLAY_PACKAGE_URL,
      'coplay url',
    );
    const crlf = withBridge(manifestText.replace(/\n/g, '\r\n'), 'pipeline', true);
    t.check(crlf.includes('\r\n') && !/[^\r]\n/.test(crlf), 'CRLF kept');
    t.equal(bridgeOf('not json'), null, 'garbage has no bridge');
    t.equal(bridgeOf(manifestText), null, 'no bridge');
    await t.throws(() => withBridge('[]', 'pipeline', true), 'not an object', 'refuses an array');
    await t.throws(
      () => withBridge('{"a":"' + 'x'.repeat(1024 * 1024) + '"}', 'pipeline', true),
      'over 1 MB',
      'refuses a big file',
    );
    await t.throws(() => withBridge(manifestText, 'pipeline', true, '1.0; rm'), 'not a package version', 'bad version');

    t.section('Asset Store cache');
    const dirs = new Set(['C:\\Env\\Asset Store-5.x', 'C:\\Users\\u\\AppData\\Roaming\\Unity\\Asset Store-5.x']);
    const isDir = (d: string): boolean => dirs.has(d);
    t.equal(
      pcAssetCacheDirs({ appData: 'C:\\Users\\u\\AppData\\Roaming', envValue: 'C:\\Env' }, isDir),
      ['C:\\Env', 'C:\\Users\\u\\AppData\\Roaming\\Unity'],
      'the environment first',
    );
    t.equal(
      pcAssetCacheDirs({ appData: 'C:\\Users\\u\\AppData\\Roaming' }, isDir),
      ['C:\\Users\\u\\AppData\\Roaming\\Unity'],
      'the default',
    );
    t.equal(pcAssetCacheDirs({ appData: 'C:\\X' }, isDir), [], 'none');
    const tree: Record<string, string[]> = {
      R: ['Pub', 'file.txt'],
      'R\\Pub': ['Cat'],
      'R\\Pub\\Cat': ['a.unitypackage', 'b.txt'],
    };
    const assetFs: AssetFs = {
      list: (d) => tree[d] ?? [],
      isDir: (d) => d in tree,
      size: (f) => (f.endsWith('.unitypackage') ? 7 : null),
    };
    t.equal(assetPackages('R', assetFs), [{ publisher: 'Pub', category: 'Cat', name: 'a', sizeBytes: 7 }], 'packages');
    const many: Record<string, string[]> = {
      R: ['P'],
      'R\\P': ['C'],
      'R\\P\\C': Array.from({ length: 2500 }, (_, i) => 'p' + i + '.unitypackage'),
    };
    t.equal(
      assetPackages('R', { ...assetFs, list: (d) => many[d] ?? [], isDir: (d) => d in many }).length,
      2000,
      'at most 2000',
    );

    t.section('status');
    const good = status();
    t.check(UnityStatusSchema.safeParse(good).success, 'a status parses');
    t.check(
      !UnityStatusSchema.safeParse({ ...good, editors: Array.from({ length: 33 }, () => good.editors[0]) }).success,
      '33 editors are refused',
    );

    t.section('guide');
    const lines = (s: UnityStatus): string => unityGuideLines(s, [{ workspace: 'C:\\Workspace\\G' }]).join('\n');
    const exe = '"C:\\PcInstalls\\unity\\6000.0.58f2\\Editor\\Unity.exe"';
    t.equal(
      unityGuideLines(good, [{ workspace: 'C:\\Workspace\\G' }])[0],
      '- Unity: editor 6000.0.58f2 at `C:\\PcInstalls\\unity\\6000.0.58f2\\Editor\\Unity.exe` (' +
        ORIGIN_LABELS.pc +
        '; the project asks for 6000.0.58f2). Build or run code without opening it: `' +
        exe +
        ' -batchmode -nographics -quit -projectPath "C:\\Workspace\\G" -executeMethod <Class.Method> -logFile -`; tests: `-runTests -testPlatform EditMode -testResults <file>` (without -quit). Opening the project in another Unity version upgrades its files: never do that without asking the user. It is the user\'s PC copy, read-only: never add modules to it.',
      'PC read-only line',
    );
    const onData = lines(
      status({
        projects: [{ ...good.projects[0], editor: 'C:\\AgentData\\tools\\unity\\editors\\2022.3.40f1' }],
      }),
    );
    t.includes(onData, '(' + ORIGIN_LABELS.data + ';', 'data origin label');
    t.excludes(onData, 'read-only: never add modules', 'a data editor has no read-only note');
    t.includes(
      lines(good),
      '- `unity` (Unity CLI 1.0.0-beta.16) is on PATH: `unity editors -i`, `unity build`, `unity test`, `unity open <project>` (opens it signed in).',
      'CLI line',
    );
    t.includes(
      lines(good),
      "- To drive a running editor (scenes, GameObjects, play mode) the project needs an editor bridge package: ask the user to add it on the sandbox tool's Unity page. Never change Packages/manifest.json yourself unless asked.",
      'no bridge',
    );
    const bridged = (bridge: 'pipeline' | 'coplay'): string =>
      lines(status({ projects: [{ ...good.projects[0], bridge }] }));
    t.includes(
      bridged('pipeline'),
      '- The open editor can be driven with `unity command` and `unity eval` (Unity Pipeline package); MCP clients use sbx-unity.',
      'pipeline',
    );
    t.includes(
      bridged('coplay'),
      '- The open editor can be driven with MCP for Unity (sbx-unity-mcp in Apps).',
      'coplay',
    );
    t.excludes(bridged('pipeline'), 'needs an editor bridge', 'no bridge line when there is one');
    t.includes(
      lines(status({ pcAssets: ['C:\\PcInstalls\\unity\\AssetStore'] })),
      "- The user's Unity Asset Store downloads (read-only): `C:\\PcInstalls\\unity\\AssetStore`; import one with the editor closed:",
      'assets',
    );
    t.includes(
      lines(status({ licence: { state: 'none', kind: '', detail: 'no licence', user: null } })),
      "- Unity licence: no licence. Batch mode fails without one: ask the user to sign in to Unity on the sandbox tool's Unity page.",
      'no licence',
    );
    t.equal(unityGuideLines(good, [{ workspace: 'C:\\Elsewhere' }]), [], 'nothing for a project Unity has no word on');

    t.section('licence files');
    t.equal(unityUlfFile('C:\\ProgramData'), 'C:\\ProgramData\\Unity\\Unity_lic.ulf', 'ulf path');
    t.equal(
      unityEntitlementFile('C:\\Users\\u\\AppData\\Local'),
      'C:\\Users\\u\\AppData\\Local\\Unity\\licenses\\UnityEntitlementLicense.xml',
      'entitlement path',
    );
    const ulf =
      '<?xml version="1.0" encoding="UTF-8"?>\r\n<root>\r\n  <License id="Terms">\r\n    <SerialMasked Value="U3-XXXX-XXXX-XXXX-XXXX-XXXX" />\r\n    <UpdateDate Value="2026-10-01T10:00:00" />\r\n  </License>\r\n</root>';
    t.equal(
      ulfSummary(ulf),
      { serialMasked: 'U3-XXXX-XXXX-XXXX-XXXX-XXXX', updated: '2026-10-01T10:00:00', kind: 'personal' },
      'personal ulf',
    );
    t.equal(ulfSummary(ulf.replace('U3-', 'F4-'))?.kind, 'paid', 'paid ulf');
    t.equal(ulfSummary('hello'), null, 'not a ulf');
    t.equal(unitySummary({ email: 'me@x.com', password: 'hunter2hunter2' }), 'me@x.com', 'the email');
    t.excludes(
      unitySummary({ email: 'me@x.com', password: 'hunter2hunter2', serial: 'SECRET' }),
      'hunter2',
      'no password in the summary',
    );
    t.equal(unitySummary({ ulf }), 'licence file (Personal)', 'a personal file');
    t.equal(unitySummary({ ulf: ulf.replace('U3-', 'F4-') }), 'licence file (Plus or Pro)', 'a paid file');
    t.check(!UnityPayloadSchema.safeParse({}).success, 'an empty sign-in is refused');
    t.check(UnityPayloadSchema.safeParse({ entitlement: '<x/>' }).success, 'an entitlement alone is a sign-in');
    t.equal(parseLicenceStatus({ weird: true }).state, 'unknown', 'an unknown shape is unknown');
    t.equal(parseLicenceStatus('text').state, 'unknown', 'text is unknown');
    t.equal(parseLicenceStatus(null).state, 'unknown', 'null is unknown');
    t.equal(parseLicenceStatus({ licenses: [] }).state, 'none', 'no licences');
    t.equal(parseLicenceStatus({ status: 'active', type: 'Personal' }).state, 'active', 'active');

    t.section('readiness');
    t.check(isToolchainReady('unity') && isKindReady('unity'), 'Unity is offered');
  },
};
