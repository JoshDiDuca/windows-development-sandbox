import type net from 'node:net';
import {
  FrameReader,
  encodeFrame,
  FrameType,
  resizeFrame,
  PING_INTERVAL_MS,
  type Frame,
  helloFrame,
} from './protocol.js';
import { OutputFilter } from './output-filter.js';
import { enableVtInput } from './console-input.js';
import { InputJoiner, JOIN_MS } from './input-joiner.js';
import { CTRL_C_CONFIRM_MS, CtrlCGuard } from './ctrl-c.js';
import { KeyGate } from './key-gate.js';
import { MouseModes } from './mouse-modes.js';

export type ClientResult =
  { reason: 'exit'; exitCode: number } | { reason: 'detach' | 'closed' } | { reason: 'error'; message: string };

/**
 * Turns off every mouse tracking mode a program may have turned on in your terminal (normal, button, any, UTF-8, SGR,
 * urxvt).
 */
export const MOUSE_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l';

/** After leaving: mouse reports still on their way are dropped until input is this quiet (at most SETTLE_MAX_MS). */
const SETTLE_QUIET_MS = 50;
const SETTLE_MAX_MS = 300;

/** Waits until `stream` has been quiet for SETTLE_QUIET_MS (or SETTLE_MAX_MS passed), dropping what it reads. */
function drainInput(stream: NodeJS.ReadStream): Promise<void> {
  return new Promise((done) => {
    let quiet: NodeJS.Timeout | undefined;
    const end = (): void => {
      clearTimeout(quiet);
      clearTimeout(cap);
      stream.off('data', onData);
      done();
    };
    const onData = (): void => {
      clearTimeout(quiet);
      quiet = setTimeout(end, SETTLE_QUIET_MS);
    };
    const cap = setTimeout(end, SETTLE_MAX_MS);
    stream.on('data', onData);
    onData();
  });
}

/** Longest wait for the console's input mode before typed keys are sent anyway (it normally takes about 2 s). */
const VT_WAIT_MS = 10000;

/**
 * Bridges this process's terminal to the remote program until it exits, the connection drops, or the user presses
 * the detach key. Restores the terminal before resolving.
 */
export function runTerminalClient(
  socket: net.Socket,
  token: string,
  /** clipboardWrites: the agent's "copy" (OSC 52) reaches the clipboard; see OutputFilterOptions. */
  /** confirmCtrlC: a lone Ctrl+C is held back until it is pressed again (CtrlCGuard, attach.confirmCtrlC). */
  options: { detachKey?: number; clipboardWrites?: boolean; confirmCtrlC?: boolean } = {},
): Promise<ClientResult> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  // getWindowSize asks the console every time; columns/rows only change when Node noticed a resize.
  const size = (): [number, number] => {
    const [c, r] = stdout.isTTY ? stdout.getWindowSize() : [0, 0];
    return [c || 120, r || 30];
  };
  // Until the console's input mode is known (enableVtInput), what is typed waits: see KeyGate.
  const keys = new KeyGate(process.platform === 'win32' && Boolean(stdin.isTTY));
  return new Promise((resolve) => {
    let done = false;
    const reader = new FrameReader();
    const filter = new OutputFilter({ clipboardWrites: options.clipboardWrites });
    let sent = size();
    let resizeTimer: NodeJS.Timeout | undefined;
    // Set once raw mode is on (below); finish() may run before that.
    // eslint-disable-next-line prefer-const
    let vtInput: ReturnType<typeof enableVtInput> | undefined, vtTimer: NodeJS.Timeout | undefined;
    // The agent's mouse modes, read from its output; only known when it is passed through (conpty.dll, see below).
    const mouse = new MouseModes();
    let passthrough = false;
    const finish = (result: ClientResult): void => {
      if (done) return;
      done = true;
      stdin.off('data', onInput);
      stdout.off('resize', onResize);
      clearTimeout(resizeTimer);
      clearInterval(heartbeat);
      clearInterval(sizeWatch);
      clearTimeout(joinTimer);
      clearTimeout(hintTimer);
      clearTimeout(vtTimer);
      socket.destroy();
      // The agent's mouse tracking ends with it: your terminal's wheel scrolls again (and clicks select text). Reports
      // the terminal sent before it read that are dropped here, or they would reach your shell as text.
      const tracked = mouse.tracking();
      const reset = '\x1b[0m\x1b[?25h' + MOUSE_OFF + (mouse.has(2004) ? '\x1b[?2004l' : '') + '\r\n';
      const flushed = new Promise<void>((written) => stdout.write(reset, () => written()));
      const settled = tracked ? flushed.then(() => drainInput(stdin)) : Promise.resolve();
      // Wait for a console-mode change still in progress, then give the console back in its normal mode.
      void Promise.all([settled, vtInput?.stop()]).then(() => {
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
        resolve(result);
      });
    };
    const joiner = new InputJoiner();
    let joinTimer: NodeJS.Timeout | undefined;
    const write = (data: Buffer): void => {
      if (data.length && !done) socket.write(encodeFrame(FrameType.Input, data));
    };
    // Mouse reports the agent has not asked for (motion without 1002/1003 ...) are dropped: see MouseModes.
    const sendInput = (data: Buffer): void => write(keys.push(passthrough ? mouse.filter(data) : data));
    const guard = options.confirmCtrlC ? new CtrlCGuard() : null;
    let hintTimer: NodeJS.Timeout | undefined;
    const onInput = (chunk: Buffer): void => {
      if (options.detachKey !== undefined && chunk.includes(options.detachKey)) {
        finish({ reason: 'detach' });
        return;
      }
      if (guard) {
        const decided = guard.push(chunk, Date.now());
        clearTimeout(hintTimer);
        if (decided.held) {
          stdout.write(guard.hintTitle());
          hintTimer = setTimeout(() => stdout.write(guard.restoreTitle()), CTRL_C_CONFIRM_MS);
          return;
        }
        if (decided.send.length === 1 && decided.send[0] === 0x03) stdout.write(guard.restoreTitle());
      }
      clearTimeout(joinTimer);
      sendInput(joiner.push(chunk));
      // A lone Esc key press is a "sequence" that never completes: send it after a moment.
      if (joiner.holding()) joinTimer = setTimeout(() => sendInput(joiner.flush()), JOIN_MS);
    };
    // Windows' own ConPTY repaints the whole screen on every resize; dragging a window edge fires dozens of them, and
    // repaints racing each other left the screen garbled. Wait until the size settles, clear what this terminal
    // reflowed on its own, then let ptyhost repaint everything once at the new size. With conpty.dll (passthrough)
    // nothing is repainted: this terminal's own reflow and scrollback stay, and the program redraws what it needs.
    const sendSize = (): void => {
      const [c, r] = size();
      if (c === sent[0] && r === sent[1]) return;
      sent = [c, r];
      if (!passthrough) stdout.write('\x1b[H\x1b[J');
      socket.write(resizeFrame(c, r));
    };
    const onResize = (): void => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        sendSize();
      }, 120);
    };
    const heartbeat = setInterval(() => socket.write(encodeFrame(FrameType.Ping)), PING_INTERVAL_MS);
    // Windows does not always report a resize in raw mode, so the size is also checked twice a second.
    const sizeWatch = setInterval(() => {
      if (!resizeTimer) sendSize();
    }, 500);

    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = reader.push(chunk);
      } catch {
        finish({ reason: 'error', message: 'invalid data from the sandbox' });
        return;
      }
      for (const frame of frames) {
        if (frame.type === FrameType.Output) {
          const out = filter.push(frame.payload);
          mouse.watch(out);
          guard?.watchOutput(out.toString('latin1'));
          stdout.write(out);
        } else if (frame.type === FrameType.Console) passthrough = frame.payload.toString('latin1') === 'conpty.dll';
        else if (frame.type === FrameType.Restarting) {
          mouse.reset();
          stdout.write(MOUSE_OFF + '\x1b[2J\x1b[3J\x1b[H');
        } else if (frame.type === FrameType.Exit)
          finish({ reason: 'exit', exitCode: frame.payload.length >= 4 ? frame.payload.readInt32LE(0) : 1 });
        else if (frame.type === FrameType.Error)
          finish({
            reason: 'error',
            message: frame.payload
              .toString('utf8')
              .slice(0, 500)
              .replace(/[\x00-\x1f\x7f]/g, ' '),
          });
      }
    });
    socket.on('close', () => finish({ reason: 'closed' }));
    socket.on('error', () => finish({ reason: 'closed' }));

    const [c, r] = size();
    stdout.write('\x1b[2J\x1b[3J\x1b[H');
    socket.write(helloFrame(token, c, r));
    if (stdin.isTTY) stdin.setRawMode(true);
    // After setRawMode (which sets the console mode): mouse reports, focus and keys then arrive as the terminal sent
    // them.
    vtInput = enableVtInput();
    // A helper that hangs must not hold the keyboard: after VT_WAIT_MS keys go as console keys until it is done.
    vtTimer = setTimeout(() => write(keys.decide(false)), VT_WAIT_MS);
    void vtInput.ready.then((on) => {
      clearTimeout(vtTimer);
      write(keys.decide(on));
    });
    stdin.on('data', onInput);
    stdin.resume();
    stdout.on('resize', onResize);
  });
}
