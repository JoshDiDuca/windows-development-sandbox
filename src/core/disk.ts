// Sizes and free space on disk, shared by `data`, `repair`, `setup` and the storage cleanup.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';

export const GB = 1024 ** 3;

/** 1536 -> "1.5 KB". */
export function humanBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = bytes <= 0 ? 0 : Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return (i === 0 ? String(bytes) : value.toFixed(value < 10 ? 1 : 0)) + ' ' + units[i];
}

/**
 * Size on disk, never following links or junctions (a link counts as 0, so a planted junction cannot make us walk this
 * PC's disk).
 */
export function sizeOf(p: string): number {
  try {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) return 0;
    if (!stat.isDirectory()) return stat.size;
    return _.sumBy(fs.readdirSync(p, { withFileTypes: true }), (d) =>
      d.isSymbolicLink() ? 0 : sizeOf(path.join(p, d.name)),
    );
  } catch {
    return 0;
  }
}

/** sizeOf with a time budget: null when measuring would take longer than `ms` (a big data folder can take minutes). */
export function sizeWithin(p: string, ms: number): number | null {
  const deadline = Date.now() + ms;
  const overBudget = Symbol('over budget');
  const walk = (at: string): number => {
    if (Date.now() > deadline) throw overBudget;
    let stat: fs.Stats;
    let entries: fs.Dirent[] = [];
    try {
      stat = fs.lstatSync(at);
      if (stat.isDirectory() && !stat.isSymbolicLink()) entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return 0; /* gone or unreadable: counts as nothing, like sizeOf */
    }
    if (stat.isSymbolicLink()) return 0;
    if (!stat.isDirectory()) return stat.size;
    return _.sumBy(entries, (d) => (d.isSymbolicLink() ? 0 : walk(path.join(at, d.name))));
  };
  try {
    return walk(p);
  } catch (e) {
    if (e === overBudget) return null;
    throw e;
  }
}

export { freeBytesAt } from '../shared/io/disk.js';

export interface DiskUsage {
  drive: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  holdsStorage: boolean;
}

/** Every local drive's size and free space, and which one holds the sandbox storage. */
export function diskUsage(storageRoot: string): DiskUsage[] {
  const storageDrive = path.parse(path.resolve(storageRoot)).root.toUpperCase();
  return 'CDEFGHIJKLMNOPQRSTUVWXYZ'
    .split('')
    .map((letter) => letter + ':\\')
    .flatMap((drive): DiskUsage[] => {
      try {
        const s = fs.statfsSync(drive);
        const totalBytes = s.blocks * s.bsize;
        if (!totalBytes) return [];
        return [
          {
            drive,
            totalBytes,
            freeBytes: s.bavail * s.bsize,
            usedBytes: totalBytes - s.bfree * s.bsize,
            holdsStorage: drive.toUpperCase() === storageDrive,
          },
        ];
      } catch {
        return [];
      }
    });
}
