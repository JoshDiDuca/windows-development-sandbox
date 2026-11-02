// Reading a file another party may still be writing (the sandbox, through the data folder) with a hard size bound: no
// link is followed, and the bound holds even when the file grows between the size check and the read (at most max + 1
// bytes are ever read from the open descriptor).
import fs from 'node:fs';

/** Test seam: runs between the size check and the read (a file that grows there must still be refused). */
export interface BoundedReadHooks {
  readonly afterStat?: () => void;
}

/** The file's bytes, or null: missing, a link, not a plain file, or bigger than `max` bytes. */
export function readBoundedFile(file: string, max: number, hooks: BoundedReadHooks = {}): Buffer | null {
  try {
    if (!fs.lstatSync(file).isFile()) return null;
  } catch {
    return null;
  }
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > max) return null;
    hooks.afterStat?.();
    const buffer = Buffer.alloc(max + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = fs.readSync(fd, buffer, total, buffer.length - total, total);
      if (read === 0) break;
      total += read;
    }
    return total > max ? null : buffer.subarray(0, total);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
