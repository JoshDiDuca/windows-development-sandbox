// The daemon's clipboard bridge (sandbox.clipboard "text"): ClipboardBridge.exe (compiled from sandbox\csharp each
// boot) reports this clipboard's changes and sets the PC's text. The rules live in clipboard-bridge.ts.
// Never logs text.
import { spawn } from 'node:child_process';
import { CLIPBOARD_LINE_MAX, CLIPBOARD_MAX_BYTES, fromBase64Text, toBase64Text } from '../../shared/clipboard/index.js';
import { ensureCompiled } from '../runtime/csc.js';
import { warn } from '../runtime/log.js';
import { isWin, run, testMode } from '../runtime/paths.js';
import { session } from '../runtime/session.js';
import { GuestClipboardBridge, type GuestClipboardHelper } from './clipboard-bridge.js';

const REPLY_TIMEOUT_MS = 5000;

function openHelper(): GuestClipboardHelper | null {
  try {
    const child = spawn(ensureCompiled('clipboardbridge'), ['serve', '--max-bytes', String(CLIPBOARD_MAX_BYTES)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const changes: ((text: string | null) => void)[] = [];
    const exits: (() => void)[] = [];
    const pending: { done: (ok: boolean) => void; timer: NodeJS.Timeout }[] = [];
    let buffer = '';
    let dropping = false;
    let ended = false;
    const line = (text: string): void => {
      if (text.startsWith('changed ')) {
        const value = fromBase64Text(text.slice(8));
        changes.forEach((l) => l(value));
      } else if (text === 'changed-other') changes.forEach((l) => l(null));
      else if (text === 'set-ok' || text === 'set-failed') {
        const first = pending.shift();
        if (first) {
          clearTimeout(first.timer);
          first.done(text === 'set-ok');
        }
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const one = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (dropping) dropping = false;
        else if (one.length <= CLIPBOARD_LINE_MAX) line(one);
      }
      if (buffer.length > CLIPBOARD_LINE_MAX) {
        buffer = '';
        dropping = true;
      }
    });
    child.stdin.on('error', () => undefined);
    const finished = (): void => {
      if (ended) return;
      ended = true;
      for (const p of pending.splice(0)) {
        clearTimeout(p.timer);
        p.done(false);
      }
      exits.forEach((l) => l());
    };
    child.on('error', finished);
    child.on('exit', finished);
    return {
      onChange: (l) => changes.push(l),
      onExit: (l) => exits.push(l),
      write: (text) =>
        new Promise<boolean>((resolve) => {
          const b64 = toBase64Text(text);
          if (b64 === null || ended || !child.stdin.writable) return resolve(false);
          const entry = {
            done: resolve,
            timer: setTimeout(() => {
              const at = pending.indexOf(entry);
              if (at >= 0) pending.splice(at, 1);
              resolve(false);
            }, REPLY_TIMEOUT_MS),
          };
          pending.push(entry);
          child.stdin.write('set ' + b64 + '\n');
        }),
      stop: () => {
        try {
          child.stdin.end();
        } catch {
          // Already closed.
        }
      },
    };
  } catch (e) {
    warn('Clipboard: the helper could not start: ' + (e instanceof Error ? e.message.slice(0, 300) : 'unknown error'));
    return null;
  }
}

export function startClipboardBridge(): void {
  const settings = session.clipboard;
  if (!settings?.bridge || !isWin || testMode) return;
  new GuestClipboardBridge({
    run,
    toPc: settings.toPc,
    toSandbox: settings.toSandbox,
    open: openHelper,
    log: warn,
  }).start();
}
