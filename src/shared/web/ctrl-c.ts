// When a Ctrl+C is "copy" and when it is an interrupt, shared by the terminal client and the web terminal. Agents turn
// mouse tracking on, so selecting text happens inside the program (a mouse drag, or an OSC 52 clipboard write) and the
// terminal never sees a selection. After that every Ctrl+C is "copy" and is not sent, until another key or a click.
// Outside that, a lone Ctrl+C is held and a second one soon after is sent. Pure: no node imports.

/** A second Ctrl+C within this long sends it. */
export const CTRL_C_CONFIRM_MS = 1500;

/** What the title shows while a Ctrl+C is held back. */
export const CTRL_C_HINT = 'Ctrl+C again to send it to the program (Esc stops an agent)';

/** What the title shows when a Ctrl+C was taken as "copy". */
export const CTRL_C_COPY_HINT = 'Copied: Ctrl+C after selecting text is not sent to the program (Esc stops an agent)';

export type CtrlCAction = 'send' | 'hold' | 'copy';

export class CtrlCDecider {
  private armedAt = Number.NEGATIVE_INFINITY;
  private selected = false;

  constructor(private readonly confirm: boolean = true) {}

  /** Text was selected in the program: Ctrl+C is "copy" from now on. */
  selection(): void {
    this.selected = true;
    this.armedAt = Number.NEGATIVE_INFINITY;
  }

  /** Any other key or a click: Ctrl+C is an interrupt again. */
  otherInput(): void {
    this.selected = false;
  }

  /** What to do with a lone Ctrl+C pressed at `nowMs`. */
  ctrlC(nowMs: number): CtrlCAction {
    if (this.selected) return 'copy';
    if (!this.confirm) return 'send';
    if (nowMs - this.armedAt <= CTRL_C_CONFIRM_MS) {
      this.armedAt = Number.NEGATIVE_INFINITY;
      return 'send';
    }
    this.armedAt = nowMs;
    return 'hold';
  }
}

// SGR reports (ESC [ < b ; x ; y M|m) and X10 reports (ESC [ M and three characters); bounded, no backtracking.
const MOUSE_REPORT = /\x1b\[<(\d{1,4});\d{1,5};\d{1,5}([Mm])|\x1b\[M([\s\S])[\s\S]{2}/g;

/** What typed input holds: the strongest mouse report (a drag, else a click), and whether anything else is in it. */
export function classifyInput(text: string): { readonly mouse: 'drag' | 'click' | null; readonly keys: boolean } {
  let drag = false;
  let click = false;
  for (const m of text.matchAll(MOUSE_REPORT)) {
    const sgr = m[1] !== undefined;
    const b = sgr ? Number(m[1]) : (m[3] ?? ' ').charCodeAt(0) - 32;
    if (b & 64) continue;
    if (b & 32) {
      if ((b & 3) !== 3) drag = true;
    } else if (sgr ? m[2] === 'M' : (b & 3) !== 3) click = true;
  }
  return { mouse: drag ? 'drag' : click ? 'click' : null, keys: text.replace(MOUSE_REPORT, '').length > 0 };
}

/** True when program output asks the terminal to write the clipboard (OSC 52). */
export function hasClipboardWrite(text: string): boolean {
  return /\x1b\]0{0,2}52;/.test(text) || /\u009d0{0,2}52;/.test(text);
}
