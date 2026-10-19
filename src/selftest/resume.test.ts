// Reopening the sessions of the last sandbox: the ledger of what ran, the decision to reopen, the limit on automatic
// restarts, which conversation file is a session's, and the arguments that open it again.
import fs from 'node:fs';
import { HarnessSchema } from '../core/schema/index.js';
import { DEFAULTS } from '../core/config/index.js';
import type { SessionStatus } from '../core/types.js';
import {
  autoRestartAllowed,
  describeLast,
  endedUnexpectedly,
  SessionLedger,
  shouldReopen,
  type Life,
  type ResumeSetting,
} from '../host/life/index.js';
import type { Registry } from '../host/projects/index.js';
import { notRunningYet } from '../cli/commands/sessions/reopen.js';
import { pickConversation, resumeArgumentsFor } from '../shared/paths/index.js';
import { SessionStatusSchema } from '../shared/channel/index.js';
import type { Suite } from './support/suite.js';

const ID_A = '0a1b2c3d-0000-4000-8000-000000000001';
const ID_B = '0a1b2c3d-0000-4000-8000-000000000002';
const ID_C = '0a1b2c3d-0000-4000-8000-000000000003';
const NOW = new Date('2026-10-14T12:00:00.000Z');
const minutes = (n: number): string => new Date(NOW.getTime() - n * 60000).toISOString();

const registry = (primary: string, other: string): Registry => ({
  launchId: 'L1',
  protections: {},
  roots: [],
  projects: [
    { name: 'api', host: primary, guest: 'C:\\Workspace\\api', primary: true, mechanism: 'launch', registeredAt: 'x' },
    { name: 'web', host: other, guest: 'C:\\Workspace\\web', primary: false, mechanism: 'boot', registeredAt: 'x' },
  ],
});

const status = (over: Partial<SessionStatus>): SessionStatus => ({
  id: 's1',
  launchId: 'L1',
  harness: 'claude',
  cwd: 'C:\\Workspace\\api',
  phase: 'running',
  message: 'ok',
  updatedAt: minutes(0),
  startedAt: minutes(30),
  ...over,
});

const life = (over: Partial<Life> = {}): Life => ({
  started: minutes(60),
  lastSeen: minutes(1),
  keepAwake: false,
  ...over,
});

export const resumeSuite: Suite = {
  name: 'resume',
  title: 'reopening the last sandbox: ledger, decision, restart limit, conversations',
  run: async (t) => {
    t.section('the ledger');
    const storage = t.dir('storage');
    const data = t.at('storage', 'data', 'main');
    const ledger = new SessionLedger(storage, data);
    const launch = { primary: 'F:\\code\\api', harness: 'claude', projects: [], headless: true, configPath: null };
    const reg = registry('F:\\code\\api', 'F:\\code\\web');
    ledger.recordSessions([status({})], reg, NOW);
    const untracked = ledger.read();
    ledger.startLaunch(launch, NOW);
    t.check(
      untracked === null && ledger.read()?.sessions.length === 0,
      'a sandbox this tool did not start records nothing; a launch starts with no sessions',
    );
    ledger.recordSessions(
      [
        status({ conversation: ID_A }),
        status({ id: 's2', harness: 'codex', cwd: 'C:\\Workspace\\web\\src', startedAt: minutes(20) }),
        status({ id: 's3', phase: 'exited' }),
        status({ id: 's4', cwd: 'D:\\nowhere' }),
        status({ id: 's5', harness: 'pwsh', kind: 'shell' }),
      ],
      reg,
      NOW,
    );
    const saved = ledger.read();
    t.equal(
      [saved?.sessions.map((s) => [s.harness, s.project, s.conversation]), saved?.launch.projects],
      [
        [
          ['claude', 'F:\\code\\api', ID_A],
          ['codex', 'F:\\code\\web\\src', undefined],
        ],
        ['F:\\code\\web'],
      ],
      'running sessions are noted with their folder on this PC (ended ones, unknown folders and shells are not), and the projects',
    );
    ledger.recordSessions(
      [
        status({ startedAt: minutes(30) }),
        status({ id: 's2', harness: 'codex', cwd: 'C:\\Workspace\\web\\src', startedAt: minutes(20) }),
      ],
      reg,
      NOW,
    );
    const kept = ledger.read()?.sessions[0].conversation;
    ledger.recordSessions([status({ conversation: 'not-an-id; rm -rf' })], reg, NOW);
    t.equal(
      [kept, ledger.read()?.sessions.map((s) => s.conversation)],
      [ID_A, [ID_A]],
      'a conversation noted before stays; one that is not an id is never kept (it ends up on a command line)',
    );
    ledger.recordSessions(
      Array.from({ length: 60 }, (_, i) => status({ id: 'x' + i, startedAt: minutes(100 - i) })),
      reg,
      NOW,
    );
    ledger.markClosedOnPurpose();
    const before = JSON.stringify(ledger.read()?.sessions);
    ledger.recordSessions([], reg, NOW);
    const erased = JSON.stringify(ledger.read()?.sessions) !== before;
    ledger.startLaunch(launch, NOW);
    t.check(
      JSON.parse(before).length === 50 &&
        !erased &&
        ledger.read()?.closedOnPurpose === false &&
        ledger.read()?.sessions.length === 50,
      'at most 50 sessions; stopping on purpose is marked and sessions ending at shutdown do not erase it; a new launch clears the mark',
    );
    t.equal(
      describeLast([
        { harness: 'claude', project: 'F:\\code\\mw2-agent', startedAt: 'x' },
        { harness: 'codex', project: 'F:\\code\\web', startedAt: 'x' },
      ]),
      'claude in mw2-agent, codex in web (2 sessions)',
      'what ran last time in plain words',
    );

    t.section('the ledger file is validated');
    const file = t.at('storage', 'sync', 'main-sessions.json');
    const good = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const refused = [
      { ...good, sessions: [{ harness: 'a', project: 'x'.repeat(2000), startedAt: 'x' }] },
      { ...good, sessions: [{ harness: 'a', project: 'b', startedAt: 'x', conversation: 'y'.repeat(200) }] },
      { ...good, sessions: 'many' },
      { savedAt: 'x', sessions: [] },
    ].map((bad) => {
      fs.writeFileSync(file, JSON.stringify(bad));
      return ledger.read();
    });
    t.equal(refused, [null, null, null, null], 'a bad file is refused (huge folder, long conversation, wrong shapes)');

    t.section('reopen, ask or leave');
    const withSessions = {
      sessions: [{ harness: 'claude', project: 'F:\\a', startedAt: 'x' }],
      closedOnPurpose: false,
    };
    const crashed = life({ ended: { at: minutes(1), cause: { kind: 'sandboxCrash', at: minutes(1), text: 'x' } } });
    const closed = life({ ended: { at: minutes(1), cause: null } });
    const expected: Record<ResumeSetting, string[]> = {
      // [last sandbox crashed, closed normally, the PC went down (no end recorded)]
      ask: ['ask', 'ask', 'ask'],
      always: ['reopen', 'reopen', 'reopen'],
      afterCrash: ['reopen', 'no', 'reopen'],
      never: ['no', 'no', 'no'],
    };
    const decided = (['ask', 'always', 'afterCrash', 'never'] as const).map((setting) => [
      shouldReopen(setting, crashed, withSessions),
      shouldReopen(setting, closed, withSessions),
      shouldReopen(setting, life(), withSessions),
    ]);
    t.equal(
      decided,
      Object.values(expected),
      'resume.sessions ask/always/afterCrash/never: after a crash, a normal close, a PC that went down',
    );
    t.check(
      shouldReopen('always', crashed, { sessions: [], closedOnPurpose: false }) === 'no' &&
        shouldReopen('always', crashed, null) === 'no' &&
        shouldReopen('afterCrash', crashed, { ...withSessions, closedOnPurpose: true }) === 'no',
      'nothing recorded, no ledger, or stopped on purpose: nothing is reopened',
    );
    t.check(
      !endedUnexpectedly(life(), false, true) && !endedUnexpectedly(null, false, false),
      'a watcher that still runs, or no record at all, is not a crash',
    );

    t.section('automatic restarts: 3 in 6 hours');
    t.check(
      autoRestartAllowed([minutes(10), minutes(20)], NOW) &&
        !autoRestartAllowed([minutes(10), minutes(20), minutes(30)], NOW) &&
        autoRestartAllowed([minutes(10), minutes(20), minutes(7 * 60)], NOW) &&
        !autoRestartAllowed([minutes(10), minutes(20), minutes(359)], NOW) &&
        autoRestartAllowed(['garbage', '', minutes(1)], NOW),
      'the fourth restart in six hours is refused; old ones and garbage in the file do not count',
    );
    const restarts = new SessionLedger(storage, t.at('storage', 'data', 'other'));
    restarts.startLaunch(launch, NOW);
    for (let i = 0; i < 4; i++) restarts.recordAutoRestart(new Date(NOW.getTime() - (4 - i) * 3600000));
    const counted = restarts.read()?.autoRestarts?.length;
    restarts.giveUp(NOW);
    t.check(
      counted === 4 && restarts.takeGaveUp() !== null && restarts.takeGaveUp() === null,
      'automatic restarts are counted; the launch hears that it gave up, once',
    );

    t.section("which conversation is a session's");
    const at = (ms: number): number => NOW.getTime() + ms * 1000;
    const files = [
      { id: ID_A, createdMs: at(5) },
      { id: ID_B, createdMs: at(20) },
      { id: ID_C, createdMs: at(-100) },
      { id: 'notes', createdMs: at(6) },
    ];
    t.equal(
      [
        pickConversation(files, NOW.getTime(), new Set()),
        pickConversation(files, NOW.getTime(), new Set([ID_A])),
        pickConversation(files, at(10), new Set()),
        pickConversation(files, at(30), new Set()),
      ],
      [ID_A, ID_B, ID_B, null],
      'the first file created since the session started, not one another session has; none yet is null',
    );

    t.section('the arguments that open it again');
    const claude = DEFAULTS.harnesses.claude;
    t.equal(
      [
        resumeArgumentsFor(claude, ID_A),
        resumeArgumentsFor(claude),
        resumeArgumentsFor(claude, 'x; calc'),
        resumeArgumentsFor(DEFAULTS.harnesses.codex, ID_A),
        resumeArgumentsFor({}, ID_A),
      ],
      [['--resume', ID_A], ['--continue'], ['--continue'], ['resume', '--last'], []],
      'a known id opens that conversation; otherwise the last one; an id that is not one never reaches the command line',
    );
    const harness = (extra: Record<string, unknown>): boolean =>
      HarnessSchema.safeParse({ npmPackage: 'x', npmBin: 'x', arguments: [], environment: {}, ...extra }).success;
    t.check(
      harness({ resumeOneArguments: ['--resume', '{id}'] }) &&
        !harness({ resumeOneArguments: ['--resume'] }) &&
        SessionStatusSchema.safeParse(status({ conversation: ID_A })).success &&
        !SessionStatusSchema.safeParse(status({ conversation: 'y'.repeat(200) })).success,
      'resumeOneArguments needs {id}; a session status may carry a capped conversation',
    );

    t.section('not opening twice');
    t.equal(
      notRunningYet(
        [
          { harness: 'claude', hostDir: 'F:\\code\\api' },
          { harness: 'claude', hostDir: 'F:\\code\\api' },
          { harness: 'codex', hostDir: 'F:\\code\\api' },
        ],
        [{ harness: 'claude', hostDir: 'F:\\code\\API' }],
      ).map((r) => r.harness),
      ['claude', 'codex'],
      'a session the sandbox already has is not opened again (one for one, any letter case)',
    );
  },
};
