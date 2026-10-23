// The storage helper (native\csharp\StorageHelper, the AgentSandboxStorage service an all-users install can add): it
// compiles with the csc that ships with Windows; its checks refuse what contained-common.ps1 refuses (run through its
// `check` dry run against temp folders); it works out the storage folder from settings the way the CLI does; its pipe
// protocol takes exactly a verb and a set; the CLI's client reads its answers and falls back to the permission prompt;
// the install script checks its arguments. No test installs the service or attaches a disk: the server runs in its
// console mode, as this user, on a pipe name of its own, with --dry-run.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { isWin } from '../core/util/index.js';
import { currentUserSid } from '../host/sharing/index.js';
import {
  containedPaths,
  HELPER_PIPE,
  HelperDiskPort,
  helperApplies,
  HelperRequestSchema,
  pipeConnector,
  readAnswer,
  type DiskPort,
  type PipeConnector,
  type PipeResult,
  type ScriptOutcome,
} from '../host/storage/index.js';
import type { MountReality } from '../host/storage/contained/state.js';
import { SYSTEM } from '../shared/system.js';
import type { Harness } from './support/harness.js';
import type { Suite } from './support/suite.js';
import { fakeVhdx } from './support/vhdx.js';

interface Answer {
  readonly ok: boolean;
  readonly message: string;
  readonly created?: boolean;
  readonly alreadyMounted?: boolean;
  readonly fallback?: boolean;
  readonly image?: string;
  readonly mount?: string;
  readonly notes?: string[];
}

class RecordingPort implements DiskPort {
  readonly calls: string[] = [];
  mount(): Promise<ScriptOutcome> {
    this.calls.push('mount');
    return Promise.resolve({ ok: true, message: 'prompt', created: false, alreadyMounted: false, notes: [] });
  }
  dismount(): Promise<ScriptOutcome> {
    this.calls.push('dismount');
    return Promise.resolve({ ok: true, message: 'prompt', created: false, alreadyMounted: false, notes: [] });
  }
  reality(): Promise<MountReality> {
    this.calls.push('reality');
    return Promise.resolve({
      imageExists: true,
      imageBytes: 1,
      mountExists: true,
      mountIsMountPoint: false,
      attached: false,
    });
  }
}

function buildHelper(t: Harness): string | null {
  const dir = path.join(t.packageRoot, 'native', 'csharp', 'StorageHelper');
  const sources = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.cs'))
    .sort()
    .map((f) => path.join(dir, f));
  const exe = t.at('storage-helper', 'bin', 'AgentSandboxStorage.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  const r = spawnSync(
    SYSTEM.csc(),
    [
      '/nologo',
      '/optimize',
      '/warnaserror',
      '/target:exe',
      '/r:System.Web.Extensions.dll',
      '/r:System.ServiceProcess.dll',
      '/out:' + exe,
      ...sources,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 },
  );
  t.check(
    r.status === 0 && fs.existsSync(exe),
    'AgentSandboxStorage.exe builds without warnings (C# 5)',
    r.stdout + r.stderr,
  );
  return fs.existsSync(exe) ? exe : null;
}

/** The folder and everything in it belong to `sid` (as the CLI would make them), not to Administrators. */
function own(dir: string, sid: string): void {
  spawnSync(SYSTEM.icacls(), [dir, '/setowner', '*' + sid, '/T', '/C', '/Q'], { windowsHide: true });
}

function units(t: Harness): void {
  t.section('the request the CLI sends, and what it makes of the answer');
  t.check(HelperRequestSchema.safeParse({ verb: 'mount', set: 'main' }).success, 'a request is a verb and a set');
  t.check(
    !HelperRequestSchema.safeParse({ verb: 'mount', set: 'main', image: 'C:\\x.vhdx' }).success &&
      !HelperRequestSchema.safeParse({ verb: 'format', set: 'main' }).success &&
      !HelperRequestSchema.safeParse({ verb: 'mount', set: '..\\x' }).success,
    'nothing else: no paths, no other verbs, no set name with a path in it',
  );
  t.check(helperApplies({}, false), 'the helper is asked with your usual settings');
  t.check(
    !helperApplies({}, true) &&
      !helperApplies({ AGENT_SANDBOX_CONFIG: 'x' }, false) &&
      !helperApplies({ AGENT_SANDBOX_HOME: 'x' }, false),
    'but not with --config, AGENT_SANDBOX_CONFIG or AGENT_SANDBOX_HOME (it would read other settings)',
  );
  const paths = containedPaths('C:\\Store', 'main');
  const answer = (over: object): PipeResult => ({
    kind: 'answer',
    text: JSON.stringify({
      protocol: 1,
      ok: true,
      message: 'The image was mounted.',
      created: false,
      alreadyMounted: false,
      fallback: false,
      image: paths.image,
      mount: paths.mount,
      notes: [],
      ...over,
    }),
  });
  const ok = readAnswer(answer({}), paths);
  t.check(ok.use === 'outcome' && ok.outcome.ok, 'an answer for our own paths is the outcome');
  t.check(
    readAnswer(answer({ image: paths.image.toUpperCase(), mount: paths.mount + '\\' }), paths).use === 'outcome',
    'case and a trailing backslash do not matter',
  );
  const elsewhere = readAnswer(answer({ mount: 'C:\\Other\\mounts\\main' }), paths);
  t.check(
    elsewhere.use === 'outcome' && !elsewhere.outcome.ok && /other folders/.test(elsewhere.outcome.message),
    'a mount in other folders than ours is a failure, never taken as done',
  );
  t.equal(readAnswer({ kind: 'absent', reason: 'ENOENT' }, paths).use, 'fallback', 'no helper: the permission prompt');
  t.equal(readAnswer(answer({ protocol: 2 }), paths).use, 'fallback', 'a helper of another version: the prompt');
  t.equal(readAnswer({ kind: 'answer', text: 'not json' }, paths).use, 'fallback', 'garbage: the prompt');
  t.equal(readAnswer(answer({ ok: false, fallback: true }), paths).use, 'fallback', 'the helper says so: the prompt');
  const half = readAnswer({ kind: 'failed', reason: 'timeout' }, paths);
  t.check(
    half.use === 'outcome' && !half.outcome.ok,
    'a helper that stopped half way is a failure (no second try through the prompt)',
  );
}

async function ports(t: Harness): Promise<void> {
  t.section('the disk port: the helper when it applies, the permission prompt otherwise');
  const paths = containedPaths(t.dir('storage-helper', 'port'), 'main');
  const request = { paths, maxGb: 64, create: false, userSid: 'S-1-5-21-1-2-3-1001' };
  const seen: string[] = [];
  const connector =
    (result: PipeResult): PipeConnector =>
    (_pipe, line) => {
      seen.push(line);
      return Promise.resolve(result);
    };
  const prompt1 = new RecordingPort();
  await new HelperDiskPort(prompt1, false, connector({ kind: 'absent', reason: 'x' }), 'test').mount(request);
  t.check(prompt1.calls.includes('mount') && seen.length === 0, 'not applying: the helper is not even asked');
  const prompt2 = new RecordingPort();
  await new HelperDiskPort(prompt2, true, connector({ kind: 'absent', reason: 'ENOENT' }), 'test').dismount(request);
  t.check(prompt2.calls.includes('dismount'), 'not installed: the permission prompt');
  t.equal(JSON.parse(seen[0]) as unknown, { verb: 'dismount', set: 'main' }, 'the line sent is the verb and the set');
  const prompt3 = new RecordingPort();
  const done = await new HelperDiskPort(
    prompt3,
    true,
    connector({
      kind: 'answer',
      text: JSON.stringify({
        protocol: 1,
        ok: true,
        message: 'The image was created and mounted.',
        created: true,
        alreadyMounted: false,
        fallback: false,
        image: paths.image,
        mount: paths.mount,
        notes: ['n'],
      }),
    }),
    'test',
  ).mount(request);
  t.check(done.ok && done.created && prompt3.calls.length === 0, 'an answer from the helper: no prompt');
  await new HelperDiskPort(prompt3, true, connector({ kind: 'absent', reason: 'x' }), 'test').reality(paths);
  t.check(prompt3.calls.includes('reality'), 'looking never needs the helper');
  await t.throws(
    () =>
      new HelperDiskPort(new RecordingPort(), true, connector({ kind: 'absent', reason: 'x' }), HELPER_PIPE).mount(
        request,
      ),
    'does not mount or dismount',
    'the self-test never talks to the real helper',
  );
  const unconfirmed = await new HelperDiskPort(
    new RecordingPort(),
    true,
    connector({ kind: 'absent', reason: 'x' }),
    'test',
  ).confirmMounted(request);
  t.equal(unconfirmed, null, 'a vouched mount without the helper stays vouched (no prompt for a check)');
  const refusedMount = await new HelperDiskPort(
    new RecordingPort(),
    true,
    connector({
      kind: 'answer',
      text: JSON.stringify({
        protocol: 1,
        ok: false,
        message: 'The mount folder is a mount point already.',
        created: false,
        alreadyMounted: false,
        fallback: false,
        image: paths.image,
        mount: paths.mount,
        notes: [],
      }),
    }),
    'test',
  ).confirmMounted(request);
  t.check(
    refusedMount !== null && !refusedMount.ok,
    'with the helper, a vouched mount is checked: a mount point of another disk is a failure',
  );
  const absent = await pipeConnector('\\\\.\\pipe\\agent-sandbox-test-no-such-pipe-' + process.pid, '{}', 5000);
  t.equal(absent.kind, 'absent', 'a pipe that is not there reads as "no helper"');
}

/** The helper's `check` dry run on one data set; the parsed answer. */
function checkRun(exe: string, verb: string, root: string, set: string, sid: string, maxGb: number): Answer {
  const r = spawnSync(exe, ['check', verb, root, set, sid, String(maxGb)], { encoding: 'utf8', windowsHide: true });
  try {
    return JSON.parse(r.stdout) as Answer;
  } catch {
    return { ok: false, message: 'no answer: ' + r.stdout + r.stderr };
  }
}

function checks(t: Harness, exe: string, sid: string): void {
  t.section('the checks (dry run): what the helper accepts and refuses');
  const root = t.dir('storage-helper', 'store');
  const paths = containedPaths(root, 'main');
  for (const dir of [paths.imagesDir, paths.mountsDir, paths.mount]) fs.mkdirSync(dir, { recursive: true });
  own(root, sid);
  const run = (over: { verb?: string; root?: string; set?: string; sid?: string; maxGb?: number } = {}): Answer =>
    checkRun(exe, over.verb ?? 'mount', over.root ?? root, over.set ?? 'main', over.sid ?? sid, over.maxGb ?? 64);
  const refused = (what: string, a: Answer, text: string): void =>
    t.check(!a.ok && a.message.toLowerCase().includes(text.toLowerCase()), 'refused: ' + what, a.message);

  const first = run();
  t.check(
    first.ok && first.created === true,
    'a first mount (no image yet) is accepted: it would create one',
    first.message,
  );
  t.check(
    first.image === paths.image && first.mount === paths.mount,
    'the paths are <storage>\\images\\<set>.vhdx and <storage>\\mounts\\<set>, built by the helper',
  );
  fakeVhdx(paths.image, { gb: 64 });
  own(paths.image, sid);
  const existing = run();
  t.check(existing.ok && existing.created === false, 'an existing image is accepted (only attached)', existing.message);
  t.check(run({ verb: 'dismount' }).ok, 'a dismount is accepted');
  fakeVhdx(paths.image, { gb: 64, staleLog: true });
  t.check(run().ok, 'a log named only in the older header is fine');

  refused('another user (the folders are not theirs)', run({ sid: 'S-1-5-21-1-2-3-1001' }), 'not yours');
  refused('a data set name that is not allowed', run({ set: 'a b' }), 'not allowed');
  refused('a data set name with a path', run({ set: '..\\x' }), 'not allowed');
  refused('a relative storage folder', run({ root: 'store' }), 'plain full path');
  refused('a storage folder with ..', run({ root: root + '\\..\\store' }), 'plain full path');
  refused('a network storage folder', run({ root: '\\\\server\\share\\store' }), 'plain full path');
  refused('a drive root', run({ root: 'C:\\' }), 'drive root');
  refused('a size limit out of range', run({ maxGb: 100000 }), 'between 8 and 4096');
  fakeVhdx(paths.image, { gb: 64, parent: true });
  refused('a differencing image (it has a parent)', run(), 'differencing');
  fakeVhdx(paths.image, { gb: 128 });
  refused('an image bigger than the limit', run(), 'bigger than the limit');
  fs.writeFileSync(paths.image, 'not a vhdx');
  refused('a file that is not a VHDX', run(), 'not a VHDX');
  fakeVhdx(paths.image, { gb: 64, log: true });
  const log = run();
  t.check(
    !log.ok && log.fallback === true && /not closed cleanly/.test(log.message),
    'an image with a log to replay is left to the permission prompt (fallback)',
    log.message,
  );
  fakeVhdx(paths.image, { gb: 64 });
  fs.writeFileSync(path.join(paths.mount, 'stray.txt'), 'x');
  refused('a mount folder that is not empty', run(), 'not empty');
  fs.rmSync(path.join(paths.mount, 'stray.txt'));

  const twin = path.join(root, 'twin.vhdx');
  try {
    fs.linkSync(paths.image, twin);
    refused('an image with a second name (hard link)', run(), 'hard links');
    fs.rmSync(twin);
  } catch {
    t.skip('image as a hard link (could not make one here)');
  }
  const users = spawnSync(SYSTEM.icacls(), [paths.imagesDir, '/grant', '*S-1-5-32-545:(M)', '/Q'], {
    windowsHide: true,
  });
  if (users.status === 0) {
    refused('a folder others may change (Users: modify)', run(), 'someone else may change');
    spawnSync(SYSTEM.icacls(), [paths.imagesDir, '/remove:g', '*S-1-5-32-545', '/Q'], { windowsHide: true });
    t.check(run().ok, 'and accepted again once only the user may change it');
  } else t.skip('a folder others may change (icacls failed)');

  const linkTarget = t.dir('storage-helper', 'linktarget');
  const junctionRoot = t.dir('storage-helper', 'junction');
  const junction = containedPaths(junctionRoot, 'main');
  fs.mkdirSync(junction.mount, { recursive: true });
  const mk = spawnSync(SYSTEM.cmd(), ['/c', 'mklink', '/J', junction.imagesDir, linkTarget], { windowsHide: true });
  if (mk.status === 0) {
    own(junctionRoot, sid);
    fakeVhdx(path.join(linkTarget, 'main.vhdx'), { gb: 8 });
    refused('an images folder that is a link', run({ root: junctionRoot }), 'link');
    fs.rmdirSync(junction.imagesDir);
  } else t.skip('images folder as a junction');
  const above = t.dir('storage-helper', 'above');
  const realParent = t.dir('storage-helper', 'above-real');
  const inner = containedPaths(path.join(realParent, 'store'), 'main');
  for (const dir of [inner.imagesDir, inner.mount]) fs.mkdirSync(dir, { recursive: true });
  own(path.join(realParent, 'store'), sid);
  fs.rmdirSync(above);
  const mk2 = spawnSync(SYSTEM.cmd(), ['/c', 'mklink', '/J', above, realParent], { windowsHide: true });
  if (mk2.status === 0) {
    refused('a link above the storage folder', run({ root: path.join(above, 'store') }), 'link');
    fs.rmdirSync(above);
  } else t.skip('a junction above the storage folder');
  const mountRoot = t.dir('storage-helper', 'mountlink');
  const mountLinked = containedPaths(mountRoot, 'main');
  fs.mkdirSync(mountLinked.imagesDir, { recursive: true });
  fs.mkdirSync(mountLinked.mountsDir, { recursive: true });
  const mk3 = spawnSync(SYSTEM.cmd(), ['/c', 'mklink', '/J', mountLinked.mount, linkTarget], { windowsHide: true });
  if (mk3.status === 0) {
    own(mountRoot, sid);
    refused('a mount folder that is a link to a folder (not a volume)', run({ root: mountRoot }), 'not a volume');
    refused('a dismount through such a link', run({ root: mountRoot, verb: 'dismount' }), 'missing');
    fs.rmdirSync(mountLinked.mount);
  } else t.skip('mount folder as a junction');
  const missing = t.dir('storage-helper', 'missing');
  own(missing, sid);
  refused('a storage folder without images and mounts', run({ root: missing }), 'missing');
}

function derive(t: Harness, exe: string): void {
  t.section('the storage folder, worked out from the settings like the CLI does');
  const env = { USERNAME: 'ann', ProgramData: 'C:\\ProgramData', USERPROFILE: 'C:\\Users\\ann' };
  let n = 0;
  const run = (input: object): { ok: boolean; root?: string; maxGb?: number; message?: string } => {
    const file = t.writeJson(t.at('storage-helper', 'derive', 'in' + n++ + '.json'), {
      base: 'C:\\Users\\ann\\.agent-sandbox',
      profile: 'C:\\Users\\ann',
      env,
      ...input,
    });
    const r = spawnSync(exe, ['derive', file], { encoding: 'utf8', windowsHide: true });
    try {
      return JSON.parse(r.stdout) as { ok: boolean };
    } catch {
      return { ok: false, message: r.stdout + r.stderr };
    }
  };
  t.equal(run({}), { ok: true, root: 'C:\\ProgramData\\AgentSandbox\\users\\ann', maxGb: 64 }, 'the defaults');
  t.equal(
    run({ machine: '{ "storage": { "root": "D:\\\\Sandbox\\\\%USERNAME%" } }' }).root,
    'D:\\Sandbox\\ann',
    'the machine file, with %USERNAME% from the user',
  );
  t.equal(
    run({
      machine: '{ "storage": { "root": "D:\\\\Sandbox" } }',
      user: '// mine\n{ "storage": { "root": "E:\\\\Mine", /* why */ "containedMaxGb": 32, }, }',
    }),
    { ok: true, root: 'E:\\Mine', maxGb: 32 },
    'the user file wins, with comments and trailing commas',
  );
  t.equal(
    run({ user: '{ "storage": { "root": "store" } }' }).root,
    'C:\\Users\\ann\\.agent-sandbox\\store',
    'a relative folder is relative to the file',
  );
  t.equal(run({ user: '{ "storage": { "root": "~\\\\data" } }' }).root, 'C:\\Users\\ann\\data', '~ is the profile');
  t.equal(run({ user: '{ "storage": { "root": "D:/a/../b" } }' }).root, 'D:\\b', 'slashes and .. are worked out');
  t.equal(
    run({ machine: '{ "storage": { "containedMaxGb": 100 } }', user: '{ "storage": { "containedMaxGb": 500 } }' })
      .maxGb,
    100,
    'a size limit set for the PC is a ceiling the user file cannot raise',
  );
  t.equal(
    run({ machine: '{ "storage": { "containedMaxGb": 100 } }', user: '{ "storage": { "containedMaxGb": 20 } }' }).maxGb,
    20,
    'but may lower',
  );
  const secret = run({ user: 'SECRET-CONTENT {' });
  t.check(
    !secret.ok && !(secret.message ?? '').includes('SECRET'),
    'a file that is not JSON is refused without repeating it',
  );
  t.check(!run({ machine: '{ "storage": { "root": "relative" } }' }).ok, 'the machine file must give a full path');
}

function protocol(t: Harness, exe: string): void {
  t.section('the pipe protocol: exactly a verb and a set');
  const parse = (line: string): { ok: boolean; verb?: string; set?: string } => {
    const r = spawnSync(exe, ['parse'], { input: line + '\n', encoding: 'utf8', windowsHide: true });
    try {
      return JSON.parse(r.stdout) as { ok: boolean };
    } catch {
      return { ok: false };
    }
  };
  t.equal(parse('{"verb":"mount","set":"main"}'), { ok: true, verb: 'mount', set: 'main' }, 'mount main');
  t.check(parse('{"verb":"dismount","set":"work.2"}').ok, 'dismount work.2');
  for (const [line, what] of [
    ['{"verb":"mount","set":"main","image":"C:\\\\Windows\\\\x.vhdx"}', 'an extra field (a path)'],
    ['{"verb":"mount"}', 'no set'],
    ['{"verb":"format","set":"main"}', 'another verb'],
    ['{"verb":"mount","set":"..\\\\x"}', 'a set with a path'],
    ['{"verb":"mount","set":["main"]}', 'a set that is not a string'],
    ['["mount","main"]', 'not an object'],
    ['not json', 'not JSON'],
    ['{"verb":"mount","set":"' + 'a'.repeat(600) + '"}', 'longer than 512 bytes'],
  ] as const)
    t.check(!parse(line).ok, 'refused: ' + what);
}

async function startConsole(
  exe: string,
  args: string[],
): Promise<{ child: ChildProcess; ready: boolean; stderr: () => string }> {
  const child = spawn(exe, ['console', ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  let err = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setInterval(() => {
      if (out.includes('ready')) done(true);
    }, 50);
    const done = (value: boolean): void => {
      clearInterval(timer);
      resolve(value);
    };
    child.on('exit', () => done(false));
    setTimeout(() => done(out.includes('ready')), 20000);
  });
  return { child, ready, stderr: () => err };
}

async function server(t: Harness, exe: string, sid: string): Promise<void> {
  t.section('the server in its console mode (this user, a pipe of its own, dry run)');
  const root = t.dir('storage-helper', 'served');
  const paths = containedPaths(root, 'main');
  for (const dir of [paths.imagesDir, paths.mount]) fs.mkdirSync(dir, { recursive: true });
  own(root, sid);
  const profile = t.dir('storage-helper', 'profile');
  t.writeJson(path.join(profile, '.agent-sandbox', 'config.json'), { storage: { root, containedMaxGb: 16 } });
  const logs = t.dir('storage-helper', 'logs');
  const name = 'agent-sandbox-test-' + process.pid;
  const pipe = '\\\\.\\pipe\\' + name;
  const common = ['--group', sid, '--log-folder', logs, '--machine-config', 'none', '--profile', profile, '--dry-run'];
  const first = await startConsole(exe, ['--pipe', name, ...common]);
  t.check(first.ready, 'it starts', first.stderr());
  if (!first.ready) return;
  try {
    const port = new HelperDiskPort(new RecordingPort(), true, pipeConnector, pipe);
    const mounted = await port.mount({ paths, maxGb: 64, create: true, userSid: sid });
    t.check(
      mounted.ok && mounted.created && /would be created/.test(mounted.message),
      'a mount through the pipe: the client is you, the folders come from your settings',
      JSON.stringify(mounted),
    );
    const otherPaths = containedPaths(t.dir('storage-helper', 'elsewhere'), 'main');
    const mismatch = await port.mount({ paths: otherPaths, maxGb: 64, create: true, userSid: sid });
    t.check(
      !mismatch.ok && /other folders/.test(mismatch.message),
      'a CLI with other folders gets a failure, not a mount',
    );
    const raw = async (line: string): Promise<string> => {
      const r = await pipeConnector(pipe, line, 10000);
      return r.kind === 'answer' ? r.text : r.kind + ': ' + r.reason;
    };
    t.includes(
      await raw('{"verb":"mount","set":"main","image":"C:\\\\Windows\\\\x.vhdx"}'),
      'exactly a verb and a set',
      'a request with a path in it is refused over the pipe',
    );
    t.includes(await raw('{"verb":"mount","set":"other"}'), 'missing', 'another set is checked like any other');
    const second = await startConsole(exe, ['--pipe', name, ...common]);
    t.check(
      !second.ready && /exists already/.test(second.stderr()),
      'a second server on the same pipe name does not start (someone else made the pipe first)',
      second.stderr(),
    );
    const holder = path.join(t.packageRoot, 'src', 'selftest', 'fixtures', 'storage-helper', 'hold-mutex.ps1');
    if (fs.existsSync(holder)) {
      const lockName = 'Local\\agent-sandbox-test-lock-' + process.pid;
      const hold = spawn(
        SYSTEM.powershell(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', holder, '-Name', lockName],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      let held = '';
      hold.stdout.on('data', (d: Buffer) => (held += d.toString()));
      await t.waitFor(() => held.includes('held'), 20000);
      const squatted = await startConsole(exe, ['--pipe', name + '-lock', '--mutex', lockName, ...common]);
      t.check(
        !squatted.ready && /not by an administrator/.test(squatted.stderr()),
        'a lock that a normal user made first stops the service from starting (it could be held to block mounts)',
        squatted.stderr(),
      );
      hold.stdin.end();
    } else t.skip('a lock made first by a normal user (the fixture is only in the repository)');
    let limited = 0;
    for (let i = 0; i < 12; i++) if (/Too many calls/.test(await raw('{"verb":"dismount","set":"main"}'))) limited++;
    t.check(limited >= 3, 'more than 10 calls a minute from one user are refused');
    const log = fs.readFileSync(path.join(logs, 'storage-helper.log'), 'utf8');
    t.check(
      log.includes('sid=' + sid) &&
        log.includes('verb=mount') &&
        log.includes('set="main"') &&
        log.includes('result="ok:'),
      'every call is logged: who, what, the result',
    );
    t.equal((log.match(/too many calls/gi) ?? []).length, 1, 'a refused call is logged once per minute, not each time');
  } finally {
    first.child.stdin?.end();
    await new Promise((resolve) => {
      first.child.on('exit', resolve);
      setTimeout(resolve, 10000);
    });
  }
}

function installScript(t: Harness): void {
  t.section('set-storage-helper.ps1: encoding, syntax, what it would do');
  const script = path.join(t.packageRoot, 'native', 'scripts', 'set-storage-helper.ps1');
  const text = fs.readFileSync(script, 'utf8');
  t.check(!/(?<!\r)\n/.test(text) && text.startsWith('#Requires -Version 5.1'), 'CRLF and #Requires -Version 5.1');
  const parse = spawnSync(
    SYSTEM.powershell(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(t.packageRoot, 'native', 'scripts', 'check-syntax.ps1'),
      '-Path',
      script,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  t.check(parse.status === 0, 'it parses in PowerShell 5.1', parse.stderr + parse.stdout);
  const installRoot = t.dir('storage-helper', 'install-root');
  const sources = t.dir(
    'storage-helper',
    'install-root',
    'versions',
    '1.0.0',
    'package',
    'native',
    'csharp',
    'StorageHelper',
  );
  t.write(path.join(sources, 'A.cs'), '// placeholder');
  const dry = (args: string[]): { status: number | null; out: string } => {
    const r = spawnSync(
      SYSTEM.powershell(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        ...args,
        '-DryRun',
        '-ServiceName',
        'AgentSandboxStorageDryRun',
        '-MachineData',
        t.dir('storage-helper', 'machine'),
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 },
    );
    return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  };
  const group = 'S-1-5-21-111-222-333-1009';
  const ok = dry(['-Install', '-GroupSid', group, '-InstallRoot', installRoot, '-Sources', sources]);
  t.check(ok.status === 0, 'a dry run of the install is accepted', ok.out);
  for (const step of [
    'build AgentSandboxStorage.exe',
    'admin-only folder',
    'create the service',
    'LocalSystem, automatic start',
    'service --group ' + group,
    'SeManageVolumePrivilege',
    'start the service',
  ])
    t.includes(ok.out, step, 'it would: ' + step);
  t.excludes(ok.out, 'SeDebugPrivilege', 'and no privilege it does not need');
  const refused = (what: string, args: string[], text: string): void => {
    const r = dry(args);
    t.check(r.status === 1 && r.out.includes(text), 'refused: ' + what, r.out);
  };
  refused(
    'a group that is not a local group SID',
    ['-Install', '-GroupSid', 'S-1-1-0', '-InstallRoot', installRoot, '-Sources', sources],
    'GroupSid',
  );
  refused(
    'sources outside the install folder',
    ['-Install', '-GroupSid', group, '-InstallRoot', installRoot, '-Sources', t.dir('storage-helper', 'elsewhere-src')],
    'Sources',
  );
  const removal = dry(['-Remove', '-InstallRoot', installRoot]);
  t.check(
    removal.status === 0 && removal.out.includes('remove ' + path.join(installRoot, 'helper')),
    'a dry run of the removal',
    removal.out,
  );
}

export const storageHelperSuite: Suite = {
  name: 'storage-helper',
  title: 'the storage helper service: builds, checks like the scripts, settings, pipe protocol, client fallback',
  timeoutMs: 300000,
  run: async (t) => {
    units(t);
    await ports(t);
    if (!isWin || !fs.existsSync(SYSTEM.csc())) {
      t.skip('the helper itself (needs Windows and its csc)');
      return;
    }
    const exe = buildHelper(t);
    if (!exe) return;
    const sid = currentUserSid();
    checks(t, exe, sid);
    derive(t, exe);
    protocol(t, exe);
    await server(t, exe, sid);
    installScript(t);
  },
};
