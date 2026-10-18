import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { session, stateDir } from '../runtime/session.js';
import { dryRun } from '../runtime/paths.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log, warn } from '../runtime/log.js';
import { robocopy } from '../runtime/process.js';
import { copyTreeTolerant } from '../../shared/io/copy-tree.js';

/**
 * claude-mem keeps SQLite + a vector store. They run from the sandbox's own disk (SQLite and mapped folders do not
 * mix) and are mirrored to persistent storage, from where the host syncs them back to your PC.
 */
export const claudeMemPaths = {
  store: path.join(stateDir, 'claude-mem'),
  local: path.join(os.homedir(), '.claude-mem'),
};

const claudeMemEnabled = (): boolean => session.claudeProfile.syncClaudeMem && !dryRun;

export function restoreClaudeMem(): void {
  if (!claudeMemEnabled()) return;
  // A save cut off between its two renames (see saveClaudeMem) leaves only the aside copy: it is the newest data.
  const previous = claudeMemPaths.store + '.previous';
  if (!exists(claudeMemPaths.store) && exists(previous)) fs.renameSync(previous, claudeMemPaths.store);
  // A store that is gone or damaged: the newest backup that is a real database.
  const backups = claudeMemPaths.store + '.backups';
  if (!looksLikeSqlite(path.join(claudeMemPaths.store, 'claude-mem.db')) || !exists(claudeMemPaths.store)) {
    const good = (exists(backups) ? fs.readdirSync(backups).sort().reverse() : []).find(
      (b) => exists(path.join(backups, b, 'claude-mem.db')) && looksLikeSqlite(path.join(backups, b, 'claude-mem.db')),
    );
    if (good) {
      if (exists(claudeMemPaths.store))
        fs.renameSync(claudeMemPaths.store, claudeMemPaths.store + '.damaged-' + Date.now());
      fs.cpSync(path.join(backups, good), claudeMemPaths.store, { recursive: true });
      warn(
        'claude-mem: the stored database was missing or damaged; restored the backup from ' +
          new Date(Number(good)).toISOString() +
          '.',
      );
    }
  }
  if (!exists(claudeMemPaths.store)) return;
  robocopy(claudeMemPaths.store, claudeMemPaths.local);
  log('claude-mem data restored from persistent storage.');
}

/** Size + mtime of every SQLite database and -wal file under `dir`: when these have not moved, nothing was written. */
const databaseFingerprint = (dir: string): string => {
  const parts: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(db|sqlite3?)(-wal)?$/i.test(entry.name)) {
        try {
          const s = fs.statSync(full);
          parts.push(full + ':' + s.size + ':' + s.mtimeMs);
        } catch {
          // Gone since the listing (a database being replaced): left out, the next save looks again.
        }
      }
    }
  };
  walk(dir);
  return parts.sort().join('|');
};

/** The databases as of the last save by this process (null: not saved yet, so the first save always copies). */
let lastSaved: string | null = null;

/**
 * Copies the live claude-mem folder back to persistent storage (staging folder + swap, never a half copy). Called from
 * the daemon tick: when no database changed since the last save it does nothing (no copy of the whole folder).
 */
const SQLITE_HEADER = 'SQLite format 3\0';
/** A database file that starts like SQLite and is not empty (a missing one counts as fine: nothing to protect yet). */
const looksLikeSqlite = (file: string): boolean => {
  if (!exists(file)) return true;
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    return fs.readSync(fd, head, 0, 16, 0) === 16 && head.toString('latin1') === SQLITE_HEADER;
  } finally {
    fs.closeSync(fd);
  }
};

const MAX_BACKUPS = 3;
const BACKUP_EVERY_MS = 6 * 3600 * 1000;
/**
 * Moves the replaced copy into `dir` as a dated backup (at most one per 6 hours, the newest 3 kept); else deletes it.
 */
const keepBackup = (previous: string, dir: string): void => {
  if (!exists(previous)) return;
  const backups = exists(dir)
    ? fs
        .readdirSync(dir)
        .filter((n) => /^\d{13}$/.test(n))
        .sort()
    : [];
  const newest = Number(backups[backups.length - 1] ?? 0);
  if (Date.now() - newest < BACKUP_EVERY_MS) {
    fs.rmSync(previous, { recursive: true, force: true });
    return;
  }
  fs.renameSync(previous, path.join(mkdirp(dir), String(Date.now())));
  for (const old of [...backups, String(Date.now())].slice(0, -MAX_BACKUPS))
    fs.rmSync(path.join(dir, old), { recursive: true, force: true });
};

export function saveClaudeMem(): void {
  if (!claudeMemEnabled() || !exists(claudeMemPaths.local)) return;
  const { store, local } = claudeMemPaths;
  const fingerprint = databaseFingerprint(local);
  if (fingerprint === lastSaved && exists(store)) return;
  // A damaged copy (zero-filled after a crash, cut short) must never replace the store: that once destroyed the only
  // copy.
  if (!looksLikeSqlite(path.join(local, 'claude-mem.db'))) {
    warn(
      'claude-mem: the local database does not look valid, so it was not saved over the stored copy (' + local + ').',
    );
    return;
  }
  const incoming = store + '.incoming';
  const previous = store + '.previous';
  fs.rmSync(incoming, { recursive: true, force: true });
  // The database and its -wal are copied together, so the copy is consistent with itself. A -journal is never copied:
  // beside a database taken at another moment it would be rolled back over it. The -shm is rebuilt by SQLite. Files the
  // agent removes while this runs (hook spool files) are skipped.
  copyTreeTolerant(local, incoming, (name) => /\.(pid|lock)$|-journal$|-shm$/i.test(name));
  // Swap without a window where no copy exists: old aside, new in, then keep the old one as a dated backup.
  fs.rmSync(previous, { recursive: true, force: true });
  if (exists(store)) fs.renameSync(store, previous);
  try {
    fs.renameSync(incoming, store);
  } catch (e) {
    if (exists(previous)) fs.renameSync(previous, store);
    throw e;
  }
  keepBackup(previous, store + '.backups');
  lastSaved = fingerprint;
}
