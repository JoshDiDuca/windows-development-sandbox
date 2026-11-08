// This PC's clipboard and "is the sandbox window in front", through one long-running `HostTools clipboard-bridge`.
// Text travels as base64 lines; nothing here logs or keeps it.
import { spawn, type ChildProcess } from 'node:child_process';
import { isWin } from '../../core/util/index.js';
import { CLIPBOARD_LINE_MAX, CLIPBOARD_MAX_BYTES, fromBase64Text, toBase64Text } from '../../shared/clipboard/index.js';
import { hostToolsExe } from '../native.js';
import { selfTestRunning } from '../test-guard.js';

export type ClipboardRead = { kind: 'text'; text: string } | { kind: 'none' } | { kind: 'tooBig' } | { kind: 'failed' };

export interface HostClipboardPort {
  onForeground(listener: (inFront: boolean) => void): void;
  read(): Promise<ClipboardRead>;
  write(text: string): Promise<boolean>;
  onExit(listener: () => void): void;
  stop(): void;
}

/** One answer from HostTools is waited for this long. */
const REPLY_TIMEOUT_MS = 5000;

type Pending =
  | { readonly kind: 'read'; readonly done: (r: ClipboardRead) => void; readonly timer: NodeJS.Timeout }
  | { readonly kind: 'write'; readonly done: (ok: boolean) => void; readonly timer: NodeJS.Timeout };

class HostToolsClipboard implements HostClipboardPort {
  private readonly pending: Pending[] = [];
  private readonly foreground: ((inFront: boolean) => void)[] = [];
  private readonly exits: (() => void)[] = [];
  private buffer = '';
  private dropping = false;
  private ended = false;

  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.feed(chunk));
    child.stdin?.on('error', () => undefined);
    const ended = (): void => {
      if (this.ended) return;
      this.ended = true;
      for (const p of this.pending.splice(0)) {
        clearTimeout(p.timer);
        if (p.kind === 'read') p.done({ kind: 'failed' });
        else p.done(false);
      }
      this.exits.forEach((l) => l());
    };
    child.on('error', ended);
    child.on('exit', ended);
  }

  onForeground(listener: (inFront: boolean) => void): void {
    this.foreground.push(listener);
  }

  onExit(listener: () => void): void {
    this.exits.push(listener);
  }

  read(): Promise<ClipboardRead> {
    return new Promise((resolve) => {
      if (!this.send('get\n')) return resolve({ kind: 'failed' });
      const timer = setTimeout(() => this.expire(entry), REPLY_TIMEOUT_MS);
      timer.unref();
      const entry: Pending = { kind: 'read', done: resolve, timer };
      this.pending.push(entry);
    });
  }

  write(text: string): Promise<boolean> {
    return new Promise((resolve) => {
      const b64 = toBase64Text(text);
      if (b64 === null || !this.send('set ' + b64 + '\n')) return resolve(false);
      const timer = setTimeout(() => this.expire(entry), REPLY_TIMEOUT_MS);
      timer.unref();
      const entry: Pending = { kind: 'write', done: resolve, timer };
      this.pending.push(entry);
    });
  }

  stop(): void {
    try {
      this.child.stdin?.end();
    } catch {
      // Already closed.
    }
  }

  private send(line: string): boolean {
    if (this.ended || !this.child.stdin?.writable) return false;
    try {
      this.child.stdin.write(line);
      return true;
    } catch {
      // The pipe closed: the call fails.
      return false;
    }
  }

  private expire(entry: Pending): void {
    const at = this.pending.indexOf(entry);
    if (at < 0) return;
    this.pending.splice(at, 1);
    if (entry.kind === 'read') entry.done({ kind: 'failed' });
    else entry.done(false);
  }

  /** Lines, with a cap: a longer line is dropped up to its newline. */
  private feed(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) break;
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (this.dropping) this.dropping = false;
      else if (line.length <= CLIPBOARD_LINE_MAX) this.line(line);
    }
    if (this.buffer.length > CLIPBOARD_LINE_MAX) {
      this.buffer = '';
      this.dropping = true;
    }
  }

  private line(line: string): void {
    if (line === 'fg 1' || line === 'fg 0') {
      this.foreground.forEach((l) => l(line === 'fg 1'));
      return;
    }
    const first = this.pending.shift();
    if (!first) return;
    clearTimeout(first.timer);
    if (first.kind === 'write') first.done(line === 'set-ok');
    else if (line.startsWith('got ')) {
      const text = fromBase64Text(line.slice(4));
      first.done(text === null ? { kind: 'failed' } : { kind: 'text', text });
    } else if (line === 'got-none') first.done({ kind: 'none' });
    else if (line === 'got-too-big') first.done({ kind: 'tooBig' });
    else first.done({ kind: 'failed' });
  }
}

/** HostTools clipboard-bridge; null off Windows, in the self-test, or when HostTools cannot be built. */
export function openHostClipboard(storageRoot: string): HostClipboardPort | null {
  if (!isWin || selfTestRunning()) return null;
  const tools = hostToolsExe(storageRoot);
  if (!tools) return null;
  try {
    const child = spawn(tools, ['clipboard-bridge', '--max-bytes', String(CLIPBOARD_MAX_BYTES)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return new HostToolsClipboard(child);
  } catch {
    // Could not start it: no bridge.
    return null;
  }
}
