// Git folders other than the project's own: submodules and nested repositories, which git also runs hooks from.
import fs from 'node:fs';
import path from 'node:path';
import { fileExists } from '../../core/util/index.js';
import { EMPTY_GIT, gitState, guardGitDir, plainGitDir } from './git-dirs.js';
import type { GitState, GuardRule, RepoFinding, RepoSnapshot } from './types.js';

const MAX_OTHER_REPOS = 64;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'agent-sandbox-quarantine',
  'target',
  'dist',
  'build',
  'bin',
  'obj',
  '.venv',
  'venv',
]);
const NEVER_CHECKED = new Set(['node_modules', '.git', 'agent-sandbox-quarantine']);
const notSkipped =(d: string): boolean => !SKIP_DIRS.has(path.basename(d).toLowerCase());

function plainDirs(dir: string, limit: number): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .slice(0, limit)
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** The key of a git folder in RepoSnapshot.repos: its path relative to the workspace, with forward slashes. */
function repoKey(workspace: string, dir: string): string {
  return path.relative(workspace, dir).split(path.sep).join('/');
}

/**
 * Git folders other than the project's own: submodules (.git/modules/**) and repositories nested up to two levels deep.
 * git runs their hooks and config too (git status in a subfolder, VS Code's repository scan). Bounded: links are never
 * followed and at most MAX_OTHER_REPOS are looked at.
 */
export function otherGitDirs(workspace: string): string[] {
  const found: string[] = [];
  const main = plainGitDir(workspace);
  // Submodules: a folder with a config and a HEAD is a git folder, and may have modules of its own.
  const walk = (dir: string, depth: number): void => {
    for (const d of plainDirs(dir, 200)) {
      if (found.length >= MAX_OTHER_REPOS) return;
      if (fileExists(path.join(d, 'config')) && fileExists(path.join(d, 'HEAD'))) {
        found.push(d);
        if (depth < 3) walk(path.join(d, 'modules'), depth + 1);
      } else if (depth < 3) walk(d, depth + 1);
    }
  };
  if (main) walk(path.join(main, 'modules'), 0);
  // A repository directly in build\, dist\, bin\ ... is still one VS Code's repository scan opens (it skips only
  // node_modules), so those folders are checked themselves; only their insides are skipped.
  const neverChecked = (d: string): boolean => NEVER_CHECKED.has(path.basename(d).toLowerCase());
  for (const sub of plainDirs(workspace, 500).filter((d) => !neverChecked(d))) {
    const inside = notSkipped(sub) ? plainDirs(sub, 200).filter(notSkipped) : [];
    for (const candidate of [sub, ...inside]) {
      if (found.length >= MAX_OTHER_REPOS) return found;
      const git = plainGitDir(candidate);
      if (git) found.push(git);
    }
  }
  return found;
}

/** The state of every other git folder, for the snapshot. */
export function nestedRepoStates(workspace: string): Record<string, GitState> {
  return Object.fromEntries(otherGitDirs(workspace).map((d) => [repoKey(workspace, d), gitState(d)]));
}

/** Submodules and nested repositories get the same git checks; a new one is compared with an empty baseline. */
export class NestedReposRule implements GuardRule {
  readonly kind = 'nested-repos';

  check(workspace: string, before: RepoSnapshot): RepoFinding[] {
    // Snapshots from before this check existed have no baseline: checking against nothing would move your own files.
    const repos = before.repos;
    if (!repos) return [];
    return otherGitDirs(workspace).flatMap((other) => {
      const rel = repoKey(workspace, other);
      return guardGitDir(other, repos[rel] ?? EMPTY_GIT).map((f) => ({ ...f, detail: rel + ': ' + f.detail }));
    });
  }
}
