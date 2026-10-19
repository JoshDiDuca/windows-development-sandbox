// A git folder's hooks, config and redirect files, and the rule that guards the project's own .git.
import fs from 'node:fs';
import path from 'node:path';
import { dirExists, isInsideOrEqual, isLink } from '../../core/util/index.js';
import { filesIn } from './file-hash.js';
import { configLines, disableConfig } from './git-config.js';
import { quarantine } from './quarantine.js';
import type { GitState, GuardRule, RepoFinding, RepoSnapshot } from './types.js';

/** Files in .git that make git read config/hooks from somewhere else. */
const REDIRECTS = ['commondir', 'config.worktree'] as const;
const isHook = (name: string): boolean => !name.endsWith('.sample');

export const EMPTY_GIT: GitState = { config: [], hooks: {}, redirects: [], pathHooks: {} };

/** The names git runs as hooks (a core.hooksPath folder inside the project holds other files too). */
const HOOK_NAMES = new Set([
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'p4-changelist',
  'p4-prepare-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'post-index-change',
]);

/**
 * Folders inside the work tree that the repo's own core.hooksPath points at (husky: .husky/_, whose stubs run the
 * hooks in .husky/). The sandbox can write them, and git on this PC runs them at the next commit.
 */
function hooksPathDirs(dir: string, config: readonly string[]): string[] {
  if (path.basename(dir).toLowerCase() !== '.git') return [];
  const workTree = path.dirname(dir);
  let section = '';
  let value: string | null = null;
  for (const line of config) {
    const header = /^\s*\[\s*([A-Za-z0-9.-]+)/.exec(line);
    if (header) section = header[1].toLowerCase();
    const pair = /^\s*(?:\[[^\]]*\]\s*)?hookspath\s*=\s*"?([^"]*?)"?\s*$/i.exec(line);
    if (pair && section === 'core') value = pair[1];
  }
  if (!value || value.startsWith('~')) return [];
  const target = path.resolve(workTree, value);
  if (!isInsideOrEqual(workTree, target) || !dirExists(target) || isLink(target)) return [];
  return path.basename(target) === '_' ? [target, path.dirname(target)] : [target];
}

const hooksIn = (dirs: readonly string[], workTree: string): Record<string, string> =>
  Object.fromEntries(
    dirs.flatMap((d) =>
      Object.entries(filesIn(d, (n) => HOOK_NAMES.has(n))).map(([n, h]) => [
        path.relative(workTree, path.join(d, n)),
        h,
      ]),
    ),
  );

/** <workspace>\.git when it is a real folder (not a link or a "gitdir:" file). */
export function plainGitDir(workspace: string): string | null {
  const dir = path.join(workspace, '.git');
  return dirExists(dir) && !isLink(dir) ? dir : null;
}

export function gitState(dir: string | null): GitState {
  const config = dir ? configLines(dir) : [];
  return {
    config,
    pathHooks: dir ? hooksIn(hooksPathDirs(dir, config), path.dirname(dir)) : {},
    hooks: dir ? filesIn(path.join(dir, 'hooks'), isHook) : {},
    redirects: dir ? REDIRECTS.filter((n) => fs.existsSync(path.join(dir, n))) : [],
  };
}

/** New or changed hooks and new redirect files are quarantined; new config that runs programs is commented out. */
export function guardGitDir(dir: string, before: GitState): RepoFinding[] {
  const hooksDir = path.join(dir, 'hooks');
  const hooksNow = filesIn(hooksDir, isHook);
  return [
    ...quarantine(
      hooksDir,
      Object.keys(hooksNow).filter((n) => before.hooks[n] !== hooksNow[n]),
      dir,
      'hook',
    ),
    ...quarantine(
      dir,
      REDIRECTS.filter((n) => fs.existsSync(path.join(dir, n)) && !before.redirects.includes(n)),
      dir,
      'git',
    ),
    ...disableConfig(dir, before.config),
    ...guardPathHooks(dir, before),
  ];
}

/** New or changed hooks in a core.hooksPath folder inside the project (not checked against older snapshots). */
function guardPathHooks(dir: string, before: GitState): RepoFinding[] {
  if (!before.pathHooks) return [];
  const workTree = path.dirname(dir);
  const now = hooksIn(hooksPathDirs(dir, before.config), workTree);
  const changed = Object.keys(now).filter((rel) => before.pathHooks?.[rel] !== now[rel]);
  return changed.flatMap((rel) =>
    quarantine(path.dirname(path.join(workTree, rel)), [path.basename(rel)], dir, 'hook').map((f) => ({
      ...f,
      detail: rel + ' (core.hooksPath): ' + f.detail,
    })),
  );
}

/** The project's own .git; a .git replaced by a link or a "gitdir:" file is reported, never followed. */
export class GitDirRule implements GuardRule {
  readonly kind = 'git-dir';

  check(workspace: string, before: RepoSnapshot): RepoFinding[] {
    const dir = plainGitDir(workspace);
    if (dir) return guardGitDir(dir, before);
    const replaced = before.gitDir && fs.existsSync(path.join(workspace, '.git'));
    if (!replaced) return [];
    return [
      {
        kind: 'git',
        detail:
          '.git was replaced by a link or a "gitdir:" file inside the sandbox. Do not run git in ' +
          workspace +
          ' until you have checked it.',
      },
    ];
  }
}
