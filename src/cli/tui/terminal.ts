// The terminal while the menu owns it: the alternate screen (your scrollback stays as it was), raw keys, a cursor that
// is hidden, and redraws that only rewrite the rows that changed, in one write (inside a synchronized update where the
// terminal has one), so nothing flickers. stop() hands the terminal back for a command's own output; start() takes it
// again.
import readline from 'node:readline';
import { Text } from './text.js';

/** One key press: `name` for special keys (up, return, escape, f1 ...), `text` for something typed. */
export interface Key {
  name: string;
  text: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

/** Ctrl+C: leave the menu at once (callers let it propagate to the top). */
export class ExitRequested extends Error {
  constructor() {
    super('Ctrl+C');
    this.name = 'ExitPromptError';
  }
}

/** DEC 2026: the terminal shows a frame only when it is complete. Others ignore it, so only these are asked. */
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

/**
 * How long a lone ESC waits for the rest of an escape sequence before it counts as the Esc key. Node's default is
 * 500 ms, which every Esc (back, close) waited for. Terminals send a key's whole sequence in one write, so a short wait
 * is enough.
 */
export const ESCAPE_TIMEOUT_MS = 25;

/** Whether this terminal is known to take synchronized updates (AGENT_SANDBOX_SYNC_UPDATE=1 or 0 overrides). */
export function supportsSyncUpdate(env: NodeJS.ProcessEnv = process.env): boolean {
  const forced = env.AGENT_SANDBOX_SYNC_UPDATE;
  if (forced === '1' || forced === '0') return forced === '1';
  const program = env.TERM_PROGRAM ?? '';
  return Boolean(env.WT_SESSION) || ['vscode', 'WezTerm', 'iTerm.app', 'ghostty', 'contour'].includes(program);
}

export class Terminal {
  private active = false;
  private frame: string[] = [];
  private queue: Key[] = [];
  private waiting: { resolve: (key: Key) => void; reject: (e: Error) => void } | null = null;
  private resizeHandler: (() => void) | null = null;
  private readonly sync = supportsSyncUpdate();
  private readonly onKeypress = (str: string | undefined, key: readline.Key | undefined): void => this.push(str, key);
  private readonly onResize = (): void => {
    this.frame = [];
    this.resizeHandler?.();
  };

  constructor(
    private readonly stdin: NodeJS.ReadStream = process.stdin,
    private readonly stdout: NodeJS.WriteStream = process.stdout,
  ) {}

  get width(): number {
    return Math.max(40, this.stdout.columns ?? 80);
  }
  get height(): number {
    return Math.max(12, this.stdout.rows ?? 30);
  }
  /** Keys can be read from a real terminal here (the menu refuses to open without one). */
  get interactive(): boolean {
    return Boolean(this.stdin.isTTY);
  }

  /** Called after the window was resized (the screen draws itself again). */
  onResized(handler: (() => void) | null): void {
    this.resizeHandler = handler;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.frame = [];
    // The first call on a stream sets its decoder; later calls (and readline interfaces) keep it.
    readline.emitKeypressEvents(this.stdin, { escapeCodeTimeout: ESCAPE_TIMEOUT_MS } as unknown as readline.Interface);
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.on('keypress', this.onKeypress);
    this.stdin.resume();
    this.stdout.on('resize', this.onResize);
    this.stdout.write('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J');
  }

  /** Gives the terminal back exactly as it was (also on errors: callers use try/finally). */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.stdin.off('keypress', this.onKeypress);
    this.stdout.off('resize', this.onResize);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
    this.queue = [];
    this.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  }

  get running(): boolean {
    return this.active;
  }

  /** Key presses are waiting to be read (the screen may skip a draw and show the result of the last one). */
  get hasKeys(): boolean {
    return this.queue.length > 0;
  }

  /** Draws a whole screen: `lines` are cut to the width and padded to the height; unchanged rows are not rewritten. */
  render(lines: string[]): void {
    const { width, height } = this;
    // One column is left free: writing the last column can scroll older consoles.
    const rows = Array.from({ length: height }, (_, i) => Text.fit(lines[i] ?? '', width - 1));
    // A different height (or nothing drawn yet: after a resize or a start) repaints everything.
    const repaint = this.frame.length !== rows.length;
    const out =
      (repaint ? '\x1b[H\x1b[2J' : '') +
      rows
        .map((row, i) => (repaint || this.frame[i] !== row ? '\x1b[' + (i + 1) + ';1H' + row + '\x1b[0m' : ''))
        .join('');
    this.frame = rows;
    if (out) this.stdout.write(this.sync ? SYNC_BEGIN + out + SYNC_END : out);
  }

  /** The next key press. Ctrl+C rejects with ExitRequested. */
  key(): Promise<Key> {
    const next = this.queue.shift();
    if (next) return next.ctrl && next.name === 'c' ? Promise.reject(new ExitRequested()) : Promise.resolve(next);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  private push(str: string | undefined, key: readline.Key | undefined): void {
    const event: Key = {
      name: key?.name ?? '',
      text: str && !key?.ctrl && !key?.meta && str.length >= 1 && str >= ' ' && str !== '\x7f' ? str : '',
      ctrl: Boolean(key?.ctrl),
      meta: Boolean(key?.meta),
      shift: Boolean(key?.shift),
    };
    const waiting = this.waiting;
    if (!waiting) {
      this.queue.push(event);
      return;
    }
    this.waiting = null;
    if (event.ctrl && event.name === 'c') waiting.reject(new ExitRequested());
    else waiting.resolve(event);
  }
}
