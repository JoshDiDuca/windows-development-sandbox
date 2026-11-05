// Unity licence and sign-in: the host source (a fake ProgramData and LocalAppData in temp folders), the guest adapter
// (apply and read back, release with an injected runner) and the Accounts page. Nothing real is read or run.
import path from 'node:path';
import { serviceRow, servicePage } from '../app/features/accounts/index.js';
import { pageLines } from '../cli/output/index.js';
import { AccountLeases, HOST_SOURCES, ServiceAccountStore } from '../host/accounts/index.js';
import { unitySource } from '../host/accounts/kinds/unity.js';
import { SecretStore } from '../host/secrets/index.js';
import {
  serviceWanted,
  unityEntitlementFile,
  unityUlfFile,
  type UsedBy,
  type UnityPayload,
} from '../shared/accounts/index.js';
import { activateUnityLicence, unityAdapterFor, type UnityRunner } from '../guest/accounts/kinds/unity.js';
import type { Suite } from './support/suite.js';

const ULF = '<?xml version="1.0"?><root><License id="Terms"><SerialMasked Value="U3-XXXX-XXXX"/></License></root>';
const ENTITLEMENT = '<?xml version="1.0"?><Entitlement><Id>abc</Id></Entitlement>';
const PASSWORD = 'hunter2-unity-pw';
const SERIAL = 'E3-AAAA-BBBB-CCCC-DDDD-EEEE';

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return String((e as Error).message);
  }
  return '';
}

export const unityAccountsSuite: Suite = {
  name: 'unity-accounts',
  title: 'Unity licence and sign-in',
  run: async (t, f) => {
    t.section('the host source');
    const pcDir = t.dir('unity-pc');
    const pc = {
      programData: path.join(pcDir, 'ProgramData'),
      localAppData: path.join(pcDir, 'Local'),
      appData: path.join(pcDir, 'Roaming'),
    };
    t.check(unitySource.fromPc!(pc) === null, 'a PC with no Unity licence gives nothing');
    t.write(unityUlfFile(pc.programData), ULF);
    t.write(unityEntitlementFile(pc.localAppData), ENTITLEMENT);
    const fromPc = unitySource.fromPc!(pc);
    t.check(fromPc?.ulf === ULF && fromPc.entitlement === ENTITLEMENT, 'the PC licence and entitlement are read');
    const other = t.dir('unity-other');
    t.write(unityUlfFile(other), ULF);
    t.check(
      unitySource.fromPc!({ ...pc, localAppData: '' }, other)?.ulf === ULF,
      '--from names another ProgramData folder',
    );
    const virtual = t.dir('unity-virtual');
    t.write(path.join(virtual, 'VirtualStore', 'ProgramData', 'Unity', 'Unity_lic.ulf'), ULF);
    t.check(
      unitySource.fromPc!({ programData: path.join(virtual, 'none'), localAppData: virtual, appData: '' })?.ulf === ULF,
      'the VirtualStore copy is the fallback',
    );

    const refusal = message(() => unitySource.fromFile!(Buffer.from('hello'), {}));
    t.check(
      refusal.includes('That is not a Unity licence file (Unity_lic.ulf) or entitlement file.'),
      'a file that is not a licence is refused with the plain text',
      refusal,
    );
    const ulfPayload = unitySource.fromFile!(Buffer.from(ULF), { email: 'me@example.com' });
    const entPayload = unitySource.fromFile!(Buffer.from(ENTITLEMENT), {});
    t.check(
      ulfPayload.ulf === ULF && ulfPayload.email === 'me@example.com' && entPayload.entitlement === ENTITLEMENT,
      'a ULF becomes ulf, an Entitlement file becomes entitlement, answers are added',
    );
    t.check(
      message(() => unitySource.fromAnswers!({ serial: SERIAL, email: 'me@example.com' })).includes(
        'A serial needs your Unity ID email and password.',
      ),
      'a serial without email and password is refused',
    );
    const typed = unitySource.fromAnswers!({ email: 'me@example.com', password: PASSWORD, serial: SERIAL });
    t.check(
      typed.email === 'me@example.com' && typed.password === PASSWORD && typed.serial === SERIAL,
      'typed answers',
    );
    const summary = unitySource.summary(typed) ?? '';
    t.check(!summary.includes(PASSWORD) && !summary.includes(SERIAL), 'the summary never holds a secret');

    t.section('the guest adapter');
    const runs: string[] = [];
    const run: UnityRunner = (file, args) => {
      runs.push(file + ' ' + args.join(' '));
      return Promise.resolve({ code: 0, stdout: '{"status":"active","type":"Personal"}' });
    };
    const dirs = {
      programData: t.dir('unity-guest-pd'),
      localAppData: t.dir('unity-guest-local'),
      secrets: t.dir('unity-guest-secrets'),
    };
    const adapter = unityAdapterFor(dirs, run);
    t.check(adapter.current!() === null, 'nothing is held at first');
    const payload: UnityPayload = { ulf: ULF, entitlement: ENTITLEMENT, email: 'me@example.com', password: PASSWORD };
    const applied = await adapter.apply(payload);
    const back = adapter.current!();
    t.check(
      back?.ulf === ULF &&
        back.entitlement === ENTITLEMENT &&
        back.email === 'me@example.com' &&
        back.password === PASSWORD,
      'apply then current keeps the licence files and the password',
    );
    t.check(!applied.summary.includes(PASSWORD) && !applied.summary.includes('me@example.com'), 'the summary is safe');
    await adapter.release!();
    t.check(runs.length === 0, 'release without activated.json runs nothing');

    const serialDirs = { ...dirs, secrets: t.dir('unity-guest-secrets2') };
    const serialRuns: string[] = [];
    const record: UnityRunner = (file, args, o) => {
      serialRuns.push(file + ' ' + args.join(' '));
      return run(file, args, o);
    };
    const serialAdapter = unityAdapterFor(serialDirs, record);
    await serialAdapter.apply({ email: 'me@example.com', password: PASSWORD, serial: SERIAL });
    const licence = await activateUnityLicence(
      { editorExe: 'C:\\Editor\\Unity.exe', unityExe: 'C:\\Cli\\unity.exe' },
      serialDirs,
      record,
    );
    t.check(
      serialRuns[0].includes('-serial') && serialRuns[0].includes('activate.log') && licence.state === 'active',
      'a serial is activated with the editor, then the licence status is read',
    );
    t.check(
      !JSON.stringify(licence).includes(PASSWORD) && !JSON.stringify(licence).includes(SERIAL),
      'the licence status holds no secret',
    );
    await serialAdapter.release!();
    t.check(
      serialRuns.some((r) => r.includes('-returnlicense') && r.includes('return.log')),
      'release returns the seat once activated.json exists',
    );
    const noLicence: UnityRunner = () => Promise.resolve({ code: 0, stdout: '{"licenses":[]}' });
    const none = await activateUnityLicence(
      { editorExe: null, unityExe: 'C:\\Cli\\unity.exe' },
      { programData: t.dir('unity-empty-pd'), localAppData: t.dir('unity-empty-la'), secrets: t.dir('unity-empty-s') },
      noLicence,
    );
    t.check(
      none.state === 'none' && none.detail === 'none: sign in to Unity once in this sandbox',
      'no licence: sign in once',
    );
    const refused = await activateUnityLicence(
      { editorExe: null, unityExe: 'C:\\Cli\\unity.exe', source: 'this PC' },
      dirs,
      noLicence,
    );
    t.check(
      refused.state === 'invalid' && refused.detail.includes('is not accepted here: sign in again'),
      'a licence file that is not accepted says to sign in again',
    );

    t.section('who wants it, and the page');
    t.check(
      serviceWanted('unity', new Set<UsedBy>(['unity'])) && !serviceWanted('unity', new Set<UsedBy>(['steam'])),
      'only the Unity toolchain wants the Unity sign-in',
    );
    t.check(HOST_SOURCES.unity === unitySource, 'the Unity source is registered');
    const config = f.makeConfig();
    const store = new ServiceAccountStore(config.storage.root, SecretStore.memory());
    const row = serviceRow('unity', config, store, new AccountLeases(config.storage.root));
    const text = pageLines(servicePage(row)).join('\n');
    t.check(
      row.canImport && row.canLogin && row.warnings.length > 0 && !text.includes('sandbox account'),
      'the Accounts section offers import and sign in, and shows no "sandbox account" command text',
      text,
    );
  },
};
