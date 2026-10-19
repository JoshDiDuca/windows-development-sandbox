// The audit log: kept small (repeats folded, a cap per minute, old days compressed, limits on days and size), read back
// filtered, secrets scrubbed from command lines, every program linked to the session that started it (and nothing
// guessed), commits read from a project's reflog, what the sandbox reports checked like everything else from it, and
// the Activity page on every surface.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { z } from 'zod';
import { auditArgv, auditPage, auditView, listAudit, NO_SESSION, type AuditList } from '../app/features/audit/index.js';
import { auditListing } from '../app/features/audit/audit.run.js';
import { pageLines } from '../cli/output/index.js';
import { menuView } from '../cli/menu/render-view.js';
import {
  AuditCollector,
  AuditLog,
  CommitWatcher,
  fold,
  makesCommits,
  parseReflogLine,
  redactCommandLine,
  SessionBook,
  type AuditEvent,
  type AuditSettings,
} from '../host/audit/index.js';
import { Attributor, parseProcessEvents } from '../guest/audit/parse.js';
import { RunDir } from '../shared/channel/index.js';
import type { Suite } from './support/suite.js';

const DAY = 86400000;
const ev = (t: string, extra: Partial<AuditEvent> = {}): AuditEvent => ({
  t,
  k: 'proc',
  p: 'C:\\x\\cargo.exe',
  c: 'cargo build',
  ...extra,
});
/** YYYY-MM-DD, `n` days before today (UTC, like the day files). */
const day = (n: number): string => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const SHA = (c: string): string => c.repeat(40);
const settings = (extra: Partial<AuditSettings> = {}): AuditSettings => ({
  enabled: true,
  days: 7,
  maxMb: 50,
  processes: true,
  files: false,
  commits: true,
  projects: [],
  ...extra,
});

/** A 4688 event as wevtutil prints it. */
function procEvent(id: number, pid: number, ppid: number, program: string, cmd = program, t = iso(1000)): string {
  return (
    "<Event><System><TimeCreated SystemTime='" +
    t +
    "'/><EventRecordID>" +
    id +
    "</EventRecordID></System><EventData><Data Name='NewProcessId'>0x" +
    pid.toString(16) +
    "</Data><Data Name='NewProcessName'>" +
    program +
    "</Data><Data Name='CommandLine'>" +
    cmd +
    "</Data><Data Name='ProcessId'>0x" +
    ppid.toString(16) +
    "</Data><Data Name='ParentProcessName'>C:\\parent.exe</Data></EventData></Event>"
  );
}

export const auditSuite: Suite = {
  name: 'audit',
  title: 'audit log (folding, retention, secrets, sessions, commits, untrusted reports, the Activity page)',
  run: (t) => {
    t.section('small');
    const folded = fold([
      ev('2026-01-01T10:00:01Z'),
      ev('2026-01-01T10:00:02Z'),
      ev('2026-01-01T10:00:03Z', { c: 'cargo test' }),
      ev('2026-01-01T10:01:00Z'),
    ]);
    t.equal(
      folded.map((e) => [e.c, e.n ?? 1]),
      [
        ['cargo build', 2],
        ['cargo test', 1],
        ['cargo build', 1],
      ],
      'repeats within a minute become one line with a count',
    );
    t.equal(
      fold([ev('2026-01-01T10:00:01Z', { s: 'a' }), ev('2026-01-01T10:00:02Z', { s: 'b' })]).length,
      2,
      "the same command in two sessions stays two lines (each session's own)",
    );
    const flood = fold(
      [
        ...Array.from({ length: 50 }, (_, i) => ev('2026-01-01T10:00:00Z', { c: 'step ' + i })),
        ev('2026-01-01T10:00:00Z', { k: 'commit', h: SHA('a'), p: 'a commit' }),
      ],
      10,
    );
    t.check(
      flood.length === 12 &&
        flood.some((e) => e.k === 'commit') &&
        flood.at(-1)!.k === 'note' &&
        flood.at(-1)!.p!.startsWith('40 more'),
      'past the per-minute cap the rest is one note; a commit is never dropped',
    );

    t.section('retention: days and size');
    const dir = t.at('audit-log');
    const log = new AuditLog(dir, { days: 3, maxMb: 5 });
    log.append([
      ev(day(4) + 'T10:00:00Z'),
      ev(day(1) + 'T10:00:00Z'),
      ev(day(0) + 'T00:00:01Z', { k: 'file', p: 'src/a.ts', a: 'change', w: 'C:\\app' }),
    ]);
    log.maintain(day(0));
    t.equal(
      fs.readdirSync(dir).sort(),
      [day(1) + '.jsonl.gz', day(0) + '.jsonl'],
      'finished days are compressed and days past audit.days are deleted',
    );
    t.includes(
      zlib.gunzipSync(fs.readFileSync(path.join(dir, day(1) + '.jsonl.gz'))).toString(),
      'cargo build',
      'a compressed day still holds its events',
    );
    // Written while the limit was higher, then kept to 5 MB.
    const roomy = new AuditLog(t.at('audit-big'), { days: 30, maxMb: 50 });
    // Random text: compression must not make the test data fit after all.
    const line = (d: string): AuditEvent => ev(d + 'T00:00:00Z', { c: crypto.randomBytes(900).toString('hex') });
    for (const d of [day(2), day(1), day(0)]) roomy.append(Array.from({ length: 1400 }, () => line(d)));
    const big = new AuditLog(roomy.dir, { days: 30, maxMb: 5 });
    big.maintain(day(0));
    t.check(
      big.bytes() <= 5 * 1024 * 1024 && fs.readdirSync(big.dir).length < 3,
      'past audit.maxMb the oldest days go',
      String(big.bytes()),
    );
    const capped = new AuditLog(t.at('audit-capped'), { days: 30, maxMb: 5 });
    for (let i = 0; i < 3; i++) capped.append(Array.from({ length: 1400 }, () => line(day(0))));
    const cappedEvents = capped.read({ days: 1 });
    t.check(
      capped.bytes() <= 5 * 1024 * 1024 + 4096 &&
        cappedEvents.filter((e) => e.k === 'note' && e.p!.includes('audit.maxMb')).length === 1,
      'past audit.maxMb nothing more is written while the sandbox runs, but one note saying so',
      String(capped.bytes()),
    );
    const late = new AuditLog(t.at('audit-late'), { days: 7, maxMb: 5 });
    late.append([ev(day(1) + 'T23:59:58Z', { c: 'before midnight' })]);
    late.maintain(day(0));
    late.append([ev(day(1) + 'T23:59:59Z', { c: 'reported late' })]);
    late.maintain(day(0));
    t.equal(
      late.read({ days: 3 }).map((e) => e.c),
      ['before midnight', 'reported late'],
      "a line that arrives after its day was compressed is added to it: the day's log is never written over",
    );
    const clipped = new AuditLog(t.at('audit-clip'), { days: 7, maxMb: 5 });
    clipped.append([ev(day(0) + 'T00:00:01Z', { k: 'session', w: 'C:\\' + 'x'.repeat(3000) })]);
    t.equal(
      clipped.read({ days: 1 }).map((e) => e.w?.length),
      [1024],
      'a field longer than its limit is cut, not left to make the line unreadable later',
    );
    const kept = new AuditLog(t.at('audit-kept'), { days: 2, maxMb: 5 });
    kept.append([ev(day(5) + 'T10:00:00Z', { c: 'old' }), ev(day(0) + 'T00:00:01Z', { c: 'new' })]);
    t.equal(
      kept.read({ days: 30 }).map((e) => e.c),
      ['new'],
      'reading never goes back past audit.days, even before the old day is deleted',
    );
    t.write(path.join(kept.dir, day(1) + '.jsonl.gz'), 'not gzip at all');
    t.equal(kept.read({ days: 2 }).length, 1, 'a damaged day is left out, the rest is read');

    t.section('reading');
    t.equal(
      log.read({ days: 3, kinds: ['file'] }).map((e) => e.p),
      ['src/a.ts'],
      'events can be filtered by kind',
    );
    t.equal(log.read({ days: 3, grep: 'SRC/A.TS' }).length, 1, '... and by text (any case)');

    t.section('secrets never reach the log');
    const cases: [string, string, string][] = [
      ['curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" https://x', 'abcdefghijklmnop', 'a header'],
      ['git push https://bob:hunter22@github.com/a/b.git', 'hunter22', 'a password in a URL'],
      ['npm publish --token npm_abcdefghijklmnopqrstuvwxyz0123456789', 'npm_abcdefgh', 'a token flag'],
      ['mytool --password=s3cretvalue --verbose', 's3cretvalue', '--password=value'],
      ['set API_KEY=zzzyyyxxx123 && run', 'zzzyyyxxx123', 'NAME=value'],
      ['mysql -u root -pHunter2pass db', 'Hunter2pass', 'mysql -p<password>'],
      ['echo ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', 'ghp_abcdefghij', 'a token by its shape'],
      ["$env:GITHUB_TOKEN = 'abcdef123456'", 'abcdef123456', 'a PowerShell variable'],
      ['set PGPASSWORD=pgsecret1 && psql', 'pgsecret1', 'a name with the word inside (PGPASSWORD)'],
      ['tool --accessToken abc123def456', 'abc123def456', 'a camelCase flag'],
      ['tool --apiToken=abc123def456', 'abc123def456', 'a camelCase flag with ='],
      ['docker login -u me -p dockerpw1 registry.io', 'dockerpw1', 'docker login -p'],
      ['sshpass -p sshpw123 ssh host', 'sshpw123', 'sshpass -p'],
      ['curl --user=me:curlpw12 https://x', 'curlpw12', 'curl --user=name:password'],
      ['git clone https://abcdef0123456789@github.com/a/b', 'abcdef0123456789', 'a token as the user name of a URL'],
      ['$p = ConvertTo-SecureString "pspw1234" -AsPlainText', 'pspw1234', 'ConvertTo-SecureString'],
    ];
    for (const [cmd, secret, what] of cases) {
      const out = redactCommandLine(cmd);
      t.check(!out.includes(secret) && out.includes('***'), 'hidden: ' + what, out);
    }
    t.equal(
      redactCommandLine('git commit -m "fix the login page" && cargo build --release'),
      'git commit -m "fix the login page" && cargo build --release',
      'ordinary command lines stay as they are',
    );

    t.section('which session a program belongs to');
    const attributor = new Attributor();
    const now = Date.now();
    const roots = [
      { session: 's-one', pid: 100, from: now - 60000 },
      { session: 's-old', pid: 300, from: now - 600000, to: now - 300000 },
    ];
    const who = (pid: number, ppid: number, at = now): string | undefined =>
      attributor.attribute({ pid, ppid, t: at }, roots);
    t.equal(
      [who(100, 50), who(101, 100), who(102, 101), who(103, 102)],
      [undefined, 's-one', 's-one', 's-one'],
      "the ptyhost itself is no session's; what it starts, and what those start, are its session's",
    );
    t.equal(who(200, 77), undefined, 'a program whose parent was never seen is no session: nothing is guessed');
    t.equal(who(102, 999), undefined, 'a reused process id does not keep the session of the process it had before');
    t.equal(who(104, 102), undefined, '... and neither do the programs it starts');
    t.equal(who(301, 300), undefined, "an ended session's ptyhost id, reused later, is not that session's");
    const xml =
      procEvent(41, 0x200, 0x100, 'C:\\AgentData\\tools\\git\\cmd\\git.exe', 'git push --force &quot;origin&quot;') +
      procEvent(42, 0x201, 0x200, 'C:\\Windows\\System32\\conhost.exe') +
      procEvent(43, 0x202, 0x201, 'C:\\x\\node.exe', 'node a.js');
    const parsed = parseProcessEvents(xml, {
      attributor: new Attributor(),
      roots: [{ session: 's-two', pid: 0x100, from: now - 60000 }],
    });
    t.equal(
      {
        last: parsed.last,
        lines: parsed.lines.map((l) => JSON.parse(l) as AuditEvent).map((e) => [e.p, e.c, e.s]),
      },
      {
        last: 43,
        lines: [
          ['C:\\AgentData\\tools\\git\\cmd\\git.exe', 'git push --force "origin"', 's-two'],
          ['C:\\x\\node.exe', 'node a.js', 's-two'],
        ],
      },
      "Windows process events become audit lines linked to their session; Windows' own programs are left out but still carry the link",
    );

    t.section('commits, read from the reflog on this PC');
    const repo = t.dir('audit-repo');
    const reflog = t.write(path.join(repo, '.git', 'logs', 'HEAD'), '');
    const reflogLine = (sha: string, msg: string, secondsAgo = 5): string =>
      SHA('0') +
      ' ' +
      sha +
      ' Ada Lovelace <ada@example.com> ' +
      Math.floor((Date.now() - secondsAgo * 1000) / 1000) +
      ' +0100\t' +
      msg +
      '\n';
    fs.appendFileSync(reflog, reflogLine(SHA('1'), 'commit (initial): before the sandbox'));
    const watcher = new CommitWatcher();
    watcher.prime([repo]);
    fs.appendFileSync(
      reflog,
      reflogLine(SHA('2'), 'commit: add the parser') +
        reflogLine(SHA('3'), 'checkout: moving from main to dev') +
        reflogLine(SHA('4'), 'commit (amend): add the parser, fixed') +
        'garbage line\n',
    );
    const seen = watcher.commits([repo]);
    t.equal(
      seen.map((c) => [c.sha.slice(0, 1), c.action, c.message, c.author]),
      [
        ['2', 'commit', 'add the parser', 'Ada Lovelace <ada@example.com>'],
        ['4', 'amend', 'add the parser, fixed', 'Ada Lovelace <ada@example.com>'],
      ],
      'only commits made since the first look are reported (checkouts and junk are not commits)',
    );
    t.equal(watcher.commits([repo]), [], 'nothing new, nothing reported');
    fs.writeFileSync(reflog, reflogLine(SHA('5'), 'commit: rewritten'));
    t.equal(watcher.commits([repo]), [], 'a reflog that shrank is not read again from the start');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt', 'logs'), { recursive: true });
    const wt = t.write(path.join(repo, '.git', 'worktrees', 'wt', 'logs', 'HEAD'), '');
    watcher.commits([repo]);
    fs.appendFileSync(wt, reflogLine(SHA('6'), 'commit: in a worktree'));
    fs.appendFileSync(reflog, reflogLine(SHA('7'), 'merge feature: Merge made by the ort strategy.'));
    t.equal(
      watcher
        .commits([repo])
        .map((c) => c.action + ' ' + c.sha.slice(0, 1))
        .sort(),
      ['commit 6', 'merge 7'],
      "a worktree's commits are seen too, and merges",
    );
    t.equal(
      parseReflogLine(SHA('0') + ' ' + SHA('0') + ' x <y> 1 +0000\tcommit: deleted', repo),
      null,
      'a line that does not record a commit (all-zero id) is not one',
    );
    t.check(
      makesCommits('C:\\git\\cmd\\git.exe', 'git commit -m x') &&
        makesCommits('git', 'git -C app merge dev') &&
        !makesCommits('C:\\git\\cmd\\git.exe', 'git status') &&
        !makesCommits('C:\\x\\node.exe', 'node commit.js'),
      'the git commands that can make a commit are told apart from the rest',
    );

    t.section('files and commits: linked only when it can be known');
    const book = new SessionBook();
    const base = Date.now() - 3600000;
    const at = (minutes: number): string => new Date(base + minutes * 60000).toISOString();
    book.update(
      [
        { id: 'a', harness: 'claude', project: 'app', phase: 'exited', startedAt: at(0), updatedAt: at(30) },
        { id: 'b', harness: 'codex', project: 'app', phase: 'running', startedAt: at(20), updatedAt: at(20) },
        { id: 'c', harness: 'claude', project: 'web', phase: 'running', startedAt: at(0), updatedAt: at(0) },
      ],
      'app',
    );
    const ms = (minutes: number): number => base + minutes * 60000;
    t.equal(
      [
        book.linkFile('app', ms(10)),
        book.linkFile('app', ms(25)),
        book.linkFile('app', ms(40)),
        book.linkFile('other', ms(10)),
      ],
      [{ s: 'a', sv: 't' }, undefined, { s: 'b', sv: 't' }, undefined],
      'a file change is linked (as likely) only while exactly one session ran in its project',
    );
    t.equal(
      [
        book.linkCommit('app', ms(25), [{ t: ms(24), session: 'b' }]),
        book.linkCommit('app', ms(25), [
          { t: ms(24), session: 'a' },
          { t: ms(24.5), session: 'b' },
        ]),
        book.linkCommit('app', ms(25), [{ t: ms(24), session: 'c' }]),
      ],
      [{ s: 'b', sv: 'p' }, undefined, undefined],
      "a commit goes to the session whose git command made it; two candidates or another project's session: none",
    );
    t.equal(
      [book.linkCommit('app', ms(40), [], true), book.linkCommit('app', ms(40), [], false)],
      [{ s: 'b', sv: 't' }, undefined],
      'with no git command seen, a commit is "likely" the only running session only when programs are not recorded',
    );
    book.update([], 'app', ms(50));
    t.equal(book.linkFile('app', ms(55)), undefined, 'a session whose record is gone counts as ended');

    t.section('what the sandbox reports');
    const data = t.at('audit-data', 'data', 'd');
    const storage = t.at('audit-data');
    const run = new RunDir(data);
    t.writeJson(run.sessionFile('known-1'), {
      id: 'known-1',
      launchId: 'l1',
      harness: 'claude',
      cwd: 'C:\\Projects\\app',
      project: 'app',
      phase: 'running',
      message: 'claude is running',
      updatedAt: iso(60000),
      startedAt: iso(120000),
    });
    t.write(
      path.join(run.auditDir, '1-1.jsonl'),
      [
        JSON.stringify({ t: iso(5000), k: 'guard', p: 'fake: all clear', s: 'known-1' }),
        JSON.stringify({
          t: iso(4000),
          k: 'proc',
          p: 'C:\\x.exe',
          c: 'x --token abcdefgh12345678',
          w: 'C:\\Users\\me',
          s: 'known-1',
          ag: 'not-claude',
        }),
        JSON.stringify({ t: '2001-01-01T00:00:00Z', k: 'proc', p: 'C:\\y.exe', s: 'made-up-session' }),
        'not json',
        JSON.stringify({ t: iso(3000), k: 'proc', p: 'x'.repeat(5000) }),
      ].join('\n'),
    );
    t.write(path.join(run.auditDir, 'not-a-report.txt'), 'ignored');
    // A folder with a report's name stops nothing.
    fs.mkdirSync(path.join(run.auditDir, '0-0.jsonl'), { recursive: true });
    const project = t.dir('audit-data', 'app');
    const collector = new AuditCollector(data, storage, settings(), () => [{ name: 'app', host: project }]);
    collector.flush();
    const got = new AuditLog(AuditLog.dirFor(storage, data), { days: 7, maxMb: 50 }).read({ days: 7 });
    const procs = got.filter((e) => e.k === 'proc');
    t.equal(
      procs.map((e) => [e.p, e.w, e.s, e.ag, e.pj, e.sv]),
      [
        ['fake: all clear', undefined, 'known-1', 'claude', 'app', 'p'],
        ['C:\\x.exe', undefined, 'known-1', 'claude', 'app', 'p'],
        ['C:\\y.exe', undefined, undefined, undefined, undefined, undefined],
      ],
      "sandbox reports can only be programs: other kinds are recorded as such, fields it may not set are dropped, the agent comes from this PC's record, a session this sandbox does not have is dropped, oversized lines are refused",
    );
    t.check(
      procs[1].c === 'x --token ***' && Math.abs(Date.parse(procs[2].t) - Date.now()) < 60000,
      'a reported command line loses its secrets, and a time far from now is taken as now',
      JSON.stringify(procs),
    );
    t.check(
      got.some((e) => e.k === 'session' && e.a === 'start' && e.s === 'known-1' && e.ag === 'claude'),
      'a session starting is recorded with its id and agent',
    );
    t.check(!fs.existsSync(path.join(run.auditDir, '1-1.jsonl')), 'reports are deleted once taken in');
    // A commit in the project: held until the git command that made it could be reported, then linked to it.
    fs.mkdirSync(path.join(project, '.git', 'logs'), { recursive: true });
    const projectLog = path.join(project, '.git', 'logs', 'HEAD');
    fs.writeFileSync(projectLog, '');
    const second = new AuditCollector(data, storage, settings(), () => [{ name: 'app', host: project }]);
    second.start();
    fs.appendFileSync(projectLog, reflogLine(SHA('9'), 'commit: use the token from --password hunter2x'));
    t.write(
      path.join(run.auditDir, '2-1.jsonl'),
      JSON.stringify({ t: iso(2000), k: 'proc', p: 'C:\\git\\cmd\\git.exe', c: 'git commit -m x', s: 'known-1' }),
    );
    second.flush(true);
    const commit = new AuditLog(AuditLog.dirFor(storage, data), { days: 7, maxMb: 50 })
      .read({ days: 7, kinds: ['commit'] })
      .at(-1);
    t.check(
      commit !== undefined &&
        commit.h === SHA('9') &&
        commit.s === 'known-1' &&
        commit.sv === 'p' &&
        commit.ag === 'claude' &&
        commit.au === 'Ada Lovelace <ada@example.com>' &&
        !commit.p!.includes('hunter2x'),
      'a commit is recorded with its id, author and message (secrets hidden), linked to the session whose git command made it',
      JSON.stringify(commit),
    );

    t.section('the Activity page');
    const pageLog = new AuditLog(t.at('audit-page'), { days: 7, maxMb: 100 });
    pageLog.append([
      { t: iso(9000), k: 'session', a: 'start', p: 'claude', s: 'sess-claude-1', ag: 'claude', pj: 'app' },
      { t: iso(8000), k: 'proc', p: 'C:\\git.exe', c: 'git status', s: 'sess-claude-1', ag: 'claude', pj: 'app' },
      {
        t: iso(7000),
        k: 'file',
        a: 'change',
        p: 'src/a.ts',
        w: 'F:\\app',
        pj: 'app',
        s: 'sess-claude-1',
        ag: 'claude',
        sv: 't',
      },
      {
        t: iso(6000),
        k: 'commit',
        a: 'commit',
        p: 'add a',
        h: SHA('a'),
        pj: 'app',
        s: 'sess-claude-1',
        ag: 'claude',
        sv: 'p',
      },
      { t: iso(5000), k: 'proc', p: 'C:\\npm.cmd', c: 'npm test', s: 'sess-codex-22', ag: 'codex', pj: 'web', n: 3 },
      { t: iso(4000), k: 'proc', p: 'C:\\setup.exe', c: 'setup /quiet' },
      { t: iso(3000), k: 'guard', p: 'hook: a pre-commit hook was neutralised' },
    ]);
    const listing = (input: z.input<typeof listAudit.input> = {}): AuditList =>
      auditListing(pageLog, { enabled: true, days: 7, maxMb: 100 }, listAudit.input.parse(input), 'C:\\audit');
    const all = listing();
    t.equal(
      [all.totals, all.unlinked, all.sessions.map((s) => [s.id, s.agent, s.commands, s.files, s.commits])],
      [
        { events: 7, commands: 5, files: 1, commits: 1, sessions: 2 },
        { commands: 1, files: 0, commits: 0 },
        [
          ['sess-codex-22', 'codex', 3, 0, 0],
          ['sess-claude-1', 'claude', 1, 1, 1],
        ],
      ],
      'the totals, what no session can be linked to, and each session summed up',
    );
    t.equal(
      [
        listing({ session: 'sess-claude' }).events.length,
        listing({ session: NO_SESSION }).events.map((e) => e.kind),
        listing({ agent: 'CODEX' }).events.map((e) => e.what),
        listing({ kind: 'commit' }).events.map((e) => e.sha),
        listing({ grep: 'npm' }).matched,
        listing({ limit: 2 }).events.map((e) => e.kind),
        listing({ project: 'web' }).totals.commands,
      ],
      [4, ['guard', 'proc'], ['C:\\npm.cmd'], [SHA('a')], 1, ['guard', 'proc'], 3],
      'filters: a session (or the start of its id, or none), an agent, a kind, a text, a limit (the newest), a project',
    );
    const page = auditPage(all);
    const sessionsSection = page.sections.find((s) => s.id === 'sessions');
    const card = sessionsSection?.items?.find((i) => i.id === 'session:sess-claude-1');
    t.check(
      page.sections.map((s) => s.id).join(',') === 'summary,agents,sessions,events' &&
        sessionsSection?.cards === true &&
        card?.primary?.kind === 'link' &&
        card.primary.target.kind === 'view' &&
        card.primary.target.params?.session === 'sess-claude-1' &&
        sessionsSection.items!.some((i) => i.id === 'session:' + NO_SESSION) &&
        page.sections.find((s) => s.id === 'summary')!.facts!.some((f) => f.label === 'Commits' && f.value === '1'),
      'the page: totals, per agent, each session as a card that opens its own events, then the events',
      JSON.stringify(page.sections.map((s) => [s.id, s.items?.length, s.facts?.length])),
    );
    const lines = pageLines(page);
    t.check(
      lines.some((l) => /^Commits\s+1$/.test(l)) &&
        lines.some((l) => /^\s*SESSION\s+AGENT\s+PROJECT\s+STARTED\s+COMMANDS\s+FILES\s+COMMITS$/.test(l)) &&
        lines.some((l) => /^\s*TIME\s+AGENT\s+KIND\s+WHAT$/.test(l)) &&
        lines.some((l) => /claude\?\s+file\s+changed src\/a\.ts/.test(l)) &&
        lines.some((l) => /codex\s+command\s+npm test {2}×3/.test(l)) &&
        lines.some((l) => l.startsWith('? = the only session')),
      'on the command line: the totals, a table of sessions and one of events ("?" marks a likely link)',
      lines.join('\n'),
    );
    const one = auditPage(listing({ session: 'sess-claude-1' }));
    t.check(
      one.sections[0].id === 'filter' &&
        one.sections[0].summary!.includes('session sess-cla') &&
        !one.sections.some((s) => s.id === 'sessions'),
      "one session's page says so and offers to show everything instead of the session cards",
    );
    t.equal(
      pageLines(auditPage({ ...listing({ grep: 'nothing-like-this' }), enabled: false })).at(-1),
      'The audit log is off. Turn it on in the menu (Settings > Security & privacy > Audit log) or with: sandbox config set audit.enabled true',
      'an empty page says how to turn the log on',
    );
    const off = auditPage({
      ...listing({ grep: 'nothing-like-this' }),
      filter: { days: 1, kind: 'all' },
      enabled: false,
    });
    t.check(
      off.empty?.action?.kind === 'operation' &&
        off.empty.action.op === 'settings.set' &&
        off.empty.action.input.key === 'audit.enabled',
      'with the log off, the empty page offers to turn it on (the settings operation, on every surface)',
    );
    t.equal(
      [auditArgv({ days: '7', kind: 'all', session: 'abc' }), auditArgv({ kind: 'commit' })],
      [
        ['audit', '--days', '7', '--session', 'abc'],
        ['audit', '--kind', 'commit'],
      ],
      "the menu shows a session's events with the same command line",
    );
    const menu = menuView(page, { category: 'activity', prefix: 'audit:' });
    const chosen = menu.resolve({ kind: 'pick', value: 'audit:session:sess-claude-1' });
    t.check(
      chosen?.kind === 'action' && chosen.action.kind === 'link' && chosen.action.target.kind === 'view',
      "in the menu, Enter on a session's row opens its events",
    );
    t.equal(
      auditView.inputs!({ days: '14', kind: 'bogus', session: 'x' }),
      { audit: { days: 14, kind: 'all', session: 'x' } },
      "the web page's address becomes the query's input (values it does not know are left at their default)",
    );
  },
};
