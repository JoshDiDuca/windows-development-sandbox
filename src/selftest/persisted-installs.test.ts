// Large installs kept between sandboxes (guest/toolchains/persisted.ts): the staging folder and its TEMP, the marker,
// the refusal when the disk is short (an injected statfs), keeping only keepVersions, the records `sandbox data`
// reads, which Visual Studio the toolchains ask for (vs-request.ts), and how it is saved on the data disk and put
// back (vs-persist.ts: folders, marker, instance state, registry). Temp folders only.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../core/config/index.js';
import {
  assertLocalRoom,
  ensurePersisted,
  installRecords,
  InstallRecordsSchema,
  LOCAL_RESERVE_BYTES,
  recordUse,
  type PersistedDeps,
} from '../guest/toolchains/persisted.js';
import {
  BUILD_TOOLS_COMPONENTS,
  UNREAL_BUILD_TOOLS_COMPONENTS,
  UNREAL_COMPONENTS,
  visualStudioWanted,
  vsExitText,
} from '../guest/toolchains/native/vs-request.js';
import {
  markerFrom,
  newestInstance,
  persistCovers,
  rebase,
  registryPlan,
  restoreInput,
  rewriteInstanceState,
  SaveResultSchema,
  saveInput,
  SETUP_CLSID,
  VsPersistMarkerSchema,
  type RegEntry,
  type VsPersistMarker,
  type WinPlaces,
} from '../guest/toolchains/native/vs-persist.js';
import { freeBytesAt } from '../shared/io/disk.js';
import { SIGNERS, signerMatches } from '../shared/signer.js';
import { decideToolchains } from '../core/detect/toolchains.js';
import { NOT_READY } from '../shared/readiness.js';
import { ConfigFile } from '../app/features/settings/settings-file.js';
import { settingsOf } from '../app/features/settings/settings-rows.js';
import { collectDataEntries } from '../cli/services/data-collect.js';
import type { Suite } from './support/suite.js';

const GB = 1024 ** 3;

export const persistedInstallsSuite: Suite = {
  name: 'persisted-installs',
  title:
    'large persisted installs: staging, marker, room checks, pruning, records; Visual Studio: request, save, restore',
  run: async (t) => {
    t.section('installing a version');
    const tools = t.dir('persisted-tools');
    const roomy: PersistedDeps = { toolsDir: tools, statfs: () => ({ bavail: 100 * GB, bsize: 1 }) };
    const spec = {
      name: 'engine',
      version: '1.0',
      needBytes: 2 * GB,
      marker: 'bin/engine.exe',
      what: 'Engine 1.0',
      keepVersions: 2,
    };
    let seen: { staging: string; temp: string } | null = null;
    const first = await ensurePersisted(
      spec,
      async (staging, temp) => {
        seen = { staging, temp };
        fs.writeFileSync(path.join(temp, 'download.part'), 'x'.repeat(10));
        fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(staging, 'bin', 'engine.exe'), 'engine');
      },
      roomy,
    );
    const done = path.join(tools, 'engine', '1.0');
    t.check(
      first.fresh &&
        first.dir === done &&
        fs.existsSync(path.join(done, '.complete.json')) &&
        !fs.existsSync(path.join(done, '.temp')) &&
        seen !== null &&
        path.dirname((seen as { staging: string }).staging) === path.join(tools, 'engine') &&
        (seen as { temp: string }).temp.startsWith((seen as { staging: string }).staging),
      'it is built in a staging folder next to the target (TEMP inside it) and moved into place with its marker',
    );
    t.equal(first.sizeBytes, 'engine'.length, 'its size is counted once (the temporary files are gone)');
    let ran = false;
    const again = await ensurePersisted(
      spec,
      async () => {
        ran = true;
      },
      roomy,
    );
    t.check(!again.fresh && !ran && again.sizeBytes === first.sizeBytes, 'a finished version is not installed again');
    t.check(
      InstallRecordsSchema.safeParse(JSON.parse(fs.readFileSync(path.join(tools, 'installs.json'), 'utf8'))).success &&
        installRecords(roomy).some((r) => r.name === 'engine' && r.version === '1.0' && r.sizeBytes === 6),
      'tools\\installs.json records it with its size (what sandbox data shows)',
    );

    t.section('when something goes wrong');
    await t.throws(
      () => ensurePersisted({ ...spec, version: '2.0' }, async () => undefined, roomy),
      'without bin/engine.exe',
      'an install that does not leave its marker fails',
    );
    t.check(
      !fs.existsSync(path.join(tools, 'engine', '2.0')) &&
        !fs.readdirSync(path.join(tools, 'engine')).some((n) => n.startsWith('.staging')),
      'and leaves nothing behind',
    );
    const short: PersistedDeps = { toolsDir: tools, statfs: () => ({ bavail: GB, bsize: 1 }) };
    let installed = false;
    await t.throws(
      () =>
        ensurePersisted(
          { ...spec, version: '3.0' },
          async () => {
            installed = true;
          },
          short,
        ),
      'it needs 2.0 GB',
      'a disk with too little room refuses before anything is downloaded',
    );
    t.check(!installed, 'and the installer never ran');
    await t.throws(
      () => ensurePersisted({ ...spec, version: '..' }, async () => undefined, roomy),
      'not a usable',
      'a version cannot climb out of tools\\',
    );
    await t.throws(
      () =>
        Promise.resolve(
          assertLocalRoom(GB, 'Visual Studio', {
            localDir: tools,
            statfs: () => ({ bavail: LOCAL_RESERVE_BYTES, bsize: 1 }),
          }),
        ),
      'Visual Studio',
      "a real installer leaves 13 GB free on the sandbox's own disk",
    );

    t.section('keeping versions');
    const make = (version: string) =>
      ensurePersisted(
        { ...spec, version },
        async (staging) => {
          fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });
          fs.writeFileSync(path.join(staging, 'bin', 'engine.exe'), version);
        },
        roomy,
      );
    await make('1.1');
    recordUse('engine', '1.0', roomy);
    await make('1.2');
    const left = fs.readdirSync(path.join(tools, 'engine')).sort();
    t.equal(left, ['1.0', '1.2'], 'beyond keepVersions the least recently used version goes');
    t.check(!installRecords(roomy).some((r) => r.version === '1.1'), 'and its record with it');

    t.section('what sandbox data shows');
    const data = t.dir('persisted-data');
    const big = t.dir('persisted-data', 'tools', 'editor', '6000.0');
    fs.writeFileSync(path.join(big, 'Unity.exe'), 'small here');
    t.writeJson(path.join(data, 'tools', 'installs.json'), {
      installs: [{ name: 'editor', version: '6000.0', sizeBytes: 7 * GB, installedAt: 'x', usedAt: 'x' }],
    });
    t.dir('persisted-data', 'tools', 'walked', '1.0');
    const rows = collectDataEntries(data, t.dir('persisted-storage'));
    t.check(
      rows.find((r) => r.name === 'editor')?.bytes === 7 * GB && rows.some((r) => r.name === 'walked'),
      'a tool whose versions are all recorded shows the recorded size (not walked); the others are measured',
    );

    t.section('which Visual Studio');
    const tc = structuredClone(DEFAULTS.toolchains);
    t.equal(visualStudioWanted(tc), null, 'no toolchain that needs it: none');
    tc.flutter.enabled = true;
    tc.flutter.windowsDesktop = true;
    const tools1 = visualStudioWanted(tc);
    t.check(
      tools1?.product === 'buildtools' &&
        BUILD_TOOLS_COMPONENTS.every((c) => tools1.components.includes(c)) &&
        tools1.licence === 'toolchains.msvc.acceptLicense' &&
        !tools1.accepted,
      "Flutter desktop: the Build Tools' C++ parts, under the MSVC licence setting",
    );
    tc.unity.enabled = true;
    tc.unity.modules = ['windows-il2cpp'];
    tc.unreal.enabled = true;
    tc.unreal.acceptLicense = true;
    tc.unreal.components = ['Microsoft.VisualStudio.Component.VC.Llvm.Clang'];
    const all = visualStudioWanted(tc);
    t.check(
      all?.product === 'community' &&
        all.accepted &&
        all.for.join() === 'unreal,flutter,unity' &&
        UNREAL_COMPONENTS.every((c) => all.components.includes(c)) &&
        all.components.includes('Microsoft.VisualStudio.Component.VC.Llvm.Clang'),
      'with Unreal: one Community install serves all of them',
    );

    t.section('Unreal on the Build Tools');
    tc.unreal.visualStudio = 'buildtools';
    const bt = visualStudioWanted(tc);
    t.check(
      bt?.product === 'buildtools' &&
        bt.for.join() === 'unreal,flutter,unity' &&
        bt.licence === 'toolchains.unreal.acceptLicense' &&
        UNREAL_BUILD_TOOLS_COMPONENTS.every((c) => bt.components.includes(c)) &&
        BUILD_TOOLS_COMPONENTS.every((c) => bt.components.includes(c)) &&
        bt.components.includes('Microsoft.VisualStudio.Component.VC.Llvm.Clang'),
      '"buildtools": the Build Tools with what UnrealBuildTool needs, shared with Flutter and Unity',
    );
    t.equal(
      DEFAULTS.toolchains.unreal.visualStudio,
      'full',
      'Community is the default (the IDE, its debugger and Unreal integration)',
    );
    const on = DEFAULTS.toolchains;
    const decided = decideToolchains(
      { ...structuredClone(on), unreal: { ...on.unreal, acceptLicense: true } },
      ['Game.uproject'],
      [],
    );
    t.check(
      decided.unreal.on && !decided.msvc.on,
      'an Unreal project does not turn the portable MSVC on (Visual Studio brings MSVC)',
    );

    t.section('Visual Studio kept on the data disk');
    const places: WinPlaces = {
      programFiles: 'C:\\Program Files',
      programFilesX86: 'C:\\Program Files (x86)',
      programData: 'C:\\ProgramData',
    };
    const root = 'C:\\AgentData\\tools\\visualstudio\\persist';
    const community = 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community';
    const instances = 'C:\\ProgramData\\Microsoft\\VisualStudio\\Packages\\_Instances';
    const vsAt = { product: 'community' as const, installationPath: community, instanceId: 'a190d188' };
    const save = saveInput(vsAt, root, places, 'T:\\result.json');
    const saved = (name: string) => save.copies.find((c) => c.name === name);
    t.check(
      saved('Community')?.from === community &&
        saved('Community')?.to === root + '\\Community' &&
        saved('WindowsKits10')?.from === 'C:\\Program Files (x86)\\Windows Kits\\10' &&
        saved('instance')?.from === instances + '\\a190d188' &&
        saved('instance')?.to === root + '\\instance' &&
        saved('Setup')?.from === 'C:\\ProgramData\\Microsoft\\VisualStudio\\Setup' &&
        saved('Installer')?.optional === false &&
        saved('ReferenceAssemblies')?.optional === true &&
        save.resultFile === 'T:\\result.json',
      'the capture mirrors the install, the Windows SDK, the installer, the Setup API and the instance onto the data disk',
    );
    t.check(
      save.registry.length === 8 &&
        save.registry.filter((r) => r.view === '32').length === 4 &&
        save.registry.some((r) => r.key.endsWith('NETFXSDK') && r.recurse) &&
        save.registry.some((r) => r.key.endsWith('Installed Roots') && r.names?.join() === 'KitsRoot10'),
      'it reads the SDK registry values in both views (NETFXSDK with its subkeys, only KitsRoot10 of the kits roots)',
    );
    await t.throws(
      () => Promise.resolve(saveInput({ ...vsAt, instanceId: '..\\x' }, root, places, 'r')),
      'not a Visual Studio instance ID',
      'an instance ID is never a path',
    );

    const captured: RegEntry[] = [
      {
        view: '64',
        key: 'SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots',
        name: 'KitsRoot10',
        kind: 'string',
        value: 'C:\\Program Files (x86)\\Windows Kits\\10\\',
      },
      {
        view: '32',
        key: 'SOFTWARE\\Microsoft\\Microsoft SDKs\\Windows\\v10.0',
        name: 'ProductVersion',
        kind: 'string',
        value: '10.0.22621',
      },
      {
        view: '32',
        key: 'SOFTWARE\\Microsoft\\Microsoft SDKs\\NETFXSDK\\4.8',
        name: 'KitsInstallationFolder',
        kind: 'string',
        value: 'C:\\Program Files (x86)\\Windows Kits\\NETFXSDK\\4.8\\',
      },
      {
        view: '32',
        key: 'SOFTWARE\\Microsoft\\Microsoft SDKs\\NETFXSDK\\4.8\\WinSDK-NetFx40Tools-x64',
        name: 'InstallationFolder',
        kind: 'string',
        value: 'c:\\program files (x86)\\Microsoft SDKs\\Windows\\v10.0A\\bin\\NETFX 4.8 Tools\\x64\\',
      },
      {
        view: '64',
        key: 'SOFTWARE\\Microsoft\\VisualStudio\\Setup',
        name: 'KeepDownloadedPayloads',
        kind: 'dword',
        value: 0,
      },
      {
        view: '64',
        key: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
        name: 'planted',
        kind: 'string',
        value: 'C:\\planted.exe',
      },
    ];
    const result = SaveResultSchema.parse({
      copied: [
        'Community',
        'WindowsKits10',
        'NETFXSDK',
        'MicrosoftSDKs-v10.0A',
        'ReferenceAssemblies',
        'Installer',
      ].concat(['Setup', 'instance']),
      registry: captured,
    });
    const marker: VsPersistMarker = VsPersistMarkerSchema.parse(
      markerFrom(
        { product: 'community', components: [...UNREAL_COMPONENTS] },
        { installationPath: community, instanceId: 'a190d188', version: '17.14.37827.9' },
        result,
        '2026-11-04T00:00:00.000Z',
      ),
    );
    t.check(
      marker.sdkVersion === '10.0.22621' && marker.instanceId === 'a190d188' && marker.folders.length === 8,
      'the marker keeps the instance ID, what was saved and the Windows SDK version from the registry',
    );
    t.check(
      !VsPersistMarkerSchema.safeParse({ ...marker, instanceId: '..\\..\\Windows' }).success &&
        !VsPersistMarkerSchema.safeParse({ ...marker, folders: ['..'] }).success,
      'a marker with a path for its instance ID, or a folder it does not know, is refused',
    );

    const plan = registryPlan(marker, root, places);
    const value = (view: string, key: string, name: string) =>
      plan.find((e) => e.view === view && e.key.toLowerCase() === key.toLowerCase() && e.name === name)?.value;
    const kits = root + '\\WindowsKits10\\';
    const sdk = 'SOFTWARE\\Microsoft\\Microsoft SDKs\\Windows\\v10.0';
    const netfx = 'SOFTWARE\\Microsoft\\Microsoft SDKs\\NETFXSDK\\4.8';
    t.check(
      ['64', '32'].every(
        (v) =>
          value(v, 'SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots', 'KitsRoot10') === kits &&
          value(v, sdk, 'InstallationFolder') === kits &&
          value(v, sdk, 'ProductVersion') === '10.0.22621' &&
          value(v, netfx, 'KitsInstallationFolder') === root + '\\NETFXSDK\\4.8\\' &&
          value(v, netfx + '\\WinSDK-NetFx40Tools-x64', 'InstallationFolder') ===
            root + '\\MicrosoftSDKs-v10.0A\\bin\\NETFX 4.8 Tools\\x64\\' &&
          value(v, 'SOFTWARE\\Microsoft\\VisualStudio\\Setup', 'KeepDownloadedPayloads') === 0,
      ),
      'both registry views point the Windows SDK and the .NET Framework SDK at the data disk (any case); the rest stays',
    );
    const clsid = 'SOFTWARE\\Classes\\CLSID\\' + SETUP_CLSID + '\\InprocServer32';
    const setupDll = 'Microsoft.VisualStudio.Setup.Configuration.Native.dll';
    t.check(
      value('64', clsid, '') === 'C:\\ProgramData\\Microsoft\\VisualStudio\\Setup\\x64\\' + setupDll &&
        value('32', clsid, '') === 'C:\\ProgramData\\Microsoft\\VisualStudio\\Setup\\x86\\' + setupDll &&
        value('64', clsid, 'ThreadingModel') === 'Both' &&
        value('32', clsid, 'ThreadingModel') === 'Both',
      'the Setup Configuration COM class is registered (x64 and x86), so vswhere and UnrealBuildTool find the instance',
    );
    t.check(
      !plan.some((e) => /CurrentVersion\\Run/i.test(e.key)),
      'a value the capture never reads is never written back (a tampered marker)',
    );

    const back = restoreInput(marker, root, places);
    const copied = (name: string) => back.copies.find((c) => c.name === name);
    t.check(
      !copied('Community') &&
        !copied('WindowsKits10') &&
        !copied('NETFXSDK') &&
        !copied('Shared') &&
        copied('Installer')?.to === 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer' &&
        copied('Installer')?.mode === 'all' &&
        copied('ReferenceAssemblies')?.mode === 'missing' &&
        copied('instance')?.from === root + '\\instance' &&
        copied('instance')?.to === instances + '\\a190d188' &&
        back.registry.length === plan.length,
      'a boot copies back only the small fixed-path folders that were saved (the instance under its ID); the big ones stay',
    );

    t.check(
      persistCovers(marker, { product: 'community', components: [...UNREAL_COMPONENTS] }) &&
        persistCovers(marker, { product: 'community', components: ['component.unreal'] }) &&
        !persistCovers(marker, {
          product: 'community',
          components: [...UNREAL_COMPONENTS, 'Microsoft.VisualStudio.Component.VC.Llvm.Clang'],
        }) &&
        persistCovers(marker, { product: 'buildtools', components: [...BUILD_TOOLS_COMPONENTS] }) &&
        !persistCovers({ ...marker, product: 'buildtools' }, { product: 'community', components: [] }) &&
        !persistCovers(
          { ...marker, folders: marker.folders.filter((f) => f !== 'Setup') },
          {
            product: 'community',
            components: [],
          },
        ),
      'a saved copy serves requests with no more components (Community serves the Build Tools too); one without the Setup API none',
    );

    const state = JSON.stringify({
      installationPath: community,
      resolvedInstallationPath: community.toLowerCase(),
      nested: community + '\\Common7\\IDE',
      longer: community + '2',
      launchParams: { fileName: 'Common7\\IDE\\devenv.exe' },
      enginePath: 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\resources\\app',
    });
    const moved = JSON.parse(rewriteInstanceState(state, community, root + '\\Community')) as Record<string, unknown>;
    t.check(
      moved.installationPath === root + '\\Community' &&
        moved.resolvedInstallationPath === root + '\\Community' &&
        moved.nested === root + '\\Community\\Common7\\IDE' &&
        moved.longer === community + '2' &&
        moved.enginePath === 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\resources\\app',
      "the instance's state names the saved folder (JSON-escaped, any case); a longer name that only starts the same stays",
    );
    const buildTools = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools';
    const movedBt = JSON.parse(
      rewriteInstanceState(JSON.stringify({ installationPath: buildTools }), buildTools + '\\', root + '\\BuildTools'),
    ) as Record<string, unknown>;
    t.check(
      movedBt.installationPath === root + '\\BuildTools' &&
        rebase('D:\\Other\\x', [{ from: 'C:\\Program Files', to: 'D:\\y' }]) === 'D:\\Other\\x',
      'the Build Tools too (a trailing backslash does not matter); a value outside the saved folders is kept',
    );

    t.equal(
      newestInstance([
        { installationVersion: '17.9.1', id: 'a' },
        { installationVersion: '17.14.37827.9', id: 'b' },
        { installationVersion: '17.14.3', id: 'c' },
      ])?.id,
      'b',
      'the newest instance is chosen by version (vswhere -latest fails on two instances installed at the same time)',
    );
    t.equal(newestInstance([]), null, 'no instance: none');

    t.section('the Visual Studio installer');
    t.check(
      vsExitText(3762504530).includes('crashed') &&
        vsExitText(-1).includes('exit 4294967295') &&
        vsExitText(0) === 'installed' &&
        vsExitText(1602) === 'cancelled' &&
        vsExitText(8006).includes('running') &&
        vsExitText(3010).includes('restart') &&
        vsExitText(5007).includes('refused'),
      'installer exit codes are told in words (0xE0434352 is a crash)',
    );
    t.equal(
      freeBytesAt(path.join(t.dir('layout-room'), 'not', 'there'), () => ({ bavail: 3, bsize: 2 })),
      6,
      'free room of a folder that does not exist asks its parent',
    );
    t.equal(
      freeBytesAt(t.dir('layout-room'), () => {
        throw new Error('no');
      }),
      null,
      'unknown free room is null',
    );

    t.section('signers');
    const ms = { subject: SIGNERS.microsoft.subject, issuer: undefined };
    const msSig = {
      subject: 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
      issuer: 'CN=Microsoft Code Signing PCA',
    };
    t.check(
      signerMatches(msSig, ms) &&
        !signerMatches({ ...msSig, subject: 'CN=Microsoft Corporation Fake, O=Evil' }, ms) &&
        !signerMatches(null, ms) &&
        signerMatches({ subject: 'CN="Valve Corp.", O=Valve', issuer: 'x' }, SIGNERS.valve) &&
        signerMatches({ subject: 'CN=Unity Technologies ApS', issuer: 'x' }, SIGNERS.unity) &&
        !signerMatches({ subject: 'CN=Microsoft Corporation', issuer: 'x' }, SIGNERS.valve) &&
        signerMatches(msSig, { subject: ['^CN=Microsoft'], issuer: ['code signing'] }) &&
        !signerMatches(msSig, { subject: ['^CN=Microsoft'], issuer: ['nobody'] }),
      'a signer matches by subject (and issuer when named), never an empty or unsigned file',
    );

    t.section('not ready yet');
    const everything = structuredClone(on);
    for (const name of NOT_READY.toolchains) (everything[name] as { enabled: boolean | 'auto' }).enabled = 'auto';
    const found = decideToolchains(everything, ['ProjectVersion.txt', 'project.godot', 'fxmanifest.lua'], ['unity']);
    t.check(
      NOT_READY.toolchains.every((n) => !found[n].on),
      '"auto" never turns on a toolchain that is not written yet, whatever the project holds',
    );
    const shown = settingsOf(ConfigFile.user(t.at('settings', 'config.json'))).map((r) => r.key.join('.'));
    t.check(
      !shown.some((k) => /^toolchains\.(godot|android|flutter|dart|reactNative)\./.test(k)) &&
        shown.includes('toolchains.unreal.visualStudio') &&
        shown.some((k) => k.startsWith('toolchains.fivem.')),
      'settings do not list the toolchains that are not written yet',
    );
  },
};
