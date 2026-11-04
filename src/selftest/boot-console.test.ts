// The boot's console (docs/design/parallel-boot.md, "Console output"): a fixture of runner events played into the
// progress view, read back as the exact plain output (logs, CI, dry runs) and as live frames (a terminal), colours
// stripped. Also the log file's line format. Pure: a fake clock and a fake screen, no terminal.
import { plainText, fileLines } from '../guest/runtime/log-line.js';
import {
  CONSOLE_GLYPHS,
  ProgressView,
  readyLines,
  RICH_GLYPHS,
  stepsDetail,
  wrap,
  type ViewTask,
} from '../guest/boot/progress-view.js';
import type { TaskOutcome } from '../guest/boot/runner.js';
import type { Suite } from './support/suite.js';

const STAGES = [
  { stage: 1, name: 'Network and session host' },
  { stage: 2, name: 'Pre-provision hooks and desktop' },
  { stage: 3, name: 'Developer tools' },
  { stage: 4, name: 'Agent: claude' },
];

const TASKS: readonly ViewTask[] = [
  { id: 'ptyhost', stage: 1, title: 'Session host' },
  { id: 'network', stage: 1, title: 'Private-network blocking' },
  { id: 'desktop', stage: 2, title: 'Personalisation' },
  { id: 'toolchains', stage: 3, title: 'Developer tools', critical: true },
  { id: 'dbCommands', stage: 3, title: 'Tool commands' },
  { id: 'agent', stage: 4, title: 'Agent install', critical: true },
];

const task = (id: string): ViewTask => TASKS.find((t) => t.id === id)!;
const done = (id: string, ms: number): TaskOutcome => ({ id, title: task(id).title, state: 'done', ms });

interface Played {
  readonly view: ProgressView;
  readonly out: () => string;
  /** Everything written so far, then forgets it. */
  readonly take: () => string;
  at(ms: number): void;
}

const play = (live: boolean, columns = 80): Played => {
  let now = 0;
  let written = '';
  let taken = 0;
  const view = new ProgressView(STAGES, TASKS, {
    live,
    glyphs: live ? RICH_GLYPHS : CONSOLE_GLYPHS,
    now: () => now,
    screen: { write: (text) => void (written += text), columns: () => columns },
  });
  return {
    view,
    out: () => written,
    take: () => {
      const part = written.slice(taken);
      taken = written.length;
      return part;
    },
    at: (ms) => {
      now = ms;
    },
  };
};

/** The happy boot: overlapping tasks, lines from several stages, a warning, a soft failure, the summary. */
const happyBoot = (p: Played): void => {
  const v = p.view;
  v.start('Agent sandbox · demo · claude · C:\\Work\\demo');
  v.line('Service sign-ins: none', undefined);
  v.started(task('ptyhost'));
  v.started(task('desktop'));
  v.started(task('dbCommands'));
  v.line('Desktop personalisation applied from this PC.', 2);
  p.at(300);
  v.finished(task('ptyhost'), done('ptyhost', 300));
  v.started(task('network'));
  p.at(1200);
  v.finished(task('desktop'), done('desktop', 1200));
  v.line('LAN blocked in the guest firewall.', 1);
  v.warning('gh: the GitHub login was kept in Credential Manager. Log in again with: gh auth login --web');
  p.at(1300);
  v.finished(task('dbCommands'), { ...done('dbCommands', 1300), state: 'failed', error: 'disk full' });
  v.warning('Tool commands failed (continuing): disk full');
  p.at(4600);
  v.finished(task('network'), done('network', 4300));
  v.started(task('toolchains'));
  v.detail('toolchains', stepsDetail(['Node', 'Python', 'Rust', 'Go', 'Java'], 5, 13));
  v.line('Installing the Visual C++ runtime ...', 3);
  p.at(13600);
  v.finished(task('toolchains'), done('toolchains', 9000));
  v.started(task('agent'));
  v.line('claude already cached in persistent storage.', 4);
  p.at(15400);
  v.finished(task('agent'), done('agent', 1800));
  v.summary(['git: 2.43.0.windows.1', 'node: 24.22.0 (from this PC, switch with nvm use)', 'vc++ runtime: installed']);
  v.notice('If Claude asks you to sign in, do it once; the login is saved in persistent storage.');
  v.release({
    ms: 15400,
    outcomes: [done('ptyhost', 300), done('network', 4300), done('toolchains', 9000), done('agent', 1800)],
    background: ['Visual Studio', 'Unreal'],
    logPath: 'C:\\AgentData\\logs\\guest.log',
  });
};

const PLAIN_HAPPY = [
  'Agent sandbox · demo · claude · C:\\Work\\demo',
  '',
  'Service sign-ins: none',
  '[1/4] Network and session host           4.6s',
  '      LAN blocked in the guest firewall.',
  '[2/4] Pre-provision hooks and desktop    1.2s',
  '      Desktop personalisation applied from this PC.',
  '[3/4] Developer tools                   13.6s',
  '      Installing the Visual C++ runtime ...',
  '[4/4] Agent: claude                      1.8s',
  '      claude already cached in persistent storage.',
  '',
  'Warnings',
  '  ! gh: the GitHub login was kept in Credential Manager. Log in again with: gh auth login --web',
  '  ! Tool commands failed (continuing): disk full',
  '',
  'Tools',
  '  git           2.43.0.windows.1',
  '  node          24.22.0 (from this PC, switch with nvm use)',
  '  vc++ runtime  installed',
  '',
  'If Claude asks you to sign in, do it once; the login is saved in persistent storage.',
  '',
  'Ready in 15.4s (slowest: Developer tools 9.0s, Private-network blocking 4.3s, Agent install 1.8s)',
  'Still installing in the background: Visual Studio, Unreal (a few minutes; it does not hold you up)',
  'Log: C:\\AgentData\\logs\\guest.log',
  '',
].join('\n');

export const bootConsoleSuite: Suite = {
  name: 'boot-console',
  title: "the boot's console: plain ordered output, live stage rows, warnings, tool summary, log file lines",
  run: (t) => {
    t.section('plain output (logs, CI, dry runs)');
    {
      const p = play(false);
      happyBoot(p);
      t.equal(p.out().split('\n'), PLAIN_HAPPY.split('\n'), 'a boot prints its stages in order, each once finished');
      t.check(!p.out().includes('\x1b'), 'plain output has no colour or cursor codes');
    }
    {
      // Stage 1 finishes last: stages 2 and 3 wait for it, then all three come out in order.
      const p = play(false);
      const v = p.view;
      v.start('header');
      p.take();
      v.started(task('ptyhost'));
      v.started(task('desktop'));
      v.finished(task('desktop'), done('desktop', 0));
      const early = p.take();
      v.finished(task('ptyhost'), done('ptyhost', 0));
      v.started(task('network'));
      v.finished(task('network'), done('network', 0));
      t.check(
        early === '' && /^\[1\/4\][^\n]*\n\[2\/4\]/.test(p.take()),
        'a finished stage waits until the stages before it are printed',
        early,
      );
    }
    {
      const p = play(false);
      const v = p.view;
      v.start('header');
      v.started(task('ptyhost'));
      v.finished(task('ptyhost'), done('ptyhost', 100));
      v.started(task('network'));
      v.finished(task('network'), done('network', 100));
      v.started(task('desktop'));
      v.finished(task('desktop'), done('desktop', 100));
      v.started(task('dbCommands'));
      v.started(task('toolchains'));
      p.at(2000);
      v.finished(task('toolchains'), { ...done('toolchains', 2000), state: 'failed', error: 'no network' });
      v.finished(task('dbCommands'), done('dbCommands', 2000));
      v.finished(task('agent'), { ...done('agent', 0), state: 'skipped', error: 'Developer tools failed' });
      p.take();
      v.release(null);
      t.equal(
        p.out().split('\n').slice(4, 8),
        [
          '[3/4] Developer tools                    2.0s  FAILED',
          '      x Developer tools failed: no network',
          '[4/4] Agent: claude                    skipped',
          '      - Agent install skipped (Developer tools failed)',
        ],
        'a critical failure marks its stage FAILED and says why; what comes after it is skipped',
      );
    }
    {
      const p = play(false);
      p.view.start('header');
      p.view.started(task('ptyhost'));
      p.view.line('half way', 1);
      p.take();
      p.view.release(null);
      t.equal(
        p.take().split('\n'),
        ['[1/4] Network and session host           0.0s  not finished', '      half way', ''],
        'when the boot fails, a stage that had started is printed with what it logged',
      );
    }

    t.section('live frames (a terminal)');
    {
      const p = play(true);
      const v = p.view;
      v.start('Agent sandbox · demo · claude · C:\\Work\\demo');
      t.equal(
        v.frame(false),
        [
          '  · 1  Network and session host                 waiting',
          '  · 2  Pre-provision hooks and desktop          waiting',
          '  · 3  Developer tools                          waiting',
          '  · 4  Agent: claude                            waiting',
        ],
        'before any task: every stage waits',
      );
      v.started(task('ptyhost'));
      v.started(task('desktop'));
      v.started(task('dbCommands'));
      p.at(300);
      v.finished(task('ptyhost'), done('ptyhost', 300));
      v.started(task('network'));
      p.at(1200);
      v.finished(task('desktop'), done('desktop', 1200));
      v.finished(task('dbCommands'), done('dbCommands', 1200));
      v.started(task('toolchains'));
      v.detail('toolchains', stepsDetail(['Node', 'Python', 'Rust', 'Go', 'Java'], 5, 13));
      v.warning('gh: the GitHub login was kept in Credential Manager. Log in again with: gh auth login --web');
      p.at(12340);
      t.equal(
        v.frame(false),
        [
          // 12340 ms: the spinner's fifth frame.
          '  ⠼ 1  Network and session host          12.3s  Private-network blocking',
          '  ✓ 2  Pre-provision hooks and desktop    1.2s',
          '  ⠼ 3  Developer tools                   12.3s  Node, Python, Rust +2 (5/13)',
          '  · 4  Agent: claude                            waiting',
          '',
          '  ! gh: the GitHub login was kept in Credential Manager. Log in again with: gh…',
        ],
        'while tasks run: their stage spins and names them (the toolchain steps), done stages show their time',
      );
      t.check(
        v.frame(false).every((l) => l.length <= 79) && plainText(v.frame().join('\n')) === v.frame(false).join('\n'),
        'every row fits in the terminal (one column spare); the colours are only colours',
      );
      const narrow = play(true, 53);
      narrow.view.started(task('toolchains'));
      narrow.view.detail('toolchains', stepsDetail(['Node', 'Python'], 1, 9));
      t.equal(
        narrow.view.frame(false)[2],
        '  ⠋ 3  Developer tools                    0.0s  Nod…',
        'a narrow terminal cuts the row, not wraps it',
      );
      p.take();
      v.tick();
      const redraw = p.take();
      // The first frame (at start) had the 4 rows; this one has the rows, a blank line and the warning.
      t.check(
        redraw.startsWith('\r\x1b[4A') && redraw.endsWith('\x1b[J') && redraw.split('\n').length === 7,
        'a redraw moves up over the block it drew last and draws the new one in place',
        JSON.stringify(redraw.slice(0, 40)),
      );
      v.tick();
      t.check(p.take() === '', 'nothing is drawn when nothing changed');

      const before = v.capturing;
      let inside = true;
      const printed = v.aside(() => {
        inside = v.capturing;
        v.line('Hook [pre-agent]: 90-games.cmd', 2);
        return 7;
      });
      const asideText = p.take();
      t.check(
        printed === 7 &&
          asideText.startsWith('\r\x1b[6A\x1b[J') &&
          asideText.includes('Hook [pre-agent]: 90-games.cmd\n') &&
          asideText.endsWith('\x1b[J'),
        'a hook gets the terminal: the block steps aside, the hook prints, the block comes back below it',
        JSON.stringify(asideText.slice(0, 60)),
      );
      t.check(
        before && !inside && v.capturing,
        "programs' output goes to the log while the block owns the terminal, not while a hook has it",
      );

      v.finished(task('network'), done('network', 12040));
      v.finished(task('toolchains'), done('toolchains', 11140));
      v.started(task('agent'));
      p.at(14000);
      v.finished(task('agent'), done('agent', 1660));
      v.summary(['git: 2.43.0.windows.1', 'PROTECTION MISSING: the LAN firewall is off']);
      p.take();
      v.release({
        ms: 14000,
        outcomes: [done('network', 12040), done('toolchains', 11140), done('agent', 1660)],
        background: [],
        logPath: 'C:\\AgentData\\logs\\guest.log',
      });
      const final = p.take();
      t.equal(
        plainText(final).replace(/\r/g, '').split('\n'),
        [
          '  ✓ 1  Network and session host          12.3s',
          '  ✓ 2  Pre-provision hooks and desktop    1.2s',
          '  ✓ 3  Developer tools                   12.3s',
          '  ✓ 4  Agent: claude                      1.7s',
          '',
          'Warnings',
          '  ! gh: the GitHub login was kept in Credential Manager. Log in again with: gh',
          '    auth login --web',
          '',
          'Tools',
          '  git                 2.43.0.windows.1',
          '  PROTECTION MISSING  the LAN firewall is off',
          '',
          'Ready in 14.0s (slowest: Private-network blocking 12.0s, Developer tools 11.1s, Agent install 1.7s)',
          'Log: C:\\AgentData\\logs\\guest.log',
          '',
        ],
        'when ready: the block stays as a still list, then the warnings in full, the tools and the ready line',
      );
      t.check(
        final.startsWith('\r\x1b[') && final.endsWith('\x1b[?25h') && !v.capturing,
        'release erases the live block, shows the cursor again and gives the console back',
      );
      v.line('late line', 3);
      v.warning('late warning');
      v.tick();
      t.check(p.take() === '', 'nothing prints after the release (the first session owns the console)');
    }
    {
      const p = play(true);
      p.view.start('x');
      p.view.started(task('ptyhost'));
      p.view.line('an info line', 1);
      t.check(
        !plainText(p.out()).includes('an info line') && p.view.capturing,
        'live: info lines go to the log file only, and programs hand their output to the log',
      );
    }

    t.section('pieces');
    t.equal(stepsDetail([], 0, 0), 'Developer tools', 'no step running yet: the stage says what it does');
    t.equal(
      readyLines({ ms: 900, outcomes: [done('ptyhost', 900)], background: ['A', 'B', 'C', 'D', 'E'], logPath: 'l' }),
      [
        'Ready in 0.9s',
        'Still installing in the background: A, B, C and 2 more (a few minutes; it does not hold you up)',
      ],
      'the ready line names no task under a second; a long background list is shortened',
    );
    t.equal(wrap('aa bb cc dd', 5), ['aa bb', 'cc dd'], 'wrap breaks between words');
    t.equal(wrap('abcdefghij k', 4), ['abcd', 'efgh', 'ij k'], 'wrap cuts a word longer than the width');

    t.section('log file lines');
    const at = new Date(Date.UTC(2026, 10, 4, 2, 7, 5, 9));
    t.equal(
      fileLines('hello', at),
      ['2026-11-04T02:07:05.009Z hello'],
      'a file line starts with a zero-padded UTC time',
    );
    t.equal(
      fileLines('\n\x1b[36m[1/9] Network\x1b[0m\r\nsecond  ', at, 'Developer tools'),
      ['2026-11-04T02:07:05.009Z [Developer tools] [1/9] Network', '2026-11-04T02:07:05.009Z [Developer tools] second'],
      'colours are stripped, each line gets its own time and task, blank lines are dropped',
    );
    t.equal(fileLines('\n \n', at), [], 'a blank message writes nothing');
    t.equal(plainText('\x1b[2K\x1b[?25l\x1b[1;33mx\x1b[0m'), 'x', 'cursor and colour codes are removed');
  },
};
