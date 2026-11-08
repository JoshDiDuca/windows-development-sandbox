/** OSC commands that may reach your terminal: window title (0, 1, 2), links (8), progress (9;4), shell marks (133). */
const KEPT_OSC = (body: string): boolean => {
  const number = /^(\d{1,4})(;|$)/.exec(body);
  if (!number) return false;
  const n = Number(number[1]);
  return n <= 2 || n === 8 || n === 133 || (n === 9 && body.startsWith(number[1] + ';4;'));
};
/** Longest OSC kept (a title or a link); anything longer is dropped whole. */
const MAX_KEPT_STRING = 4096;
/** Longest clipboard write kept (about 750 KB of text); anything longer is dropped whole. */
const MAX_CLIPBOARD_STRING = 1024 * 1024;
/** A clipboard write (OSC 52: selection, then base64): never a read ("?"), which would send the clipboard back. */
const CLIPBOARD_WRITE = /^0{0,2}52;[cpqs0-7]{0,8};[A-Za-z0-9+/=]*$/;

export interface OutputFilterOptions {
  /**
   * Let clipboard writes (OSC 52) through: the agent's "copy" reaches your clipboard. Only where the sandbox can reach
   * that clipboard anyway (its own terminal, or sandbox.clipboard "text" / "shared" copying to this PC). Clipboard
   * reads are always dropped.
   */
  readonly clipboardWrites?: boolean;
}

/**
 * Removes the terminal "strings" an untrusted program could abuse from the sandbox's output before it reaches your
 * terminal: clipboard writes (OSC 52, unless clipboardWrites) and reads, terminal macros (ConEmu's OSC 9), DCS / APC /
 * PM / SOS, and their C1 forms.
 * Titles, links, progress and colours pass. A byte-level state machine, so no split across chunks, leading zero
 * (ESC]052) or huge payload slips through: a dropped string stays dropped until its terminator, however long it is.
 */
export class OutputFilter {
  /**
   * text: normal output; esc: after ESC; c2: after a 0xC2 lead byte; string: inside an OSC/DCS/...; stringEsc /
   * stringC2: a possible terminator inside one.
   */
  private state: 'text' | 'esc' | 'c2' | 'string' | 'stringEsc' | 'stringC2' = 'text';
  /** The string being read: an OSC worth keeping is collected until its terminator; null = being dropped. */
  private body: number[] | null = null;
  private readonly maxString: number;

  constructor(private readonly options: OutputFilterOptions = {}) {
    this.maxString = options.clipboardWrites ? MAX_CLIPBOARD_STRING : MAX_KEPT_STRING;
  }

  /** An OSC that may pass: a short title, link, progress or mark, or (when allowed) a clipboard write. */
  private kept(body: string): boolean {
    if (this.options.clipboardWrites && CLIPBOARD_WRITE.test(body)) return true;
    return body.length <= MAX_KEPT_STRING && KEPT_OSC(body);
  }

  push(chunk: Buffer): Buffer {
    // At most: the string carried over from the last chunk, this chunk, and an OSC prefix and terminator.
    const out = Buffer.allocUnsafe(chunk.length + (this.body?.length ?? 0) + 8);
    let n = 0;
    const put = (...bytes: number[]): void => {
      for (const b of bytes) out[n++] = b;
    };
    /** After ESC (or the C1 form): ] opens an OSC (maybe kept), P X ^ _ open DCS / SOS / PM / APC (dropped). */
    const opens = (b: number, c1: boolean): boolean => {
      if (b === (c1 ? 0x9d : 0x5d)) {
        this.body = c1 ? null : [];
        this.state = 'string';
        return true;
      }
      if ((c1 ? [0x90, 0x98, 0x9e, 0x9f] : [0x50, 0x58, 0x5e, 0x5f]).includes(b)) {
        this.body = null;
        this.state = 'string';
        return true;
      }
      return false;
    };
    const endString = (terminator: number[]): void => {
      const body = this.body && Buffer.from(this.body).toString('latin1');
      if (body !== null && this.kept(body)) {
        put(0x1b, 0x5d);
        out.write(body, n, 'latin1');
        n += body.length;
        put(...terminator);
      }
      this.body = null;
      this.state = 'text';
    };
    const collect = (b: number): void => {
      if (this.body && this.body.push(b) > this.maxString) this.body = null;
    };
    for (const b of chunk) {
      switch (this.state) {
        case 'text':
          if (b === 0x1b) this.state = 'esc';
          else if (b === 0xc2) this.state = 'c2';
          else put(b);
          break;
        case 'esc':
          if (opens(b, false)) break;
          if (b !== 0x1b) {
            put(0x1b, b);
            this.state = 'text';
          } else put(0x1b);
          break;
        case 'c2':
          if (opens(b, true)) break;
          if (b === 0x1b) {
            put(0xc2);
            this.state = 'esc';
          } else if (b === 0xc2) put(0xc2);
          else {
            put(0xc2, b);
            this.state = 'text';
          }
          break;
        case 'string':
          if (b === 0x07) endString([0x07]);
          else if (b === 0x1b) this.state = 'stringEsc';
          else if (b === 0xc2) this.state = 'stringC2';
          else if (b === 0x18 || b === 0x1a) {
            this.body = null;
            this.state = 'text';
          } else collect(b);
          break;
        case 'stringC2':
          // U+009C is the C1 string terminator; any other character is part of the string.
          if (b === 0x9c) endString([0x1b, 0x5c]);
          else {
            collect(0xc2);
            this.state = 'string';
            if (b === 0x07) endString([0x07]);
            else if (b === 0x1b) this.state = 'stringEsc';
            else if (b !== 0xc2) collect(b);
            else this.state = 'stringC2';
          }
          break;
        case 'stringEsc':
          if (b === 0x5c) {
            endString([0x1b, 0x5c]);
            break;
          }
          // ESC inside a string ends it (dropped) and starts a new sequence.
          this.body = null;
          this.state = 'esc';
          if (!opens(b, false) && b !== 0x1b) {
            put(0x1b, b);
            this.state = 'text';
          }
          break;
      }
    }
    return out.subarray(0, n);
  }
}
