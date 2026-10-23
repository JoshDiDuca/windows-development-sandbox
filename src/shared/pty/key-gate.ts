// Windows: holds what you type until the client knows how the console hands keys over, so Backspace stays Backspace.

/**
 * Node on Windows reads keys through the console API, where Backspace is ^H and Ctrl+Backspace is DEL: the reverse of
 * what terminals send. ConPTY reads ^H as Ctrl+Backspace (delete a word), so swap them back.
 */
export function fixWindowsKeys(chunk: Buffer): Buffer {
  if (!chunk.includes(0x08) && !chunk.includes(0x7f)) return chunk;
  return Buffer.from(chunk.map((b) => (b === 0x08 ? 0x7f : b === 0x7f ? 0x08 : b)));
}

/**
 * Typed input before the console's mode is settled. Once ENABLE_VIRTUAL_TERMINAL_INPUT is on (enableVtInput), the
 * console hands over the terminal's own bytes (DEL for Backspace, ^H for Ctrl+Backspace) and nothing may be swapped;
 * only when it could not be turned on are keys read as console key records and swapped (fixWindowsKeys). Turning it
 * on takes a moment (a PowerShell helper), and input read meanwhile used to be swapped although it was the terminal's
 * own: a Backspace pressed then reached the agent as ^H and deleted a word. So input waits here until the mode is
 * known.
 */
export class KeyGate {
  private pending: Buffer[] = [];
  private decided: boolean;
  private swap = false;

  /** windowsConsole: input comes from a Windows console in raw mode (its mode is decided later); else it goes as is. */
  constructor(windowsConsole: boolean) {
    this.decided = !windowsConsole;
  }

  /** The bytes to send now (empty while the mode is not known yet). */
  push(data: Buffer): Buffer {
    if (!data.length) return data;
    if (!this.decided) {
      this.pending.push(data);
      return Buffer.alloc(0);
    }
    return this.swap ? fixWindowsKeys(data) : data;
  }

  /** The console's mode is known: what was held, ready to send. Later calls only change how new input is read. */
  decide(vtInput: boolean): Buffer {
    this.swap = !vtInput;
    this.decided = true;
    const held = Buffer.concat(this.pending);
    this.pending = [];
    return this.swap ? fixWindowsKeys(held) : held;
  }
}
