// Keeps a log that a detached program appends to from growing for ever: past the limit it becomes <log>.1.
import fs from 'node:fs';

/** Moves `file` to `file + '.1'` (replacing the older copy) when it is over `maxBytes`; true when it moved. */
export function rotateLog(file: string, maxBytes: number): boolean {
  try {
    if (fs.statSync(file).size <= maxBytes) return false;
    fs.rmSync(file + '.1', { force: true });
    fs.renameSync(file, file + '.1');
    return true;
  } catch {
    // No log yet, or it is held open: the next start tries again.
    return false;
  }
}
