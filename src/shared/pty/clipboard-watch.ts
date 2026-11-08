// Windows: tells the terminal client when the clipboard changes, e.g. you just copied text in the sandbox window (which
// copies on select). It prints a line per change and ends with this process. In the sandbox that is the compiled
// ClipboardBridge.exe (`watch --parent`, ready in about 0.1 s); on the PC, where there is no such exe, it is
// sandbox\scripts\watch-clipboard.ps1 (about 2 s to start, for the Add-Type).
// Only built-ins here: view.js bundles this.
import { spawn, type ChildProcess } from 'node:child_process';
import { SYSTEM } from '../system.js';
import { scriptArgs } from '../scripts.js';

/** The most output kept while waiting for the end of a line. */
const MAX_PENDING = 1024;

/** Calls `onChange` for each clipboard change from now on. No-op off Windows. `exe`: a compiled ClipboardBridge.exe. */
export function watchClipboard(onChange: () => void, exe?: string): { stop: () => void } {
  if (process.platform !== 'win32') return { stop: () => undefined };
  let child: ChildProcess | null = null;
  try {
    const pid = String(process.pid);
    child = exe
      ? spawn(exe, ['watch', '--parent', pid], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      : spawn(SYSTEM.powershell(), scriptArgs('watch-clipboard.ps1', ['-ProcessId', pid]), {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
  } catch {
    // Without the watcher a copy is only recognised from the program's own selection: nothing else is lost.
    return { stop: () => undefined };
  }
  let pending = '';
  child.stdout?.setEncoding('latin1');
  child.stdout?.on('data', (text: string) => {
    const lines = (pending + text).split('\n');
    pending = (lines.pop() ?? '').slice(-MAX_PENDING);
    for (const line of lines) if (line.trim() === 'changed') onChange();
  });
  child.on('error', () => undefined);
  return {
    stop: () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}
