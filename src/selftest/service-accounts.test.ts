// Service sign-ins for sandboxes (accounts.<kind>.share): the sealed store, the one-holder leases, which launch gets
// what (and only in the one-shot file), what a sandbox hands back and what is refused, forgetting everywhere, the
// bounded and BOM-aware readers, the Epic launcher's ini, the sandbox's watch, the `account` command line and the
// shared-core flows. Everything in temp folders with SecretStore.memory().
import fs from 'node:fs';
import path from 'node:path';
import {
  accountsView,
  importServiceFlow,
  loginServiceFlow,
  logoutServiceFlow,
  SERVICE_NAMES_TEXT,
  servicePage,
  serviceRow,
  type ServiceRow,
} from '../app/features/accounts/index.js';
import { fakeIO } from '../app/kernel/index.js';
import { buildProgram, parseCli } from '../cli/args.js';
import { COMMANDS } from '../cli/manifest.js';
import { pageLines } from '../cli/output/index.js';
import { DEFAULTS } from '../core/config/index.js';
import { applyOverrides, normalizeOverrides, type BootWant } from '../core/local-config/index.js';
import {
  AccountLeases,
  forgetEverywhere,
  handoffDir,
  HOST_SOURCES,
  prepareServiceAccounts,
  ServiceAccountStore,
  takeHandoffs,
} from '../host/accounts/index.js';
import { generateSandbox } from '../host/launch/index.js';
import { hostDataFolder } from '../host/storage/index.js';
import { clearSecrets, SecretStore } from '../host/secrets/index.js';
import { applyServiceAccounts, readDelivered } from '../guest/accounts/apply.js';
import type { GuestAdapter } from '../guest/accounts/adapter.js';
import { AccountWatch } from '../guest/accounts/watch.js';
import { epicAdapter } from '../guest/accounts/kinds/epic.js';
import {
  epicSettingsFile,
  epicSettingsFiles,
  fingerprint,
  readEpicLogin,
  SERVICE_KINDS,
  type ServiceKind,
  serviceWanted,
  withEpicLogin,
  type UsedBy,
} from '../shared/accounts/index.js';
import { RunDir } from '../shared/channel/index.js';
import type { SecretsFile } from '../shared/channel/secrets.js';
import { decodeText, encodeText, readBoundedFile } from '../shared/io/index.js';
import { isKindReady } from '../shared/readiness.js';
import type { Suite } from './support/suite.js';

const SIGN_IN = 'PlantedEpicSignIn' + 'AbCdEf0123456789+/'.repeat(6) + '==';
const RENEWED = 'PlantedRenewed' + 'ZyXw9876543210'.repeat(6);
const CFX = 'cfxk_PlantedServerKey_0123456789';
const INI = [
  '[Launcher]',
  'DefaultAppInstallLocation=C:\\Games',
  '',
  '[RememberMe]',
  'Enable=True',
  'Data=' + SIGN_IN,
  '',
  '[Offline]',
  'Data=keep-me',
  '',
].join('\r\n');

function allText(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'));
}

const UNREAL: ReadonlySet<UsedBy> = new Set<UsedBy>(['unreal']);
const notRunning = (): boolean => false;

export const serviceAccountsSuite: Suite = {
  name: 'service-accounts',
  title: 'service sign-ins: store, leases, delivery gates, handoffs, forgetting, readers, the watch, CLI and flows',
  run: async (t, f) => {
    t.section('the kinds');
    t.equal(
      SERVICE_NAMES_TEXT,
      SERVICE_KINDS.slice(0, -1).join(', ') + ' or ' + SERVICE_KINDS.at(-1),
      'the help names every kind',
    );
    t.check(
      SERVICE_KINDS.every((k) => DEFAULTS.accounts[k].share === false),
      'no sign-in is shared by default',
    );
    t.check(
      serviceWanted('epic', UNREAL) &&
        !serviceWanted('epic', new Set<UsedBy>(['steam'])) &&
        serviceWanted('keystore', new Set<UsedBy>(['flutter'])) &&
        serviceWanted('keystore', new Set<UsedBy>(['unity'])) &&
        !serviceWanted('cfx', new Set<UsedBy>(['android'])),
      'a sign-in is wanted only by its toolchains (Flutter, React Native, Godot and Unity build for Android)',
    );

    t.section("the Epic launcher's settings file");
    t.equal(readEpicLogin(INI), { data: SIGN_IN }, 'the sign-in is read from [RememberMe] only');
    t.equal(readEpicLogin(INI.replace('Enable=True', 'Enable=False')), null, 'a turned-off "Remember me" is none');
    t.equal(readEpicLogin(INI.replace(SIGN_IN, 'not base64 !')), null, 'a value of the wrong shape is refused');
    t.equal(readEpicLogin('[Launcher]\r\nData=' + SIGN_IN), null, 'a Data line in another section is not the sign-in');
    const written = withEpicLogin(INI, { data: RENEWED });
    t.check(
      readEpicLogin(written)?.data === RENEWED &&
        !written.includes(SIGN_IN) &&
        written.includes('DefaultAppInstallLocation=C:\\Games') &&
        written.includes('Data=keep-me') &&
        written.split('[RememberMe]').length === 2,
      'writing replaces only [RememberMe] and keeps the other sections',
    );

    t.section('bounded and BOM-aware reading');
    const utf16 = encodeText(INI, 'utf16le');
    const decoded = decodeText(utf16);
    t.check(
      decoded.encoding === 'utf16le' &&
        decoded.text === INI &&
        encodeText(decoded.text, decoded.encoding).equals(utf16) &&
        decodeText(encodeText('x', 'utf8bom')).text === 'x' &&
        decodeText(Buffer.from('plain')).encoding === 'utf8',
      'UTF-16LE and UTF-8 (with or without a mark) round-trip in the encoding they were read in',
    );
    const grows = t.write(t.at('bounded', 'grows.txt'), 'x'.repeat(100));
    t.check(readBoundedFile(grows, 100)?.length === 100, 'a file within the bound is read');
    t.check(readBoundedFile(grows, 99) === null, 'a file over the bound is not read');
    t.check(
      readBoundedFile(grows, 120, { afterStat: () => fs.appendFileSync(grows, 'y'.repeat(50)) }) === null,
      'a file that grows past the bound between the size check and the read is still refused',
    );
    t.check(readBoundedFile(t.at('bounded', 'missing.txt'), 10) === null, 'a missing file reads as nothing');

    t.section('the sealed store');
    const storage = t.dir('svc-storage');
    const store = new ServiceAccountStore(storage, SecretStore.memory());
    t.check(store.state('epic') === 'none' && store.info('epic') === null, 'nothing is saved at first');
    store.save('epic', { data: SIGN_IN }, 'pc');
    const file = path.join(storage, 'accounts', 'epic.json');
    t.check(
      store.state('epic') === 'saved' && !fs.readFileSync(file, 'utf8').includes(SIGN_IN),
      'it is saved sealed: the sign-in is not in the file',
    );
    t.equal(store.read('epic'), { data: SIGN_IN }, 'and it opens for the launch');
    t.equal(store.info('epic')?.source, 'pc', 'where it came from is kept');
    await t.throws(
      () => store.save('cfx', { licenseKey: 'not a key' } as never, 'typed'),
      '',
      'a payload of the wrong shape is refused',
    );
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"sealed": "[^"]*"/, '"sealed": "dpapi1:AAAA"'));
    t.check(store.state('epic') === 'unreadable', 'a sign-in this Windows user cannot open is reported as unreadable');
    t.check(
      store.remove('epic') && store.state('epic') === 'none' && !store.remove('epic'),
      'removing deletes it (once)',
    );

    t.section('leases');
    const leases = new AccountLeases(t.dir('svc-leases'));
    t.equal(leases.claim('steam', 'default', 'L1', null, notRunning), { ok: true }, 'a free lease is claimed');
    t.equal(
      leases.claim('steam', 'other', 'L2', null, (set) => set === 'default'),
      { ok: false, heldBy: 'default' },
      'one holder: another data set is refused while its sandbox runs',
    );
    t.equal(leases.claim('steam', 'other', 'L3', null, notRunning), { ok: true }, 'a stale lease is taken over');
    t.equal(leases.holder('steam')?.launchId, 'L3', 'and names the new launch');
    leases.releaseAll('other');
    t.equal(leases.holder('steam'), null, 'releasing a data set lets go of its leases');

    t.section('which launch gets what');
    const config = f.makeConfig();
    const root = config.storage.root;
    const signIns = new ServiceAccountStore(root, SecretStore.memory());
    const launchLeases = new AccountLeases(root);
    const run = await f.run({}, config);
    const deliver = (over: Partial<Parameters<typeof prepareServiceAccounts>[0]> = {}) =>
      prepareServiceAccounts({
        config,
        others: [],
        on: UNREAL,
        storageRoot: root,
        dataPath: run.dataPath,
        launchId: 'L-boot',
        isRunning: notRunning,
        store: signIns,
        leases: launchLeases,
        ...over,
      });
    signIns.save('epic', { data: SIGN_IN }, 'pc');
    signIns.save('cfx', { licenseKey: CFX }, 'typed');
    t.equal(deliver().payloads, {}, 'share off: nothing is handed over');
    config.accounts.epic.share = true;
    config.accounts.cfx.share = true;
    t.equal(
      Object.keys(deliver({ on: new Set<UsedBy>(['steam']) }).payloads),
      [],
      'no toolchain that uses it: nothing',
    );
    const other: BootWant = { name: 'mod-pack', config: structuredClone(config) };
    other.config.accounts.epic.share = false;
    const tightened = deliver({ others: [other] });
    t.check(
      !tightened.payloads.epic && tightened.notes.some((n) => n.includes('mod-pack')),
      'another project in the boot that turns it off keeps it out (and it says which)',
    );
    const both = deliver({ on: new Set<UsedBy>(['unreal', 'fivem']) });
    t.check(
      both.payloads.epic?.data === SIGN_IN &&
        both.payloads.cfx?.licenseKey === CFX &&
        both.leased.includes('epic') &&
        !both.leased.includes('cfx') &&
        !both.notes.join(' ').includes(SIGN_IN) &&
        !both.notes.join(' ').includes(CFX),
      'shared and used: handed over, one-holder kinds leased; the notes never hold a secret',
    );
    const busy = deliver({ isRunning: () => true, dataPath: path.join(root, 'data', 'busy') });
    t.check(
      busy.payloads.epic === undefined && busy.notes.some((n) => n.includes('in use by sandbox')),
      'held by another running sandbox: not handed over, and it says so',
    );
    signIns.remove('epic');
    const first = deliver();
    t.check(
      !first.payloads.epic && first.leased.includes('epic') && launchLeases.holder('epic')?.launchId === 'L-boot',
      'nothing saved yet: the lease is claimed anyway, so a first sign-in made there can come back',
    );
    const pcLocal = t.dir('svc-pc-local');
    for (const file of epicSettingsFiles(pcLocal)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, INI);
    }
    const thisPc = { localAppData: pcLocal, appData: t.dir('svc-pc-roaming'), programData: t.dir('svc-pc-data') };
    signIns.remove('epic');
    const fromPc = deliver({ pc: thisPc });
    t.check(
      fromPc.payloads.epic?.data === SIGN_IN && signIns.info('epic')?.source === 'pc',
      "shared with nothing saved: this PC's own sign-in is taken and saved, as import would",
    );
    for (const file of epicSettingsFiles(pcLocal)) fs.writeFileSync(file, INI.replace(SIGN_IN, RENEWED));
    t.check(
      deliver({ pc: thisPc }).payloads.epic?.data === RENEWED && signIns.read('epic')?.data === RENEWED,
      "one taken from this PC follows it: the PC's renewed sign-in replaces the stale copy",
    );
    signIns.save('epic', { data: SIGN_IN }, 'sandbox');
    t.check(
      deliver({ pc: thisPc }).payloads.epic?.data === SIGN_IN && signIns.info('epic')?.source === 'sandbox',
      'one a sandbox handed back is newer than the PC’s and is kept',
    );
    signIns.remove('epic');
    t.check(!deliver().payloads.epic, 'without this PC (pc left out) nothing is taken');
    const sharedRun = await f.run({}, config);
    const launched = generateSandbox({
      packageRoot: t.packageRoot,
      run: sharedRun,
      harnessArgs: [],
      probe: f.probe,
      pcLanguages: [],
      serviceAccounts: { epic: { data: RENEWED }, cfx: { licenseKey: CFX } },
      accountLeases: ['epic'],
    });
    t.check(
      !allText(launched.launchPath).some((text) => text.includes(RENEWED) || text.includes(CFX)),
      'the sign-ins are in neither session.json nor any file of the launch folder',
    );
    t.equal(
      f.readJson<{ accountLeases?: string[] }>(launched.sessionPath).accountLeases,
      ['epic'],
      'session.json names the leased kinds only',
    );
    const secrets = f.readJson<SecretsFile>(new RunDir(sharedRun.dataPath).secretFile(launched.launchId));
    t.check(
      secrets.serviceAccounts?.epic?.data === RENEWED && secrets.serviceAccounts?.cfx?.licenseKey === CFX,
      'they are only in the one-shot file for the sandbox',
    );
    clearSecrets(root, sharedRun.dataPath);
    const offConfig = structuredClone(config);
    offConfig.accounts.epic.share = false;
    const offRun = await f.run({}, offConfig);
    const off = generateSandbox({
      packageRoot: t.packageRoot,
      run: offRun,
      harnessArgs: [],
      probe: f.probe,
      pcLanguages: [],
      serviceAccounts: { epic: { data: RENEWED } },
    });
    const offFile = new RunDir(offRun.dataPath).secretFile(off.launchId);
    t.check(
      !fs.existsSync(offFile) || f.readJson<SecretsFile>(offFile).serviceAccounts?.epic === undefined,
      'generateSandbox checks again: a kind that is not shared is never handed over',
    );
    clearSecrets(root, offRun.dataPath);

    t.section('a project file can only turn sharing off');
    const mine = structuredClone(DEFAULTS);
    t.check(
      applyOverrides(mine, normalizeOverrides({ accounts: { epic: { share: true } } }, f.workA, 'x')).accounts.epic
        .share === false,
      'a project asking for a sign-in leaves it off',
    );
    const shared = structuredClone(DEFAULTS);
    shared.accounts.steam.share = true;
    t.check(
      applyOverrides(shared, normalizeOverrides({ accounts: { steam: { share: false } } }, f.workA, 'x')).accounts.steam
        .share === false,
      'and it may turn one off',
    );

    t.section('what a sandbox hands back');
    const dataPath = run.dataPath;
    const handoffs = handoffDir(dataPath);
    t.equal(
      handoffs,
      path.join(hostDataFolder(dataPath, 'state'), 'accounts'),
      'handoffs are found where the state folder is (contained storage too)',
    );
    const handoff = (kind: string): string => path.join(handoffs, kind + '.json');
    const back = new ServiceAccountStore(root, SecretStore.memory());
    t.write(handoff('epic'), JSON.stringify({ kind: 'epic', launchId: 'L-boot', payload: { data: RENEWED } }));
    t.write(
      handoff('steam'),
      JSON.stringify({ kind: 'steam', launchId: 'L-boot', payload: { account: 'me', configVdf: 'x', sentries: [] } }),
    );
    const took = takeHandoffs(dataPath, false, back, launchLeases);
    t.check(
      took.taken.includes('epic') && back.read('epic')?.data === RENEWED && back.info('epic')?.source === 'sandbox',
      'a renewed sign-in of the leased launch is sealed into the store',
    );
    t.check(
      took.dropped.includes('steam') && back.state('steam') === 'none' && !fs.existsSync(handoff('steam')),
      'one without a lease for this data set is dropped unsealed',
    );
    t.check(!fs.existsSync(handoff('epic')), 'and the plain copy is deleted');
    t.write(handoff('epic'), JSON.stringify({ kind: 'epic', launchId: 'L-other', payload: { data: SIGN_IN } }));
    t.check(
      takeHandoffs(dataPath, false, back, launchLeases).dropped.includes('epic') && back.read('epic')?.data === RENEWED,
      'one from another launch is dropped',
    );
    t.write(handoff('epic'), '{"kind":"epic","launchId":"L-boot","payload":{"data":"' + 'A'.repeat(80 * 1024) + '"}}');
    t.check(
      takeHandoffs(dataPath, false, back, launchLeases).dropped.includes('epic') && !fs.existsSync(handoff('epic')),
      'an oversized copy is never read',
    );
    t.write(handoff('epic'), '{"kind":"epic","launchId":"L-boot","payload":{"data":"not base64 !"}}');
    t.check(
      takeHandoffs(dataPath, false, back, launchLeases).dropped.includes('epic') && back.read('epic')?.data === RENEWED,
      'a damaged copy is dropped and the saved one stays',
    );
    fs.rmSync(handoffs, { recursive: true, force: true });
    const victim = t.dir('svc-victim');
    t.write(
      path.join(victim, 'epic.json'),
      JSON.stringify({ kind: 'epic', launchId: 'L-boot', payload: { data: SIGN_IN } }),
    );
    fs.mkdirSync(path.dirname(handoffs), { recursive: true });
    fs.symlinkSync(victim, handoffs, 'junction');
    const linked = takeHandoffs(dataPath, false, back, launchLeases);
    t.check(
      linked.dropped.includes('epic') &&
        back.read('epic')?.data === RENEWED &&
        fs.existsSync(path.join(victim, 'epic.json')),
      'through a planted junction nothing is taken and nothing behind it is deleted',
    );
    fs.rmdirSync(handoffs);
    takeHandoffs(dataPath, true, back, launchLeases);
    t.check(launchLeases.holder('epic') === null, "the sandbox's last sync releases its leases");

    t.section('forgetting everywhere');
    launchLeases.claim('epic', path.basename(dataPath), 'L-boot', null, notRunning);
    t.write(handoff('epic'), JSON.stringify({ kind: 'epic', launchId: 'L-boot', payload: { data: SIGN_IN } }));
    const forgot = forgetEverywhere('epic', root, back, launchLeases);
    t.check(
      forgot.removed &&
        forgot.pendingDeleted === 1 &&
        back.state('epic') === 'none' &&
        launchLeases.holder('epic') === null &&
        !fs.existsSync(handoff('epic')),
      'the saved one, its lease and the copy a sandbox left are gone',
    );

    t.section('in the sandbox');
    const guestRoot = t.dir('svc-guest');
    const fake = { held: null as { data: string } | null, released: 0 };
    const fakeEpic: GuestAdapter<'epic'> = {
      kind: 'epic',
      apply: (p) => {
        fake.held = p;
        return { summary: 'fake epic', env: { FAKE_EPIC: '1' } };
      },
      current: () => fake.held,
      release: () => {
        fake.released++;
      },
    };
    const env = await applyServiceAccounts(
      { epic: { data: SIGN_IN } },
      { leased: ['epic'], root: guestRoot, adapters: { epic: fakeEpic } },
    );
    const delivered = readDelivered(guestRoot);
    t.check(
      env.FAKE_EPIC === '1' &&
        delivered.leased.includes('epic') &&
        delivered.fingerprints.epic === fingerprint({ data: SIGN_IN }) &&
        !fs.readFileSync(path.join(guestRoot, 'delivered.json'), 'utf8').includes(SIGN_IN),
      'boot applies each sign-in and remembers only its fingerprint and the leased kinds',
    );
    const guestData = t.dir('svc-guest-data');
    const watch = new AccountWatch(['epic', 'cfx'], {
      dataDir: guestData,
      launchId: 'L-boot',
      root: guestRoot,
      adapters: { epic: fakeEpic },
    });
    const guestHandoff = path.join(guestData, 'state', 'accounts', 'epic.json');
    t.check(watch.watched().join() === 'epic', 'only kinds that come back are watched');
    t.check(
      !watch.check('epic') && !fs.existsSync(guestHandoff),
      'the first look writes nothing (it is what was delivered)',
    );
    fake.held = { data: RENEWED };
    await watch.flush();
    t.check(
      fs.existsSync(guestHandoff) &&
        f.readJson<{ payload: { data: string }; launchId: string }>(guestHandoff).payload.data === RENEWED,
      'a renewed one is left for the PC at the next flush, with its launch',
    );
    fs.rmSync(guestHandoff);
    t.check(!watch.check('epic'), 'and only once');
    await watch.flush(true);
    t.equal(fake.released, 1, 'the last flush lets go of what is held');
    const oldLocal = process.env.LOCALAPPDATA;
    const local = t.dir('svc-local');
    process.env.LOCALAPPDATA = local;
    try {
      t.write(epicSettingsFile(local), '');
      fs.writeFileSync(epicSettingsFile(local), encodeText(INI.replace(SIGN_IN, RENEWED), 'utf16le'));
      await epicAdapter.apply({ data: SIGN_IN });
      const after = decodeText(fs.readFileSync(epicSettingsFile(local)));
      t.check(
        after.encoding === 'utf16le' &&
          readEpicLogin(after.text)?.data === SIGN_IN &&
          epicAdapter.current?.()?.data === SIGN_IN,
        "the Epic launcher's UTF-16 file gets the sign-in and stays UTF-16",
      );
    } finally {
      if (oldLocal === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = oldLocal;
    }

    t.section('the account command');
    t.check(!COMMANDS.some((c) => ['epic', 'steam'].includes(c.name)), 'no command of its own for a service');
    const account = buildProgram(() => undefined).commands.find((c) => c.name() === 'account')!;
    const help = account.helpInformation();
    t.check(
      ['status', 'import', 'login', 'logout', '--from', '--yes'].every((w) => help.includes(w)),
      'sandbox account --help lists status, import, login, logout, --from and --yes',
      help,
    );
    const parsed = parseCli(['account', 'import', 'steam', '--from', 'C:\\steamcmd', '--yes']);
    t.check(
      parsed.command === 'account' &&
        parsed.positionals.join() === 'import,steam' &&
        parsed.yes &&
        parsed.raw.from === 'C:\\steamcmd',
      'sandbox account import steam --from <folder> --yes parses',
    );

    t.section('the shared-core flows');
    const pc = { localAppData: t.dir('svc-pc'), appData: '', programData: '' };
    t.write(epicSettingsFile(pc.localAppData), INI);
    const flowStore = new ServiceAccountStore(t.dir('svc-flow'), SecretStore.memory());
    await t.throws(
      () => importServiceFlow(fakeIO([false]).io, 'epic', undefined, { store: flowStore, pc, share: false }),
      '',
      'saying no takes nothing',
    );
    t.check(flowStore.state('epic') === 'none', 'and nothing is saved');
    const { io: yesIO, seen } = fakeIO([true]);
    const taken = await importServiceFlow(yesIO, 'epic', undefined, { store: flowStore, pc, share: false });
    const asked = seen.questions[0] as { kind: string; implied?: boolean; lines?: string[] };
    t.check(
      flowStore.state('epic') === 'saved' &&
        asked.kind === 'confirm' &&
        asked.implied !== true &&
        JSON.stringify(asked).includes('signs the launcher on this PC out') &&
        !JSON.stringify(seen).includes(SIGN_IN) &&
        !taken.message.includes(SIGN_IN) &&
        taken.message.includes('Share with sandboxes'),
      'importing asks first (the command line too: --yes answers it), warns the PC is signed out, never shows the sign-in',
    );
    const empty = await importServiceFlow(fakeIO([true]).io, 'epic', undefined, {
      store: flowStore,
      pc: { ...pc, localAppData: t.dir('svc-pc-empty') },
      share: true,
    });
    t.check(empty.message.includes('No saved'), 'no launcher sign-in on this PC: it says so');
    await t.throws(
      () => loginServiceFlow(fakeIO([]).io, 'epic', { store: flowStore, share: true }),
      'nothing to type',
      'Epic has nothing to type',
    );
    const typed = await loginServiceFlow(fakeIO([CFX, '']).io, 'cfx', { store: flowStore, share: true });
    t.check(
      flowStore.read('cfx')?.licenseKey === CFX && !typed.message.includes(CFX),
      'a typed kind (the Cfx.re key) is saved from what you type, and never shown back',
    );
    t.check(
      Boolean(HOST_SOURCES.epic.fromPc) && !HOST_SOURCES.epic.fromAnswers,
      'Epic comes from this PC (or a sandbox), never typed',
    );
    const gone = await logoutServiceFlow(
      fakeIO([true]).io,
      'epic',
      t.dir('svc-flow-root'),
      flowStore,
      new AccountLeases(t.dir('svc-flow-root')),
    );
    t.check(gone.deleted && flowStore.state('epic') === 'none', 'forgetting deletes it after asking');

    t.section('the accounts page');
    const row = serviceRow(
      'epic',
      { ...config, accounts: { ...config.accounts, epic: { share: true } } },
      signIns,
      launchLeases,
    );
    const lines = pageLines(servicePage(row)).join('\n');
    t.check(
      lines.includes('Epic Games') &&
        servicePage(row).sections[0].facts?.some((f) => f.description === 'The agent can use it.') === true &&
        !lines.includes(SIGN_IN),
      'a service shows its state and one short warning, never the sign-in',
    );
    t.check(
      Object.values(accountsView.queries).some((q) => q.id === 'accounts.services') &&
        ['accounts.service.import', 'accounts.service.login', 'accounts.service.logout', 'settings.set'].every((id) =>
          accountsView.operations.some((o) => o.id === id),
        ),
      'the accounts view offers the services and their actions on every surface',
    );

    t.section('every action a service page shows works from the menu');
    const shareOn = { ...config, accounts: { ...config.accounts, perplexity: { share: true } } };
    const pcFound = { localAppData: t.dir('svc-pc-found'), appData: '', programData: '', env: {} };
    t.write(epicSettingsFile(pcFound.localAppData), INI);
    const pcNone = { localAppData: t.dir('svc-pc-none'), appData: '', programData: '', env: {} };
    const pageStore = new ServiceAccountStore(t.dir('svc-page'), SecretStore.memory());
    const pageLeases = new AccountLeases(t.dir('svc-page-leases'));
    const rowOn = (kind: ServiceKind, pc: typeof pcFound | undefined, c = config): ServiceRow =>
      serviceRow(kind, c, pageStore, pageLeases, pc);
    const labelsOf = (row: ServiceRow): string[] => servicePage(row).sections[0].actions!.map((a) => a.label);

    const descriptionsOf = (r: ServiceRow): string =>
      (servicePage(r).sections[0].facts ?? []).map((f) => ' ' + (f.description ?? '')).join('');
    const epicFound = rowOn('epic', pcFound);
    const epicText = pageLines(servicePage(epicFound)).join('\n') + descriptionsOf(epicFound);
    t.check(
      epicFound.onPc === true &&
        /On this PC\s+found/.test(epicText) &&
        epicText.includes("takes this PC's") &&
        !epicText.includes(SIGN_IN),
      'a kind that comes from this PC says it is found there (never the sign-in), and what sharing does',
    );
    t.check(
      rowOn('epic', pcNone).onPc === false &&
        /On this PC\s+not found/.test(pageLines(servicePage(rowOn('epic', pcNone))).join('\n')),
      'and says not found when this PC has none',
    );
    t.check(
      labelsOf(epicFound).includes("Take this PC's sign-in") &&
        !labelsOf(epicFound).some((l) => l.startsWith('Import…')),
      'taking it from this PC has a plain name',
    );
    const perplexityLabels = labelsOf(rowOn('perplexity', pcFound, shareOn));
    t.check(
      perplexityLabels.includes("Take this PC's sign-in") &&
        perplexityLabels.includes('Import from a file…') &&
        perplexityLabels.includes('Type the sign-in…'),
      'the API key can be taken from this PC, read from a file or typed',
    );
    const cometRow = rowOn('comet', pcFound);
    const cometText = pageLines(servicePage(cometRow)).join('\n') + descriptionsOf(cometRow);
    t.check(
      cometRow.onPc === null &&
        cometRow.sandboxOnly &&
        labelsOf(cometRow).every((l) => l === 'Share with sandboxes') &&
        cometText.includes('Sign in once inside a sandbox; it is kept for the next ones.'),
      'Comet offers only sharing and says plainly to sign in once inside a sandbox',
    );

    // Every action a page shows is one its kind can do (import: a PC or file way; sign in: a typed way).
    for (const kind of SERVICE_KINDS.filter(isKindReady)) {
      const r = rowOn(kind, pcFound);
      for (const a of servicePage(r).sections[0].actions ?? []) {
        if (a.kind !== 'operation') continue;
        const src = HOST_SOURCES[kind];
        const ok =
          a.op === 'accounts.service.import'
            ? Boolean(src.fromPc || src.fromFile)
            : a.op === 'accounts.service.login'
              ? Boolean(src.fromAnswers)
              : ['accounts.service.logout', 'settings.set'].includes(a.op);
        t.check(ok, kind + ': "' + a.label + '" is something this kind can do');
      }
    }

    // The paths themselves, through the menu's questions (fakeIO): a file, typed, forgotten.
    const envFile = t.write(t.at('svc-page', 'keys.env'), 'PERPLEXITY_API_KEY=pplx-PlantedKey0123456789\n');
    const fileIO = fakeIO([envFile, true]);
    const fromFile = await importServiceFlow(
      fileIO.io,
      'perplexity',
      undefined,
      { store: pageStore, pc: pcNone, share: true },
      true,
    );
    t.check(
      pageStore.info('perplexity')?.source === 'file' &&
        fileIO.seen.questions[0].kind === 'path' &&
        !fromFile.message.includes('PlantedKey'),
      'Import from a file asks for the file even when this PC could give one, and saves it',
    );
    await logoutServiceFlow(fakeIO([true]).io, 'perplexity', t.dir('svc-page-root'), pageStore, pageLeases);
    const pcWithKey = { ...pcNone, env: { PERPLEXITY_API_KEY: 'pplx-FromThisPc0123456789' } };
    const keyRow = rowOn('perplexity', pcWithKey);
    t.check(keyRow.onPc === true, 'the API key in this terminal is found on this PC');
    await importServiceFlow(fakeIO([true]).io, 'perplexity', undefined, {
      store: pageStore,
      pc: pcWithKey,
      share: true,
    });
    t.check(pageStore.info('perplexity')?.source === 'pc', "Take this PC's sign-in saves the PC's key");
    await loginServiceFlow(fakeIO(['pplx-Typed0123456789']).io, 'perplexity', { store: pageStore, share: true });
    t.check(pageStore.info('perplexity')?.source === 'typed', 'Type the sign-in saves what was typed');
    const savedRow = rowOn('perplexity', pcWithKey);
    t.check(labelsOf(savedRow).includes('Forget…') && savedRow.state === 'saved', 'a saved sign-in offers Forget');
    await t.throws(
      () => importServiceFlow(fakeIO([true]).io, 'comet', undefined, { store: pageStore, pc: pcWithKey, share: true }),
      'inside a sandbox',
      'Comet has nothing to import: the error says to sign in inside a sandbox',
    );
  },
};
