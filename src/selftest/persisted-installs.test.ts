// Large installs kept between sandboxes (guest/toolchains/persisted.ts): the staging folder and its TEMP, the marker,
// the refusal when the disk is short (an injected statfs), keeping only keepVersions, the records `sandbox data`
// reads, and which Visual Studio the toolchains ask for (vs-request.ts). Temp folders only.
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
  UNREAL_COMPONENTS,
  visualStudioWanted,
} from '../guest/toolchains/native/vs-request.js';
import { collectDataEntries } from '../cli/services/data-collect.js';
import type { Suite } from './support/suite.js';

const GB = 1024 ** 3;

export const persistedInstallsSuite: Suite = {
  name: 'persisted-installs',
  title: 'large persisted installs: staging, marker, room checks, pruning, records; the Visual Studio request',
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
  },
};
