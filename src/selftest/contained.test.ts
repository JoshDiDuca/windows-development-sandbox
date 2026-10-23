// Contained storage (beta, phase 2 of docs/design/engines.md): the data set split into mappings, the mount record and
// its refcount, stale mounts, the provider, the move into and out of an image, and the PowerShell scripts (parsed,
// CRLF, run in their dry-run mode against temp folders: they print the diskpart lines they would run and refuse what
// is not safe). No test mounts a disk: the real disk port is only started on a PC, everything else uses a fake.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertNoGuestOverlap } from '../core/config/index.js';
import type { Config } from '../core/types.js';
import { isWin } from '../core/util/index.js';
import { CONTAINED_CHECKS } from '../cli/commands/repair/checks/contained.js';
import type { RepairEnv } from '../cli/commands/repair/types.js';
import { storageBusy } from '../cli/services/index.js';
import { generateSandbox, GUEST } from '../host/launch/index.js';
import { currentUserSid } from '../host/sharing/index.js';
import {
  addHolder,
  CONTAINED_FOLDERS,
  containedAvailability,
  ContainedStorage,
  containedMappings,
  containedPaths,
  diagnose,
  hostDataFolder,
  markMounted,
  mountedSets,
  planTransfer,
  providerFor,
  pruneHolders,
  removeHolder,
  runTransfer,
  ScriptDiskPort,
  setNameOf,
  setStateOf,
  staleMountNote,
  StateFile,
  type ContainedDeps,
  type ContainedPaths,
  type DiskPort,
  type MountReality,
  type ScriptOutcome,
} from '../host/storage/index.js';
import type { Runner } from '../host/storage/contained/disk-port.js';
import { EMPTY_STATE } from '../host/storage/contained/state.js';
import { SYSTEM } from '../shared/system.js';
import type { Suite } from './support/suite.js';
import { fakeVhdx } from './support/vhdx.js';

const SCRIPTS = ['contained-common', 'mount-contained', 'dismount-contained', 'check-contained', 'run-elevated'];

class FakePort implements DiskPort {
  readonly calls: string[] = [];
  mounted = false;
  imageExists = false;
  failMount: string | null = null;
  constructor(public paths: ContainedPaths) {}

  mount(request: { create: boolean }): Promise<ScriptOutcome> {
    this.calls.push('mount' + (request.create ? ':create' : ''));
    if (this.failMount) return Promise.resolve(this.outcome(false, this.failMount));
    this.mounted = true;
    this.imageExists = true;
    return Promise.resolve(this.outcome(true, 'mounted'));
  }

  dismount(): Promise<ScriptOutcome> {
    this.calls.push('dismount');
    this.mounted = false;
    return Promise.resolve(this.outcome(true, 'detached'));
  }

  reality(): Promise<MountReality> {
    return Promise.resolve({
      imageExists: this.imageExists,
      imageBytes: 1,
      mountExists: fs.existsSync(this.paths.mount),
      mountIsMountPoint: this.mounted,
      attached: this.mounted,
    });
  }

  private outcome(ok: boolean, message: string): ScriptOutcome {
    return { ok, message, created: false, alreadyMounted: false, notes: [] };
  }
}

export const containedSuite: Suite = {
  name: 'contained',
  title: 'contained storage: mapping split, mount record and refcount, stale mounts, scripts (beta)',
  timeoutMs: 300000,
  run: async (t, f) => {
    const config: Config = f.baseConfig;
    const GUEST_DATA = 'C:\\AgentData';

    t.section('the data set splits into mappings with the same guest paths');
    const storageRoot = t.dir('contained', 'storage');
    const dataPath = t.dir('contained', 'storage', 'data', 'main');
    const paths = containedPaths(storageRoot, 'main');
    const mappings = containedMappings(dataPath, paths.mount, GUEST_DATA);
    t.equal(
      mappings.map((m) => m.guest),
      ['run', ...CONTAINED_FOLDERS].map((n) => GUEST_DATA + '\\' + n),
      'run and every contained folder is mapped at its place under C:\\AgentData',
    );
    t.check(
      ['run', 'tools', 'state', 'logs'].every((n) => mappings.some((m) => m.guest === GUEST_DATA + '\\' + n)),
      'the guest still has C:\\AgentData\\run, tools, state and logs (what one mapping of the data folder gave)',
    );
    t.equal(mappings[0].host, path.join(dataPath, 'run'), 'run stays the plain host folder (the host reads it)');
    t.check(
      mappings.slice(1).every((m) => m.host.startsWith(paths.mount + path.sep) && !m.readOnly),
      'the others come from inside the mount folder, read/write',
    );
    assertNoGuestOverlap(mappings);
    t.check(true, 'no mapping lies inside another');

    t.section('a launch with contained storage maps the split, not the whole folder');
    const vhdxConfig: Config = { ...structuredClone(config), storage: { ...config.storage, contained: 'vhdx' } };
    const run = await f.run({}, vhdxConfig);
    const launchMappings = containedMappings(
      run.dataPath,
      containedPaths(run.storageRoot, setNameOf(run.dataPath)).mount,
      GUEST.data,
    );
    const generated = generateSandbox({
      packageRoot: t.packageRoot,
      run,
      harnessArgs: ['--version'],
      probe: f.probe,
      pcLanguages: ['python'],
      dataMappings: launchMappings,
    });
    const guests = generated.mappings.map((m) => m.guest);
    t.check(!guests.includes(GUEST.data), 'C:\\AgentData itself is no longer one mapping');
    t.check(
      launchMappings.every((m) => guests.includes(m.guest) && generated.mappings.some((g) => g.host === m.host)),
      'every split mapping is in the launch',
    );
    const wsb = fs.readFileSync(generated.wsbPath, 'utf8');
    t.check(
      CONTAINED_FOLDERS.every((n) => wsb.includes('<SandboxFolder>C:\\AgentData\\' + n + '</SandboxFolder>')) &&
        wsb.includes('<SandboxFolder>C:\\AgentData\\run</SandboxFolder>'),
      'the .wsb has a folder for each of them',
    );
    await t.throws(
      () => generateSandbox({ packageRoot: t.packageRoot, run, harnessArgs: [], probe: f.probe }),
      'Contained storage was not prepared for this launch',
      'contained storage without a mounted image stops before anything is written',
    );

    t.section('the mount record: refcount and transitions');
    let state = EMPTY_STATE;
    const holder = (id: string, pid: number) => ({ id, pid, since: 'now' });
    state = addHolder(addHolder(state, 'main', holder('launch', 10)), 'main', holder('watcher', 11));
    t.equal(setStateOf(state, 'main').holders.length, 2, 'two holders');
    state = addHolder(state, 'main', holder('watcher', 12));
    t.equal(
      setStateOf(state, 'main').holders.map((h) => h.pid),
      [10, 12],
      'the same holder id is refreshed, not added twice',
    );
    t.equal(
      setStateOf(
        pruneHolders(state, 'main', (pid) => pid === 12),
        'main',
      ).holders.map((h) => h.id),
      ['watcher'],
      'a holder whose process is gone is dropped',
    );
    t.equal(
      setStateOf(removeHolder(state, 'main', 'launch'), 'main').holders.map((h) => h.id),
      ['watcher'],
      'a holder lets go by id',
    );
    t.check(setStateOf(markMounted(state, 'main', true), 'main').mounted, 'mounted is recorded');
    t.equal(state.sets.other, undefined, 'another set is untouched');

    const base = t.dir('contained', 'life');
    const lifePaths = containedPaths(base, 'main');
    const port = new FakePort(lifePaths);
    let alive = new Set<number>([100, 101]);
    let running = false;
    const deps: ContainedDeps = {
      storageRoot: base,
      maxGb: 64,
      protect: () => undefined,
      userSid: () => 'S-1-5-21-1-2-3-1001',
      port,
      sandboxRunning: () => running,
      alive: (pid) => alive.has(pid),
      deviceOf: (dir) => (dir === lifePaths.mount && port.mounted ? 2 : 1),
    };
    const storage = new ContainedStorage(deps, 'main');
    await t.throws(
      () => storage.acquire({ id: 'launch', pid: 100 }),
      'image is missing',
      'an image that is not there is not made by a launch',
    );
    t.equal(port.calls, [], 'nothing was mounted for that');
    t.equal(storage.liveHolders(), 0, 'and the failed holder was removed again');
    const mount = await storage.acquire({ id: 'launch', pid: 100 }, { create: true });
    t.equal(
      [mount, port.calls],
      [lifePaths.mount, ['mount:create']],
      'the first launch creates and mounts the image once',
    );
    t.check(
      CONTAINED_FOLDERS.every((n) => fs.existsSync(path.join(mount, n))),
      'the data set folders exist inside the mount folder',
    );
    await storage.acquire({ id: 'watcher', pid: 101 });
    t.equal(port.calls, ['mount:create'], 'a second holder that finds it mounted does not mount again');
    t.equal(storage.liveHolders(), 2, 'both hold it');
    t.equal(
      await storage.release('launch'),
      { dismounted: false, note: 'another command still uses it' },
      'the first to let go leaves it mounted',
    );
    running = true;
    alive = new Set([]);
    t.equal((await storage.release('watcher')).dismounted, false, 'never dismounted while a sandbox runs');
    running = false;
    t.equal(storage.recordedMounted(), true, 'it stays recorded as mounted');
    const done = await storage.release('watcher');
    t.equal([done.dismounted, port.calls], [true, ['mount:create', 'dismount']], 'the last to let go dismounts, once');
    t.equal(storage.recordedMounted(), false, 'and the record says so');
    t.equal(
      (await storage.release('watcher')).dismounted,
      false,
      'letting go of nothing mounted asks for no permission',
    );
    t.equal(port.calls.length, 2, 'no extra dismount call');
    port.calls.length = 0;
    alive = new Set([100]);
    await storage.acquire({ id: 'launch', pid: 100 });
    t.equal(port.calls, ['mount'], 'with the image there it is only attached, never created again');

    t.section('failures leave nothing behind');
    port.failMount = 'The image is bigger than the limit of 64 GB.';
    port.mounted = false;
    port.calls.length = 0;
    const other = new ContainedStorage({ ...deps, storageRoot: t.dir('contained', 'fail') }, 'main');
    port.paths = other.paths;
    port.imageExists = true;
    await t.throws(
      () => other.acquire({ id: 'launch', pid: 100 }),
      'bigger than the limit',
      'a refusal of the script stops the launch with its reason',
    );
    t.equal([other.liveHolders(), other.recordedMounted()], [0, false], 'no holder and no mounted record are left');
    port.failMount = null;
    const wrongDevice = new ContainedStorage(
      { ...deps, storageRoot: t.dir('contained', 'device'), deviceOf: () => 1 },
      'main',
    );
    port.paths = wrongDevice.paths;
    await t.throws(
      () => wrongDevice.acquire({ id: 'launch', pid: 100 }),
      'not mounted at',
      "a mount folder on this PC's own disk is never written to",
    );
    t.equal(fs.readdirSync(wrongDevice.paths.mount), [], 'nothing was written into it');

    t.section('stale mounts');
    const reality = (over: Partial<MountReality>): MountReality => ({
      imageExists: true,
      imageBytes: 1,
      mountExists: true,
      mountIsMountPoint: false,
      attached: false,
      ...over,
    });
    const record = (mounted: boolean) => ({ mounted, holders: [] });
    t.equal(
      diagnose({ state: record(false), reality: reality({}), live: 0, sandboxRunning: false }).kind,
      'ok',
      'nothing mounted, nothing recorded: fine',
    );
    t.equal(
      diagnose({ state: record(true), reality: reality({}), live: 0, sandboxRunning: false }).kind,
      'stale-state',
      'recorded as mounted but not: the record is stale',
    );
    t.equal(
      diagnose({
        state: record(true),
        reality: reality({ mountIsMountPoint: true, attached: true }),
        live: 0,
        sandboxRunning: false,
      }).kind,
      'stale-mount',
      'mounted with no holder and no sandbox: a stale mount (dismount it)',
    );
    t.equal(
      diagnose({ state: record(false), reality: reality({ mountIsMountPoint: true }), live: 0, sandboxRunning: false })
        .kind,
      'stale-mount',
      'mounted but not even recorded: also stale',
    );
    t.equal(
      diagnose({ state: record(true), reality: reality({ mountIsMountPoint: true }), live: 1, sandboxRunning: false })
        .kind,
      'in-use',
      'a live holder: in use',
    );
    t.equal(
      diagnose({ state: record(true), reality: reality({ mountIsMountPoint: true }), live: 0, sandboxRunning: true })
        .kind,
      'in-use',
      'a running sandbox: in use',
    );
    t.equal(
      diagnose({ state: record(false), reality: reality({ imageExists: false }), live: 0, sandboxRunning: false }).kind,
      'image-missing',
      'no image file',
    );
    const staleBase = t.dir('contained', 'stale');
    const staleFile = new StateFile(containedPaths(staleBase, 'main'), (pid) => pid === 5);
    staleFile.update((s) => addHolder(markMounted(s, 'main', true), 'main', holder('watcher', 5)));
    t.equal(
      staleMountNote(staleBase, 'main', false, (pid) => pid === 5),
      null,
      'a running holder: no note',
    );
    t.includes(
      staleMountNote(staleBase, 'main', false, () => false) ?? '',
      'sandbox repair',
      'a mount nobody holds: the note points at repair',
    );
    t.equal(
      staleMountNote(staleBase, 'main', true, () => false),
      null,
      'no note while a sandbox runs',
    );
    t.equal(mountedSets(staleBase), ['main'], 'a storage move sees the mounted set');
    t.includes(storageBusy(staleBase) ?? '', 'is mounted', 'and waits for it');
    fs.writeFileSync(containedPaths(staleBase, 'main').stateFile, '{ not json');
    t.equal(
      [mountedSets(staleBase), staleMountNote(staleBase, 'main', false)],
      [[], null],
      'a broken record counts as empty',
    );
    const staleLock = containedPaths(staleBase, 'main').lockFile;
    fs.writeFileSync(staleLock, '99999999');
    new StateFile(containedPaths(staleBase, 'main'), () => false).update((s) => markMounted(s, 'main', false));
    t.check(!fs.existsSync(staleLock), 'a lock left by a dead process is taken over and removed');

    t.section('where the host finds the folders');
    t.equal(
      hostDataFolder(dataPath, 'tools'),
      path.join(dataPath, 'tools'),
      'without contained storage: the plain data folder',
    );
    const fakeStale = containedPaths(storageRoot, 'main');
    new StateFile(fakeStale).update((s) => markMounted(s, 'main', true));
    fs.mkdirSync(fakeStale.mount, { recursive: true });
    t.equal(
      hostDataFolder(dataPath, 'tools'),
      path.join(dataPath, 'tools'),
      'a record that says mounted, on the same volume: still the plain folder (never into the empty mount folder)',
    );

    t.section('availability and the provider');
    const facts = { windows: true, insideSandbox: false, diskpartPresent: true, powershellPresent: true };
    t.equal(containedAvailability(facts).available, true, 'a normal Windows PC can use it');
    t.includes(
      containedAvailability({ ...facts, insideSandbox: true }).reasons.join(' '),
      'inside a Windows Sandbox',
      'not inside a sandbox',
    );
    t.includes(
      containedAvailability({ ...facts, diskpartPresent: false }).reasons.join(' '),
      'diskpart.exe',
      'not without diskpart',
    );
    t.includes(
      containedAvailability({ ...facts, windows: false }).reasons.join(' '),
      'needs Windows',
      'not off Windows',
    );
    const unavailable = () => ({ available: false, reasons: ['No.'], fixes: ['Fix it.'] });
    await t.throws(
      () => providerFor(vhdxConfig, { availability: unavailable }),
      'Contained storage cannot be used: No.',
      'the provider is refused with the reasons',
    );
    await t.throws(
      () => providerFor(vhdxConfig, { availability: () => containedAvailability(facts) }),
      'was not set up',
      'and needs its deps',
    );
    t.equal(providerFor(config).id, 'folder', 'off: the folder provider');
    const providerBase = t.dir('contained', 'provider');
    const providerPaths = containedPaths(providerBase, 'main');
    const providerPort = new FakePort(providerPaths);
    providerPort.imageExists = true;
    const provider = providerFor(vhdxConfig, {
      availability: () => containedAvailability(facts),
      contained: {
        ...deps,
        storageRoot: providerBase,
        port: providerPort,
        alive: () => true,
        deviceOf: (dir) => (dir === providerPaths.mount && providerPort.mounted ? 2 : 1),
      },
    });
    t.equal(provider.id, 'vhdx-mounted', 'on: the vhdx-mounted provider');
    const providerData = t.dir('contained', 'provider', 'data', 'main');
    const prepared = await provider.prepare({ dataPath: providerData, guest: GUEST_DATA });
    t.equal(
      prepared.mappings,
      containedMappings(providerData, providerPaths.mount, GUEST_DATA),
      'prepare mounts and returns the split',
    );
    t.equal(prepared.attachments.length, prepared.mappings.length, 'one attachment for each mapping');
    t.check(fs.existsSync(path.join(providerData, 'run')), 'the run folder exists on this PC');
    await provider.release();
    t.equal(providerPort.calls, ['mount', 'dismount'], 'release lets go and, with nobody else holding it, dismounts');

    t.section('a repair check only shows up when contained storage is in use');
    const env = { ctx: { loaded: { config } }, storageRoot: t.dir('contained', 'doctor') } as unknown as RepairEnv;
    t.equal(
      CONTAINED_CHECKS.map((c) => c.applies?.(env) ?? true),
      [false, false],
      'not shown while it is off and no image exists',
    );

    t.section('moving the folders into the image and back');
    const home = t.dir('contained', 'move', 'plain');
    const image = t.dir('contained', 'move', 'image');
    t.write(path.join(home, 'tools', 'node', 'node.exe'), 'node');
    t.write(path.join(home, 'tools', 'bin', 'a.txt'), 'a');
    t.write(path.join(home, 'logs', 'daemon.log'), 'log');
    t.dir('contained', 'move', 'plain', 'state');
    t.write(path.join(home, 'run', 'sandbox.json'), '{}');
    const plan = planTransfer(home, image, home);
    t.equal(
      plan.folders.map((p) => p.name),
      ['tools', 'logs'],
      'only folders that hold something, never run',
    );
    t.equal([plan.total.files, plan.total.bytes], [3, 8], 'size and file count are measured first');
    t.check(plan.estimate.seconds >= 0 && plan.estimate.fits, 'with a time and room check');
    const moved = await runTransfer(plan, home);
    t.equal([moved.files, moved.notes], [3, []], 'everything is copied');
    t.equal(fs.readFileSync(path.join(image, 'tools', 'node', 'node.exe'), 'utf8'), 'node', 'the content arrived');
    t.check(
      !fs.existsSync(path.join(home, 'tools')) && !fs.existsSync(path.join(home, 'logs')),
      'the originals are removed afterwards',
    );
    t.check(fs.existsSync(path.join(home, 'run', 'sandbox.json')), 'the run folder was not touched');
    const back = planTransfer(image, home, home);
    t.equal(
      back.folders.map((p) => p.name),
      ['tools', 'logs'],
      'moving back out lists the same folders',
    );
    t.write(path.join(home, 'logs', 'blocker.log'), 'x');
    await t.throws(
      () => runTransfer(back, image),
      'already holds files',
      'a target that holds files is never merged or overwritten',
    );
    t.check(fs.existsSync(path.join(image, 'tools', 'node', 'node.exe')), 'and nothing was removed from the image');
    fs.rmSync(path.join(home, 'logs'), { recursive: true });
    const returned = await runTransfer(back, image);
    t.equal(returned.files, 3, 'with the target free, the files go back');
    t.check(
      fs.existsSync(path.join(home, 'tools', 'node', 'node.exe')) && !fs.existsSync(path.join(image, 'tools')),
      'and leave the image',
    );

    t.section('the disk port asks the scripts, through files');
    const seen: { args: string[]; request: Record<string, unknown>; sha: string; fileSha: string }[] = [];
    const runner: Runner = (_file, args) => {
      const json = args[args.indexOf('-Json') + 1];
      const sha = args[args.indexOf('-Sha256') + 1];
      seen.push({
        args: [...args],
        request: JSON.parse(fs.readFileSync(json, 'utf8')) as Record<string, unknown>,
        sha,
        fileSha: crypto.createHash('sha256').update(fs.readFileSync(json)).digest('hex'),
      });
      fs.writeFileSync(
        path.join(path.dirname(json), 'result.json'),
        JSON.stringify({ ok: true, message: 'ok', created: true, notes: 'one' }),
      );
      return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    };
    const fakeSid = 'S-1-5-21-1-2-3-1001';
    const outcome = await new ScriptDiskPort(runner).mount({
      paths: lifePaths,
      maxGb: 64,
      create: true,
      userSid: fakeSid,
    });
    t.equal([outcome.ok, outcome.created, outcome.notes], [true, true, ['one']], 'the answer is read from result.json');
    t.equal(
      seen[0].request,
      {
        set: 'main',
        storageRoot: lifePaths.storageRoot,
        image: lifePaths.image,
        mount: lifePaths.mount,
        userSid: fakeSid,
        maxGb: 64,
        create: true,
      },
      'the request names the image, the mount folder and your SID',
    );
    t.equal(seen[0].sha, seen[0].fileSha, 'with the checksum of the request file, which the script checks');
    t.check(
      seen[0].args.includes('run-elevated.ps1') || seen[0].args.some((a) => a.endsWith('run-elevated.ps1')),
      'it goes through the one elevation helper',
    );
    t.check(
      seen[0].args.some((a) => a.endsWith('mount-contained.ps1')),
      'which runs the fixed mount script',
    );
    t.check(
      !fs.existsSync(path.dirname(String(seen[0].args[seen[0].args.indexOf('-Json') + 1]))),
      'the private temp folder is removed afterwards',
    );
    const silent: Runner = () => Promise.resolve({ status: 1, stdout: '', stderr: '' });
    await t.throws(
      () => new ScriptDiskPort(silent).dismount({ paths: lifePaths, userSid: fakeSid }),
      'did not give permission',
      'a declined prompt is said plainly',
    );

    if (!isWin) {
      t.skip('PowerShell scripts (needs Windows PowerShell 5.1)');
      return;
    }

    t.section('the scripts: encoding, syntax');
    const scriptDir = path.join(t.packageRoot, 'native', 'scripts');
    for (const name of SCRIPTS) {
      const file = path.join(scriptDir, name + '.ps1');
      const text = fs.readFileSync(file, 'utf8');
      t.check(!/(?<!\r)\n/.test(text) && text.includes('\r\n'), name + '.ps1 is CRLF all the way');
      t.check(text.startsWith('#Requires -Version 5.1'), name + '.ps1 starts with #Requires -Version 5.1');
      const parse = spawnSync(
        SYSTEM.powershell(),
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(scriptDir, 'check-syntax.ps1'),
          '-Path',
          file,
        ],
        { encoding: 'utf8' },
      );
      t.check(parse.status === 0, name + '.ps1 parses in PowerShell 5.1', parse.stderr + parse.stdout);
    }
    for (const name of ['mount-contained', 'dismount-contained']) {
      const text = fs.readFileSync(path.join(scriptDir, name + '.ps1'), 'utf8');
      t.check(/^param\(/m.test(text), name + '.ps1 has a param() block');
    }
    const mountText = fs.readFileSync(path.join(scriptDir, 'mount-contained.ps1'), 'utf8');
    const dismountText = fs.readFileSync(path.join(scriptDir, 'dismount-contained.ps1'), 'utf8');
    t.equal((mountText.match(/format fs=ntfs/g) ?? []).length, 1, 'the mount script has exactly one format line');
    const formatAt = mountText.indexOf('format fs=ntfs');
    const elseAt = mountText.lastIndexOf('} else {', formatAt);
    t.check(
      elseAt > mountText.indexOf('# Attach and mount the first partition') &&
        mountText.slice(elseAt, formatAt).includes('create vdisk'),
      'and it sits in the branch for an image that did not exist',
    );
    const code = (text: string): string =>
      text
        .split('\r\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
    t.check(
      !/format|create vdisk|delete|Remove-Item|clean all/i.test(code(dismountText)),
      'the dismount script never formats, creates or deletes',
    );
    t.check(!/Remove-Item|del |Delete\(/i.test(code(mountText)), 'the mount script never deletes anything');

    t.section('the scripts in dry-run: what they print and what they refuse');
    const sid = currentUserSid();
    const dryRoot = t.dir('contained', 'dry', 'storage');
    const dry = containedPaths(dryRoot, 'main');
    for (const dir of [dry.imagesDir, dry.mountsDir, dry.mount]) fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    const dryRun = (script: string, request: object, extra: string[] = []): { status: number | null; out: string } => {
      const dir = t.dir('contained', 'dry', 'req' + n++);
      const file = path.join(dir, 'request.json');
      fs.writeFileSync(file, JSON.stringify(request));
      const r = spawnSync(
        SYSTEM.powershell(),
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(scriptDir, script + '.ps1'),
          '-Json',
          file,
          '-DryRun',
          ...extra,
        ],
        { encoding: 'utf8' },
      );
      return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
    };
    const request = (over: object = {}): object => ({
      set: 'main',
      storageRoot: dry.storageRoot,
      image: dry.image,
      mount: dry.mount,
      userSid: sid,
      maxGb: 64,
      create: false,
      ...over,
    });
    const diskpartLines = (out: string): string[] =>
      out
        .split(/\r?\n/)
        .filter((l) => l.startsWith('DISKPART: '))
        .map((l) => l.slice(10));

    const created = dryRun('mount-contained', request({ create: true }));
    t.check(
      created.status === 0 && created.out.includes('RESULT: ok'),
      'a first mount (no image yet) is accepted',
      created.out,
    );
    t.equal(
      diskpartLines(created.out),
      [
        `create vdisk file="${dry.image}" maximum=65536 type=expandable`,
        `select vdisk file="${dry.image}"`,
        'attach vdisk',
        'create partition primary',
        'format fs=ntfs quick label=AgentData',
        `assign mount="${dry.mount}"`,
      ],
      'it would create a dynamic image of the size limit, partition, format and mount it',
    );

    fakeVhdx(dry.image, { gb: 64 });
    const existing = dryRun('mount-contained', request());
    t.check(existing.status === 0, 'an existing image is accepted', existing.out);
    t.equal(
      diskpartLines(existing.out),
      [`select vdisk file="${dry.image}"`, 'attach vdisk', 'select partition 1', `assign mount="${dry.mount}"`],
      'an existing image is only attached and mounted',
    );
    t.check(!/format|create /i.test(existing.out.replace('RESULT: ok', '')), 'never formatted, never created over');
    const named = diskpartLines(existing.out)
      .concat(diskpartLines(created.out))
      .filter((l) => /file=|mount=/.test(l));
    t.check(
      named.every((l) =>
        [...l.matchAll(/(?:file|mount)="([^"]*)"/g)].every((m) => m[1] === dry.image || m[1] === dry.mount),
      ),
      'every diskpart line names only the given image file and mount folder',
    );
    const detach = dryRun('dismount-contained', request());
    t.check(detach.status === 0, 'a dismount is accepted', detach.out);
    t.equal(
      diskpartLines(detach.out),
      [`select vdisk file="${dry.image}"`, 'detach vdisk'],
      'it would only detach this image',
    );

    const refused = (what: string, run: { status: number | null; out: string }, text: string): void =>
      t.check(
        run.status === 1 &&
          run.out.includes('RESULT: refused') &&
          run.out.toLowerCase().includes(text.toLowerCase()) &&
          diskpartLines(run.out).length === 0,
        'refused: ' + what,
        run.out,
      );
    const outside = t.dir('contained', 'dry', 'outside');
    refused(
      'an image outside the storage folder',
      dryRun('mount-contained', request({ image: path.join(outside, 'main.vhdx') })),
      'must be',
    );
    refused(
      'a mount folder outside the storage folder',
      dryRun('mount-contained', request({ mount: outside })),
      'must be',
    );
    refused(
      'a storage folder that is not the one the paths are in',
      dryRun('mount-contained', request({ storageRoot: outside })),
      'must be',
    );
    refused(
      'a path with ..',
      dryRun('mount-contained', request({ image: dry.imagesDir + '\\..\\images\\main.vhdx' })),
      'plain full path',
    );
    refused('a relative path', dryRun('mount-contained', request({ mount: 'mounts\\main' })), 'plain full path');
    refused('a data set name that is not allowed', dryRun('mount-contained', request({ set: 'a b' })), 'not allowed');
    refused(
      'another user (the files are not theirs)',
      dryRun('mount-contained', request({ userSid: 'S-1-5-21-1-2-3-1001' })),
      'not yours',
    );
    refused('a size limit out of range', dryRun('mount-contained', request({ maxGb: 100000 })), 'between 8 and 4096');
    refused(
      'a wrong checksum',
      dryRun('mount-contained', request(), ['-Sha256', '00']),
      'changed after it was written',
    );
    refused(
      'creating over an image that exists',
      dryRun('mount-contained', request({ create: true })),
      'refusing to create over',
    );

    const gone = path.join(dry.imagesDir, 'main.vhdx.away');
    fs.renameSync(dry.image, gone);
    refused('an image that is missing when it should exist', dryRun('mount-contained', request()), 'missing');
    refused('a dismount of an image that is missing', dryRun('dismount-contained', request()), 'missing');
    fakeVhdx(dry.image, { gb: 64, parent: true });
    refused('a differencing image (it has a parent)', dryRun('mount-contained', request()), 'differencing');
    fakeVhdx(dry.image, { gb: 128 });
    refused('an image bigger than the limit', dryRun('mount-contained', request()), 'bigger than the limit');
    fs.writeFileSync(dry.image, 'not a vhdx');
    refused('a file that is not a VHDX', dryRun('mount-contained', request()), 'not a VHDX');
    fakeVhdx(dry.image, { gb: 64 });

    fs.writeFileSync(path.join(dry.mount, 'stray.txt'), 'x');
    refused('a mount folder that is not empty', dryRun('mount-contained', request()), 'not empty');
    fs.rmSync(path.join(dry.mount, 'stray.txt'));

    const linkTarget = t.dir('contained', 'dry', 'linktarget');
    const linkedRoot = t.dir('contained', 'dry', 'linked');
    const linked = containedPaths(linkedRoot, 'main');
    fs.mkdirSync(linked.mountsDir, { recursive: true });
    fs.mkdirSync(linked.mount, { recursive: true });
    const junction = spawnSync(SYSTEM.cmd(), ['/c', 'mklink', '/J', linked.imagesDir, linkTarget], {
      encoding: 'utf8',
    });
    if (junction.status === 0) {
      fakeVhdx(path.join(linkTarget, 'main.vhdx'), { gb: 8 });
      refused(
        'an images folder that is a link',
        dryRun('mount-contained', {
          ...request(),
          storageRoot: linked.storageRoot,
          image: linked.image,
          mount: linked.mount,
        }),
        'link',
      );
      fs.rmdirSync(linked.imagesDir);
    } else t.skip('images folder as a junction (could not make one here)');
    const linkedRoot2 = t.dir('contained', 'dry', 'linked2');
    const linked2 = containedPaths(linkedRoot2, 'main');
    fs.mkdirSync(linked2.imagesDir, { recursive: true });
    fs.mkdirSync(linked2.mountsDir, { recursive: true });
    fs.mkdirSync(linked2.mount, { recursive: true });
    fakeVhdx(path.join(linkTarget, 'real.vhdx'), { gb: 8 });
    try {
      fs.symlinkSync(path.join(linkTarget, 'real.vhdx'), linked2.image, 'file');
      refused(
        'an image file that is a link',
        dryRun('mount-contained', {
          ...request(),
          storageRoot: linked2.storageRoot,
          image: linked2.image,
          mount: linked2.mount,
        }),
        'link',
      );
    } catch {
      t.skip('image as a symbolic link (not allowed here)');
    }
    const junctionMount = t.dir('contained', 'dry', 'linked3');
    const linked3 = containedPaths(junctionMount, 'main');
    fs.mkdirSync(linked3.imagesDir, { recursive: true });
    fs.mkdirSync(linked3.mountsDir, { recursive: true });
    fakeVhdx(linked3.image, { gb: 8 });
    const mountJunction = spawnSync(SYSTEM.cmd(), ['/c', 'mklink', '/J', linked3.mount, linkTarget], {
      encoding: 'utf8',
    });
    if (mountJunction.status === 0) {
      refused(
        'a mount folder that is already a link or mount point',
        dryRun('mount-contained', {
          ...request(),
          storageRoot: linked3.storageRoot,
          image: linked3.image,
          mount: linked3.mount,
        }),
        'mount point',
      );
      fs.rmdirSync(linked3.mount);
    } else t.skip('mount folder as a junction (could not make one here)');

    t.section('the status script only looks');
    const look = spawnSync(
      SYSTEM.powershell(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(scriptDir, 'check-contained.ps1'),
        '-Image',
        dry.image,
        '-Mount',
        dry.mount,
      ],
      { encoding: 'utf8' },
    );
    const answer = JSON.parse(look.stdout) as Record<string, unknown>;
    t.check(
      look.status === 0 &&
        answer.imageExists === true &&
        answer.mountExists === true &&
        answer.mountIsMountPoint === false,
      'it reports the image and a plain mount folder',
      look.stdout + look.stderr,
    );
    const real = await new ScriptDiskPort().reality(dry);
    t.check(real.imageExists && real.mountExists && !real.mountIsMountPoint, 'and the disk port reads that answer');
  },
};
