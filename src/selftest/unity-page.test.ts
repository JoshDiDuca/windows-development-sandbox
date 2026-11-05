// The Unity page and its host side: this PC's editors and Asset Store downloads (a temp PC tree), "auto" following the
// launch, the status file never read through a link, the page itself (no command text, every operation on it) and the
// editor bridge edited in a temp project. No network: the Pipeline version lookup is given a fake.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../core/config/index.js';
import { pageActions } from '../app/kernel/index.js';
import { unityPage, unityView } from '../app/features/unity/index.js';
import {
  addBridgeToProject,
  latestPipelineVersion,
  readStatus,
  removeBridgeFromProject,
} from '../app/features/unity/unity.run.js';
import { discoverPcInstalls, type PcInstallSource } from '../host/pc-installs/index.js';
import { findUnityEditorsOnPc, unityAssetCacheDirs, unityPcFiles } from '../host/pc-installs/unity.js';
import { unityAssetInstalls } from '../host/pc-installs/unity-assets.js';
import { pageLines } from '../cli/output/render-view.js';
import { UNITY_STATUS_FILE, bridgeOf, type UnityStatus } from '../shared/unity/index.js';
import type { Suite } from './support/suite.js';
import { UNITY_SAMPLE } from './support/unity-sample.js';

const STATUS: UnityStatus = {
  updatedAt: '2026-11-05T12:00:00.000Z',
  cli: null,
  editors: [],
  projects: [],
  licence: { state: 'unknown', kind: '', detail: '', user: null },
  assetCache: { mode: 'persisted', dir: null },
  pcAssets: [],
  hub: { installed: false, path: null },
  mcp: null,
  skills: false,
  problem: null,
};

const MANIFEST =
  JSON.stringify({ dependencies: { 'com.unity.ugui': '2.0.0', 'com.unity.modules.ai': '1.0.0' } }, null, 2) + '\n';

export const unityPageSuite: Suite = {
  name: 'unity-page',
  title: "The Unity page: this PC's editors and downloads, auto, the status file, the bridge",
  run: async (t) => {
    t.section("this PC's editors");
    const pcDir = t.dir('pc');
    const appData = path.join(pcDir, 'AppData');
    const programFiles = path.join(pcDir, 'Program Files');
    const editor = (root: string): string => t.write(path.join(root, 'Editor', 'Unity.exe'), 'x');
    editor(path.join(programFiles, 'Unity', 'Hub', 'Editor', '6000.0.58f2'));
    const second = path.join(pcDir, 'Editors');
    editor(path.join(second, '2022.3.20f1'));
    t.write(path.join(appData, 'UnityHub', 'secondaryInstallPath.json'), JSON.stringify(second));
    const listedRoot = path.join(pcDir, 'Elsewhere', '2021.3.1f1');
    editor(listedRoot);
    editor(path.join(pcDir, 'Elsewhere', 'evil'));
    t.write(
      path.join(appData, 'UnityHub', 'editors-v2.json'),
      JSON.stringify({
        'schema-version': 'v2',
        data: [
          { version: '2021.3.1f1', location: [path.join(listedRoot, 'Editor', 'Unity.exe')], other: 1 },
          { version: '../../evil', location: path.join(pcDir, 'Elsewhere', 'evil', 'Editor', 'Unity.exe') },
          { version: '2020.3.1f1', location: path.join(pcDir, 'Elsewhere', 'x', 'Editor', 'notunity.exe') },
          { version: 5, location: 3 },
        ],
      }),
    );
    const files = unityPcFiles({ appData, localAppData: '', programData: '', programFiles });
    const found = findUnityEditorsOnPc(files, true);
    t.equal(
      found.map((e) => e.id),
      ['6000.0.58f2', '2022.3.20f1', '2021.3.1f1'],
      'the default folder, the secondary folder and editors-v2.json are read; a bad version or exe name is skipped',
    );
    t.check(
      found.every((e) => e.kind === 'unity' && e.name === 'Unity ' + e.id && e.version === e.id),
      'each editor is named by its version',
    );
    t.equal(
      findUnityEditorsOnPc(files, ['2022.3.20f1']).map((e) => e.id),
      ['2022.3.20f1'],
      'a list asks for exact versions only',
    );
    t.write(path.join(appData, 'UnityHub', 'secondaryInstallPath.json'), JSON.stringify('relative\\dir'));
    t.equal(
      findUnityEditorsOnPc(files, true).map((e) => e.id),
      ['6000.0.58f2', '2021.3.1f1'],
      'a relative secondary path is ignored',
    );

    t.section("this PC's Asset Store downloads");
    const store = path.join(appData, 'Unity', 'Asset Store-5.x');
    t.write(path.join(store, 'Kenney', '2D', 'Pack.unitypackage'), 'x');
    const envRoot = t.dir('pc', 'Cache');
    t.dir('pc', 'Cache', 'Asset Store-5.x');
    t.equal(unityAssetCacheDirs(files, undefined), [store], 'the default folder under %APPDATA%\\Unity');
    t.equal(
      unityAssetCacheDirs(files, envRoot),
      [path.join(envRoot, 'Asset Store-5.x'), store],
      'the environment variable first, then the default',
    );
    t.equal(
      unityAssetInstalls([store, store + '2']).map((i) => i.id),
      ['AssetStore', 'AssetStore2'],
      'mapped at AssetStore, AssetStore2',
    );

    t.section('auto follows the launch');
    const host = t.dir('auto-host', '6000.0.58f2');
    const unitySource: PcInstallSource = {
      kind: 'unity',
      setting: 'unityEditors',
      find: () => [{ kind: 'unity', id: '6000.0.58f2', name: 'Unity 6000.0.58f2', host, guest: '' }],
    };
    const unrealSource: PcInstallSource = {
      kind: 'unreal',
      setting: 'unrealEngines',
      find: () => [{ kind: 'unreal', id: 'UE_5.4', name: 'Unreal Engine 5.4', host, guest: '' }],
    };
    const run = (o: { unityOn?: boolean; unrealOn?: boolean }): string[] =>
      discoverPcInstalls(DEFAULTS.pcInstalls, {
        packageRoot: t.packageRoot,
        storageRoot: t.dir('auto-storage'),
        sources: [unitySource, unrealSource],
        ...o,
      }).manifest.items.map((i) => i.guest);
    t.equal(run({ unityOn: true }), ['C:\\PcInstalls\\unity\\6000.0.58f2'], 'Unity on: the editors, not the engines');
    t.equal(run({ unrealOn: true }), ['C:\\PcInstalls\\unreal\\UE_5.4'], 'Unreal on: the engines, not the editors');
    t.equal(run({}), [], 'neither on: nothing');

    t.section('the status file');
    const data = t.dir('status-data');
    const target = t.dir('status-elsewhere');
    t.write(path.join(target, UNITY_STATUS_FILE), JSON.stringify(STATUS));
    t.write(path.join(data, 'plain', 'tools', 'unity', UNITY_STATUS_FILE), JSON.stringify(STATUS));
    t.check(readStatus(path.join(data, 'plain')) !== null, 'a status file in the data folder is read');
    fs.mkdirSync(path.join(data, 'linked', 'tools'), { recursive: true });
    fs.symlinkSync(target, path.join(data, 'linked', 'tools', 'unity'), 'junction');
    t.check(readStatus(path.join(data, 'linked')) === null, 'a junction at tools\\unity is never followed');
    t.write(path.join(data, 'bad', 'tools', 'unity', UNITY_STATUS_FILE), '{"editors": "x"}');
    t.check(readStatus(path.join(data, 'bad')) === null, 'a status file that does not fit the schema is not used');

    t.section('the page');
    const page = unityPage(UNITY_SAMPLE);
    t.equal(
      page.sections.map((s) => s.id),
      ['editors', 'pc', 'assets', 'licence', 'projects', 'tools', 'settings'],
      'editors, this PC, assets, licence, projects, agent tools, settings',
    );
    const actions = pageActions(page);
    const ops = actions.flatMap((a) => (a.kind === 'operation' ? [a.op] : []));
    t.check(
      unityView.operations.every((op) => ops.includes(op.id) || op.id === 'unity.openHub'),
      'every operation of the view is on the page (Open Unity Hub once the Hub is in the sandbox)',
    );
    const withHub = pageActions(unityPage({ ...UNITY_SAMPLE, hub: { installed: true, setting: true } }));
    t.check(
      withHub.some((a) => a.kind === 'operation' && a.op === 'unity.openHub'),
      'Open Unity Hub is offered when the Hub is installed',
    );
    t.check(
      actions.some((a) => a.kind === 'link' && a.target.kind === 'view' && a.target.view === 'accounts'),
      'a link to Unity sign-in in Accounts',
    );
    const settingKeys = actions.flatMap((a) =>
      a.kind === 'link' && a.target.kind === 'setting' ? [a.target.key] : [],
    );
    t.check(settingKeys.includes('pcInstalls.unityEditors'), 'the settings are links');
    const text = pageLines(page).join('\n');
    for (const needle of [
      '6000.0.58f2',
      'this PC, read-only',
      'Platformer Pack',
      'dev@example.com',
      'toolchains.unity.assetCache',
      'pcInstalls.unityAssets',
    ])
      t.includes(text, needle, 'the page shows ' + needle);
    t.check(!/sandbox (unity|launch|config|account|projects)/.test(text), 'no page text tells you to run a command');
    t.excludes(text, 'unity editors', 'no Unity CLI command on the page');
    t.excludes(text, ' --', 'no flag on the page');
    const empty = pageLines(unityPage({ ...UNITY_SAMPLE, setUp: false, editors: [], projects: [] })).join('\n');
    t.includes(empty, 'No sandbox has set Unity up yet', 'nothing set up: the page says so');

    t.section('the editor bridge');
    const project = t.dir('bridge', 'Game');
    t.write(path.join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.58f2\n');
    const manifest = t.write(path.join(project, 'Packages', 'manifest.json'), MANIFEST);
    const hooks = {
      pipelineVersion: (): Promise<string> => Promise.resolve('0.10.1'),
      confirm: (): Promise<boolean> => Promise.resolve(true),
    };
    const declined = await addBridgeToProject(project, undefined, { ...hooks, confirm: () => Promise.resolve(false) });
    t.check(
      fs.readFileSync(manifest, 'utf8') === MANIFEST && declined.message === 'Nothing was changed.',
      'no: nothing changes',
    );
    const added = await addBridgeToProject(project, undefined, hooks);
    const after = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { dependencies: Record<string, string> };
    t.equal(
      Object.keys(after.dependencies),
      ['com.unity.ugui', 'com.unity.modules.ai', 'com.unity.pipeline'],
      'exactly one dependency is added, the others keep their order',
    );
    t.check(after.dependencies['com.unity.pipeline'] === '0.10.1', 'the Pipeline version is the one looked up');
    t.check(
      bridgeOf(fs.readFileSync(manifest, 'utf8')) === 'pipeline' && added.file === manifest,
      'it is the Pipeline bridge',
    );
    const again = await addBridgeToProject(project, undefined, hooks);
    t.includes(again.message, 'already', 'adding twice changes nothing');
    await removeBridgeFromProject(project, hooks);
    t.check(fs.readFileSync(manifest, 'utf8') === MANIFEST, 'removing restores the bytes');
    const crlf = MANIFEST.replace(/\n/g, '\r\n');
    fs.writeFileSync(manifest, crlf);
    await addBridgeToProject(project, undefined, hooks);
    await removeBridgeFromProject(project, hooks);
    t.check(fs.readFileSync(manifest, 'utf8') === crlf, 'a CRLF manifest comes back as it was');

    const old = t.dir('bridge', 'Old');
    t.write(path.join(old, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.20f1\n');
    const oldManifest = t.write(path.join(old, 'Packages', 'manifest.json'), MANIFEST);
    await addBridgeToProject(old, undefined, hooks);
    t.check(bridgeOf(fs.readFileSync(oldManifest, 'utf8')) === 'coplay', 'Unity before 6 gets the Coplay bridge');
    await t.throws(
      () => addBridgeToProject(t.dir('bridge', 'Old2'), 'pipeline', hooks),
      /not a Unity project/,
      'a folder without ProjectVersion.txt is refused',
    );
    const old2 = t.dir('bridge', 'Old3');
    t.write(path.join(old2, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.20f1\n');
    t.write(path.join(old2, 'Packages', 'manifest.json'), MANIFEST);
    await t.throws(() => addBridgeToProject(old2, 'pipeline', hooks), /Unity 6/, 'Pipeline is refused before Unity 6');
    const offline = t.dir('bridge', 'Offline');
    t.write(path.join(offline, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.58f2\n');
    const offlineManifest = t.write(path.join(offline, 'Packages', 'manifest.json'), MANIFEST);
    const fallback = await addBridgeToProject(offline, undefined, {
      ...hooks,
      pipelineVersion: () => Promise.reject(new Error('offline')),
    });
    t.includes(fallback.message, 'offline', 'no answer from Unity: the bundled version is used and it says so');
    t.check(bridgeOf(fs.readFileSync(offlineManifest, 'utf8')) === 'pipeline', 'the bridge is still added');

    t.section('the Pipeline version lookup (a fake registry)');
    const reply =
      (body: string): typeof fetch =>
      () =>
        Promise.resolve(new Response(body));
    t.check(
      (await latestPipelineVersion(reply(JSON.stringify({ 'dist-tags': { latest: '0.11.0' } })))) === '0.11.0',
      'dist-tags.latest is used',
    );
    await t.throws(
      () => latestPipelineVersion(reply(JSON.stringify({ 'dist-tags': { latest: '1; rm -rf' } }))),
      /no usable version/,
      'a version that is not semver is refused',
    );
    await t.throws(
      () => latestPipelineVersion(reply('x'.repeat(3 * 1024 * 1024))),
      /over 2 MB/,
      'a huge answer is refused',
    );
  },
};
