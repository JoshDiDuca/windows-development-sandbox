// Client side of the ptyhost protocol (see sandbox/csharp/PtyHost.cs). Used by the window inside the sandbox and by
// `--terminal` / `attach` on the host, so it only depends on Node built-ins.

export const FrameType = {
  Hello: 1,
  Input: 2,
  Resize: 3,
  Restart: 4,
  Ping: 5,
  /** Ends the program and everything it started, and with it the session. */
  Close: 6,
  Output: 16,
  Exit: 17,
  Error: 18,
  Restarting: 19,
  Status: 20,
  Console: 21,
} as const;

/** HELLO flags: control-only connections get no output and never size the console; a query only asks for STATUS. */
export const HelloFlag = { ControlOnly: 1, Query: 2 } as const;

/**
 * Viewers ping this often; ptyhost counts a viewer as gone after 15 s of silence (e.g. its terminal tab was closed).
 */
export const PING_INTERVAL_MS = 5000;

export interface Frame {
  type: number;
  payload: Buffer;
}

/** Ctrl+] — the same detach key telnet uses; Claude Code does not bind it. */
export const DETACH_KEY = 0x1d;

export function encodeFrame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function helloFrame(token: string, cols: number, rows: number, flags = 0): Buffer {
  const head = Buffer.alloc(5);
  head.writeInt16LE(cols, 0);
  head.writeInt16LE(rows, 2);
  head.writeUInt8(flags, 4);
  return encodeFrame(FrameType.Hello, Buffer.concat([head, Buffer.from(token, 'utf8')]));
}

export function resizeFrame(cols: number, rows: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeInt16LE(cols, 0);
  payload.writeInt16LE(rows, 2);
  return encodeFrame(FrameType.Resize, payload);
}

/** Same limit as PtyHost.cs; a peer announcing more is broken or hostile. */
export const MAX_FRAME_BYTES = 1 << 20;

/** Splits a TCP byte stream back into frames. */
export class FrameReader {
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): Frame[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Frame[] = [];
    while (this.pending.length >= 5) {
      const length = this.pending.readUInt32LE(1);
      if (length > MAX_FRAME_BYTES) throw new Error('frame too large (' + length + ' bytes)');
      if (this.pending.length < 5 + length) break;
      frames.push({ type: this.pending[0], payload: this.pending.subarray(5, 5 + length) });
      this.pending = this.pending.subarray(5 + length);
    }
    return frames;
  }
}
