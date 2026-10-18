// What the sandbox keeps between runs, and removing parts of it. Everything under the data folder is sandbox-writable:
// sizes and deletes never follow links, and targets resolve strictly inside the data folder. Never prints.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { diskUsage, sizeOf, type DiskUsage } from '../../core/disk.js';
import { assertNoLinks, errMsg, fail, isLink } from '../../core/util/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import type { Context } from '../commands/context.js';
import { collectDataEntries, type DataEntry } from './data-collect.js';
import { removeTree } from './data-remove.js';
import { resolveCleanTargets, type CleanTarget } from './data-targets.js';

export interface DataReport {
  readonly dataPath: string;
  readonly storageRoot: string;
  readonly totalBytes: number;
  readonly entries: DataEntry[];
  readonly disks: DiskUsage[];
}

/** A target that exists, with its size. */
export interface SizedTarget extends CleanTarget {
  readonly bytes: number;
}

export interface CleanPlan {
  /** Every target asked for (after dropping those inside another one). */
  readonly targets: CleanTarget[];
  /** The ones that exist on disk. */
  readonly present: SizedTarget[];
  readonly totalBytes: number;
}

export interface CleanOutcome {
  readonly freedBytes: number;
  /** One line per target that could not be removed. */
  readonly failed: string[];
  /** The data folder (or all of it) was among the targets: the next sandbox reinstalls what it needs. */
  readonly touchedData: boolean;
}

export class DataService {
  constructor(private readonly ctx: Pick<Context, 'dataPath' | 'storageRoot'>) {}

  /** Every stored folder by area, then what this PC keeps for the sandbox (sizes may take a moment). */
  entries(): DataEntry[] {
    return collectDataEntries(this.ctx.dataPath, this.ctx.storageRoot);
  }

  report(): DataReport {
    const entries = this.entries();
    return {
      dataPath: this.ctx.dataPath,
      storageRoot: this.ctx.storageRoot,
      totalBytes: _.sumBy(entries, 'bytes'),
      entries,
      disks: diskUsage(this.ctx.storageRoot),
    };
  }

  /**
   * Turns the targets named into folders and checks they can be removed now: no sandbox is running and no link sits
   * between the data folder and a target.
   */
  plan(inputs: string[]): CleanPlan {
    const { dataPath, storageRoot } = this.ctx;
    const targets = resolveCleanTargets(inputs, dataPath, storageRoot);
    if (isSandboxRunning())
      fail(
        'A Windows Sandbox is running, and it uses these folders.',
        'Close it first (sandbox stop), then run this again.',
      );
    // Every folder from the root down to the target's parent must be real; a link in place of the target is removed
    // itself.
    for (const t of targets) assertNoLinks(t.root, path.dirname(t.path));
    const present = targets
      .filter((t) => fs.existsSync(t.path) || isLink(t.path))
      .map((t) => ({ ...t, bytes: sizeOf(t.path) }));
    return { targets, present, totalBytes: _.sumBy(present, 'bytes') };
  }

  /** Removes the planned folders. A failure on one does not stop the others. */
  clean(plan: CleanPlan): CleanOutcome {
    const failed: string[] = [];
    for (const t of plan.present) {
      try {
        removeTree(t.path, t.root);
      } catch (e) {
        failed.push(t.target + ' (' + errMsg(e) + ')');
      }
    }
    return {
      freedBytes: plan.totalBytes - _.sumBy(plan.present, (t) => sizeOf(t.path)),
      failed,
      touchedData: plan.present.some((t) => t.root === this.ctx.dataPath || t.target === 'all'),
    };
  }
}
