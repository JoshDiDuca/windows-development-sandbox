// audit.commits: the git commits made in the projects while the sandbox runs, seen from this PC. Git appends a line
// to <project>\.git\logs\HEAD (and to each worktree's) for every commit; only what was added since the last look is
// read, a bounded amount each time. The sandbox can write these files (the project is mapped into it), so they are
// read as untrusted text: no links followed, sizes capped, every line checked, and a reflog that shrank is not read
// again from the start (that would report old commits as new).
import fs from 'node:fs';
import path from 'node:path';

/** One commit as the reflog records it. */
export interface CommitSeen {
  /** ISO time git wrote. */
  readonly t: string;
  readonly sha: string;
  /** Who made it, as git names them ("Name <email>"). */
  readonly author: string;
  /** commit | amend | merge | cherry-pick | revert | rebase | initial. */
  readonly action: string;
  /** The first line of its message. */
  readonly message: string;
  /** The project folder on this PC. */
  readonly project: string;
}

/** Most new bytes read from one reflog per look (the rest waits for the next look). */
const MAX_READ = 256 * 1024;
/** A reflog bigger than this is not read at all (it is not a project's). */
const MAX_REFLOG = 512 * 1024 * 1024;
const MAX_LINE = 4096;
/** Worktrees of one project looked at, at most. */
const MAX_WORKTREES = 32;

const LINE = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) (.{0,300}?) (\d{1,12}) ([+-]\d{4})\t(.*)$/;
/** The reflog messages that are new commits: what made it, and its subject. */
const COMMIT =
  /^(commit(?: \((initial|amend|merge)\))?|cherry-pick|revert|merge [^:]{1,200}|rebase(?: -i)? \((pick|reword|squash|fixup|edit)\)): ?(.*)$/;

/** A reflog line as a commit, or null when it is not one (a checkout, a reset, a pull without a merge commit ...). */
export function parseReflogLine(line: string, project: string): CommitSeen | null {
  const m = LINE.exec(line);
  if (!m) return null;
  const c = COMMIT.exec(m[6]);
  if (!c || /^0+$/.test(m[2])) return null;
  const action = c[2] ?? (c[1].startsWith('merge') ? 'merge' : c[1].startsWith('rebase') ? 'rebase' : c[1]);
  const seconds = Number(m[4]);
  const time = new Date(seconds * 1000);
  if (Number.isNaN(time.getTime())) return null;
  return {
    t: time.toISOString(),
    sha: m[2],
    author: m[3].slice(0, 256),
    action: action === 'commit' || action === 'initial' ? action : action.slice(0, 32),
    message: (c[4] || '').slice(0, 1024),
    project,
  };
}

/** Is this path a plain folder or file (not a link), every step from `root` down? */
function plainPath(root: string, target: string, kind: 'dir' | 'file'): boolean {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  let current = root;
  const parts = rel.split(path.sep).filter(Boolean);
  try {
    if (fs.lstatSync(current).isSymbolicLink()) return false;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return false;
      const last = i === parts.length - 1;
      if (last ? (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) : !stat.isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Follows the projects' reflogs: commits() returns the commits added since the last call. */
export class CommitWatcher {
  /** Reflog file -> bytes already read. */
  private readonly offsets = new Map<string, number>();

  /** The reflogs of a project: the main one and each worktree's. */
  private reflogs(project: string): string[] {
    const git = path.join(project, '.git');
    if (!plainPath(project, git, 'dir')) return [];
    const files = [path.join(git, 'logs', 'HEAD')];
    const worktrees = path.join(git, 'worktrees');
    if (plainPath(project, worktrees, 'dir'))
      try {
        for (const name of fs.readdirSync(worktrees).slice(0, MAX_WORKTREES))
          files.push(path.join(worktrees, name, 'logs', 'HEAD'));
      } catch {
        /* no worktrees to read */
      }
    return files.filter((f) => plainPath(project, f, 'file'));
  }

  /** Starts from what is there now: only commits made from here on are reported. */
  prime(projects: readonly string[]): void {
    for (const project of projects)
      for (const file of this.reflogs(project)) if (!this.offsets.has(file)) this.offsets.set(file, this.sizeOf(file));
  }

  private sizeOf(file: string): number {
    try {
      return fs.lstatSync(file).size;
    } catch {
      return 0;
    }
  }

  /** The commits added to the projects' reflogs since the last call. A reflog seen for the first time is primed. */
  commits(projects: readonly string[]): CommitSeen[] {
    const found: CommitSeen[] = [];
    for (const project of projects)
      for (const file of this.reflogs(project)) {
        const size = this.sizeOf(file);
        const done = this.offsets.get(file);
        // New (a worktree made since): from its end. Shrunk (expired or rewritten): from its new end.
        if (done === undefined || size < done || size > MAX_REFLOG) {
          this.offsets.set(file, size);
          continue;
        }
        if (size === done) continue;
        const length = Math.min(size - done, MAX_READ);
        const bytes = this.readRange(file, done, length);
        if (bytes === null) continue;
        // Only whole lines (counted in bytes); a line cut by the read limit is read next time, one longer than the
        // limit is skipped.
        const end = bytes.lastIndexOf(0x0a);
        if (end < 0) {
          if (length === MAX_READ) this.offsets.set(file, done + length);
          continue;
        }
        this.offsets.set(file, done + end + 1);
        for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
          if (line.length > MAX_LINE) continue;
          const commit = parseReflogLine(line.replace(/\r$/, ''), project);
          if (commit) found.push(commit);
        }
      }
    return found;
  }

  private readRange(file: string, from: number, length: number): Buffer | null {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      // What was opened must still be a plain file (not swapped for something else after the check).
      if (!fs.fstatSync(fd).isFile()) return null;
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, from);
      return buffer.subarray(0, read);
    } catch {
      return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}
