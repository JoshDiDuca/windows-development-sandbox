// The Perplexity desktop app, a Microsoft Store package: the catalogue entry, the sign-in kind (sandbox only, like
// Comet), the package manifest, the PC's fetch and staging with a fake Store tool (no download, nothing run), the
// sandbox's check of the kept files and the shortcut's command line. Temp folders only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../core/config/index.js';
import { OFF_IS_SAFER } from '../core/local-config/index.js';
import { HOST_SOURCES } from '../host/accounts/index.js';
import { prepareStorePackages, stagedPackageDir, StorePackages, type StoreRunner } from '../host/apps/index.js';
import { prepareServiceAccounts } from '../host/accounts/index.js';
import { checkedPackage } from '../guest/apps/store-check.js';
import { peekPendingPerplexityApp, perplexityAppPendingFile } from '../guest/accounts/kinds/perplexityapp.js';
import { perplexityAppShortcutArgs, restoreAppSignIn } from '../guest/browser/perplexity-app.js';
import {
  appsToInstall,
  appById,
  isStorePackageFile,
  PERPLEXITY_DESKTOP_FAMILY,
  PERPLEXITY_DESKTOP_PACKAGE,
  PERPLEXITY_DESKTOP_PRODUCT_ID,
  assignStoreRoles,
  storeApps,
  StorePackageManifestSchema,
  storePackageFitsX64,
  storePackageRole,
} from '../shared/apps/index.js';
import {
  appsNeededFor,
  appUsersOn,
  PAYLOADS,
  SERVICE_SPECS,
  serviceWanted,
  usedByText,
  type UsedBy,
} from '../shared/accounts/index.js';
import type { Suite } from './support/suite.js';

const MAIN = 'PerplexityAI.PerplexityApp_1.2.3.0_x64__3jh4kjrg4dzr2.msix';
const FRAMEWORK = 'Microsoft.VCLibs.140.00_14.0.33519.0_x64__8wekyb3d8bbwe.appx';
const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

/** A fake Store tool: writes the given files into -OutDir and answers like get-store-package.ps1. */
function fakeStore(files: Record<string, string>, ok = true): { run: StoreRunner; calls: () => number } {
  let calls = 0;
  const run: StoreRunner = (_exe, args) => {
    calls++;
    if (!ok)
      return Promise.resolve({
        status: 0,
        stdout: JSON.stringify({ ok: false, message: 'no Store access', files: [] }),
        stderr: '',
      });
    const out = args[args.indexOf('-OutDir') + 1];
    fs.mkdirSync(out, { recursive: true });
    for (const [name, text] of Object.entries(files))
      if (path.basename(name) === name) fs.writeFileSync(path.join(out, name), text);
    return Promise.resolve({
      status: 0,
      stdout: 'progress\n' + JSON.stringify({ ok: true, message: 'ok', files: Object.keys(files) }),
      stderr: '',
    });
  };
  return { run, calls: () => calls };
}

export const storeAppSuite: Suite = {
  name: 'store-app',
  title: 'Perplexity desktop app: Store package fetched on the PC, installed in the sandbox, sign-in kept like Comet',
  run: async (t) => {
    t.section('the catalogue entry');
    const entry = appById('perplexity-desktop');
    t.check(
      entry !== undefined &&
        'store' in entry.source &&
        entry.source.store.productId === PERPLEXITY_DESKTOP_PRODUCT_ID &&
        entry.source.store.family === PERPLEXITY_DESKTOP_FAMILY &&
        PERPLEXITY_DESKTOP_FAMILY.startsWith(PERPLEXITY_DESKTOP_PACKAGE + '_') &&
        entry.userOnly === true,
      'a Store source with the product and the package family, yours only',
    );
    t.equal(
      storeApps(['rtk', 'perplexity-desktop']).map((a) => a.productId),
      ['9P9XG917PWCJ'],
      'only Store apps are fetched',
    );
    t.check(
      appsToInstall({ ...DEFAULTS.apps, install: ['perplexity-desktop'] }, 'none').entries.length === 1,
      'it needs no 7-Zip and no other app',
    );

    t.section('the sign-in kind');
    const spec = SERVICE_SPECS.perplexityapp;
    t.check(
      spec.sources.join() === 'sandbox' &&
        spec.returns &&
        !spec.singleHolder &&
        DEFAULTS.accounts.perplexityapp.share === false &&
        OFF_IS_SAFER.includes('accounts.perplexityapp.share') &&
        spec.warnings.some((w) => w.includes("can't be copied from this PC")),
      'only from a sandbox, handed back, not shared by default, a project file can only turn it off',
    );
    const source = HOST_SOURCES.perplexityapp;
    t.check(
      !source.fromPc && !source.fromFile && !source.fromAnswers,
      'nothing is read from this PC (the cookies are sealed to it)',
    );
    t.check(
      appUsersOn(['perplexity-desktop']).join() === 'perplexityapp' &&
        serviceWanted('perplexityapp', new Set<UsedBy>(['perplexityapp'])) &&
        !serviceWanted('perplexityapp', new Set<UsedBy>(['comet'])) &&
        usedByText(['perplexityapp']) === 'the Perplexity desktop app',
      'handed over only where the app is on',
    );
    const cookie = { name: 's', value: 'v', domain: '.perplexity.ai', path: '/', secure: true, httpOnly: true };
    t.check(
      PAYLOADS.perplexityapp.safeParse({ cookies: [cookie] }).success &&
        !PAYLOADS.perplexityapp.safeParse({ cookies: [{ ...cookie, domain: 'example.com' }] }).success,
      'the payload is the perplexity.ai cookie allow-list',
    );
    const pendingRoot = t.dir('pending');
    t.write(perplexityAppPendingFile(pendingRoot), JSON.stringify({ cookies: [cookie] }));
    t.check(peekPendingPerplexityApp(pendingRoot)?.cookies.length === 1, 'a waiting sign-in is read and left in place');
    t.write(perplexityAppPendingFile(pendingRoot), '{"cookies":[{"domain":"example.com"}]}');
    t.check(peekPendingPerplexityApp(pendingRoot) === null, 'one that is not the allow-listed shape is not used');
    t.check(
      !(await restoreAppSignIn({ cookies: [{ ...cookie, expires: 4_000_000_000 }] }, t.dir('no-app-profile'))),
      'with the app not running, nothing is written',
    );

    t.section('the package manifest');
    const file = (name: string, role: 'main' | 'dependency'): object => ({ name, role, sha256: sha(name), bytes: 10 });
    const manifest = (files: object[]): unknown => ({
      productId: '9P9XG917PWCJ',
      fetchedAt: '2026-01-01T00:00:00Z',
      files,
    });
    t.check(
      StorePackageManifestSchema.safeParse(manifest([file(MAIN, 'main'), file(FRAMEWORK, 'dependency')])).success &&
        !StorePackageManifestSchema.safeParse(manifest([file(FRAMEWORK, 'dependency')])).success &&
        !StorePackageManifestSchema.safeParse(
          manifest([file(MAIN, 'main'), file(MAIN.toUpperCase().replace('.MSIX', '.msix'), 'main')]),
        ).success &&
        !StorePackageManifestSchema.safeParse(manifest([file('..\\evil.msix', 'main')])).success &&
        !StorePackageManifestSchema.safeParse(manifest([file('x.exe', 'main')])).success,
      'exactly one app file, and only .msix/.appx names (no paths, no programs)',
    );
    t.check(
      storePackageRole(MAIN, PERPLEXITY_DESKTOP_PACKAGE) === 'main' &&
        storePackageRole(FRAMEWORK, PERPLEXITY_DESKTOP_PACKAGE) === 'dependency' &&
        isStorePackageFile(MAIN) &&
        !isStorePackageFile('a/b.msix'),
      'the app is told from its frameworks by name',
    );

    t.section('this PC fetches and stages the package');
    const storageRoot = t.dir('pc', 'storage');
    const dataPath = t.dir('pc', 'storage', 'data', 'set');
    const app = {
      id: 'perplexity-desktop',
      productId: PERPLEXITY_DESKTOP_PRODUCT_ID,
      packageName: PERPLEXITY_DESKTOP_PACKAGE,
    };
    const store = fakeStore({
      [MAIN]: 'app-bytes',
      [FRAMEWORK]: 'framework-bytes',
      '..evil.txt': 'x',
      '../escape.msix': 'x',
    });
    let now = Date.parse('2026-06-01T00:00:00Z');
    const packages = new StorePackages({ storageRoot, dataPath, run: store.run, now: () => now });
    const first = await packages.ensure(app);
    t.check(
      first.note === 'downloaded' &&
        first.manifest.files.length === 2 &&
        first.manifest.files.find((f) => f.role === 'main')?.sha256 === sha('app-bytes') &&
        packages.cached(app.productId) !== null &&
        !fs.existsSync(packages.cacheDir(app.productId) + '.new'),
      "the files are hashed here, not taken on the script's word; names that are not packages are ignored",
    );
    const second = await packages.ensure(app);
    t.check(store.calls() === 1 && second.note.startsWith('kept'), 'a fresh cache is not fetched again');
    const staged = packages.stage(app, first.manifest);
    t.check(
      staged === stagedPackageDir(dataPath, app.id) &&
        fs.readFileSync(path.join(staged, MAIN), 'utf8') === 'app-bytes' &&
        fs.existsSync(path.join(staged, 'store-package.json')),
      'the package is copied into the data folder with its manifest',
    );
    fs.writeFileSync(path.join(staged, 'stale.msix'), 'old');
    packages.stage(app, first.manifest);
    t.check(!fs.existsSync(path.join(staged, 'stale.msix')), 'a file the manifest does not list is removed');

    t.section('an old cache and a failing Store');
    now += 40 * 24 * 3600 * 1000;
    const failing = new StorePackages({ storageRoot, dataPath, run: fakeStore({}, false).run, now: () => now });
    const kept = await failing.ensure(app);
    t.check(
      kept.note.includes('could not be fetched') && kept.note.includes('no Store access'),
      'the old package stands, and says why',
    );
    const emptyRoot = t.dir('pc2', 'storage');
    const emptyData = t.dir('pc2', 'storage', 'data', 'set');
    const outcome = await prepareStorePackages([app], {
      storageRoot: emptyRoot,
      dataPath: emptyData,
      run: fakeStore({}, false).run,
    });
    t.check(
      outcome.notes.length === 1 &&
        outcome.notes[0].includes('NOT installed in this sandbox') &&
        outcome.notes[0].includes('no Store access') &&
        outcome.notes[0].startsWith('perplexity-desktop:') &&
        outcome.notes[0].includes('winget download --id 9P9XG917PWCJ'),
      'with nothing kept the launch goes on, with a note that says what to fix',
    );
    const good = await prepareStorePackages([app], {
      storageRoot: emptyRoot,
      dataPath: emptyData,
      run: fakeStore({ [MAIN]: 'a' }).run,
    });
    t.check(
      good.notes[0].includes('downloaded') && fs.existsSync(path.join(stagedPackageDir(emptyData, app.id), MAIN)),
      'and a working Store stages it',
    );

    t.section('frameworks: the right builds, and the app told from them');
    const VCLIBS_X86 = 'Microsoft.VCLibs.140.00_14.0.33519.0_x86__8wekyb3d8bbwe.appx';
    const VCLIBS_ARM = 'Microsoft.VCLibs.140.00_14.0.33519.0_arm64__8wekyb3d8bbwe.appx';
    t.check(
      storePackageFitsX64(FRAMEWORK) &&
        !storePackageFitsX64(VCLIBS_X86) &&
        !storePackageFitsX64(VCLIBS_ARM) &&
        storePackageFitsX64('Microsoft.WindowsAppRuntime.1.6_6000.311.0_neutral__8wekyb3d8bbwe.msix'),
      '32-bit and ARM frameworks are left out, x64 and neutral ones stay',
    );
    t.equal(
      assignStoreRoles(['Perplexity_x64.msixbundle', FRAMEWORK], PERPLEXITY_DESKTOP_PACKAGE, [FRAMEWORK]).map(
        (f) => f.role,
      ),
      ['main', 'dependency'],
      'an app winget names another way is still found: it is the file outside Dependencies',
    );
    t.check(
      (() => {
        try {
          assignStoreRoles([FRAMEWORK], PERPLEXITY_DESKTOP_PACKAGE, [FRAMEWORK]);
          return false;
        } catch (e) {
          return String(e).includes('only frameworks');
        }
      })(),
      'frameworks without the app are refused with a plain reason',
    );
    const rich = await new StorePackages({
      storageRoot: t.dir('pc3', 'storage'),
      dataPath: t.dir('pc3', 'storage', 'data', 'set'),
      run: (_exe, args) => {
        const out = args[args.indexOf('-OutDir') + 1];
        fs.mkdirSync(out, { recursive: true });
        for (const n of ['Perplexity_1.2_x64.msixbundle', FRAMEWORK, VCLIBS_X86, VCLIBS_ARM])
          fs.writeFileSync(path.join(out, n), n);
        return Promise.resolve({
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            message: 'ok',
            files: ['Perplexity_1.2_x64.msixbundle', FRAMEWORK, VCLIBS_X86, VCLIBS_ARM],
            dependencies: [FRAMEWORK, VCLIBS_X86, VCLIBS_ARM],
          }),
          stderr: '',
        });
      },
    }).fetch(app);
    t.check(
      rich.files.map((f) => f.role).join() === 'main,dependency' &&
        rich.files.every((f) => storePackageFitsX64(f.name)),
      'a fetch keeps the app and only the x64 framework, with the roles the script reported',
    );

    t.section('a sign-in for an app that is not installed says so');
    t.equal(appsNeededFor('perplexityapp'), ['perplexity-desktop'], 'the app a sign-in needs');
    t.equal(appsNeededFor('epic'), [], 'a sign-in a toolchain uses needs no app');
    const sharing = { ...DEFAULTS, accounts: { ...DEFAULTS.accounts, perplexityapp: { share: true } } };
    const deliverFor = (on: UsedBy[]): ReturnType<typeof prepareServiceAccounts> =>
      prepareServiceAccounts({
        config: sharing,
        others: [],
        on: new Set<UsedBy>(on),
        storageRoot: t.dir('pc4', 'storage'),
        dataPath: t.dir('pc4', 'storage', 'data', 'set'),
        launchId: 'L-1',
        isRunning: () => false,
      });
    const missing = deliverFor([]);
    t.check(
      missing.notes.some(
        (n) => n.includes('accounts.perplexityapp.share') && n.includes('Fix: turn the app on in Apps'),
      ) && !missing.leased.length,
      'share on with the app off: a launch note names the setting and the app to turn on',
    );
    t.check(
      !deliverFor(['perplexityapp']).notes.some((n) => n.includes('is not installed')),
      'with the app on there is no such note',
    );

    t.section('the sandbox checks the kept files');
    const checked = await checkedPackage(staged);
    t.check(
      path.basename(checked.main) === MAIN && checked.dependencies.map((d) => path.basename(d)).join() === FRAMEWORK,
      'the app and its frameworks, in order',
    );
    fs.writeFileSync(path.join(staged, FRAMEWORK), 'tampered');
    t.check(
      (await t.thrownMessage(() => checkedPackage(staged))).includes('missing or changed'),
      'a changed file stops the install',
    );
    t.check(
      (await t.thrownMessage(() => checkedPackage(t.dir('nothing')))).includes('did not hand over its package'),
      'no package says so',
    );

    t.section('the shortcut');
    const args = perplexityAppShortcutArgs(
      'C:\\AgentLaunch\\sandbox\\scripts\\start-store-app.ps1',
      'C:\\Users\\X\\profile',
    );
    t.check(
      args.includes('-File "C:\\AgentLaunch\\sandbox\\scripts\\start-store-app.ps1"') &&
        args.includes('-PackageName PerplexityAI.PerplexityApp') &&
        args.includes('-UserDataDir "C:\\Users\\X\\profile"') &&
        args.includes('-Port 0') &&
        args.includes('-WindowStyle Hidden'),
      'a hidden PowerShell start with the package, its own profile and a free DevTools port',
    );
  },
};
