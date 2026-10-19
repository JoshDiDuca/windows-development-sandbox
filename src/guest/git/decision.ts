export type Decision = { allow: true } | { allow: false; reason: string };

/** Subcommands that only read. */
const READ_ONLY = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'annotate',
  'ls-files',
  'ls-tree',
  'ls-remote',
  'rev-parse',
  'rev-list',
  'describe',
  'shortlog',
  'grep',
  'cat-file',
  'reflog',
  'whatchanged',
  'name-rev',
  'for-each-ref',
  'show-ref',
  'merge-base',
  'count-objects',
  'check-ignore',
  'check-attr',
  'var',
  'version',
  'help',
  'diff-tree',
  'diff-files',
  'diff-index',
  'cherry',
  'range-diff',
  'show-branch',
  'verify-commit',
  'verify-tag',
]);

/**
 * `git branch` / `git tag` list when every argument is a listing flag, or when a listing flag is present and the
 * rest are patterns/commits (`git branch --contains HEAD`). A bare name (`git branch new`) creates, so it is refused.
 */
const listingOnly =
  (flags: RegExp, listFlags: RegExp) =>
  (rest: string[]): boolean =>
    rest.every((a) => flags.test(a)) ||
    (rest.some((a) => listFlags.test(a)) && rest.every((a) => flags.test(a) || !a.startsWith('-')));

/** Subcommands that are read-only only in their listing forms. */
const LISTING: Record<string, (rest: string[]) => boolean> = {
  branch: listingOnly(
    /^(-a|-r|-v|-vv|--all|--remotes|--list|-l|--show-current|--verbose|--no-color|--color(=.*)?|--contains|--no-contains|--merged|--no-merged|--sort=.*|--format=.*)$/,
    /^(--list|-l|--contains|--no-contains|--merged|--no-merged)$/,
  ),
  tag: listingOnly(
    /^(-l|--list|-n\d*|--contains|--no-contains|--merged|--no-merged|--points-at|--sort=.*|--format=.*)$/,
    /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)$/,
  ),
  remote: (rest) => rest.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(rest[0]),
  config: (rest) =>
    rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope|--name-only)$/.test(a)) &&
    !rest.some((a) =>
      /^(--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|-e|--edit)$/.test(a),
    ),
  stash: (rest) => ['list', 'show'].includes(rest[0] ?? ''),
  worktree: (rest) => rest[0] === 'list',
  submodule: (rest) => rest.length === 0 || rest[0] === 'status' || rest[0] === 'summary',
  notes: (rest) => rest.length === 0 || ['list', 'show'].includes(rest[0]),
};

/** Global options that take a value (`git -C dir status`). Config overrides (-c, --config-env) are refused outright. */
const WITH_VALUE = new Set(['-C', '--namespace']);
const FORBIDDEN_GLOBAL = /^(-c|--config-env|--exec-path|--git-dir|--work-tree|--super-prefix)(=|$)/;

/** Options of reading commands that run a program or write a file (grep -O<cmd>, ls-remote --upload-pack, --output). */
const RUNS_OR_WRITES = /^(--open-files-in-pager|--upload-pack|--output|--ext-diff)(=|$)/;

export function gitDecision(args: string[], access: string): Decision {
  if (access === 'full') return { allow: true };
  if (access !== 'readonly')
    return {
      allow: false,
      reason: 'git is disabled in this sandbox (provisioning.git.access = ' + (access || 'none') + ').',
    };
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (FORBIDDEN_GLOBAL.test(args[i]))
      return { allow: false, reason: 'git ' + args[i] + ' is not allowed: git is read-only in this sandbox.' };
    i += WITH_VALUE.has(args[i]) ? 2 : 1;
  }
  const [command, ...rest] = args.slice(i);
  const runsOrWrites = rest.find(
    (a) =>
      RUNS_OR_WRITES.test(a) ||
      (command === 'ls-remote' && /^-u(.|$)/.test(a)) ||
      (command === 'grep' && /^-O/.test(a)),
  );
  if (runsOrWrites)
    return { allow: false, reason: 'git ' + runsOrWrites + ' is not allowed: git is read-only in this sandbox.' };
  if (command === undefined || command === '--version' || READ_ONLY.has(command) || (LISTING[command]?.(rest) ?? false))
    return { allow: true };
  return {
    allow: false,
    reason:
      'git ' +
      command +
      ' is blocked: git is read-only in this sandbox (provisioning.git.access = readonly). Reading (status, log, diff, show, blame) is allowed.',
  };
}
