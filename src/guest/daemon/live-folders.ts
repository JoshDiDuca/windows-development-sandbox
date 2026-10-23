// Live folders, the daemon's half (opt-in alpha, docs/design/hcs-live-folders.md): the host shares a folder into the
// running sandbox (vSMB), then asks here, with a request signed by this launch's key (shared/channel/live.ts), to show
// it at C:\Workspace\<name> through the bind filter (sandbox\csharp\BindMount.cs). A canary request does the same for a
// test share, reads the token in it and hides it again: that proves to the host that the share reached THIS sandbox.
// Every file in run\live is read at most 16 KB, links and bad names are deleted unread, and a request is acted on only
// with a valid signature, this launch's id, a fresh time and an id not seen before (the seen ids are kept on the
// sandbox's own disk, so restarting the daemon does not reopen them). Guest paths come only from the strict folder
// name: never a path from the request. The mappings made are recorded and made again when the daemon starts.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { LIVE_FOLDER_NAME, LIVE_KEY, LIVE_SHARE_NAME, LIVE_TOKEN, openLive } from '../../shared/channel/live.js';
import type { LivePayload, LiveReply } from '../../shared/channel/live.js';
import type { RunDir } from '../../shared/channel/run-dir.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { WORKSPACES_GUEST } from '../../shared/paths/projects.js';
import { errMsg } from '../../core/util/errors.js';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_SEEN = 512;
/** BindMount's exit codes. */
const EXIT_OK = 0;
const EXIT_NO_SHARE = 3;
const EXIT_NOT_MAPPED = 4;

/** The bind filter, behind an interface so the self-test can run the handler without one. */
export interface BindPort {
  /** BindMount map: 0 done, 3 the share is not there (yet), anything else failed. */
  map(folder: string, share: string, readOnly: boolean): number;
  unmap(folder: string): number;
  /** BindMount mapped: 0 mapped, 4 not mapped, anything else unknown. */
  mapped(folder: string): number;
}

const StateSchema = z.object({
  key: z.string().regex(LIVE_KEY).nullable(),
  launchId: z.string().max(64),
  seen: z.array(z.object({ id: z.string().max(64), at: z.number() })).max(MAX_SEEN),
  mappings: z
    .array(
      z.object({
        folder: z.string().regex(LIVE_FOLDER_NAME),
        share: z.string().regex(LIVE_SHARE_NAME),
        readOnly: z.boolean(),
      }),
    )
    .max(256),
});
type State = z.output<typeof StateSchema>;

export interface LiveFolderOptions {
  readonly run: RunDir;
  /** The daemon's own state file on the sandbox's disk (made administrator-only by the caller). */
  readonly stateFile: string;
  readonly launchId: string;
  readonly bind: BindPort;
  readonly workspaces?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How often a missing share is tried again (0.5 s apart). */
  readonly tries?: number;
  readonly log?: (line: string) => void;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class LiveFolderHandler {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly o: LiveFolderOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private log(line: string): void {
    this.o.log?.(line);
  }

  private read(): State {
    try {
      const text = fs.readFileSync(this.o.stateFile, 'utf8');
      const parsed = StateSchema.safeParse(JSON.parse(text));
      if (parsed.success && parsed.data.launchId === this.o.launchId) return parsed.data;
    } catch {
      // No state yet (or unreadable): a fresh one for this launch.
    }
    return { key: null, launchId: this.o.launchId, seen: [], mappings: [] };
  }

  private save(state: State): void {
    fs.mkdirSync(path.dirname(this.o.stateFile), { recursive: true });
    writeJsonAtomic(this.o.stateFile, state);
  }

  /** The key the boot handed over (from the one-shot secrets file). */
  setKey(key: string): void {
    if (!LIVE_KEY.test(key)) return;
    this.save({ ...this.read(), key });
  }

  /** C:\Workspace\<name> from a checked name only. */
  private folderPath(name: string): string {
    if (!LIVE_FOLDER_NAME.test(name)) throw new Error('not a plain folder name');
    return path.win32.join(this.o.workspaces ?? WORKSPACES_GUEST, name);
  }

  /** One pass over run\live: every file is claimed (deleted) at once; valid ones are handled one after another. */
  tick(): void {
    const dir = this.o.run.liveDir;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return; // no requests yet
    }
    for (const name of names.slice(0, 64)) {
      if (name.endsWith('.tmp')) continue;
      const file = path.join(dir, name);
      let envelope: unknown = null;
      try {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && stat.size <= MAX_REQUEST_BYTES && /^[A-Za-z0-9_-]{1,64}\.json$/.test(name))
          envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        envelope = null;
      } finally {
        try {
          fs.rmSync(file, { recursive: true, force: true });
        } catch {
          // Locked for a moment: the next pass deletes it (the id is then seen already).
        }
      }
      if (envelope === null) continue;
      this.queue = this.queue
        .then(() => this.handle(envelope))
        .catch((e: unknown) => this.log('live folder: ' + errMsg(e)));
    }
  }

  /** Waits for what tick() queued (tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  async handle(envelope: unknown): Promise<void> {
    const state = this.read();
    const now = this.now();
    const opened = openLive(state.key, envelope, { launchId: this.o.launchId, now });
    if ('refused' in opened) {
      this.log('live folder request ignored: ' + opened.refused);
      return;
    }
    const p = opened.payload;
    const seen = state.seen.filter((s) => now - s.at < 10 * 60 * 1000);
    if (seen.some((s) => s.id === p.id)) {
      this.log('live folder request ignored: seen before (' + p.id + ')');
      return;
    }
    this.save({ ...state, seen: [...seen, { id: p.id, at: now }].slice(-MAX_SEEN) });
    let reply: Omit<LiveReply, 'id' | 'finishedAt'>;
    try {
      reply = await this.act(p);
    } catch (e) {
      reply = { ok: false, message: errMsg(e).slice(0, 900) };
    }
    this.reply(p.id, reply);
  }

  private reply(id: string, r: Omit<LiveReply, 'id' | 'finishedAt'>): void {
    try {
      fs.mkdirSync(this.o.run.liveRepliesDir, { recursive: true });
      writeJsonAtomic(this.o.run.liveReplyFile(id), { id, ...r, finishedAt: new Date(this.now()).toISOString() });
    } catch (e) {
      this.log('live folder reply not written: ' + errMsg(e));
    }
  }

  /** map with retries while the share is not there yet. */
  private async mapWithRetry(folder: string, share: string, readOnly: boolean): Promise<number> {
    const tries = this.o.tries ?? 20;
    let code = EXIT_NO_SHARE;
    for (let i = 0; i < tries; i++) {
      code = this.o.bind.map(folder, share, readOnly);
      if (code !== EXIT_NO_SHARE) return code;
      await (this.o.sleep ?? wait)(500);
    }
    return code;
  }

  /** The folder must not exist yet: not as a folder, a file or a link. */
  private assertFree(folder: string): void {
    let exists = true;
    try {
      fs.lstatSync(folder);
    } catch {
      exists = false;
    }
    if (exists) throw new Error(folder + ' exists already');
    // The bind filter needs the parent (C:\Workspace) to exist: without it BfSetupFilter answers "not found", exactly
    // like a share that has not arrived (seen in a Windows Sandbox, 2026-10-23). It must be a plain folder.
    const parent = path.dirname(folder);
    fs.mkdirSync(parent, { recursive: true });
    if (!fs.lstatSync(parent).isDirectory()) throw new Error(parent + ' is not a plain folder');
  }

  private async act(p: LivePayload): Promise<Omit<LiveReply, 'id' | 'finishedAt'>> {
    const folder = this.folderPath(p.folder);
    if (p.kind === 'unmap') {
      const state = this.read();
      const known = state.mappings.find((m) => m.folder === p.folder);
      if (!known) return { ok: false, message: 'no live folder at ' + folder };
      const code = this.o.bind.unmap(folder);
      if (code !== EXIT_OK || this.o.bind.mapped(folder) !== EXIT_NOT_MAPPED)
        return { ok: false, message: 'the folder could not be hidden again (are files in it open?)' };
      const after = this.read();
      this.save({ ...after, mappings: after.mappings.filter((m) => m.folder !== p.folder) });
      return { ok: true, message: 'hidden: ' + folder };
    }
    const share = p.share ?? '';
    this.assertFree(folder);
    if (p.kind === 'canary') {
      const code = await this.mapWithRetry(folder, share, true);
      if (code !== EXIT_OK) return { ok: false, message: 'the test share could not be shown (' + code + ')' };
      try {
        const file = path.join(folder, 'token.txt');
        const stat = fs.statSync(file);
        const token = stat.size <= 64 ? fs.readFileSync(file, 'utf8').trim() : '';
        return LIVE_TOKEN.test(token)
          ? { ok: true, message: 'read the test share', token }
          : { ok: false, message: 'the test share holds no token' };
      } finally {
        this.o.bind.unmap(folder);
      }
    }
    const code = await this.mapWithRetry(folder, share, p.readOnly);
    if (code !== EXIT_OK)
      return {
        ok: false,
        message:
          code === EXIT_NO_SHARE
            ? 'the share did not reach the sandbox'
            : 'the folder could not be shown (' + code + ')',
      };
    const state = this.read();
    this.save({
      ...state,
      mappings: [
        ...state.mappings.filter((m) => m.folder !== p.folder),
        { folder: p.folder, share, readOnly: p.readOnly },
      ],
    });
    return { ok: true, message: 'shown at ' + folder };
  }

  /** When the daemon starts: the recorded mappings this launch made, made again where they are gone. */
  reapply(): number {
    let done = 0;
    for (const m of this.read().mappings) {
      const folder = this.folderPath(m.folder);
      if (this.o.bind.mapped(folder) === EXIT_OK) continue;
      fs.mkdirSync(path.dirname(folder), { recursive: true });
      if (this.o.bind.map(folder, m.share, m.readOnly) === EXIT_OK) done++;
      else this.log('live folder ' + folder + ' could not be shown again');
    }
    return done;
  }
}
