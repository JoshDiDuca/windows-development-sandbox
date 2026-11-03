// pcInstalls (this PC's games, engines and editors, read-only in the sandbox): where each one appears, what is
// refused, that a project file can never ask for them, and the launch writing them into the .wsb and session.json
// (paths in the sandbox only). Also the new toolchains' detection: markers, what one brings along, licence gates, and
// that a project can never accept a licence for you. Temp folders and fake sources only.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../core/config/index.js';
import { decideToolchains, LICENSED_TOOLCHAINS } from '../core/detect/index.js';
import { applyOverrides, normalizeOverrides, OFF_IS_SAFER } from '../core/local-config/index.js';
import { LocalOverridesSchema } from '../core/schema/index.js';
import { discoverPcInstalls, type PcInstallSource } from '../host/pc-installs/index.js';
import { generateSandbox } from '../host/launch/index.js';
import { isValidGuestPath, PC_INSTALLS_GUEST, type PcInstall } from '../shared/paths/index.js';
import { NOT_READY } from '../shared/readiness.js';
import type { Suite } from './support/suite.js';

const PC = { localAppData: '', appData: '', programData: '' };

export const pcInstallsSuite: Suite = {
  name: 'pc-installs',
  title: "this PC's installs mapped read-only; new toolchains' markers, implications and licence gates",
  run: async (t, f) => {
    t.section('placing them');
    const game = t.dir('pc-games', 'Spacewar');
    const engine = t.dir('pc-engines', 'UE_5.4');
    const installs = (items: PcInstall[]): PcInstallSource => ({
      kind: 'steam-game',
      setting: 'steamGames',
      find: () => items,
    });
    const steam = installs([
      { kind: 'steam-game', id: '480', name: 'Spacewar', host: game, guest: '' },
      { kind: 'steam-game', id: '481', name: 'Gone', host: path.join(game, 'missing'), guest: '' },
      { kind: 'steam-game', id: '..', name: 'Climber', host: game, guest: '' },
    ]);
    const unreal: PcInstallSource = {
      kind: 'unreal',
      setting: 'unrealEngines',
      find: () => [
        { kind: 'unreal', id: 'UE_5.4', name: 'Unreal Engine 5.4', version: '5.4', host: engine, guest: '' },
      ],
    };
    const settings = { ...DEFAULTS.pcInstalls, steamGames: [480, 481], unrealEngines: true as const };
    const found = discoverPcInstalls(
      settings,
      { packageRoot: t.packageRoot, storageRoot: f.baseConfig.storage.root, sources: [steam, unreal] },
      PC,
    );
    t.equal(
      found.mappings.map((m) => [m.guest, m.readOnly]),
      [
        [PC_INSTALLS_GUEST + '\\steam\\480', true],
        [PC_INSTALLS_GUEST + '\\unreal\\UE_5.4', true],
      ],
      'each one appears read-only under C:\\PcInstalls by its kind and id',
    );
    t.check(
      found.notes.some((n) => n.includes('Gone')) && found.notes.some((n) => n.includes('Climber')),
      'a folder that is not there, or an id that is not a folder name, is left out with a note',
    );
    t.check(
      !JSON.stringify(found.manifest).includes(game) &&
        found.manifest.items.every((i) => i.guest.startsWith(PC_INSTALLS_GUEST)),
      'the manifest for the sandbox holds no path of this PC',
    );
    t.equal(
      discoverPcInstalls(
        DEFAULTS.pcInstalls,
        { packageRoot: t.packageRoot, storageRoot: f.baseConfig.storage.root, sources: [steam] },
        PC,
      ).mappings,
      [],
      'off by default: nothing is looked for',
    );
    const unsafe = installs([
      { kind: 'steam-game', id: '1', name: 'Storage', host: f.baseConfig.storage.root, guest: '' },
    ]);
    t.check(
      discoverPcInstalls(
        { ...settings, unrealEngines: false },
        { packageRoot: t.packageRoot, storageRoot: f.baseConfig.storage.root, sources: [unsafe] },
        PC,
      ).mappings.length === 0,
      "this tool's own folders are refused like any other mapping",
    );
    t.check(!isValidGuestPath('C:\\PcInstalls\\mine'), 'no other mapping may use C:\\PcInstalls');

    t.section('yours only');
    t.check(!('pcInstalls' in LocalOverridesSchema.shape), 'a project file has no pcInstalls');
    await t.throws(
      () => normalizeOverrides({ pcInstalls: { steamGames: true } }, f.workA, 'project'),
      'not valid',
      'a project file asking for them is refused',
    );

    t.section('the launch');
    const run = await f.run({}, f.makeConfig());
    const launched = generateSandbox({
      packageRoot: t.packageRoot,
      run,
      harnessArgs: [],
      probe: f.probe,
      pcLanguages: [],
      pcInstalls: { mappings: found.mappings, manifest: found.manifest },
    });
    const wsb = fs.readFileSync(launched.wsbPath, 'utf8');
    const session = f.readJson<{ pcInstalls?: { items: { guest: string; id: string }[] } }>(launched.sessionPath);
    t.check(wsb.includes(game) && wsb.includes(PC_INSTALLS_GUEST + '\\steam\\480'), 'the .wsb maps them');
    t.check(
      session.pcInstalls?.items.map((i) => i.id).join() === '480,UE_5.4' &&
        !JSON.stringify(session.pcInstalls).includes(game),
      'session.json lists them by their place in the sandbox only',
    );

    t.section('detection of the new toolchains');
    // These toolchains are hidden until written (NOT_READY); their detection rules are tested as if they were ready.
    const hidden = [...NOT_READY.toolchains];
    (NOT_READY.toolchains as unknown as string[]).length = 0;
    const tc = structuredClone(DEFAULTS.toolchains);
    const decide = (entries: string[], hints = {}, settingsOf = tc) => decideToolchains(settingsOf, entries, [], hints);
    const godot = decide(['project.godot']);
    const steamApp = decide(['steam_appid.txt']);
    const unity = decide(['ProjectSettings/ProjectVersion.txt']);
    t.check(
      godot.godot.on && steamApp.steam.on && decide(['src/Main.kt']).java.on,
      'project.godot, steam_appid.txt and *.kt turn their toolchains on',
    );
    t.check(
      !unity.unity.on && unity.unity.reason.includes('toolchains.unity.acceptLicense'),
      'Unity is licensed: "auto" waits for acceptLicense and says so',
    );
    const flutter = decide([], { flutter: 'pubspec.yaml uses Flutter' });
    t.check(
      flutter.flutter.on &&
        !flutter.android.on &&
        flutter.android.reason.includes('Flutter') &&
        flutter.android.reason.includes('acceptLicense') &&
        !flutter.java.on,
      'Flutter would bring the Android SDK, but not before its licence is accepted (and no JDK then)',
    );
    const accepted = structuredClone(tc);
    accepted.android.acceptLicense = true;
    const flutterOk = decide([], { reactNative: 'package.json uses react-native' }, accepted);
    t.check(
      flutterOk.android.on && flutterOk.java.on && flutterOk.java.reason.includes('JDK'),
      'React Native brings the Android SDK, and the Android SDK a JDK',
    );
    const godotNet = structuredClone(tc);
    godotNet.godot.dotnet = true;
    t.check(decide(['project.godot'], {}, godotNet).dotnet.on, "Godot's .NET build brings .NET");
    const fivem = decide(['fxmanifest.lua']);
    t.check(!fivem.fivem.on && fivem.fivem.reason.includes('fivem.acceptLicense'), 'the FiveM server is licensed too');
    (NOT_READY.toolchains as unknown as string[]).push(...hidden);

    t.section('a project never accepts a licence or shares a sign-in');
    t.check(
      LICENSED_TOOLCHAINS.every((n) => OFF_IS_SAFER.includes('toolchains.' + n + '.acceptLicense')) &&
        OFF_IS_SAFER.includes('accounts.epic.share') &&
        OFF_IS_SAFER.includes('accounts.appstore.share'),
      'every acceptLicense and every share is a protection a project can only turn off',
    );
    const mine = structuredClone(DEFAULTS);
    const merged = applyOverrides(
      mine,
      normalizeOverrides(
        {
          toolchains: {
            unity: { acceptLicense: true },
            msvc: { acceptLicense: true },
            android: { acceptLicense: true },
          },
        },
        f.workA,
        'project',
      ),
    );
    t.check(
      !merged.toolchains.unity.acceptLicense &&
        !merged.toolchains.msvc.acceptLicense &&
        !merged.toolchains.android.acceptLicense,
      'a project asking to accept a licence leaves it unaccepted',
    );
  },
};
