// Copies a folder that something else is still writing to: a file that disappears between the listing and the copy
// (a spool file the agent's hook just consumed, a SQLite journal that was committed) is skipped, not an error.
import fs from 'node:fs';
import path from 'node:path';

export interface CopyTreeResult {
  readonly copied: number;
  /** Files (or folders) that were gone by the time they were reached. */
  readonly vanished: number;
}

const isGone = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/** Copies `from` into `to`; `skip(name)` leaves out files by name. Any error except "no such file" is thrown. */
export function copyTreeTolerant(
  from: string,
  to: string,
  skip: (name: string) => boolean = () => false,
): CopyTreeResult {
  let copied = 0;
  let vanished = 0;
  const walk = (src: string, dest: string): void => {
    fs.mkdirSync(dest, { recursive: true });
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(src, { withFileTypes: true });
    } catch (e) {
      if (!isGone(e)) throw e;
      vanished++;
      return;
    }
    for (const entry of entries) {
      if (skip(entry.name)) continue;
      const source = path.join(src, entry.name);
      const target = path.join(dest, entry.name);
      try {
        if (entry.isDirectory()) walk(source, target);
        else if (entry.isFile()) {
          fs.copyFileSync(source, target);
          copied++;
        }
      } catch (e) {
        if (!isGone(e)) throw e;
        vanished++;
        fs.rmSync(target, { force: true });
      }
    }
  };
  walk(from, to);
  return { copied, vanished };
}
