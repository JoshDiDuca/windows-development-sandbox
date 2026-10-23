// Live folders through HCS (opt-in alpha, projects.liveFolders "hcs"; docs/design/hcs-live-folders.md): adds a folder
// of this PC to the RUNNING Windows Sandbox where `wsb share` is missing. Two halves:
//  - the share: native\scripts\hcs-live-share.ps1, run elevated (one Windows permission prompt per add or remove),
//    runs HcsHost.exe wsb-share, which finds the one running Windows Sandbox, proves with a canary share that it is
//    the sandbox whose daemon answers in our run folder, and only then shares the folder (read-only unless asked);
//  - the guest mapping: a request signed with this launch's key (shared/channel/live.ts) asks the sandbox's daemon to
//    show the share at C:\Workspace\<name>.
// The record is host-only, <storage>\state\live-folders.json (never in the data folder): the launch, its key (sealed
// with DPAPI), the Windows Sandbox id the first canary proved, and the shares this tool added. Remove takes only names
// in that record. A stop of the sandbox clears it (shares end with the VM). Nothing read from the sandbox can ask for a
// share: the host only ever compares the canary token the daemon read.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { assertNoLinks, fail, sleep } from '../../../core/util/index.js';
import {
  LIVE_SHARE_NAME,
  LIVE_TOKEN,
  LiveReplySchema,
  newLiveKey,
  newShareName,
  RunDir,
  signLive,
  type LivePayload,
  type LiveReply,
} from '../../../shared/channel/index.js';
import { JsonFile, readValid, writeFileAtomic, writeJsonAtomic } from '../../../shared/io/index.js';
import { SYSTEM } from '../../../shared/system.js';
import { nativeFile, nativeScript } from '../../native.js';
import { refuseInSelfTest } from '../../test-guard.js';
import { SecretStore } from '../../secrets/index.js';
import { isSandboxRunning } from '../../sandbox/index.js';
import { currentUserSid } from '../../sharing/index.js';
import { hcsHostExe } from './helper.js';

const GUID = /^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$/;
/** The prompt, the canary (45 s at most in HcsHost) and three HCS operations of 60 s at most. */
const ELEVATED_TIMEOUT_MS = 6 * 60_000;
const CANARY_REPLY_MS = 30_000;
const MAP_REPLY_MS = 60_000;
const MAX_LOG_BYTES = 256 * 1024;

/** The warning shown wherever live folders are offered or used. */
export const LIVE_FOLDERS_WARNING =
  'Live folders through HCS are an alpha, untested on a real PC: if it fails, the sandbox may close, so save your work first. Each add or remove asks for administrator permission.';

const ShareSchema = z.object({
  name: z.string().regex(LIVE_SHARE_NAME),
  host: z.string().min(3).max(1024),
  guest: z.string().max(1024),
  folder: z.string().max(64),
  readOnly: z.boolean(),
  addedAt: z.string().max(40),
});
const RecordSchema = z.object({
  launchId: z.string().min(1).max(64),
  dataPath: z.string().max(1024),
  /** This launch's key for signed requests, sealed (SecretStore). */
  key: z.string().max(4096),
  /** The running Windows Sandbox's HCS id, once the first canary proved it. */
  systemId: z.string().regex(GUID).nullable(),
  shares: z.array(ShareSchema).max(256),
});
export type LiveRecord = z.output<typeof RecordSchema>;
export type LiveShare = z.output<typeof ShareSchema>;

/** What the elevated script was asked (request.json; HcsHost checks every field again). */
export interface LiveShareRequest {
  readonly action: 'add' | 'remove';
  readonly id: string;
  readonly name: string;
  readonly path?: string;
  readonly readOnly?: boolean;
  readonly storageRoot: string;
  readonly dataPath: string;
  readonly userSid: string;
  readonly exe: string;
  readonly exeSha256: string;
}

const OutcomeSchema = z.object({
  ok: z.boolean(),
  message: z.string().max(4000),
  id: z.string().max(64).optional(),
  canary: z.string().max(64).optional(),
});
export type LiveOutcome = z.output<typeof OutcomeSchema>;

/** The elevated half: one run of hcs-live-share.ps1. `onCanary` gets the canary share's name, returns its token. */
export interface ElevatedLivePort {
  run(request: LiveShareRequest, onCanary: (share: string) => Promise<string | null>): Promise<LiveOutcome>;
}

export type LiveRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ status: number | null }>;

export const spawnLiveRunner: LiveRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(file, [...args], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ status: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code });
    });
  });

/** run-elevated.ps1 -Script hcs-live-share.ps1 with the request in a private temp folder; relays the canary. */
export class ScriptLivePort implements ElevatedLivePort {
  constructor(
    private readonly runner: LiveRunner = spawnLiveRunner,
    private readonly tempRoot: string = os.tmpdir(),
    private readonly pollMs = 300,
  ) {}

  async run(request: LiveShareRequest, onCanary: (share: string) => Promise<string | null>): Promise<LiveOutcome> {
    if (this.runner === spawnLiveRunner) refuseInSelfTest('add a folder to the running Windows Sandbox');
    const dir = fs.mkdtempSync(path.join(this.tempRoot, 'agent-sandbox-live-'));
    try {
      const file = path.join(dir, 'request.json');
      fs.writeFileSync(file, JSON.stringify(request, null, 2), 'utf8');
      const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      let done = false;
      const finished = this.runner(
        SYSTEM.powershell(),
        nativeScript('run-elevated.ps1', [
          '-Script',
          nativeFile('scripts', 'hcs-live-share.ps1'),
          '-Json',
          file,
          '-Sha256',
          sha,
        ]),
        ELEVATED_TIMEOUT_MS,
      ).then((r) => {
        done = true;
        return r;
      });
      let relayed = false;
      while (!done) {
        if (!relayed) {
          const share = readCanary(path.join(dir, 'canary.json'));
          if (share) {
            relayed = true;
            const token = await onCanary(share).catch(() => null);
            writeFileAtomic(path.join(dir, 'answer.txt'), token && LIVE_TOKEN.test(token) ? token : 'none');
          }
        }
        await sleep(this.pollMs);
      }
      const r = await finished;
      const answer = readValid(OutcomeSchema, path.join(dir, 'result.json'));
      if (!answer)
        return fail(
          r.status === 1
            ? 'Windows did not give permission (the prompt was declined or closed).'
            : 'The live-folder helper gave no answer.',
          'Run the command again and choose Yes in the Windows prompt, or restart the sandbox to add the folder.',
        );
      return answer;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** canary.json from the elevated helper: {"share": "agentsbx-..."} (small, checked). */
function readCanary(file: string): string | null {
  try {
    if (fs.statSync(file).size > 1024) return null;
    const parsed = z
      .object({ share: z.string().regex(LIVE_SHARE_NAME) })
      .safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data.share : null;
  } catch {
    return null;
  }
}

export interface LiveFolderDeps {
  readonly storageRoot: string;
  readonly dataPath: string;
  readonly secrets: SecretStore;
  readonly elevated: ElevatedLivePort;
  /** HcsHost.exe and its SHA-256 (built when needed), or null when it cannot be built. */
  readonly exe: () => { path: string; sha256: string } | null;
  readonly userSid: () => string;
  readonly isAlive?: () => boolean;
  readonly pollMs?: number;
  readonly now?: () => Date;
  /** How long the sandbox's daemon has for the canary and for a map or unmap (tests make them short). */
  readonly canaryMs?: number;
  readonly mapMs?: number;
}

/** <storage>\state\live-folders.json. */
export function liveRecordFile(storageRoot: string): string {
  return path.join(storageRoot, 'state', 'live-folders.json');
}

export class LiveFolders {
  private readonly file: JsonFile<LiveRecord>;
  private readonly run: RunDir;

  constructor(private readonly d: LiveFolderDeps) {
    this.file = new JsonFile(RecordSchema, liveRecordFile(d.storageRoot));
    this.run = new RunDir(d.dataPath);
  }

  read(): LiveRecord | null {
    return this.file.read();
  }

  /** At launch (projects.liveFolders "hcs"): a new key for this launch, kept sealed; returned for the secrets file. */
  startLaunch(launchId: string): string {
    const key = newLiveKey();
    this.file.write({
      launchId,
      dataPath: this.d.dataPath,
      key: this.d.secrets.seal(key),
      systemId: null,
      shares: [],
    });
    return key;
  }

  /** The sandbox stopped (its shares ended with it), or a launch without live folders: the record goes. */
  clear(): void {
    fs.rmSync(liveRecordFile(this.d.storageRoot), { force: true });
  }

  /** Why live folders cannot be used for this launch now (null: they can). */
  unavailable(launchId: string): string | null {
    const record = this.read();
    if (!record)
      return 'the running sandbox was started while projects.liveFolders was off (turn it on before it starts)';
    if (record.launchId !== launchId) return 'the live-folder record belongs to an earlier sandbox';
    if (path.resolve(record.dataPath).toLowerCase() !== path.resolve(this.d.dataPath).toLowerCase())
      return 'the live-folder record belongs to another data folder';
    return null;
  }

  private log(line: string): void {
    try {
      const file = path.join(this.d.storageRoot, 'state', 'live-folders.log');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + '.old');
      } catch {
        // No log yet.
      }
      fs.appendFileSync(file, (this.d.now ?? (() => new Date()))().toISOString() + ' ' + line + '\n', 'utf8');
    } catch {
      // The log is a convenience.
    }
  }

  private key(record: LiveRecord): string {
    return this.d.secrets.open(record.key);
  }

  /** Sends one signed request to the sandbox's daemon and waits for its reply. */
  private async ask(
    record: LiveRecord,
    p: Omit<LivePayload, 'v' | 'id' | 'launchId' | 'createdAt'>,
    timeoutMs: number,
  ): Promise<LiveReply> {
    const id = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    const payload: LivePayload = {
      v: 1,
      id,
      launchId: record.launchId,
      createdAt: (this.d.now ?? (() => new Date()))().toISOString(),
      ...p,
    };
    assertNoLinks(this.d.dataPath, this.run.liveDir);
    assertNoLinks(this.d.dataPath, this.run.liveRepliesDir);
    writeJsonAtomic(this.run.liveFile(id), signLive(this.key(record), payload));
    const reply = this.run.liveReplyFile(id);
    const deadline = Date.now() + timeoutMs;
    for (let round = 0; Date.now() < deadline; round++) {
      const answer = readValid(LiveReplySchema, reply);
      if (answer && answer.id === id) {
        fs.rmSync(reply, { force: true });
        return answer;
      }
      if (round % 10 === 9 && this.d.isAlive && !this.d.isAlive()) break;
      await sleep(this.d.pollMs ?? 300);
    }
    fs.rmSync(this.run.liveFile(id), { force: true });
    return { id, ok: false, message: 'the sandbox did not answer', finishedAt: '' };
  }

  private request(
    record: LiveRecord,
    action: 'add' | 'remove',
    name: string,
    extra: { path?: string; readOnly?: boolean },
  ): LiveShareRequest {
    const exe =
      this.d.exe() ??
      fail('HcsHost.exe could not be built.', 'It needs the .NET Framework compiler that ships with Windows.');
    return {
      action,
      id: record.systemId ?? '',
      name,
      ...extra,
      storageRoot: this.d.storageRoot,
      dataPath: this.d.dataPath,
      userSid: this.d.userSid(),
      exe: exe.path,
      exeSha256: exe.sha256,
    };
  }

  /**
   * Shares `host` (its real path) into the running sandbox and shows it at C:\Workspace\`folder`. Throws with the
   * reason when anything refuses or fails; the folder is then not shared.
   */
  async add(o: {
    launchId: string;
    host: string;
    guest: string;
    folder: string;
    readOnly: boolean;
  }): Promise<LiveShare> {
    const why = this.unavailable(o.launchId);
    if (why) fail('Live folders cannot be used: ' + why + '.');
    const record = this.read()!;
    if (record.shares.some((s) => s.host.toLowerCase() === o.host.toLowerCase()))
      fail(o.host + ' is a live folder already.');
    const name = newShareName();
    const onCanary = async (share: string): Promise<string | null> => {
      const reply = await this.ask(
        record,
        { kind: 'canary', share, folder: 'live-canary-' + crypto.randomBytes(4).toString('hex'), readOnly: true },
        this.d.canaryMs ?? CANARY_REPLY_MS,
      );
      return reply.ok && reply.token ? reply.token : null;
    };
    const outcome = await this.d.elevated.run(
      this.request(record, 'add', name, { path: o.host, readOnly: o.readOnly }),
      onCanary,
    );
    this.log(
      'add ' +
        name +
        ' ' +
        o.host +
        ' -> ' +
        o.guest +
        ' id=' +
        (outcome.id ?? '') +
        ' canary=' +
        (outcome.canary ?? '') +
        ' ' +
        (outcome.ok ? 'ok' : 'failed: ' + outcome.message),
    );
    if (!outcome.ok) fail('The folder was not shared: ' + outcome.message + '.');
    if (
      !outcome.id ||
      !GUID.test(outcome.id) ||
      (record.systemId && record.systemId.toLowerCase() !== outcome.id.toLowerCase())
    )
      fail('The live-folder helper answered for an unexpected sandbox; nothing more is done.');
    const share: LiveShare = {
      name,
      host: o.host,
      guest: o.guest,
      folder: o.folder,
      readOnly: o.readOnly,
      addedAt: new Date().toISOString(),
    };
    const latest = this.read() ?? record;
    this.file.write({ ...latest, systemId: outcome.id, shares: [...latest.shares, share] });
    const mapped = await this.ask(
      record,
      { kind: 'map', share: name, folder: o.folder, readOnly: o.readOnly },
      this.d.mapMs ?? MAP_REPLY_MS,
    );
    if (!mapped.ok) {
      this.log('map ' + name + ' failed: ' + mapped.message);
      const undone = await this.removeShare(share).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
      fail(
        'The folder was shared but the sandbox could not show it: ' +
          mapped.message +
          (undone === true ? ' (the share was removed again).' : ' (the share stays until the sandbox stops).'),
      );
    }
    return share;
  }

  /** The share itself (elevated). True when it is gone; the record is kept when not. */
  private async removeShare(share: LiveShare): Promise<true> {
    const record = this.read();
    if (!record?.systemId || !record.shares.some((s) => s.name === share.name))
      fail('That share is not in the live-folder record.');
    const outcome = await this.d.elevated.run(this.request(record, 'remove', share.name, {}), async () => null);
    this.log('remove ' + share.name + ' ' + share.host + ' ' + (outcome.ok ? 'ok' : 'failed: ' + outcome.message));
    if (!outcome.ok) fail('The share could not be removed: ' + outcome.message + '. It ends when the sandbox stops.');
    const latest = this.read() ?? record;
    this.file.write({ ...latest, shares: latest.shares.filter((s) => s.name !== share.name) });
    return true;
  }

  /** The live folder of `host`, if there is one. */
  shareOf(host: string): LiveShare | null {
    return this.read()?.shares.find((s) => s.host.toLowerCase() === host.toLowerCase()) ?? null;
  }

  /** Removes a live folder: the guest mapping first, then the share. Throws (and keeps it) when either fails. */
  async remove(launchId: string, host: string): Promise<void> {
    const why = this.unavailable(launchId);
    if (why) fail('Live folders cannot be used: ' + why + '.');
    const record = this.read()!;
    const share = this.shareOf(host) ?? fail(host + ' is not a live folder.');
    const hidden = await this.ask(
      record,
      { kind: 'unmap', folder: share.folder, readOnly: share.readOnly },
      this.d.mapMs ?? MAP_REPLY_MS,
    );
    if (!hidden.ok)
      fail(
        'The sandbox could not hide ' + share.guest + ': ' + hidden.message + '.',
        'Close what uses it in the sandbox and try again; otherwise it stays until the sandbox stops.',
      );
    await this.removeShare(share);
  }
}

/** HcsHost.exe (built on first use in <storage>\bin\hcs) with its SHA-256, for the elevated script to check. */
function hcsHostWithHash(storageRoot: string): { path: string; sha256: string } | null {
  const exe = hcsHostExe(storageRoot);
  return exe ? { path: exe, sha256: crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex') } : null;
}

/** The real thing: DPAPI, the elevated script, HcsHost.exe, this user's SID. */
export function realLiveFolders(storageRoot: string, dataPath: string): LiveFolders {
  return new LiveFolders({
    storageRoot,
    dataPath,
    secrets: SecretStore.standard(),
    elevated: new ScriptLivePort(),
    exe: () => hcsHostWithHash(storageRoot),
    userSid: currentUserSid,
    isAlive: isSandboxRunning,
  });
}

/** The sandbox of `dataPath` stopped: its live-folder record (and key) goes; its shares ended with the VM. */
export function clearLiveRecord(storageRoot: string, dataPath: string): boolean {
  const record = new JsonFile(RecordSchema, liveRecordFile(storageRoot)).read();
  if (!record || path.resolve(record.dataPath).toLowerCase() !== path.resolve(dataPath).toLowerCase()) return false;
  fs.rmSync(liveRecordFile(storageRoot), { force: true });
  return true;
}
