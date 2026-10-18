// The storage folder's work for the command line, the menu and the web: where the saved data is, moving it (both
// folders remembered), switching to another folder without moving, and the folders offered for a choice. Never prints.
import fs from 'node:fs';
import path from 'node:path';
import { userConfigPath, userDir } from '../../core/config/index.js';
import { diskUsage } from '../../core/disk.js';
import { protectPrivateFolder } from '../../host/sharing/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import {
  mountedSets,
  sharedDefaultRoot,
  StorageHistory,
  StorageMove,
  otherDataFolders,
  type MoveProgress,
  type MoveResult,
} from '../../host/storage/index.js';
import { watcherRunning } from '../../sync/index.js';
import type { Context } from '../commands/context.js';

/** Why a move cannot start (a background sync is still on a data folder in the old storage), or null. */
export function storageBusy(root: string): string | null {
  const mounted = mountedSets(root);
  if (mounted.length > 0)
    return (
      'The contained storage of "' +
      mounted.join('", "') +
      '" is mounted (a disk image; moving now would reach into it).'
    );
  const data = path.join(root, 'data');
  try {
    for (const name of fs.readdirSync(data))
      if (watcherRunning(path.join(data, name))) return 'The background sync of "' + name + '" is still finishing.';
  } catch {
    // no data folder: nothing runs
  }
  return null;
}

export class StorageService {
  constructor(private readonly ctx: Pick<Context, 'loaded' | 'storageRoot'>) {}

  /** Why a move or a switch cannot happen now, or null. */
  busy(): string | null {
    return storageBusy(this.ctx.storageRoot);
  }

  /** Throws a UserError when moving to `to` is not possible right now. */
  validate(to: string): void {
    this.mover().validate(this.ctx.storageRoot, to);
  }

  /** Moves the data (copying across drives) and remembers both folders. */
  async move(to: string, keepOld: boolean, onProgress?: (progress: MoveProgress) => void): Promise<MoveResult> {
    const from = this.ctx.storageRoot;
    const result = await this.mover().move(from, to, {
      keepOld,
      ...(onProgress ? { onProgress } : {}),
    });
    const history = new StorageHistory(userDir());
    history.remember(from);
    history.remember(to);
    return result;
  }

  /** Looks for the data in `to` from now on, without moving it. The caller has checked `busy()`. */
  use(to: string): void {
    new StorageHistory(userDir()).remember(this.ctx.storageRoot);
    this.mover().pin(to);
  }

  /** The folders offered for a choice: the default, folders that hold data, and each other drive's AgentSandbox. */
  knownFolders(): string[] {
    const root = this.ctx.storageRoot;
    const known = [sharedDefaultRoot(), ...otherDataFolders(root, new StorageHistory(userDir()))];
    const drives = diskUsage(root)
      .filter((d) => !d.holdsStorage)
      .map((d) => path.join(d.drive, 'AgentSandbox'));
    return [...new Set([...known, ...drives])].filter((f) => f.toLowerCase() !== root.toLowerCase());
  }

  private mover(): StorageMove {
    return new StorageMove(
      this.ctx.loaded.configPath ?? userConfigPath(),
      () => storageBusy(this.ctx.storageRoot),
      isSandboxRunning,
      protectPrivateFolder,
    );
  }
}
