// The mouse tracking a program asked for, read from its output, and the mouse reports it may receive.

/** X10 compatibility (press only), normal (press/release/wheel), button-event (+ drag), any-event (+ every motion). */
const TRACKING = [9, 1000, 1002, 1003] as const;
/** Longest DECSET / DECRST parameter list followed; anything longer is not a mode change. */
const MAX_PARAMS = 64;
/** Button code bits of a mouse report: motion (drag or move), and "no button" in the low two bits. */
const MOTION = 32;
const NO_BUTTON = 3;

/**
 * Follows the private modes a program turns on and off in its output (DECSET / DECRST, kept across chunks: mouse
 * tracking 9, 1000, 1002, 1003, the encodings 1005 and 1015, bracketed paste 2004 ...) and drops the mouse reports it
 * did not ask for: none without tracking, motion only with 1002 (while a button is held: a drag) or 1003 (every move).
 * Your terminal reports what the program's modes say; what is dropped is what was still on its way when the program
 * turned tracking off, exited or restarted, and would reach it as text.
 */
export class MouseModes {
  private readonly on = new Set<number>();
  /** 0 text, 1 after ESC, 2 after ESC[, 3 in ESC[? parameters, 4 after ESC[! */
  private state = 0;
  private params = '';

  /** Reads the program's output (after OutputFilter): the mode changes in it. */
  watch(output: Buffer): void {
    for (const b of output) {
      if (b === 0x1b) {
        this.state = 1;
        continue;
      }
      if (this.state === 1) {
        // RIS (ESC c), a full reset, turns every mode off.
        if (b === 0x63) this.on.clear();
        this.state = b === 0x5b ? 2 : 0;
      } else if (this.state === 2) {
        // DECSTR (ESC[!p), a soft reset, turns mouse tracking off too.
        this.state = b === 0x3f ? 3 : b === 0x21 ? 4 : 0;
        this.params = '';
      } else if (this.state === 4) {
        if (b === 0x70) this.on.clear();
        this.state = 0;
      } else if (this.state === 3) {
        if ((b >= 0x30 && b <= 0x39) || b === 0x3b) {
          this.params += String.fromCharCode(b);
          if (this.params.length > MAX_PARAMS) this.state = 0;
        } else {
          if (b === 0x68 || b === 0x6c) this.apply(this.params, b === 0x68);
          this.state = 0;
        }
      }
    }
  }

  /** The program is gone (exited or restarting): its modes went with it. */
  reset(): void {
    this.on.clear();
    this.state = 0;
    this.params = '';
  }

  /** True while the program tracks the mouse in any way. */
  tracking(): boolean {
    return TRACKING.some((m) => this.on.has(m));
  }

  /** True while the program has a mode on (2004: bracketed paste). */
  has(mode: number): boolean {
    return this.on.has(mode);
  }

  /** The mode numbers on now (for the report and tests). */
  modes(): number[] {
    return [...this.on].sort((a, b) => a - b);
  }

  /** `input` without the mouse reports the program has not asked for. Sequences must be whole (InputJoiner). */
  filter(input: Buffer): Buffer {
    if (!input.includes(0x1b)) return input;
    const parts: Buffer[] = [];
    let from = 0;
    let i = input.indexOf(0x1b);
    while (i !== -1) {
      const report = mouseReport(input, i, this.on.has(1005), this.on.has(1015));
      if (report && !this.allows(report.button)) {
        parts.push(input.subarray(from, i));
        from = i + report.length;
        i = input.indexOf(0x1b, from);
      } else i = input.indexOf(0x1b, i + 1);
    }
    if (from === 0) return input;
    parts.push(input.subarray(from));
    return Buffer.concat(parts);
  }

  private allows(button: number): boolean {
    if (!this.tracking()) return false;
    if ((button & MOTION) === 0) return true;
    if (this.on.has(1003)) return true;
    return this.on.has(1002) && (button & NO_BUTTON) !== NO_BUTTON;
  }

  private apply(params: string, set: boolean): void {
    for (const p of params.split(';')) {
      const mode = Number(p);
      if (!p || !Number.isSafeInteger(mode)) continue;
      if (set) this.on.add(mode);
      else this.on.delete(mode);
    }
  }
}

/**
 * The mouse report starting at `at`: SGR (ESC[<b;x;yM or m, 1006), urxvt (ESC[b;x;yM, 1015, b offset by 32; only while
 * 1015 is on) or X10
 * (ESC[M and three bytes; not with UTF-8 coordinates, 1005, where its length cannot be told). Null when there is none.
 */
function mouseReport(
  data: Buffer,
  at: number,
  utf8: boolean,
  urxvt: boolean,
): { button: number; length: number } | null {
  if (data[at + 1] !== 0x5b) return null;
  const sgr = data[at + 2] === 0x3c;
  if (sgr || (urxvt && data[at + 2] >= 0x30 && data[at + 2] <= 0x39)) {
    let i = at + (sgr ? 3 : 2);
    let digits = '';
    let fields = 1;
    for (; i < data.length && i - at < 32; i++) {
      const b = data[i];
      if (b >= 0x30 && b <= 0x39) {
        if (fields === 1) digits += String.fromCharCode(b);
      } else if (b === 0x3b) fields++;
      else break;
    }
    if (i >= data.length || fields !== 3 || !digits) return null;
    if (sgr ? data[i] !== 0x4d && data[i] !== 0x6d : data[i] !== 0x4d) return null;
    const button = Number(digits) - (sgr ? 0 : 32);
    return button >= 0 ? { button, length: i - at + 1 } : null;
  }
  if (data[at + 2] === 0x4d && !utf8 && data.length - at >= 6) {
    const button = data[at + 3] - 32;
    return button >= 0 ? { button, length: 6 } : null;
  }
  return null;
}
