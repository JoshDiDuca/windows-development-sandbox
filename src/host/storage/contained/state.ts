// The record of which data sets are mounted and which processes hold them, kept outside the image
// (<storage>\mounts\state.json): the first launch mounts, a second one that finds it mounted only adds itself, and the
// last one to let go dismounts. Pure transitions on a plain object, plus the file (with a lock) around them.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { JsonFile } from '../../../shared/io/index.js';
import { SET_NAME_RULE, type ContainedPaths } from './layout.js';

const HolderSchema = z.strictObject({
  /** What holds the mount: "launch" while a launch starts the sandbox, "watcher" for the background process. */
  id: z.string().regex(/^[a-z-]{1,20}$/),
  pid: z.number().int().positive(),
  since: z.string().max(40),
});
export type Holder = z.infer<typeof HolderSchema>;

const SetStateSchema = z.strictObject({
  mounted: z.boolean(),
  holders: z.array(HolderSchema).max(32),
});
export type SetState = z.infer<typeof SetStateSchema>;

export const ContainedStateSchema = z.strictObject({
  version: z.literal(1),
  sets: z.record(z.string().regex(SET_NAME_RULE), SetStateSchema),
});
export type ContainedState = z.infer<typeof ContainedStateSchema>;

export const EMPTY_STATE: ContainedState = { version: 1, sets: {} };

const NONE: SetState = { mounted: false, holders: [] };

export function setStateOf(state: ContainedState, set: string): SetState {
  return state.sets[set] ?? NONE;
}

function withSet(state: ContainedState, set: string, next: SetState): ContainedState {
  return { version: 1, sets: { ...state.sets, [set]: next } };
}

/** Drops the holders whose process is gone (a launch that ended, a watcher that crashed). */
export function pruneHolders(state: ContainedState, set: string, alive: (pid: number) => boolean): ContainedState {
  const current = setStateOf(state, set);
  const holders = current.holders.filter((h) => alive(h.pid));
  return holders.length === current.holders.length ? state : withSet(state, set, { ...current, holders });
}

/** Adds a holder (or refreshes the one with the same id). */
export function addHolder(state: ContainedState, set: string, holder: Holder): ContainedState {
  const current = setStateOf(state, set);
  const holders = [...current.holders.filter((h) => h.id !== holder.id), holder];
  return withSet(state, set, { ...current, holders });
}

export function removeHolder(state: ContainedState, set: string, id: string): ContainedState {
  const current = setStateOf(state, set);
  return withSet(state, set, { ...current, holders: current.holders.filter((h) => h.id !== id) });
}

export function markMounted(state: ContainedState, set: string, mounted: boolean): ContainedState {
  return withSet(state, set, { ...setStateOf(state, set), mounted });
}

/** What reality looks like, from the status script (check-contained.ps1). */
export interface MountReality {
  readonly imageExists: boolean;
  readonly imageBytes: number;
  readonly mountExists: boolean;
  readonly mountIsMountPoint: boolean;
  /** null: Windows would not say without administrator rights. */
  readonly attached: boolean | null;
}

export type ContainedDiagnosis =
  | { readonly kind: 'ok'; readonly mounted: boolean }
  | { readonly kind: 'in-use' }
  | { readonly kind: 'stale-state' }
  | { readonly kind: 'stale-mount' }
  | { readonly kind: 'image-missing' };

/** Compares the record with what is really mounted. `live` is the number of holders that still run. */
export function diagnose(o: {
  readonly state: SetState;
  readonly reality: MountReality;
  readonly live: number;
  readonly sandboxRunning: boolean;
}): ContainedDiagnosis {
  const { state, reality } = o;
  if (!reality.imageExists) return { kind: 'image-missing' };
  if (reality.mountIsMountPoint) {
    if (o.live > 0 || o.sandboxRunning) return { kind: 'in-use' };
    return { kind: 'stale-mount' };
  }
  if (state.mounted) return { kind: 'stale-state' };
  return { kind: 'ok', mounted: false };
}

/** The best answer for "is a process alive": signal 0 only checks. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const LOCK_STALE_MS = 2 * 60_000;
const LOCK_WAIT_MS = 8_000;

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** The state file with a lock, so two commands at once never lose each other's change. */
export class StateFile {
  private readonly file: JsonFile<ContainedState>;

  constructor(
    private readonly paths: Pick<ContainedPaths, 'stateFile' | 'lockFile' | 'mountsDir'>,
    private readonly alive: (pid: number) => boolean = processAlive,
    private readonly now: () => number = Date.now,
  ) {
    this.file = new JsonFile(ContainedStateSchema, paths.stateFile);
  }

  read(): ContainedState {
    return this.file.read() ?? EMPTY_STATE;
  }

  exists(): boolean {
    return fs.existsSync(this.paths.stateFile);
  }

  /** Reads, changes and writes under the lock; returns what was written. */
  update(change: (current: ContainedState) => ContainedState): ContainedState {
    return this.locked(() => {
      const next = change(this.read());
      this.file.write(next);
      return next;
    });
  }

  private locked<T>(work: () => T): T {
    fs.mkdirSync(this.paths.mountsDir, { recursive: true });
    const deadline = this.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(this.paths.lockFile, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (this.lockIsStale()) {
          fs.rmSync(this.paths.lockFile, { force: true });
          continue;
        }
        if (this.now() > deadline) throw new Error('Another command is changing the contained storage record.');
        pause(50);
      }
    }
    try {
      return work();
    } finally {
      fs.rmSync(this.paths.lockFile, { force: true });
    }
  }

  private lockIsStale(): boolean {
    try {
      const age = this.now() - fs.statSync(this.paths.lockFile).mtimeMs;
      const pid = Number.parseInt(fs.readFileSync(this.paths.lockFile, 'utf8'), 10);
      return age > LOCK_STALE_MS || (Number.isInteger(pid) && pid > 0 && !this.alive(pid));
    } catch {
      // Gone between the check and the read: the next try finds out.
      return false;
    }
  }
}

/** The data sets of a storage folder whose image is recorded as mounted (a storage move must wait for these). */
export function mountedSets(storageRoot: string): string[] {
  const state = new JsonFile(ContainedStateSchema, path.join(path.resolve(storageRoot), 'mounts', 'state.json')).read();
  return state
    ? Object.entries(state.sets)
        .filter(([, s]) => s.mounted)
        .map(([name]) => name)
    : [];
}

/**
 * A line for the start of a command when the record says an image is mounted that no running process holds and no
 * sandbox uses (nothing is looked up on the disk: this is only the record), or null. `sandboxRunning` can be a
 * function: it is only asked (it runs tasklist) when the record says an image is mounted.
 */
export function staleMountNote(
  storageRoot: string,
  set: string,
  sandboxRunning: boolean | (() => boolean),
  alive: (pid: number) => boolean = processAlive,
): string | null {
  const record = setStateOf(
    new JsonFile(ContainedStateSchema, path.join(path.resolve(storageRoot), 'mounts', 'state.json')).read() ??
      EMPTY_STATE,
    set,
  );
  if (!record.mounted || record.holders.some((h) => alive(h.pid))) return null;
  if (typeof sandboxRunning === 'function' ? sandboxRunning() : sandboxRunning) return null;
  return 'Contained storage is still mounted from an earlier sandbox. Run sandbox repair to dismount it (Windows asks for permission).';
}
