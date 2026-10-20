// The host <-> sandbox channel and the terminal protocol: everything arriving from the sandbox is validated, sized and
// filtered before this PC acts on it.
import { safeId } from '../shared/channel/index.js';
import { GuestRequestSchema, SandboxStatusSchema, SessionStatusSchema } from '../shared/channel/index.js';
import { bootLine, firstStartNotice, pendingDownloads, readyIn, stillWorking } from '../cli/commands/launch/index.js';
import {
  CTRL_C_CONFIRM_MS,
  CTRL_C_HINT,
  CtrlCGuard,
  encodeFrame,
  FrameReader,
  FrameType,
  fixWindowsKeys,
  helloFrame,
  InputJoiner,
  MAX_FRAME_BYTES,
  MOUSE_OFF,
  OutputFilter,
} from '../shared/pty/index.js';
import { bootSilent, FIRST_STATUS_MS } from '../host/channel/index.js';
import type { Suite } from './support/suite.js';

export const channelSuite: Suite = {
  name: 'channel',
  title: 'request/status validation and the terminal protocol (frames, OSC 52, keys)',
  run: async (t) => {
    t.section('a silent boot');
    t.check(
      !bootSilent(FIRST_STATUS_MS - 1, false) &&
        bootSilent(FIRST_STATUS_MS + 1, false) &&
        !bootSilent(10 * FIRST_STATUS_MS, true),
      'a boot is silent only when no status came within the first three minutes',
    );

    t.section('requests and session status');
    const validRequest = (r: unknown): boolean => GuestRequestSchema.safeParse(r).success;
    const validSession = (s: unknown): boolean => SessionStatusSchema.safeParse(s).success;
    await t.throws(() => safeId('../evil'), 'invalid id', 'a path-like id is rejected');
    t.check(
      validRequest({ kind: 'ping', id: 'abc', createdAt: 'x' }) &&
        !validRequest({ kind: 'shell', id: 'a' }) &&
        !validRequest({ kind: 'exec', id: 'a/b', command: ['x'], cwd: 'C:\\', timeoutSeconds: 1 }) &&
        !validRequest({ kind: 'ping', id: 'abc', createdAt: 'x', extra: 1 }),
      'requests: known kinds with safe ids pass; unknown kinds, path-like ids and unknown keys are rejected',
    );
    const goodSession = {
      id: 's1',
      launchId: 'l',
      harness: 'claude',
      cwd: 'C:\\Workspace',
      message: 'ok',
      phase: 'running',
      updatedAt: 'x',
      startedAt: 'x',
      attach: { addresses: ['172.20.1.5'], port: 5000, token: 't' },
    };
    t.check(
      validSession(goodSession) &&
        !validSession({ ...goodSession, attach: { ...goodSession.attach, port: 70000 } }) &&
        !validSession({ ...goodSession, phase: 'pwned' }),
      'session status: a well-formed one passes; an impossible port or unknown phase is rejected',
    );
    const shellRequest = {
      kind: 'session',
      id: 'r1',
      harness: 'shell',
      args: [],
      cwd: 'C:\\Workspace',
      shell: 'pwsh',
      createdAt: 'x',
    };
    t.check(
      validRequest(shellRequest) &&
        validRequest({ ...shellRequest, shell: 'auto' }) &&
        !validRequest({ ...shellRequest, shell: 'bash -c evil' }) &&
        validRequest({ kind: 'close', id: 'c1', session: 's1', createdAt: 'x' }) &&
        !validRequest({ kind: 'close', id: 'c1', session: '..\\s1', createdAt: 'x' }) &&
        validSession({ ...goodSession, harness: 'pwsh', kind: 'shell' }) &&
        !validSession({ ...goodSession, kind: 'daemon' }),
      'shells: a session request names one of the known shells; close names a safe session id; a status says shell',
    );

    t.section('boot progress');
    const goodStatus = {
      launchId: 'l1',
      phase: 'provisioning',
      message: '[3/8] Developer tools',
      updatedAt: 'x',
      workspaceHost: 'C:\\p',
      guestWorkspace: 'C:\\Workspace',
      headless: false,
    };
    const progress = {
      step: 3,
      steps: 8,
      title: 'Developer tools',
      active: [{ name: 'Rust', percent: 40 }, { name: 'Go' }],
      done: 2,
      total: 6,
    };
    const parsed = (s: unknown) => SandboxStatusSchema.safeParse(s);
    t.check(
      JSON.stringify(parsed({ ...goodStatus, progress }).data?.progress) === JSON.stringify(progress) &&
        parsed(goodStatus).success &&
        !parsed({ ...goodStatus, phase: 'pwned', progress }).success,
      'a well-formed boot progress is accepted (also none, from an older sandbox); an unknown phase is rejected',
    );
    const hostile = [
      { ...progress, title: 'x'.repeat(5000) },
      { ...progress, active: Array.from({ length: 100 }, () => ({ name: 'a' })) },
      { ...progress, active: [{ name: 'a', percent: 500 }] },
      { ...progress, step: -1 },
      { ...progress, extra: 1 },
      'pwned',
    ];
    t.equal(
      hostile.map((p) => {
        const r = parsed({ ...goodStatus, progress: p });
        return r.success && r.data.progress === undefined;
      }),
      hostile.map(() => true),
      'an oversized or malformed progress is dropped, the status itself still counts',
    );
    const line = (p: unknown) => bootLine(parsed({ ...goodStatus, progress: p }).data ?? null).line;
    t.equal(
      [
        line(progress),
        line({ ...progress, title: 'Agent: claude', step: 6, active: [], done: 0, total: 0 }),
        line({ ...progress, active: [{ name: '\x1b]52;c;ZXZpbA==\x07Ru\x1b[2Jst\r\n', percent: 99 }] }),
        bootLine(null).line,
      ],
      [
        '[3/8] Developer tools: downloading Rust 40%; setting up Go (2 of 6 done)',
        '[6/8] Agent: claude',
        '[3/8] Developer tools: downloading Rust 99% (2 of 6 done)',
        'Starting Windows Sandbox',
      ],
      'the boot line shows step, download and setup; escape sequences and control characters from the sandbox never reach the terminal',
    );
    t.equal(
      [
        bootLine(parsed({ ...goodStatus, progress: { ...progress, active: [{ name: 'Rust', percent: 50 }] } }).data!)
          .key,
        stillWorking('Rust', 3 * 60 * 1000),
        readyIn(432_000),
      ],
      [
        bootLine(parsed({ ...goodStatus, progress: { ...progress, active: [{ name: 'Rust', percent: 60 }] } }).data!)
          .key,
        'Still working on Rust (3 min). Full log: sandbox logs -f',
        'Ready in 7 min 12 s.',
      ],
      'a download moving on is no new plain line; the quiet-spell notice and ready time read well',
    );
    const pending = pendingDownloads(
      ['node', 'rust', 'cpp', 'postgres', 'node', 'constructor'],
      (dir) => dir === 'nvm',
    );
    t.check(
      JSON.stringify(pending) === JSON.stringify({ names: ['rust', 'C/C++', 'PostgreSQL'], mb: 900 }) &&
        firstStartNotice(false, { names: [], mb: 0 }) === null &&
        /^First start: .*\(about 900 MB: rust, C\/C\+\+, PostgreSQL\)\. This can take 5-20 minutes/.test(
          firstStartNotice(true, pending) ?? '',
        ),
      'only what is not downloaded yet counts, once each; the first start says what and how much, a later one says nothing',
    );

    t.section('terminal frames');
    const through = (...chunks: string[]): string => {
      const f = new OutputFilter();
      return Buffer.concat(chunks.map((s) => f.push(Buffer.from(s, 'latin1')))).toString('latin1');
    };
    t.equal(
      [
        through('a\x1b]52;c;ZXZpbA==\x07b\x1b]0;title\x07', 'c\x1b]5', '2;c;cGF5\x1b\\d'),
        through('x\x1b]52;c;QUFB\x1b', '\\y'),
        through('x\x1b]052;c;QUFB\x07y'),
        through('x\x1b]52;c;' + 'A'.repeat(70000), 'B'.repeat(100), '\x07y'),
        through('x\xc2\x9d52;c;QUFB\xc2\x9cy\x1bP1$qm\x1b\\z'),
      ],
      ['ab\x1b]0;title\x07cd', 'xy', 'xy', 'xy', 'xyz'],
      'clipboard writes (OSC 52) from the sandbox are stripped in every disguise (split chunks, leading zero, huge, C1); titles pass',
    );
    const copying = (...chunks: string[]): string => {
      const f = new OutputFilter({ clipboardWrites: true });
      return Buffer.concat(chunks.map((s) => f.push(Buffer.from(s, 'latin1')))).toString('latin1');
    };
    const big = 'QUFB'.repeat(50000);
    t.equal(
      [
        copying('a\x1b]52;c;ZXZpbA==\x07b'),
        copying('x\x1b]5', '2;c;cGF5\x1b', '\\y'),
        copying('x\x1b]52;c;' + big + '\x07y').length,
        copying('x\x1b]52;c;?\x07y'),
        copying('x\x1b]52;c;' + 'A'.repeat(1100000) + '\x07y'),
        copying('x\x1bP1$qm\x1b\\y\x1b]9;9;macro\x07z'),
      ],
      ['a\x1b]52;c;ZXZpbA==\x07b', 'x\x1b]52;c;cGF5\x1b\\y', big.length + 10, 'xy', 'xy', 'xyz'],
      "with clipboard writes allowed: the agent's copy passes (split, long), a clipboard read or a huge one never does, other strings stay dropped",
    );
    const plain = '\x1b]8;;https://a.b\x1b\\link\x1b]8;;\x1b\\ \x1b[31mred\x1b[0m é\xc2\xa0';
    t.equal(
      [through(plain), through('\x1b]9;9;macro\x07\x1b]9;4;1;50\x07')],
      [plain, '\x1b]9;4;1;50\x07'],
      'links, colours and UTF-8 pass unchanged; only the progress form of OSC 9 passes (ConEmu macros do not)',
    );
    await t.throws(
      () => new FrameReader().push(Buffer.concat([Buffer.from([16]), Buffer.from([0, 0, 0, 0x7f])])),
      'frame too large',
      'a frame announcing too much data is rejected instead of buffered',
    );
    const hello = new FrameReader().push(helloFrame('tok', 100, 30, 2))[0];
    t.check(
      new FrameReader().push(encodeFrame(16, Buffer.alloc(MAX_FRAME_BYTES))).length === 1 &&
        hello.type === FrameType.Hello &&
        hello.payload.readInt16LE(0) === 100 &&
        hello.payload.readInt16LE(2) === 30 &&
        hello.payload[4] === 2 &&
        hello.payload.subarray(5).toString() === 'tok',
      'a frame of exactly the maximum size is accepted; a hello frame carries size, flags and token',
    );
    t.equal(
      fixWindowsKeys(Buffer.from([0x61, 0x08, 0x7f, 0x1b])),
      Buffer.from([0x61, 0x7f, 0x08, 0x1b]),
      'Windows console Backspace (^H) reaches the agent as DEL, so it deletes one character, not a word',
    );

    t.section('Ctrl+C meant as "copy" does not reach the agent');
    const ctrlC = Buffer.from([3]);
    const g = new CtrlCGuard();
    const first = g.push(ctrlC, 1000);
    const second = g.push(ctrlC, 1000 + CTRL_C_CONFIRM_MS - 1);
    const third = g.push(ctrlC, 5000);
    const late = g.push(ctrlC, 5000 + CTRL_C_CONFIRM_MS + 1);
    t.check(
      first.held &&
        first.send.length === 0 &&
        !second.held &&
        second.send.equals(ctrlC) &&
        third.held &&
        late.held &&
        !g.push(Buffer.from('a\x03'), 6000).held &&
        !g.push(Buffer.from('x'), 6000).held,
      'a lone Ctrl+C is held back, a second one soon after is sent, a late second one is held again, other input passes',
    );
    g.watchOutput('\x1b]0;claude: working\x07more \x1b]2;\u0001evil\x07');
    t.check(
      g.hintTitle().includes(CTRL_C_HINT) && g.restoreTitle() === '\x1b]0;evil\x07',
      "the hint shows in the title, and the program's last title comes back without control characters",
    );

    t.section('typed input keeps escape sequences whole');
    const joined = (...chunks: string[]): string[] => {
      const j = new InputJoiner();
      const out = chunks.map((c) => j.push(Buffer.from(c, 'latin1')).toString('latin1'));
      out.push(j.flush().toString('latin1'));
      return out.filter(Boolean);
    };
    t.equal(
      [
        joined('ab\x1b[', 'C'),
        joined('\x1b', '[<0;10;', '5M', 'x'),
        joined('a\x1b'),
        joined('\x1b[A\x1bx\x7f'),
        joined('\x1b[' + '1;'.repeat(40)),
      ],
      [['ab', '\x1b[C'], ['\x1b[<0;10;5M', 'x'], ['a', '\x1b'], ['\x1b[A\x1bx\x7f'], ['\x1b[' + '1;'.repeat(40)]],
      'split arrows and mouse reports are sent whole; a lone Esc is held then flushed; complete keys and endless sequences pass at once',
    );
    t.check(
      MOUSE_OFF.includes('\x1b[?1000l') && MOUSE_OFF.includes('\x1b[?1003l') && MOUSE_OFF.includes('\x1b[?1006l'),
      'leaving a session turns every mouse tracking mode off in your terminal',
    );
  },
};
