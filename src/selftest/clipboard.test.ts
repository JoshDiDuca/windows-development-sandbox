// sandbox.clipboard and sandbox.clipboardDirection: modes, directions, the bridge and its files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  asDirection,
  clipboardLine,
  compareDirection,
  directionOf,
  HCS_CLIPBOARD_NOTE,
  narrowDirection,
  resolveClipboard,
  SHARED_PC_NOTE,
  sharedDirectionNote,
  sidesOf,
  type ClipboardDirection,
  type ClipboardMode,
  type ClipboardPlan,
} from '../core/clipboard.js';
import { DEFAULTS } from '../core/config/index.js';
import type { Config } from '../core/types.js';
import { launchSummary, type GeneratedSandbox } from '../cli/commands/launch/summary.js';
import { clipboardFinding } from '../cli/commands/repair/checks/sandbox.js';
import {
  clearClipboardFiles,
  HostClipboardBridge,
  readClipboardSettings,
  saveClipboardSettings,
  type ClipboardRead,
  type ClipboardSettings,
  type HostClipboardPort,
} from '../host/clipboard/index.js';
import { RunDir } from '../shared/channel/run-dir.js';
import {
  CLIPBOARD_BASE64_MAX,
  CLIPBOARD_MAX_BYTES,
  ClipboardGate,
  clipboardFile,
  openClipboardFile,
  takeClipboardFile,
  textHash,
  toBase64Text,
  type ClipboardFile,
  type ToPcDecision,
} from '../shared/clipboard/index.js';
import { GuestClipboardBridge, type GuestClipboardHelper } from '../guest/daemon/clipboard-bridge.js';
import { buildWsb } from '../host/launch/index.js';
import { hostStateFile } from '../host/storage/index.js';
import type { Suite } from './support/suite.js';

type Engine = Config['sandbox']['engine'];

const plan = (
  clipboard: ClipboardMode,
  clipboardDirection: ClipboardDirection,
  engine: Engine,
  protectedClient = true,
): ClipboardPlan => resolveClipboard({ ...DEFAULTS.sandbox, clipboard, clipboardDirection, engine, protectedClient });

const summary = (p: ClipboardPlan): unknown[] => [
  p.mode,
  p.sharedClipboard,
  p.protectedClient,
  p.bridge,
  p.toPc,
  p.toSandbox,
  p.note,
];

export const clipboardSuite: Suite = {
  name: 'clipboard',
  title: 'clipboard: modes, directions, the bridge and its files',
  run: async (t, f) => {
    t.section('modes');
    t.equal(
      [
        summary(plan('off', 'both', 'windows-sandbox')),
        summary(plan('off', 'toPc', 'hcs', false)),
        summary(plan('text', 'both', 'windows-sandbox')),
        summary(plan('text', 'toPc', 'windows-sandbox', false)),
        summary(plan('text', 'toSandbox', 'hcs')),
        summary(plan('shared', 'both', 'windows-sandbox')),
        summary(plan('shared', 'both', 'windows-sandbox', false)),
        summary(plan('shared', 'toPc', 'windows-sandbox')),
        summary(plan('shared', 'toSandbox', 'windows-sandbox', false)),
        summary(plan('shared', 'both', 'hcs')),
      ],
      [
        ['off', false, true, false, false, false, null],
        ['off', false, false, false, false, false, null],
        ['text', false, true, true, true, true, null],
        ['text', false, false, true, true, false, null],
        ['text', false, true, false, false, true, null],
        ['shared', true, false, false, true, true, SHARED_PC_NOTE],
        ['shared', true, false, false, true, true, null],
        ['text', false, true, true, true, false, sharedDirectionNote('toPc')],
        ['text', false, false, true, false, true, sharedDirectionNote('toSandbox')],
        ['text', false, true, false, true, true, HCS_CLIPBOARD_NOTE],
      ],
      'every row of the behaviour table',
    );
    t.equal(
      [plan('shared', 'toPc', 'windows-sandbox').direction, plan('shared', 'both', 'hcs').direction],
      ['toPc', 'both'],
      'the plan keeps your direction',
    );

    t.section('the one-line texts');
    t.equal(
      [
        clipboardLine(plan('off', 'both', 'windows-sandbox'), 'windows-sandbox'),
        clipboardLine(plan('text', 'both', 'windows-sandbox'), 'windows-sandbox'),
        clipboardLine(plan('text', 'toPc', 'windows-sandbox', false), 'windows-sandbox'),
        clipboardLine(plan('text', 'toSandbox', 'windows-sandbox'), 'windows-sandbox'),
        clipboardLine(plan('text', 'both', 'hcs'), 'hcs'),
        clipboardLine(plan('shared', 'both', 'windows-sandbox'), 'windows-sandbox'),
      ],
      [
        'off',
        'text both ways (Protected Client on)',
        'text from the sandbox to this PC only (Protected Client off)',
        'text from this PC into the sandbox only (Protected Client on)',
        'text through attached terminals',
        'shared: text, images and files both ways (Protected Client off)',
      ],
      'what each mode says about itself',
    );

    t.section('directions');
    t.equal(
      [sidesOf('both'), sidesOf('toPc'), sidesOf('toSandbox')],
      [
        { toPc: true, toSandbox: true },
        { toPc: true, toSandbox: false },
        { toPc: false, toSandbox: true },
      ],
      'sidesOf',
    );
    t.equal(
      [
        directionOf({ toPc: true, toSandbox: true }),
        directionOf({ toPc: true, toSandbox: false }),
        directionOf({ toPc: false, toSandbox: true }),
        directionOf({ toPc: false, toSandbox: false }),
      ],
      ['both', 'toPc', 'toSandbox', null],
      'directionOf',
    );
    t.equal(
      [
        narrowDirection('both', 'toPc'),
        narrowDirection('toSandbox', 'both'),
        narrowDirection('toPc', 'toPc'),
        narrowDirection('toPc', 'toSandbox'),
      ],
      ['toPc', 'toSandbox', 'toPc', null],
      'narrowDirection keeps what both allow',
    );
    t.equal(
      [
        compareDirection('both', 'toPc'),
        compareDirection('toPc', 'both'),
        compareDirection('toPc', 'toPc'),
        compareDirection('toPc', 'toSandbox'),
      ],
      [1, -1, 0, 1],
      'compareDirection: narrower = 1, wider = -1, same = 0, incomparable = 1',
    );
    t.equal(
      [asDirection('toPc'), asDirection(undefined), asDirection('nonsense')],
      ['toPc', 'both', 'both'],
      'asDirection',
    );

    t.section('launch');
    const wsbOf = (over: Partial<Config['sandbox']>): string =>
      buildWsb({ ...f.baseConfig, sandbox: { ...f.baseConfig.sandbox, ...over } }, 4096, []);
    const devices = (wsb: string): string[] => [
      /<ClipboardRedirection>(\w+)</.exec(wsb)?.[1] ?? '',
      /<ProtectedClient>(\w+)</.exec(wsb)?.[1] ?? '',
    ];
    t.equal(
      [
        devices(wsbOf({ clipboard: 'text' })),
        devices(wsbOf({ clipboard: 'shared' })),
        devices(wsbOf({ clipboard: 'off' })),
        devices(wsbOf({ clipboard: 'shared', clipboardDirection: 'toPc' })),
        devices(wsbOf({ clipboard: 'text', protectedClient: false })),
      ],
      [
        ['Disable', 'Enable'],
        ['Enable', 'Disable'],
        ['Disable', 'Enable'],
        ['Disable', 'Enable'],
        ['Disable', 'Disable'],
      ],
      'the .wsb: text = no RDP clipboard and Protected Client on; shared = clipboard on and Protected Client off; shared + toPc = text',
    );

    const run = await f.run();
    const gen = await f.generate(run);
    t.equal(
      gen.clipboard.mode + '/' + gen.clipboard.bridge,
      'text/true',
      'generateSandbox returns what the launch really gets',
    );
    t.equal(
      f.readJson(gen.sessionPath).clipboard,
      { bridge: true, toPc: true, toSandbox: true, line: 'text both ways (Protected Client on)' },
      'session.json tells the guest about the bridge',
    );
    const rows = launchSummary(run, gen as GeneratedSandbox, null);
    t.check(
      rows.some((r) => r[0] === 'Clipboard' && r[1] === 'text both ways (Protected Client on)'),
      'the launch summary has a Clipboard row',
      JSON.stringify(rows),
    );
    const shared = await f.generate(
      await f.run({}, { ...f.baseConfig, sandbox: { ...f.baseConfig.sandbox, clipboard: 'shared' } }),
    );
    const sharedRows = launchSummary(run, shared as GeneratedSandbox, null);
    const at = sharedRows.findIndex((r) => r[0] === 'Clipboard');
    t.equal(
      [sharedRows[at], sharedRows[at + 1]],
      [
        ['Clipboard', 'shared: text, images and files both ways (Protected Client off)'],
        ['', SHARED_PC_NOTE],
      ],
      'shared says that Protected Client is off, in a row of its own',
    );

    t.section('doctor');
    const sb = (over: Partial<Config['sandbox']>): Config['sandbox'] => ({ ...DEFAULTS.sandbox, ...over });
    t.equal(
      [
        clipboardFinding(sb({ clipboard: 'shared', protectedClient: true }), true).detail,
        clipboardFinding(sb({ clipboard: 'shared', protectedClient: false, clipboardDirection: 'toPc' }), true).detail,
        clipboardFinding(sb({}), false).detail,
        clipboardFinding(sb({}), true).detail,
        clipboardFinding(sb({ clipboard: 'off' }), false).status,
      ],
      [
        'the shared clipboard turns Protected Client off',
        'sandbox.clipboardDirection only works with "text"',
        'text copy and paste needs HostTools.exe',
        'text both ways (Protected Client on)',
        'ok',
      ],
      'doctor: the four findings',
    );

    t.section('host-only settings');
    const storage = f.at('clip-storage');
    const data = f.at('clip-storage', 'data', 'one');
    saveClipboardSettings(storage, data, plan('text', 'toPc', 'windows-sandbox'));
    t.equal(
      readClipboardSettings(storage, data),
      { mode: 'text', bridge: true, toPc: true, toSandbox: false },
      'the settings round-trip',
    );
    t.equal(readClipboardSettings(storage, f.at('clip-storage', 'data', 'two')), null, 'no file gives null');
    fs.writeFileSync(hostStateFile(storage, data, '-clipboard.json'), '{ damaged', 'utf8');
    t.equal(readClipboardSettings(storage, data), null, 'a damaged file gives null');

    t.section('files');
    const dirOf = (name: string): string => {
      const dir = f.at('clip-' + name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const wrap = (text: string): ClipboardFile => clipboardFile(text)!;
    for (const text of ['plain', 'line one\r\nline two\r\n', 'emoji \u{1F600} and é']) {
      const opened = openClipboardFile(wrap(text));
      t.equal(opened, { text, hash: textHash(text) }, 'a file round-trips: ' + JSON.stringify(text.slice(0, 8)));
    }
    const big = 'a'.repeat(CLIPBOARD_MAX_BYTES + 1);
    const good = wrap('hello');
    t.equal(toBase64Text(big), null, 'over 1 MiB gives no base64');
    t.equal(clipboardFile(big), null, 'over 1 MiB gives no file');
    t.equal(toBase64Text('a'.repeat(CLIPBOARD_MAX_BYTES)) !== null, true, 'exactly 1 MiB is fine');
    t.equal(openClipboardFile({ ...good, text: 'QQ' }), null, 'base64 without padding is refused');
    t.equal(openClipboardFile({ ...good, text: 'aGVs bG8=' }), null, 'base64 with whitespace is refused');
    t.equal(
      openClipboardFile({ ...good, text: Buffer.from([0xc3, 0x28]).toString('base64') }),
      null,
      'invalid UTF-8 is refused',
    );
    t.equal(clipboardFile('a\0b'), null, 'NUL in the text gives no file');
    t.equal(
      openClipboardFile({ ...good, text: Buffer.from('a\0b').toString('base64'), sha256: textHash('a\0b') }),
      null,
      'NUL in a file is refused',
    );
    t.equal(openClipboardFile({ ...good, sha256: textHash('other') }), null, 'a wrong hash is refused');
    t.equal(openClipboardFile({ ...good, extra: 1 }), null, 'an extra key is refused');
    t.equal(openClipboardFile({ ...good, v: 2 }), null, 'version 2 is refused');
    t.equal(
      openClipboardFile({ ...good, text: 'A'.repeat(CLIPBOARD_BASE64_MAX + 4) }),
      null,
      'an oversized text is refused',
    );
    const takeDir = dirOf('take');
    const takeFile = path.join(takeDir, 'to-pc.json');
    fs.writeFileSync(takeFile, JSON.stringify(good), 'utf8');
    t.equal(takeClipboardFile(takeFile), { text: 'hello', hash: textHash('hello') }, 'a valid file is taken');
    t.check(!fs.existsSync(takeFile), 'a taken file is deleted');
    fs.writeFileSync(takeFile, '{ not json', 'utf8');
    t.equal(takeClipboardFile(takeFile), null, 'an invalid file gives null');
    t.check(!fs.existsSync(takeFile), 'an invalid file is deleted too');
    fs.writeFileSync(takeFile, 'x'.repeat(2_000_000), 'utf8');
    t.equal(takeClipboardFile(takeFile), null, 'a 2 MB file gives null');
    t.check(!fs.existsSync(takeFile), 'a 2 MB file is deleted');
    t.equal(takeClipboardFile(path.join(takeDir, 'missing.json')), null, 'a missing file gives null');

    t.section('gate');
    const sandboxCopy = (gate: ClipboardGate, nowMs: number, text: string): ToPcDecision =>
      gate.toPc(textHash(text), nowMs);
    const g1 = new ClipboardGate({ toPc: true, toSandbox: true });
    t.equal(sandboxCopy(g1, 0, 'a'), 'background', 'not in front: background');
    t.equal(g1.foreground(true, 10), true, 'the first switch to the window offers the PC text');
    t.equal(g1.foreground(true, 20), false, 'still in front: no new offer');
    t.equal(sandboxCopy(g1, 30, 'b'), 'accept', 'in front: accept');
    t.equal(sandboxCopy(g1, 40, 'b'), 'echo', 'the same text again: echo');
    g1.foreground(false, 1000);
    t.equal(sandboxCopy(g1, 2500, 'c'), 'accept', 'left 1.5 s ago: accept');
    t.equal(sandboxCopy(g1, 3500, 'd'), 'background', 'left 2.5 s ago: background');
    t.equal(sandboxCopy(new ClipboardGate({ toPc: false, toSandbox: true }), 0, 'a'), 'off', 'toPc false: off');
    const g2 = new ClipboardGate({ toPc: true, toSandbox: true });
    g2.foreground(true, 0);
    t.equal(g2.toSandbox(textHash('X')), 'send', 'PC text X is sent');
    t.equal(g2.toSandbox(textHash('X')), 'same', 'unchanged: same');
    t.equal(g2.toPc(textHash('Y'), 5), 'accept', 'sandbox copy Y is accepted');
    t.equal(g2.toSandbox(textHash('Y')), 'same', 'PC has Y now: same');
    t.equal(g2.toSandbox(textHash('X')), 'send', 'PC copies X again: sent');
    t.equal(
      new ClipboardGate({ toPc: true, toSandbox: false }).toSandbox(textHash('X')),
      'off',
      'toSandbox false: off',
    );
    t.equal(new ClipboardGate({ toPc: true, toSandbox: true }).foreground(false, 0), false, 'first call: not in front');

    t.section('host bridge');
    const secret = 'selftest-' + crypto.randomBytes(8).toString('hex');
    class FakePort implements HostClipboardPort {
      writes: string[] = [];
      clip: ClipboardRead = { kind: 'text', text: secret };
      stopped = false;
      onForeground(): void {}
      onExit(): void {}
      read(): Promise<ClipboardRead> {
        return Promise.resolve(this.clip);
      }
      write(text: string): Promise<boolean> {
        this.writes.push(text);
        return Promise.resolve(true);
      }
      stop(): void {
        this.stopped = true;
      }
    }
    const bridgeOf = (
      name: string,
      settings: Partial<ClipboardSettings> = {},
    ): {
      bridge: HostClipboardBridge;
      port: FakePort;
      notes: string[];
      run: RunDir;
      dataPath: string;
      clock: { at: number };
    } => {
      const dataPath = dirOf('host-' + name);
      const port = new FakePort();
      const notes: string[] = [];
      const clock = { at: 100000 };
      const run = new RunDir(dataPath);
      const bridge = new HostClipboardBridge({
        dataPath,
        settings: { mode: 'text', bridge: true, toPc: true, toSandbox: true, ...settings },
        open: () => port,
        note: (m) => notes.push(m),
        now: () => clock.at,
      });
      fs.mkdirSync(run.clipboardDir, { recursive: true });
      return { bridge, port, notes, run, dataPath, clock };
    };
    const fromSandbox = (run: RunDir, text: string): void =>
      fs.writeFileSync(run.clipboardToPcFile, JSON.stringify(clipboardFile(text)), 'utf8');
    {
      const h = bridgeOf('refuse');
      fromSandbox(h.run, secret);
      t.equal(await h.bridge.poll(), 'background', 'a copy while the window is not in front is refused');
      t.equal(h.port.writes, [], 'nothing reached the PC clipboard');
      t.check(!fs.existsSync(h.run.clipboardToPcFile), 'the refused file is deleted');
      t.matches(h.notes.join('\n'), /refused 1 copy from the sandbox/, 'the refusal note counts');
      t.check(!h.notes.join('\n').includes(secret), 'the note never holds the text');
      h.port.clip = { kind: 'text', text: secret + '-pc' };
      t.equal(await h.bridge.foreground(true), 'send', 'a switch to the window sends the PC text');
      fromSandbox(h.run, secret + '-2');
      t.equal(await h.bridge.poll(), 'accept', 'a copy while in front is accepted');
      t.equal(h.port.writes, [secret + '-2'], 'it reached the PC clipboard');
      h.bridge.stop();
      t.check(!h.notes.join('\n').includes(secret), 'no note holds any text');
      t.check(
        h.notes.some((n) => /copied 1 to this PC, 1 into the sandbox, refused 1/.test(n)),
        'stop notes the totals',
      );
      t.check(h.port.stopped, 'stop ends the port');
    }
    {
      const h = bridgeOf('switch');
      t.equal(await h.bridge.foreground(true), 'send', 'the first switch sends');
      const sent = openClipboardFile(JSON.parse(fs.readFileSync(h.run.clipboardToSandboxFile, 'utf8')));
      t.equal(sent?.text, secret, 'to-sandbox.json holds the PC text');
      h.clock.at += 14000;
      await h.bridge.poll();
      t.check(fs.existsSync(h.run.clipboardToSandboxFile), 'a file under 15 s old stays');
      h.clock.at += 2000;
      await h.bridge.poll();
      t.check(!fs.existsSync(h.run.clipboardToSandboxFile), 'a file not taken in 15 s is deleted');
      h.bridge.stop();
    }
    {
      const h = bridgeOf('one-way', { toSandbox: false });
      t.equal(await h.bridge.foreground(true), null, 'toSandbox false offers nothing');
      t.check(!fs.existsSync(h.run.clipboardToSandboxFile), 'toSandbox false writes no file');
      h.bridge.stop();
    }
    {
      const h = bridgeOf('too-big');
      h.port.clip = { kind: 'tooBig' };
      await h.bridge.foreground(true);
      t.check(!fs.existsSync(h.run.clipboardToSandboxFile), 'a too big PC text writes nothing');
      t.check(
        h.notes.some((n) => /over 1 MB/.test(n)),
        'and says so',
      );
      h.bridge.stop();
    }
    {
      const h = bridgeOf('stop');
      fs.writeFileSync(h.run.clipboardToPcFile, '{}', 'utf8');
      fs.writeFileSync(h.run.clipboardToSandboxFile, '{}', 'utf8');
      h.bridge.stop();
      t.check(
        !fs.existsSync(h.run.clipboardToPcFile) && !fs.existsSync(h.run.clipboardToSandboxFile),
        'stop removes both files',
      );
    }
    if (process.platform === 'win32') {
      const h = bridgeOf('link');
      const victim = dirOf('link-victim');
      const keep = path.join(victim, 'to-pc.json');
      fs.writeFileSync(keep, JSON.stringify(wrap(secret)), 'utf8');
      fs.rmSync(h.run.clipboardDir, { recursive: true, force: true });
      fs.symlinkSync(victim, h.run.clipboardDir, 'junction');
      t.equal(await h.bridge.poll(), null, 'a planted junction is refused');
      t.check(fs.existsSync(keep), 'nothing in the link target was deleted');
      t.equal(h.port.writes, [], 'and nothing was copied');
      clearClipboardFiles(h.dataPath);
      t.check(fs.existsSync(keep), 'clearing the folder does not follow the link either');
    }

    t.section('guest bridge');
    class FakeHelper implements GuestClipboardHelper {
      writes: string[] = [];
      private listener: (text: string | null) => void = () => undefined;
      onChange(listener: (text: string | null) => void): void {
        this.listener = listener;
      }
      write(text: string): Promise<boolean> {
        this.writes.push(text);
        return Promise.resolve(true);
      }
      onExit(): void {}
      stop(): void {}
      emit(text: string | null): void {
        this.listener(text);
      }
    }
    const guestOf = (
      name: string,
      sides: { toPc: boolean; toSandbox: boolean } = { toPc: true, toSandbox: true },
    ): { bridge: GuestClipboardBridge; helper: FakeHelper; run: RunDir } => {
      const run = new RunDir(dirOf('guest-' + name));
      fs.mkdirSync(run.clipboardDir, { recursive: true });
      const helper = new FakeHelper();
      const bridge = new GuestClipboardBridge({ run, ...sides, open: () => helper, log: () => undefined });
      bridge.start();
      return { bridge, helper, run };
    };
    {
      const g = guestOf('change');
      g.helper.emit('from the sandbox');
      t.equal(
        openClipboardFile(JSON.parse(fs.readFileSync(g.run.clipboardToPcFile, 'utf8')))?.text,
        'from the sandbox',
        'a change writes to-pc.json',
      );
      g.bridge.stop();
    }
    {
      const g = guestOf('take');
      fs.writeFileSync(g.run.clipboardToSandboxFile, JSON.stringify(wrap('from the PC')), 'utf8');
      t.equal(await g.bridge.take(), true, 'a file from the PC is taken');
      t.equal(g.helper.writes, ['from the PC'], 'the helper set it');
      t.check(!fs.existsSync(g.run.clipboardToSandboxFile), 'and the file is deleted');
      g.helper.emit('from the PC');
      t.check(!fs.existsSync(g.run.clipboardToPcFile), 'its echo writes nothing');
      g.bridge.stop();
    }
    {
      const g = guestOf('one-way', { toPc: false, toSandbox: true });
      g.helper.emit('x');
      t.check(!fs.existsSync(g.run.clipboardToPcFile), 'toPc false writes nothing');
      g.bridge.stop();
      const h = guestOf('one-way-2', { toPc: true, toSandbox: false });
      fs.writeFileSync(h.run.clipboardToSandboxFile, JSON.stringify(wrap('y')), 'utf8');
      t.equal(await h.bridge.take(), false, 'toSandbox false does not set the clipboard');
      t.check(!fs.existsSync(h.run.clipboardToSandboxFile), 'and drops the file');
      h.bridge.stop();
    }
    {
      const g = guestOf('invalid');
      fs.writeFileSync(g.run.clipboardToSandboxFile, '{ nonsense', 'utf8');
      t.equal(await g.bridge.take(), false, 'an invalid file sets nothing');
      t.equal(g.helper.writes, [], 'the helper heard nothing');
      t.check(!fs.existsSync(g.run.clipboardToSandboxFile), 'an invalid file is deleted unread');
      g.bridge.stop();
    }
    {
      // Found against the real helpers: a "set" holding a NUL was put on the clipboard (the TS side never sends one).
      // Running it would write the clipboard, so the sources are checked for the refusal.
      const sources = [
        path.join(t.packageRoot, 'sandbox', 'csharp', 'ClipboardBridge.cs'),
        path.join(t.packageRoot, 'native', 'csharp', 'HostTools', 'HostClipboard.cs'),
      ];
      for (const file of sources) {
        t.check(
          /text\.IndexOf\(\(char\)0\) >= 0/.test(fs.readFileSync(file, 'utf8')),
          path.basename(file) + ' refuses a set whose text holds a NUL',
        );
      }
    }
  },
};
