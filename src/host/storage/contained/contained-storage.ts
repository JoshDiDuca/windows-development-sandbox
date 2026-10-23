// One data set's contained storage: make sure its image is mounted for a launch (creating it the first time), keep the
// record of who holds the mount, and dismount when the last holder lets go and no sandbox runs. Disks are only touched
// through the DiskPort; folders only in the places the layout names.
import fs from 'node:fs';
import path from 'node:path';
import { assertNoLinks, fail } from '../../../core/util/index.js';
import { assertTestWritable } from '../../test-guard.js';
import { CONTAINED_FOLDERS, containedPaths, type ContainedPaths } from './layout.js';
import type { DiskPort, ScriptOutcome } from './disk-port.js';
import {
  addHolder,
  diagnose,
  markMounted,
  processAlive,
  pruneHolders,
  removeHolder,
  setStateOf,
  StateFile,
  type ContainedDiagnosis,
  type ContainedState,
  type MountReality,
} from './state.js';

export interface ContainedDeps {
  readonly storageRoot: string;
  readonly maxGb: number;
  /** Makes a NEW, empty folder private (protectPrivateFolder). Never called on a folder that holds files. */
  readonly protect: (dir: string) => void;
  readonly userSid: () => string;
  readonly port: DiskPort;
  readonly sandboxRunning: () => boolean;
  readonly alive?: (pid: number) => boolean;
  /** The volume of a folder (stat.dev): a mounted image is another volume than the folder it is mounted in. */
  readonly deviceOf?: (dir: string) => number;
}

export interface HolderId {
  readonly id: string;
  readonly pid: number;
}

export interface ReleaseResult {
  readonly dismounted: boolean;
  /** Why it stayed mounted (or could not be dismounted), when it did. */
  readonly note?: string;
}

const deviceOfDefault = (dir: string): number => fs.statSync(dir).dev;

export class ContainedStorage {
  readonly paths: ContainedPaths;
  private readonly stateFile: StateFile;
  private readonly alive: (pid: number) => boolean;

  constructor(
    private readonly deps: ContainedDeps,
    readonly set: string,
  ) {
    this.paths = containedPaths(deps.storageRoot, set);
    this.alive = deps.alive ?? processAlive;
    this.stateFile = new StateFile(this.paths, this.alive);
  }

  imageExists(): boolean {
    return fs.existsSync(this.paths.image);
  }

  /** Holders of this set that still run. */
  liveHolders(): number {
    return setStateOf(this.stateFile.read(), this.set).holders.filter((h) => this.alive(h.pid)).length;
  }

  recordedMounted(): boolean {
    return setStateOf(this.stateFile.read(), this.set).mounted;
  }

  reality(): Promise<MountReality> {
    return this.deps.port.reality(this.paths);
  }

  async diagnose(): Promise<ContainedDiagnosis> {
    const reality = await this.reality();
    return diagnose({
      state: setStateOf(this.stateFile.read(), this.set),
      reality,
      live: this.liveHolders(),
      sandboxRunning: this.deps.sandboxRunning(),
    });
  }

  /**
   * Makes sure the image is mounted at its folder (creating it when `create` is set and no image exists yet), records
   * the holder and returns the mount folder, ready with the folders of the data set inside it.
   */
  async acquire(holder: HolderId, o: { readonly create?: boolean } = {}): Promise<string> {
    this.ensureFolders();
    // Others that run now vouch for a mount that is there; this holder is recorded first, so a watcher that is just
    // finishing cannot dismount between the check and the use.
    const others = this.liveHolders();
    this.stateFile.update((s) => this.withHolder(s, holder));
    try {
      return await this.mountForHolder(others > 0, o.create === true);
    } catch (e) {
      this.stateFile.update((s) => pruneHolders(removeHolder(s, this.set, holder.id), this.set, this.alive));
      throw e;
    }
  }

  private async mountForHolder(vouched: boolean, create: boolean): Promise<string> {
    const { paths } = this;
    const before = await this.reality();
    const mountedAlready = vouched && this.recordedMounted() && before.mountIsMountPoint;
    if (!mountedAlready) {
      if (!before.imageExists && !create)
        fail(
          'The contained storage image is missing: ' + paths.image,
          'Run sandbox storage contained on to make it again, or sandbox storage contained off to go back to folders.',
        );
      const outcome = await this.deps.port.mount({
        paths,
        maxGb: this.deps.maxGb,
        create: !before.imageExists,
        userSid: this.deps.userSid(),
      });
      this.requireOk(outcome, 'mount');
    } else {
      // Another holder vouches for the mount, but the folder could be a mount point of some other disk (one left after
      // a restart, whose volume name an image of someone else's now has). A port that can check it without a prompt
      // (the storage helper) is asked: it only says "mounted already" for a mount of this very image.
      const confirmed = await this.deps.port.confirmMounted?.({
        paths,
        maxGb: this.deps.maxGb,
        create: false,
        userSid: this.deps.userSid(),
      });
      if (confirmed) this.requireOk(confirmed, 'mount');
    }
    this.assertReallyMounted();
    for (const name of CONTAINED_FOLDERS) fs.mkdirSync(path.join(paths.mount, name), { recursive: true });
    this.stateFile.update((s) => markMounted(s, this.set, true));
    return paths.mount;
  }

  private withHolder(state: ContainedState, holder: HolderId): ContainedState {
    return addHolder(pruneHolders(state, this.set, this.alive), this.set, {
      ...holder,
      since: new Date().toISOString(),
    });
  }

  /** The record knows this set as mounted (the watcher only holds a mount that exists). */
  isRecorded(): boolean {
    return this.recordedMounted();
  }

  /** Adds a holder to a mount that is recorded as mounted (the background watcher); false when nothing is mounted. */
  hold(holder: HolderId): boolean {
    if (!this.recordedMounted()) return false;
    this.stateFile.update((s) => this.withHolder(s, holder));
    return true;
  }

  /** Lets go; dismounts when nobody else holds it and no sandbox runs. Never throws: a stuck mount is for doctor. */
  async release(id: string): Promise<ReleaseResult> {
    this.stateFile.update((s) => pruneHolders(removeHolder(s, this.set, id), this.set, this.alive));
    return this.dismountIfIdle();
  }

  async dismountIfIdle(): Promise<ReleaseResult> {
    if (this.liveHolders() > 0) return { dismounted: false, note: 'another command still uses it' };
    if (this.deps.sandboxRunning()) return { dismounted: false, note: 'a sandbox is running' };
    try {
      // Nothing mounted: no permission prompt for nothing.
      if (!(await this.reality()).mountIsMountPoint) {
        if (this.recordedMounted()) this.clearRecord();
        return { dismounted: false, note: 'it was not mounted' };
      }
      const outcome = await this.deps.port.dismount({ paths: this.paths, userSid: this.deps.userSid() });
      if (!outcome.ok) return { dismounted: false, note: outcome.message };
      this.stateFile.update((s) => markMounted(s, this.set, false));
      return { dismounted: true };
    } catch (e) {
      return { dismounted: false, note: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Deletes the image file (what `storage contained off` offers last, after the files were moved out). Only an image
   * that is not mounted and not attached; never through a link. The folders around it stay.
   */
  async deleteImage(): Promise<void> {
    assertTestWritable(this.paths.image);
    const reality = await this.reality();
    if (reality.mountIsMountPoint || reality.attached === true)
      fail('The image is still mounted.', 'Dismount it first (sandbox repair), then try again.');
    assertNoLinks(this.paths.storageRoot, this.paths.image);
    fs.rmSync(this.paths.image, { force: true });
    if (fs.existsSync(this.paths.image))
      fail('The image could not be deleted: ' + this.paths.image, 'Close programs that use it.');
  }

  /** Doctor/repair: the record says mounted, nothing is (clears the record; no permission prompt needed). */
  clearRecord(): void {
    this.stateFile.update((s) => markMounted(pruneHolders(s, this.set, this.alive), this.set, false));
  }

  private requireOk(outcome: ScriptOutcome, what: string): void {
    if (outcome.ok) return;
    fail(
      'Could not ' + what + ' the contained storage: ' + outcome.message,
      'Run sandbox doctor (it checks the image and the mount folder), or turn contained storage off with: sandbox storage contained off',
    );
  }

  /** A mounted image is another volume than its folder; the same id would mean writes land on this PC's own disk. */
  private assertReallyMounted(): void {
    const deviceOf = this.deps.deviceOf ?? deviceOfDefault;
    if (deviceOf(this.paths.mount) === deviceOf(this.paths.mountsDir))
      fail(
        'The disk image is not mounted at ' + this.paths.mount + ', so nothing was written there.',
        'Run sandbox doctor.',
      );
  }

  /** The folders the image needs on this PC. Only folders this call creates are made private, never one with files. */
  private ensureFolders(): void {
    const { paths } = this;
    for (const dir of [paths.imagesDir, paths.mountsDir, paths.mount]) {
      if (fs.existsSync(dir)) continue;
      fs.mkdirSync(dir, { recursive: true });
      this.deps.protect(dir);
    }
  }
}
