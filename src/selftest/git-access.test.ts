// Git access modes ("full", "readonly", "none"): which git commands the guard allows and the matching Claude deny
// rules.
import { gitDecision } from '../guest/git/decision.js';
import { gitDenyRules } from '../guest/setup/git-rules.js';
import type { Suite } from './support/suite.js';

export const gitAccessSuite: Suite = {
  name: 'git-access',
  title: 'git access modes and Claude deny rules',
  run: (t) => {
    t.section('readonly');
    const allowed = (args: string[], mode = 'readonly'): boolean => gitDecision(args, mode).allow;
    const reading = [
      'status',
      'log --oneline',
      'diff HEAD~1',
      'show HEAD',
      'blame a.ts',
      'branch',
      'branch -a',
      'branch --contains HEAD',
      'tag',
      'tag -l v*',
      'remote -v',
      'config --get user.name',
      'stash list',
      '-C sub status',
      '--no-pager log',
    ];
    t.equal(
      reading.filter((command) => !allowed(command.split(' '))),
      [],
      'readonly: reading commands are allowed',
    );
    const writing = [
      'commit -m x',
      'push',
      'add .',
      'checkout main',
      'switch -c x',
      'reset --hard',
      'stash',
      'stash pop',
      'branch new',
      'branch -D x',
      'tag v1',
      'merge x',
      'rebase main',
      'fetch',
      'pull',
      'config user.name x',
      'remote add o u',
      '-c core.hooksPath=x status',
      '--git-dir=x status',
      'clean -fd',
      'apply p.diff',
      // reading commands with options that run a program or write a file
      'grep -Ocalc.exe x',
      'grep --open-files-in-pager=calc.exe x',
      'ls-remote --upload-pack=calc.exe origin',
      'ls-remote -ucalc.exe origin',
      'diff --output=C:/x.txt',
      'log --output C:/x.txt',
      'diff --ext-diff',
    ];
    t.equal(
      writing.filter((command) => allowed(command.split(' '))),
      [],
      'readonly: anything that writes (or overrides config) is refused',
    );

    t.section('none and full');
    t.check(!allowed(['status'], 'none') && !allowed(['--version'], 'none'), 'none: every git call is refused');
    t.check(allowed(['commit'], 'full'), 'full: everything is allowed');

    t.section('Claude managed deny rules');
    const readonlyRules = gitDenyRules('readonly');
    const noneRules = gitDenyRules('none');
    t.equal(gitDenyRules('full').length, 0, 'full: no deny rules');
    t.includes(readonlyRules.join('\n'), 'Bash(git push:*)', 'readonly: pushing is denied');
    t.check(!readonlyRules.some((r) => r.startsWith('Read(')), 'readonly: reading .git is not denied');
    t.check(noneRules.includes('Bash(git:*)'), 'none: every git command is denied');
    t.check(noneRules.includes('Read(**/.git/**)'), 'none: reading .git is denied too');
  },
};
