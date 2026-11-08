// Live: the clipboard bridge's guest helper (ClipboardBridge.exe, built from sandbox\csharp) against the real
// Windows clipboard: read, write, the marker that keeps the bridge's own writes from looking like a copy, and the
// clipboard watch ignoring them. It saves the clipboard text first and puts it back at the end. It writes nothing at
// all when rdpclip.exe runs: inside Windows Sandbox that clipboard can be shared with a real PC, and a test must not
// touch it.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { SYSTEM } from '../shared/system.js';
import { CSC } from './support/live.js';
import type { Suite } from './support/suite.js';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** The stdout lines of a running helper, with a way to wait for the next one and to send a command. */
class Helper {
  readonly lines: string[] = [];
  private taken = 0;
  private buffer = '';
  readonly exited: Promise<number | null>;

  constructor(private readonly child: ReturnType<typeof spawn>) {
    child.stdout?.on('data', (d: Buffer) => {
      this.buffer += d.toString('utf8');
      const parts = this.buffer.split(/\r?\n/);
      this.buffer = parts.pop() ?? '';
      this.lines.push(...parts);
    });
    this.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  }

  /** The next unread line, or null after `ms`. */
  async next(
    t: { waitFor: <T>(read: () => T | null | false, ms?: number) => Promise<T | null> },
    ms = 15000,
  ): Promise<string | null> {
    return t.waitFor(() => (this.taken < this.lines.length ? this.lines[this.taken++] : null), ms);
  }

  send(line: string): void {
    this.child.stdin?.write(line + '\n');
  }

  close(): void {
    this.child.stdin?.end();
  }

  kill(): void {
    this.child.kill();
  }
}

export const clipboardLiveSuite: Suite = {
  name: 'clipboard-live',
  title: 'live: the clipboard bridge helper reads, writes and marks the real clipboard (never with rdpclip running)',
  live: true,
  timeoutMs: 120000,
  run: async (t) => {
    t.section('clipboard bridge helper');
    if (process.platform !== 'win32' || !fs.existsSync(CSC)) {
      t.check(true, 'skipped: needs Windows and its C# compiler');
      return;
    }
    const csharp = (n: string): string => path.join(t.packageRoot, 'sandbox', 'csharp', n);
    const exe = path.join(t.dir('clipboard-live'), 'ClipboardBridge.exe');
    const built = spawnSync(
      CSC,
      ['/nologo', '/out:' + exe, csharp('ClipboardBridge.cs'), csharp('ClipboardText.cs'), csharp('ClipboardWatch.cs')],
      { encoding: 'utf8', windowsHide: true },
    );
    t.check(built.status === 0, 'ClipboardBridge compiles with ClipboardText (C# 5)', built.stdout);
    if (built.status !== 0) return;

    // `watch` (the viewer's Ctrl+C guard): nothing here writes the clipboard.
    const usage = spawnSync(exe, ['watch'], { encoding: 'utf8', windowsHide: true });
    t.check(usage.status === 2, 'watch without --parent is a usage error', String(usage.status));
    const gone = spawnSync(exe, ['watch', '--parent', '4294967295'], { encoding: 'utf8', windowsHide: true });
    t.check(gone.status === 2, 'watch of a process that cannot be opened exits 2', String(gone.status));
    const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const started = Date.now();
    const ended = spawnSync(exe, ['watch', '--parent', String(parent.pid)], { encoding: 'utf8', windowsHide: true });
    parent.kill();
    t.check(ended.status === 0 && (ended.stdout ?? '').trim() === '', 'watch ends with 0 when its parent ends');
    t.check(Date.now() - started < 10000, 'and it ends soon after the parent does');

    const tasks = spawnSync(SYSTEM.tasklist(), ['/fi', 'imagename eq rdpclip.exe', '/nh'], { encoding: 'utf8' });
    if (/rdpclip\.exe/i.test(tasks.stdout ?? '')) {
      t.check(true, 'skipped: rdpclip.exe runs, so this clipboard may be shared with a real PC (nothing is written)');
      return;
    }

    const child = spawn(exe, ['serve', '--max-bytes', '1048576'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const helper = new Helper(child);
    let watcher: ReturnType<typeof spawn> | null = null;
    let exeWatcher: ReturnType<typeof spawn> | null = null;
    let saved: string | null = null;
    let touched = false;
    try {
      t.check((await helper.next(t)) === 'ready', 'the helper says ready');

      helper.send('get');
      const before = await helper.next(t);
      t.check(
        before !== null && (before === 'got-none' || before === 'got-too-big' || before.startsWith('got ')),
        'get answers with the clipboard text or that there is none',
        String(before),
      );
      saved = before !== null && before.startsWith('got ') ? before.slice(4) : null;

      watcher = spawn(
        SYSTEM.powershell(),
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(t.packageRoot, 'sandbox', 'scripts', 'watch-clipboard.ps1'),
          '-ProcessId',
          String(process.pid),
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      );
      let watched = '';
      watcher.stdout?.on('data', (d: Buffer) => (watched += d.toString('utf8')));
      // The watch has no "ready" line: give powershell time to compile and start polling before the write.
      await new Promise((resolve) => setTimeout(resolve, 8000));
      exeWatcher = spawn(exe, ['watch', '--parent', String(process.pid)], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let exeWatched = '';
      exeWatcher.stdout?.on('data', (d: Buffer) => (exeWatched += d.toString('utf8')));
      await new Promise((resolve) => setTimeout(resolve, 500));

      const value = 'selftest-' + crypto.randomBytes(8).toString('hex');
      touched = true;
      helper.send('set ' + b64(value));
      t.check((await helper.next(t)) === 'set-ok', 'set puts text on the clipboard');
      helper.send('get');
      t.check((await helper.next(t)) === 'got ' + b64(value), 'get reads back what set wrote');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      t.check(
        !helper.lines.some((l) => l.startsWith('changed')),
        "the bridge's own write carries the marker, so the helper does not report it",
        helper.lines.join(' | '),
      );
      t.check(!/changed/.test(watched), "the clipboard watch does not report the bridge's write", watched);
      t.check(watcher.exitCode === null, 'the clipboard watch was running during the write');
      t.check(!/changed/.test(exeWatched), "the exe watch does not report the bridge's write either", exeWatched);
      t.check(exeWatcher.exitCode === null, 'the exe watch was running during the write');
      // clip.exe writes plain text without the marker: a copy by someone else, which both watches report.
      spawnSync(SYSTEM.clip(), [], { input: 'selftest-copy', windowsHide: true });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      t.check(/changed/.test(exeWatched), 'the exe watch reports a normal copy', exeWatched);
      t.check(/changed/.test(watched), 'the script watch reports a normal copy', watched);

      helper.send('set !!!not-base64');
      const bad = await helper.next(t);
      t.check(bad === 'set-failed', 'a set that is not base64 is refused', String(bad));
    } finally {
      if (watcher) watcher.kill();
      if (exeWatcher) exeWatcher.kill();
      if (touched && saved !== null) {
        helper.send('set ' + saved);
        await helper.next(t);
      }
      helper.close();
    }
    const code = await Promise.race([
      helper.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15000)),
    ]);
    if (code === 'timeout') helper.kill();
    t.check(code === 0, 'the helper ends with exit code 0 when its input closes', String(code));
    if (touched && saved === null) {
      t.check(true, 'the clipboard had no text before the test; its test text stays only until the next copy');
    }
  },
};
