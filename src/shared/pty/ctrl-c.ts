// A lone Ctrl+C is easy to send by accident: it is "copy" everywhere else, and a terminal sends it to the program when
// the selection it was meant for has just been cleared by a redraw (an agent's spinner redraws all the time). With
// attach.confirmCtrlC the terminal client holds a lone Ctrl+C back until it is pressed again within a moment; Esc still
// stops an agent at once. Pure, so it is tested without a terminal.

/** A second Ctrl+C within this long sends it. */
export const CTRL_C_CONFIRM_MS = 1500;

/** What the title shows while a Ctrl+C is held back. */
export const CTRL_C_HINT = 'Ctrl+C again to send it to the program (Esc stops an agent)';

const OSC_TITLE = /\x1b\][02];([^\x07\x1b]{0,256})(?:\x07|\x1b\\)/g;

export class CtrlCGuard {
  private armedAt = Number.NEGATIVE_INFINITY;
  private lastTitle = '';

  /** What to send for one read from the keyboard: a lone Ctrl+C only when another came just before. */
  push(chunk: Buffer, nowMs: number): { send: Buffer; held: boolean } {
    if (chunk.length !== 1 || chunk[0] !== 0x03) return { send: chunk, held: false };
    if (nowMs - this.armedAt <= CTRL_C_CONFIRM_MS) {
      this.armedAt = Number.NEGATIVE_INFINITY;
      return { send: chunk, held: false };
    }
    this.armedAt = nowMs;
    return { send: Buffer.alloc(0), held: true };
  }

  /** Remembers the title the program last set (from its output), to put it back after the hint. */
  watchOutput(text: string): void {
    for (const m of text.matchAll(OSC_TITLE)) this.lastTitle = m[1];
  }

  /** The escape sequence that shows the hint, and the one that puts the program's title back. */
  hintTitle(): string {
    return '\x1b]0;' + CTRL_C_HINT + '\x07';
  }

  restoreTitle(): string {
    return '\x1b]0;' + this.lastTitle.replace(/[\x00-\x1f\x7f]/g, '') + '\x07';
  }
}
