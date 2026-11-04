// The boot's console on the sandbox's terminal: the live progress block when it is a terminal, ordered plain lines
// otherwise (and in a dry run). While it is open it takes the log's console lines and the output of the programs the
// boot starts; it is released, with the final summary, right before the first session takes the window.
import { log, record, routeConsole } from '../runtime/log.js';
import { routeOutput } from '../runtime/process.js';
import {
  CONSOLE_GLYPHS,
  ProgressView,
  readyLines,
  RICH_GLYPHS,
  type ReadyInfo,
  type ViewStage,
  type ViewTask,
} from './progress-view.js';
import type { BootTaskDef, RunnerObserver, TaskOutcome } from './runner.js';

/** The spinner's pace (the elapsed times change every tenth of a second too). */
const FRAME_MS = 100;
const COLUMNS = 80;
const SHOW_CURSOR = '\x1b[?25h';

export class BootConsole implements RunnerObserver {
  private timer: NodeJS.Timeout | null = null;
  private open = false;

  private constructor(
    private readonly view: ProgressView,
    private readonly live: boolean,
  ) {}

  /** `plain`: ordered lines even on a terminal (a dry run). */
  static create(stages: readonly ViewStage[], tasks: readonly ViewTask[], o: { plain: boolean }): BootConsole {
    const live = !o.plain && process.stdout.isTTY === true;
    // Windows Terminal sets WT_SESSION; the classic console's font has no braille or check marks.
    const rich = live && Boolean(process.env.WT_SESSION);
    const view = new ProgressView(stages, tasks, {
      live,
      glyphs: rich ? RICH_GLYPHS : CONSOLE_GLYPHS,
      now: () => Date.now(),
      screen: {
        write: (text) => void process.stdout.write(text),
        columns: () => process.stdout.columns ?? COLUMNS,
      },
    });
    return new BootConsole(view, live);
  }

  /** Prints the header and takes the console. */
  start(header: string): void {
    record(header);
    this.open = true;
    this.view.start(header);
    routeConsole({
      line: (message, stage) => this.view.line(message, stage),
      warning: (message) => this.view.warning(message),
      notice: (message) => this.view.notice(message),
    });
    // Programs the boot starts would draw over the block (or between the plain stages): their output goes to the log;
    // the hooks keep the terminal. After the release too: the background steps must not write into the session.
    routeOutput({ capturing: () => !this.open || this.view.capturing, line: (text) => log(text) });
    if (!this.live) return;
    this.timer = setInterval(() => this.view.tick(), FRAME_MS);
    this.timer.unref();
    // A crash must not leave the terminal without its cursor.
    process.once('exit', () => {
      if (this.open) process.stdout.write(SHOW_CURSOR);
    });
  }

  started(task: BootTaskDef): void {
    this.view.started(task);
    this.view.tick();
  }

  finished(task: BootTaskDef, outcome: TaskOutcome): void {
    this.view.finished(task, outcome);
    this.view.tick();
  }

  /** What a running task's place on its row says (null: its title). */
  detail(taskId: string, text: string | null): void {
    this.view.detail(taskId, text);
  }

  /** The tool summary: to the file now, to the console once the boot is ready. */
  summary(lines: readonly string[]): void {
    for (const line of lines) record('  ' + line);
    this.view.summary(lines);
  }

  /** Runs `work` that writes to the terminal itself (the hooks). */
  aside<T>(work: () => T): T {
    return this.view.aside(work);
  }

  /**
   * The final summary (`ready`, or null when the boot failed); the console is the log's own again. Programs' output
   * keeps going to the log (the background runs quiet: file only).
   */
  release(ready: ReadyInfo | null): void {
    if (!this.open) return;
    this.open = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    routeConsole(null);
    if (ready) for (const line of readyLines(ready)) record(line);
    this.view.release(ready);
  }
}
