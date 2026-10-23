// Live folders through HCS (opt-in alpha, docs/design/hcs-live-folders.md "Test plan", unit part): the signed
// host -> guest messages, the guest daemon's handler with a fake bind filter, the host's LiveFolders with a fake
// elevated helper (canary matched, wrong and late), the mapper's order (roots, wsb share, HCS, restart), the doctor
// row, and the refusals of HcsHost.exe and hcs-live-share.ps1 (no Hyper-V needed: all refused before HCS is asked).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isWin } from '../core/util/index.js';
import { LiveFolderHandler, type BindPort } from '../guest/daemon/live-folders.js';
import { buildHcsHostTo, HcsHelper } from '../host/engines/hcs/helper.js';
import {
  clearLiveRecord,
  LiveFolders,
  ScriptLivePort,
  type ElevatedLivePort,
  type LiveShareRequest,
} from '../host/engines/hcs/live-folders.js';
import { SecretStore } from '../host/secrets/index.js';
import { addFoldersRow, NeedsRestart, ProjectRegistry, projectMapper, type LivePort } from '../host/projects/index.js';
import { nativeFile } from '../host/native.js';
import { insideSandbox } from '../host/sandbox/index.js';
import { LiveReplySchema, newLiveKey, openLive, RunDir, signLive, type LivePayload } from '../shared/channel/index.js';
import { liveGuestFolder } from '../shared/paths/index.js';
import { SYSTEM } from '../shared/system.js';
import type { Suite } from './support/suite.js';

const LAUNCH = '1700000000000-abcdef';
const GUID = '0b9a3c2e-1f00-4a4c-9d1e-6a7b8c9d0e1f';

const payload = (over: Partial<LivePayload> = {}): LivePayload => ({
  v: 1,
  kind: 'map',
  id: 'req' + crypto.randomBytes(4).toString('hex'),
  launchId: LAUNCH,
  share: 'agentsbx-0123abcd',
  folder: 'web',
  readOnly: true,
  createdAt: new Date().toISOString(),
  ...over,
});

/** A request signed over any text (to send payloads signLive itself would refuse). */
const signRaw = (key: string, text: string): { payload: string; mac: string } => ({
  payload: text,
  mac: crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(text, 'utf8').digest('hex'),
});

/** A bind filter in memory: a "share" is a token; map makes the folder with token.txt, unmap removes it. */
class FakeBind implements BindPort {
  readonly calls: string[] = [];
  readonly tokens = new Map<string, string>();
  missingFor = 0;

  map(folder: string, share: string, readOnly: boolean): number {
    this.calls.push('map ' + path.win32.basename(folder) + ' ' + share + (readOnly ? ' ro' : ' rw'));
    if (this.missingFor > 0) {
      this.missingFor--;
      return 3;
    }
    if (!this.tokens.has(share)) return 3;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'token.txt'), this.tokens.get(share) ?? '');
    return 0;
  }

  unmap(folder: string): number {
    this.calls.push('unmap ' + path.win32.basename(folder));
    fs.rmSync(folder, { recursive: true, force: true });
    return 0;
  }

  mapped(folder: string): number {
    return fs.existsSync(folder) ? 0 : 4;
  }
}

export const liveFoldersSuite: Suite = {
  name: 'live-folders',
  title:
    'live folders through HCS (alpha): signed requests, guest handler, LiveFolders, mapper order, HcsHost refusals',
  timeoutMs: 240000,
  run: async (t) => {
    t.section('live folders: signed requests');
    const key = newLiveKey();
    const signed = signLive(key, payload({ id: 'a1' }));
    const now = Date.now();
    const ok = openLive(key, signed, { launchId: LAUNCH, now });
    const tampered = openLive(
      key,
      { ...signed, payload: signed.payload.replace('"web"', '"api"') },
      { launchId: LAUNCH, now },
    );
    const wrongKey = openLive(newLiveKey(), signed, { launchId: LAUNCH, now });
    const otherLaunch = openLive(key, signed, { launchId: '1700000000001-000000', now });
    const old = openLive(key, signed, { launchId: LAUNCH, now: now + 3 * 60_000 });
    const noKey = openLive(null, signed, { launchId: LAUNCH, now });
    t.check(
      'payload' in ok &&
        'refused' in tampered &&
        'refused' in wrongKey &&
        'refused' in otherLaunch &&
        'refused' in old &&
        'refused' in noKey,
      'a request opens only with its key, untouched, for this launch and while fresh',
    );
    const aliases = ['..', 'foo.', 'foo ', 'Foo', 'a\\b', ''].map((folder) =>
      openLive(key, signRaw(key, JSON.stringify({ ...payload(), folder })), { launchId: LAUNCH, now }),
    );
    const foreignShare = openLive(
      key,
      signRaw(
        key,
        JSON.stringify({ ...payload(), share: '3ad483dec1a233132da4197c9790dcda06668793230cd6d9e94b1882e0f7f29c' }),
      ),
      { launchId: LAUNCH, now },
    );
    const extra = openLive(key, signRaw(key, JSON.stringify({ ...payload(), path: 'C:\\Windows' })), {
      launchId: LAUNCH,
      now,
    });
    t.check(
      aliases.every((r) => 'refused' in r) && 'refused' in foreignShare && 'refused' in extra,
      "even signed: folder names '..', 'foo.', 'foo ', upper case, a path, a Windows Sandbox share name or an extra field are refused",
    );
    t.check(
      liveGuestFolder('D:\\code\\My.App') === 'C:\\Workspace\\my-app' &&
        liveGuestFolder('D:\\x\\web', ['C:\\Workspace\\web']) === 'C:\\Workspace\\web-2' &&
        liveGuestFolder('D:\\x\\...') === 'C:\\Workspace\\project',
      'a live folder gets a strict C:\\Workspace\\<name> (lower case, no dots), unique against the folders in use',
    );

    t.section('live folders: the guest handler (fake bind filter)');
    const data = t.dir('live-data');
    const run = new RunDir(data);
    const workspaces = t.dir('live-ws');
    const bind = new FakeBind();
    const logs: string[] = [];
    const handler = new LiveFolderHandler({
      run,
      stateFile: t.at('live-daemon', 'live-folders.json'),
      launchId: LAUNCH,
      bind,
      workspaces,
      sleep: async () => undefined,
      tries: 5,
      log: (l) => logs.push(l),
    });
    const send = async (envelope: unknown, id = 'x' + crypto.randomBytes(3).toString('hex')): Promise<void> => {
      t.writeJson(path.join(run.liveDir, id + '.json'), envelope);
      handler.tick();
      await handler.idle();
    };
    const replyOf = (id: string) => {
      const file = run.liveReplyFile(id);
      if (!fs.existsSync(file)) return null;
      const parsed = LiveReplySchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      return parsed.success ? parsed.data : null;
    };
    await send(signLive(key, payload({ id: 'nokey' })));
    t.check(
      replyOf('nokey') === null && fs.readdirSync(run.liveDir).length === 0,
      'without a key nothing is done and the file is deleted',
    );
    handler.setKey(key);
    const token = crypto.randomBytes(16).toString('hex');
    bind.tokens.set('agentsbx-cafe0001', token);
    bind.missingFor = 2;
    await send(
      signLive(key, payload({ id: 'c1', kind: 'canary', share: 'agentsbx-cafe0001', folder: 'live-canary-01' })),
    );
    const canary = replyOf('c1');
    t.check(
      canary?.ok === true &&
        canary.token === token &&
        bind.calls.filter((c) => c.startsWith('map live-canary-01')).length === 3 &&
        !fs.existsSync(path.join(workspaces, 'live-canary-01')),
      'a canary is retried while the share is not there yet, answers with the token read from it, and is hidden again',
      JSON.stringify({ canary, calls: bind.calls }),
    );
    bind.tokens.set('agentsbx-0123abcd', 'x');
    await send(signLive(key, payload({ id: 'm1', folder: 'web', readOnly: false })));
    t.check(
      replyOf('m1')?.ok === true &&
        bind.calls.includes('map web agentsbx-0123abcd rw') &&
        fs.existsSync(path.join(workspaces, 'web')),
      'a map shows the share at C:\\Workspace\\<name>, writable only when the signed request says so',
    );
    await send(signLive(key, payload({ id: 'm1' })));
    t.check(replyOf('m1') === null || logs.some((l) => l.includes('seen before')), 'a replayed request id is ignored');
    fs.rmSync(run.liveReplyFile('m1'), { force: true });
    await send(signLive(key, payload({ id: 'm1' })));
    t.check(
      replyOf('m1') === null && logs.some((l) => l.includes('seen before')),
      'the same id twice is acted on once',
    );
    t.dir('live-ws', 'taken');
    await send(signLive(key, payload({ id: 'm2', folder: 'taken' })));
    t.check(
      replyOf('m2')?.ok === false && /exists already/.test(replyOf('m2')?.message ?? ''),
      'a folder that exists already is refused',
    );
    await send({ payload: signed.payload, mac: '0'.repeat(64) }, 'forged');
    await send(signRaw(key, JSON.stringify({ ...payload({ id: 'dots' }), folder: '..' })), 'dots');
    t.check(
      replyOf('forged') === null && replyOf('dots') === null && fs.readdirSync(run.liveDir).length === 0,
      'a forged signature or a signed alias name is deleted unread and never answered',
    );
    // run\live can be written by the agent (an administrator in the sandbox) and by other users of a shared sandbox:
    // only the signature counts, so a planted folder or link there is removed and never followed.
    const planted = path.join(run.liveDir, 'planted.json');
    fs.mkdirSync(planted, { recursive: true });
    t.write(path.join(planted, 'inside.txt'), 'x');
    handler.tick();
    await handler.idle();
    t.check(!fs.existsSync(planted), 'a folder planted in run\\live is removed unread');
    await send(signLive(key, payload({ id: 'u0', kind: 'unmap', share: undefined, folder: 'other' })));
    t.check(replyOf('u0')?.ok === false, 'unmap only takes folders this handler mapped');
    const handler2 = new LiveFolderHandler({
      run,
      stateFile: t.at('live-daemon', 'live-folders.json'),
      launchId: LAUNCH,
      bind,
      workspaces,
    });
    fs.rmSync(path.join(workspaces, 'web'), { recursive: true, force: true });
    t.check(
      handler2.reapply() === 1 && fs.existsSync(path.join(workspaces, 'web')),
      'when the daemon starts again it shows the recorded mappings again',
    );
    await send(signLive(key, payload({ id: 'u1', kind: 'unmap', share: undefined, folder: 'web' })));
    t.check(
      replyOf('u1')?.ok === true && !fs.existsSync(path.join(workspaces, 'web')) && handler2.reapply() === 0,
      'unmap hides the folder, checks it is gone and forgets it',
    );

    t.section('live folders: LiveFolders on the host (fake elevated helper, the handler as the sandbox)');
    const storage = t.dir('live-storage');
    const hostData = path.join(storage, 'data', 'testdata');
    t.dir('live-storage', 'data', 'testdata');
    const hostRun = new RunDir(hostData);
    const guestBind = new FakeBind();
    const guest = new LiveFolderHandler({
      run: hostRun,
      stateFile: t.at('live-daemon2', 'live-folders.json'),
      launchId: LAUNCH,
      bind: guestBind,
      workspaces: t.dir('live-ws2'),
      sleep: async () => undefined,
      tries: 2,
    });
    let guestOn = true;
    const ticker = setInterval(() => {
      if (guestOn) guest.tick();
    }, 50);
    /** The elevated helper's part: a canary token (what the guest's share holds), the real share only on a match. */
    const shares: string[] = [];
    let wrongToken = false;
    let failRemove = false;
    const requests: LiveShareRequest[] = [];
    const elevated: ElevatedLivePort = {
      run: async (request, onCanary) => {
        requests.push(request);
        if (request.action === 'remove') {
          if (failRemove) return { ok: false, message: 'The Host Compute Service said: busy' };
          shares.splice(shares.indexOf(request.name), 1);
          return { ok: true, message: 'removed', id: GUID };
        }
        const canaryShare = 'agentsbx-' + crypto.randomBytes(8).toString('hex');
        const canaryToken = crypto.randomBytes(16).toString('hex');
        guestBind.tokens.set(canaryShare, wrongToken ? crypto.randomBytes(16).toString('hex') : canaryToken);
        const answer = await onCanary(canaryShare);
        if (answer !== canaryToken)
          return {
            ok: false,
            message: 'wrong token or no answer',
            id: GUID,
            canary: answer ? 'wrong token' : 'no answer',
          };
        shares.push(request.name);
        guestBind.tokens.set(request.name, 'real');
        return { ok: true, message: 'added', id: GUID, canary: 'matched' };
      },
    };
    const live = new LiveFolders({
      storageRoot: storage,
      dataPath: hostData,
      secrets: SecretStore.memory(),
      elevated,
      exe: () => ({ path: 'C:\\x\\HcsHost.exe', sha256: 'a'.repeat(64) }),
      userSid: () => 'S-1-5-21-1-2-3-1001',
      pollMs: 20,
      canaryMs: 3000,
      mapMs: 3000,
    });
    t.check(
      /turn it on before it starts/.test(live.unavailable(LAUNCH) ?? ''),
      'no record: live folders are unavailable, and the reason says why',
    );
    const launchKey = live.startLaunch(LAUNCH);
    guest.setKey(launchKey);
    const recordText = fs.readFileSync(path.join(storage, 'state', 'live-folders.json'), 'utf8');
    t.check(
      /^[0-9a-f]{64}$/.test(launchKey) && !recordText.includes(launchKey) && live.unavailable(LAUNCH) === null,
      'a launch makes a key, kept sealed in the host-only record (never in plain text)',
    );
    t.check(
      /earlier sandbox/.test(live.unavailable('1700000000009-999999') ?? ''),
      'a record of another launch is not used',
    );
    const hostFolder = t.dir('live-project');
    const added = await live.add({
      launchId: LAUNCH,
      host: hostFolder,
      guest: 'C:\\Workspace\\live-project',
      folder: 'live-project',
      readOnly: true,
    });
    const rec = live.read();
    t.check(
      shares.includes(added.name) &&
        rec?.systemId === GUID &&
        rec.shares.length === 1 &&
        requests[0].id === '' &&
        requests[0].readOnly === true &&
        requests[0].path === hostFolder &&
        guestBind.calls.some((c) => c === 'map live-project ' + added.name + ' ro'),
      'add: the canary comes back through the sandbox, then the folder is shared read-only, recorded with the proved id and shown inside',
      JSON.stringify({ rec, calls: guestBind.calls }),
    );
    const second = t.dir('live-project-2');
    await live.add({
      launchId: LAUNCH,
      host: second,
      guest: 'C:\\Workspace\\live-project-2',
      folder: 'live-project-2',
      readOnly: false,
    });
    t.check(
      requests[requests.length - 1].id === GUID,
      'later adds name the recorded sandbox id (a restarted sandbox is refused by HcsHost)',
    );
    wrongToken = true;
    const before = shares.length;
    const third = t.dir('live-project-3');
    const mismatch = await t.thrownMessage(() =>
      live.add({
        launchId: LAUNCH,
        host: third,
        guest: 'C:\\Workspace\\live-project-3',
        folder: 'live-project-3',
        readOnly: true,
      }),
    );
    wrongToken = false;
    t.check(
      /not shared/.test(mismatch) && shares.length === before && live.read()?.shares.length === 2,
      'a canary token that does not match: the real folder is never shared and nothing is recorded',
      mismatch,
    );
    guestOn = false;
    const late = await t.thrownMessage(() =>
      live.add({
        launchId: LAUNCH,
        host: third,
        guest: 'C:\\Workspace\\live-project-3',
        folder: 'live-project-3',
        readOnly: true,
      }),
    );
    guestOn = true;
    t.check(
      /not shared/.test(late) && shares.length === before && live.read()?.shares.length === 2,
      'no canary answer in time: the real folder is never shared',
      late,
    );
    failRemove = true;
    const keep = await t.thrownMessage(() => live.remove(LAUNCH, second));
    failRemove = false;
    t.check(
      /could not be removed/.test(keep) && live.read()?.shares.length === 2,
      'a share that cannot be removed stays in the record (and the user is told)',
      keep,
    );
    await live.remove(LAUNCH, hostFolder);
    t.check(
      !shares.includes(added.name) &&
        live.read()?.shares.length === 1 &&
        guestBind.calls.includes('unmap live-project'),
      'remove: the guest mapping first, then the share, then the record',
    );
    t.check(
      !clearLiveRecord(storage, path.join(storage, 'data', 'other')) &&
        live.read() !== null &&
        clearLiveRecord(storage, hostData) &&
        live.read() === null,
      'a stop clears the record of its own data folder only',
    );
    clearInterval(ticker);

    t.section('live folders: the elevated script port relays the canary (fake runner)');
    const relay = async (token: string | null): Promise<{ answer: string; ok: boolean }> => {
      let answer = '';
      const port = new ScriptLivePort(
        async (_file, args) => {
          const json = args[args.indexOf('-Json') + 1];
          const dir = path.dirname(json);
          fs.writeFileSync(path.join(dir, 'canary.json'), JSON.stringify({ share: 'agentsbx-00000000aaaa' }));
          for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'answer.txt')); i++)
            await new Promise((r) => setTimeout(r, 20));
          answer = fs.existsSync(path.join(dir, 'answer.txt'))
            ? fs.readFileSync(path.join(dir, 'answer.txt'), 'utf8')
            : '';
          fs.writeFileSync(
            path.join(dir, 'result.json'),
            JSON.stringify({ ok: answer === 'f'.repeat(32), message: 'm', id: GUID }),
          );
          return { status: 0 };
        },
        t.dir('live-tmp'),
        10,
      );
      const outcome = await port.run(
        {
          action: 'add',
          id: '',
          name: 'agentsbx-0123abcd',
          path: hostFolder,
          readOnly: true,
          storageRoot: storage,
          dataPath: hostData,
          userSid: 'S-1-5-21-1',
          exe: 'C:\\x\\HcsHost.exe',
          exeSha256: 'a'.repeat(64),
        },
        async () => token,
      );
      return { answer, ok: outcome.ok };
    };
    const good = await relay('f'.repeat(32));
    const none = await relay(null);
    const junk = await relay('not-a-token');
    t.check(
      good.answer === 'f'.repeat(32) && good.ok && none.answer === 'none' && !none.ok && junk.answer === 'none',
      "the canary token goes to the helper as it came; no answer (or anything that is not a token) is 'none'",
      JSON.stringify({ good, none, junk }),
    );
    t.check(fs.readdirSync(t.at('live-tmp')).length === 0, 'the private request folder is removed afterwards');

    t.section('live folders: the mapper tries roots, then wsb share, then HCS, then a restart');
    const mStorage = t.dir('live-map');
    const root = t.dir('live-map-root');
    const inRoot = t.dir('live-map-root', 'web');
    const outside = t.dir('live-map-outside');
    new ProjectRegistry(mStorage).start({
      launchId: LAUNCH,
      protections: {},
      primary: { host: t.dir('live-map-primary'), guest: 'C:\\Workspace\\live-map-primary' },
      roots: [{ host: root, guest: 'C:\\Projects\\live-map-root' }],
      boot: [],
    });
    const liveCalls: string[] = [];
    let liveFails = false;
    const fakeLive: LivePort = {
      unavailable: () => null,
      shareOf: (host) => (liveCalls.some((c) => c.startsWith('add ' + host)) ? ({ host } as never) : null),
      add: async (o) => {
        liveCalls.push('add ' + o.host + ' ' + o.guest + ' ' + (o.readOnly ? 'ro' : 'rw'));
        if (liveFails) throw new Error('canary did not match');
        return {
          name: 'agentsbx-0123abcd',
          host: o.host,
          guest: o.guest,
          folder: o.folder,
          readOnly: o.readOnly,
          addedAt: '',
        };
      },
      remove: async (_l, host) => {
        liveCalls.push('remove ' + host);
        if (liveFails) throw new Error('files are open');
      },
    };
    const withShare = () => ({
      exe: t.at('no-wsb.exe'),
      version: '0.1',
      commands: ['share', 'list'],
      has: (c: string) => c === 'share' || c === 'list',
    });
    const mapper = (o: {
      wsbShare?: boolean;
      detect?: () => ReturnType<typeof withShare> | null;
      mine?: boolean;
      unavailable?: string;
    }) =>
      projectMapper({
        storageRoot: mStorage,
        packageRoot: t.dir('live-map-install'),
        wsbShare: o.wsbShare ?? true,
        liveFolders: 'hcs',
        dataPath: path.join(mStorage, 'data', 'x'),
        detect: o.detect ?? (() => null),
        live: () => ({ ...fakeLive, unavailable: () => o.unavailable ?? null }),
        isMine: () => o.mine ?? true,
      });
    const fromRoot = await mapper({}).register(inRoot);
    t.check(
      fromRoot.mechanism === 'root' && liveCalls.length === 0,
      'a folder in a root joins as before; HCS is not asked',
    );
    let viaWsb: unknown = null;
    try {
      await mapper({ detect: withShare }).register(outside);
    } catch (e) {
      viaWsb = e;
    }
    t.check(
      viaWsb instanceof NeedsRestart && /wsb share/.test(viaWsb.reason) && liveCalls.length === 0,
      'where wsb share exists it is used (here it fails): HCS is never tried',
    );
    const offWsb = await t.thrownMessage(() => mapper({ wsbShare: false, detect: withShare }).register(outside));
    t.check(
      /projects.wsbShare/.test(offWsb) && liveCalls.length === 0,
      'wsb share switched off but present: a restart, never HCS',
    );
    const notMine = await t.thrownMessage(() => mapper({ mine: false }).register(outside));
    const noRecord = await t.thrownMessage(() =>
      mapper({ unavailable: 'turn it on before it starts' }).register(outside),
    );
    t.check(
      /not started by you/.test(notMine) && /turn it on before it starts/.test(noRecord) && liveCalls.length === 0,
      "another user's sandbox, or one started without live folders: a restart with the reason, HCS not asked",
    );
    const notes: string[] = [];
    const viaHcs = await mapper({}).register(outside, { readOnly: false, onNote: (n) => notes.push(n) });
    t.check(
      viaHcs.mechanism === 'hcs' &&
        viaHcs.guest === 'C:\\Workspace\\live-map-outside' &&
        liveCalls[0]?.endsWith(' rw') &&
        notes.some((n) => /save your work first/.test(n)),
      'no wsb share and liveFolders "hcs": HCS adds it (writable as the project would be), after the warning',
      JSON.stringify(liveCalls),
    );
    liveFails = true;
    const outside2 = t.dir('live-map-outside-2');
    let failed: unknown = null;
    try {
      await mapper({}).register(outside2);
    } catch (e) {
      failed = e;
    }
    t.check(
      failed instanceof NeedsRestart && /through HCS failed/.test(failed.reason) && liveCalls[1]?.endsWith(' ro'),
      'an HCS failure becomes a restart offer with the reason (read-only when the project mapping is not known)',
    );
    const kept = await t.thrownMessage(() => mapper({}).unregister(viaHcs.name));
    t.check(
      /files are open/.test(kept) &&
        new ProjectRegistry(mStorage).read()?.projects.some((p) => p.name === viaHcs.name) === true,
      'removing a live folder that cannot be hidden keeps the project',
    );
    liveFails = false;
    await mapper({}).unregister(viaHcs.name);
    t.check(
      liveCalls.includes('remove ' + fs.realpathSync.native(outside)) &&
        new ProjectRegistry(mStorage).read()?.projects.some((p) => p.name === viaHcs.name) === false,
      'removing a live folder hides it and removes its share, then forgets the project',
    );

    t.section('live folders: the doctor row');
    t.check(
      /^wsb share/.test(
        addFoldersRow({ wsbShare: true, liveFolders: 'hcs', wsbHasShare: true, liveUnavailable: null }),
      ) &&
        /^HCS \(alpha, untested on a real PC\): needs an administrator prompt/.test(
          addFoldersRow({ wsbShare: true, liveFolders: 'hcs', wsbHasShare: false, liveUnavailable: null }),
        ) &&
        /not for the running sandbox: x/.test(
          addFoldersRow({ wsbShare: true, liveFolders: 'hcs', wsbHasShare: false, liveUnavailable: 'x' }),
        ) &&
        /^restart/.test(
          addFoldersRow({ wsbShare: true, liveFolders: 'off', wsbHasShare: false, liveUnavailable: null }),
        ),
      '"Add folders while the sandbox runs" says wsb share, HCS (alpha, with the prompt) or restart, and why',
    );

    t.section('live folders: hcs-live-share.ps1 checks its request (dry run, nothing elevated)');
    if (!isWin) {
      t.skip('not Windows');
    } else {
      const dry = (request: Record<string, unknown>): { ok: boolean; out: string } => {
        const file = t.writeJson(t.at('live-dry', crypto.randomBytes(4).toString('hex') + '.json'), request);
        const r = spawnSync(
          SYSTEM.powershell(),
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            nativeFile('scripts', 'hcs-live-share.ps1'),
            '-Json',
            file,
            '-DryRun',
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 60000 },
        );
        return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
      };
      const base = {
        action: 'add',
        id: '',
        name: 'agentsbx-0123abcd',
        path: hostFolder,
        readOnly: true,
        storageRoot: storage,
        dataPath: hostData,
        userSid: 'S-1-5-21-1-2-3-1001',
        exe: 'C:\\x\\HcsHost.exe',
        exeSha256: 'a'.repeat(64),
      };
      const good2 = dry(base);
      t.check(
        good2.ok && /would add the share agentsbx-0123abcd/.test(good2.out),
        'a valid request passes the dry run',
        good2.out,
      );
      const bad = [
        dry({ ...base, name: '3ad483dec1a233132da4197c9790dcda06668793230cd6d9e94b1882e0f7f29c' }),
        dry({ ...base, action: 'update' }),
        dry({ ...base, exe: 'C:\\x\\other.exe' }),
        dry({ ...base, exe: 'C:\\x\\..\\HcsHost.exe' }),
        dry({ ...base, exeSha256: 'x' }),
        dry({ ...base, id: 'agent-sandbox-1' }),
        dry({ ...base, action: 'remove', id: '' }),
        dry({ ...base, readOnly: 'yes' }),
        dry({ ...base, path: 'relative' }),
      ];
      t.check(
        bad.every((b) => !b.ok && /refused/.test(b.out)),
        'it refuses a foreign share name, an update, another exe, a dotted path, a bad checksum or id, a remove without id, a non-boolean readOnly and a relative path',
        bad.map((b) => b.out.trim()).join(' | '),
      );
    }

    t.section('live folders: HcsHost.exe wsb-share and its rules (C# 5, no HCS asked)');
    if (!isWin || !fs.existsSync(SYSTEM.csc())) {
      t.skip('no Windows csc on this machine');
      return;
    }
    const exe = t.at('live-hcshost', 'HcsHost.exe');
    t.check(buildHcsHostTo(exe), 'HcsHost.exe builds');
    const raw = new HcsHelper(() => exe, undefined, t.dir('live-hcs-tmp'));
    const rules = (systems: unknown[], id?: string) => {
      const file = t.writeJson(t.at('live-enum', crypto.randomBytes(4).toString('hex') + '.json'), systems);
      return raw.call(['wsb-rules', file, ...(id ? [id] : [])]);
    };
    const sandbox = { Id: GUID, SystemType: 'VirtualMachine', Owner: 'Madrid', State: 'Running' };
    const one = rules([
      sandbox,
      { Id: 'agent-sandbox-x', SystemType: 'VirtualMachine', Owner: 'agent-sandbox', State: 'Running' },
    ]);
    t.check(
      one.ok && one.values.id === GUID,
      'exactly one running Windows Sandbox is found among other systems',
      JSON.stringify(one),
    );
    t.check(
      !rules([]).ok &&
        !rules([sandbox, { ...sandbox, Id: '1b9a3c2e-1f00-4a4c-9d1e-6a7b8c9d0e1f' }]).ok &&
        !rules([{ ...sandbox, Owner: 'CmService' }]).ok &&
        !rules([{ ...sandbox, State: 'Stopped' }]).ok &&
        !rules([{ ...sandbox, Id: 'WindowsSandbox' }]).ok &&
        !rules([{ ...sandbox, SystemType: 'Container' }]).ok &&
        !rules([sandbox], '1b9a3c2e-1f00-4a4c-9d1e-6a7b8c9d0e1f').ok &&
        !rules([sandbox], 'agent-sandbox-1').ok &&
        rules([sandbox], GUID.toUpperCase()).ok,
      'none, two, a wrong owner, a stopped one, a non-GUID id, a container, another recorded id or one of ours: refused',
    );
    const notJson = t.write(t.at('live-enum', 'bad.json'), 'not json');
    t.check(!raw.call(['wsb-rules', notJson]).ok, 'a list that is not JSON is refused');
    // wsb-share: refused before HCS is asked.
    const wsbShare = (request: Record<string, unknown>, sha?: string) => {
      const file = t.writeJson(t.at('live-req', crypto.randomBytes(4).toString('hex') + '.json'), request);
      const hash = sha ?? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      return raw.call(['wsb-share', file, '--sha256', hash]);
    };
    const req = {
      id: '',
      action: 'add',
      name: 'agentsbx-0123abcd',
      path: hostFolder,
      readOnly: true,
      storageRoot: storage,
      dataPath: hostData,
    };
    const usage = raw.call(['wsb-share', t.writeJson(t.at('live-req', 'nosha.json'), req)]);
    const changed = wsbShare(req, 'b'.repeat(64));
    t.check(!usage.ok && /Usage/.test(usage.message), 'wsb-share without the request checksum is a usage error');
    t.check(
      !changed.ok && /changed after it was checked/.test(changed.message),
      'a request file that changed after it was hashed is refused',
    );
    const refusedAll = [
      wsbShare({ ...req, id: 'agent-sandbox-1' }),
      wsbShare({ ...req, id: 'WindowsSandbox' }),
      wsbShare({ ...req, action: 'remove' }),
      wsbShare({ ...req, action: 'update' }),
      wsbShare({ ...req, name: '3ad483dec1a233132da4197c9790dcda06668793230cd6d9e94b1882e0f7f29c' }),
      wsbShare({ ...req, path: 'C:\\' }),
      wsbShare({ ...req, path: process.env.SystemRoot ?? 'C:\\Windows' }),
      // The profile root (from the temp folder: C:\Users\<you>\AppData\Local\Temp), never HOME/USERPROFILE.
      wsbShare({ ...req, path: fs.realpathSync.native(path.resolve(os.tmpdir(), '..', '..', '..')) }),
      wsbShare({ ...req, path: storage }),
      wsbShare({ ...req, path: hostData }),
      wsbShare({ ...req, path: path.dirname(storage), storageRoot: storage }),
      wsbShare({ ...req, path: hostFolder + ':stream' }),
      wsbShare({ ...req, path: hostFolder + '.' }),
      wsbShare({ ...req, readOnly: 'yes' }),
    ];
    t.check(
      refusedAll.every((r) => !r.ok && /^Refused: /.test(r.message)),
      'wsb-share refuses our own ids, a non-GUID, a remove without id, an update, a foreign share name, a drive, Windows, the profile root, the storage or data folder (or one that holds them), a stream, a trailing dot and a non-boolean readOnly',
      refusedAll.map((r) => r.message).join(' | '),
    );
    const shareGuid = raw.call(['share'], { id: GUID, action: 'add', name: 'agentsbx-0123abcd', path: hostFolder });
    t.check(
      !shareGuid.ok && /^Refused: /.test(shareGuid.message),
      "share (our own systems) refuses Windows Sandbox's GUID",
    );
    // A computecore.dll planted next to the exe is never loaded (System32 only).
    const planted2 = t.dir('live-planted');
    fs.copyFileSync(exe, path.join(planted2, 'HcsHost.exe'));
    fs.writeFileSync(path.join(planted2, 'computecore.dll'), 'MZ not a real dll');
    const clean = raw.check();
    const withPlant = new HcsHelper(
      () => path.join(planted2, 'HcsHost.exe'),
      undefined,
      t.dir('live-hcs-tmp2'),
    ).check();
    t.check(
      withPlant.values.computecore === clean.values.computecore,
      'a computecore.dll planted next to HcsHost.exe is ignored (it loads from System32 only)',
      JSON.stringify({ clean: clean.values, withPlant: withPlant.values }),
    );
    const systemFolders = [wsbShare({ ...req, path: 'C:\\ProgramData' }), wsbShare({ ...req, path: 'C:\\Users' })];
    t.check(
      systemFolders.every((r) => !r.ok && /^Refused: /.test(r.message)),
      'wsb-share refuses ProgramData and the users folder itself',
      systemFolders.map((r) => r.message).join(' | '),
    );

    // The shipped guest helper, inside a Windows Sandbox only. Nothing is mapped: a share that does not exist gives
    // "not found" and creates nothing, so this sandbox's own folders are never touched (the full map of a real share
    // is the manual scripts/experiments/hcs/Test-LiveGuest.ps1).
    t.section('live folders: BindMount.exe in this sandbox (refusals and a missing share; nothing is mapped)');
    if (!insideSandbox()) {
      t.skip('not inside a Windows Sandbox');
      return;
    }
    const bindExe = t.at('live-bind', 'BindMount.exe');
    fs.mkdirSync(path.dirname(bindExe), { recursive: true });
    const built = spawnSync(
      SYSTEM.csc(),
      [
        '/nologo',
        '/optimize',
        '/target:exe',
        '/out:' + bindExe,
        path.join(t.packageRoot, 'sandbox', 'csharp', 'BindMount.cs'),
      ],
      { windowsHide: true, timeout: 120000 },
    );
    t.check(built.status === 0 && fs.existsSync(bindExe), 'BindMount.cs compiles (C# 5)');
    const bm = (...args: string[]): number =>
      spawnSync(bindExe, args, { windowsHide: true, timeout: 30000, encoding: 'utf8' }).status ?? -1;
    const probe = 'C:\\Workspace\\live-selftest-' + crypto.randomBytes(4).toString('hex');
    t.check(
      bm('map', probe, 'agentsbx-' + crypto.randomBytes(8).toString('hex')) === 3 && !fs.existsSync(probe),
      'a share that is not there gives "not found" (3) and creates nothing',
    );
    t.check(
      bm('map', 'C:\\Workspace\\..', 'agentsbx-0123abcd') === 2 &&
        bm('map', 'C:\\Workspace\\foo.', 'agentsbx-0123abcd') === 2 &&
        bm('map', 'C:\\Projects\\x', 'agentsbx-0123abcd') === 2 &&
        bm('map', probe, 'e64f927cbf5c723e4cb36b51bd44c97ee7b7c825ec4b348d457e98e1c6527835') === 2 &&
        bm('map', probe, 'agentsbx-0123abcd', 'all') === 2 &&
        bm('unmap', 'C:\\Projects\\AgentProjects') === 2 &&
        bm('mapped', probe) === 4,
      "it refuses alias names, folders outside C:\\Workspace, Windows Sandbox's own share names and unknown options",
    );
  },
};
