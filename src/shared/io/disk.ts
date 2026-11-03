// Free room on a disk: one implementation for the PC (core/disk.ts) and the guest (toolchains/persisted.ts).
import fs from 'node:fs';
import path from 'node:path';

export type StatFs = (dir: string) => { bavail: number; bsize: number };

/**
 * Free bytes for this user on the drive that holds `dir` (which may not exist yet: the nearest existing parent is
 * asked); null when it cannot be told. `statfs` is injectable for tests.
 */
export function freeBytesAt(dir: string, statfs: StatFs = fs.statfsSync): number | null {
  let at = path.resolve(dir);
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  try {
    const s = statfs(at);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}
