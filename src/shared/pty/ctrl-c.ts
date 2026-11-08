// A Ctrl+C is easy to send by accident: it is "copy" everywhere else. Two rules keep it from stopping an agent.
// 1. After you select text in the program (a mouse drag it received, or it wrote the clipboard with OSC 52), or the
//    clipboard changed (you copied: the sandbox window copies on select), every Ctrl+C is "copy" and is never sent,
//    until you press another key or click.
// 2. With attach.confirmCtrlC a lone Ctrl+C is held back until it is pressed again within a moment.
// Esc still stops an agent at once. The rules live in CtrlCDecider (pure, shared with the web terminal).
import {
  CTRL_C_CONFIRM_MS,
  CTRL_C_COPY_HINT,
  CTRL_C_HINT,
  CtrlCDecider,
  classifyInput,
  hasClipboardWrite,
} from '../web/index.js';

export { CTRL_C_CONFIRM_MS, CTRL_C_COPY_HINT, CTRL_C_HINT };

const OSC_TITLE = /\x1b\][02];([^\x07\x1b]{0,256})(?:\x07|\x1b\\)/g;

export class CtrlCGuard {
  private readonly decider: CtrlCDecider;
  private lastTitle = '';

  constructor(options: { confirm?: boolean } = {}) {
    this.decider = new CtrlCDecider(options.confirm !== false);
  }

  /** What to send for one read from the keyboard: a lone Ctrl+C only when it is not held back or taken as "copy". */
  push(chunk: Buffer, nowMs: number): { send: Buffer; held: boolean; copied: boolean } {
    if (chunk.length === 1 && chunk[0] === 0x03) {
      const action = this.decider.ctrlC(nowMs);
      if (action === 'send') return { send: chunk, held: false, copied: false };
      return { send: Buffer.alloc(0), held: action === 'hold', copied: action === 'copy' };
    }
    const c = classifyInput(chunk.toString('latin1'));
    if (c.keys || c.mouse === 'click') this.decider.otherInput();
    else if (c.mouse === 'drag') this.decider.selection();
    return { send: chunk, held: false, copied: false };
  }

  /** The clipboard changed since the last key: you just copied. */
  clipboardChanged(): void {
    this.decider.selection();
  }

  /** The program wrote to the clipboard: that is a selection too. */
  watchClipboard(raw: string): void {
    if (hasClipboardWrite(raw)) this.decider.selection();
  }

  /** Remembers the title the program last set (from its output), to put it back after the hint. */
  watchOutput(text: string): void {
    for (const m of text.matchAll(OSC_TITLE)) this.lastTitle = m[1];
  }

  /** The escape sequence that shows the hint, and the one that puts the program's title back. */
  hintTitle(kind: 'hold' | 'copy' = 'hold'): string {
    return '\x1b]0;' + (kind === 'copy' ? CTRL_C_COPY_HINT : CTRL_C_HINT) + '\x07';
  }

  restoreTitle(): string {
    return '\x1b]0;' + this.lastTitle.replace(/[\x00-\x1f\x7f]/g, '') + '\x07';
  }
}
