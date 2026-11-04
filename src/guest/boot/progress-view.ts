// The boot's console (docs/design/parallel-boot.md, "Console output"). A terminal gets one header line and a block of
// stage rows that redraws in place; anything else (a log, CI, a dry run) gets plain lines, a stage at a time, in stage
// order, once it has finished. Warnings, the tool list and the ready line come once, at the end. Pure: the boot feeds
// it the runner's events and its own lines and gives it a screen to write to (boot-console.ts).
import { duration, type TaskOutcome } from './runner.js';

export interface ViewStage {
  readonly stage: number;
  readonly name: string;
}

export interface ViewTask {
  readonly id: string;
  readonly stage: number;
  readonly title: string;
  /** Its failure fails the boot (a soft failure is a warning). */
  readonly critical?: boolean;
}

/** The marks of a stage row. */
export interface Glyphs {
  readonly done: string;
  readonly failed: string;
  readonly warned: string;
  readonly skipped: string;
  readonly waiting: string;
  readonly more: string;
  readonly spinner: readonly string[];
}

/** For Windows Terminal (Cascadia has braille and check marks). */
export const RICH_GLYPHS: Glyphs = {
  done: '✓',
  failed: '✗',
  warned: '!',
  skipped: '-',
  waiting: '·',
  more: '…',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

/** For the classic console (Consolas has neither braille nor check marks). */
export const CONSOLE_GLYPHS: Glyphs = {
  done: '√',
  failed: 'x',
  warned: '!',
  skipped: '-',
  waiting: '·',
  more: '...',
  spinner: ['-', '\\', '|', '/'],
};

export interface Screen {
  /** Writes text as it is (the view writes its own line ends and, when live, its cursor moves). */
  write(text: string): void;
  /** The terminal's width (live mode). */
  columns(): number;
}

export interface ViewOptions {
  /** A terminal: the stage block redraws in place. Otherwise plain, ordered lines. */
  readonly live: boolean;
  readonly screen: Screen;
  /** Milliseconds. */
  readonly now: () => number;
  readonly glyphs?: Glyphs;
}

/** The end of the boot: how long it took, which tasks took longest and what goes on in the background. */
export interface ReadyInfo {
  readonly ms: number;
  readonly outcomes: readonly TaskOutcome[];
  readonly background: readonly string[];
  readonly logPath: string;
}

type Mark = 'waiting' | 'running' | 'done' | 'warned' | 'failed' | 'skipped';
type Colour = 'green' | 'red' | 'yellow' | 'cyan' | 'dim' | 'bold';

/** How a stage row looks in each state: its glyph (a running row spins instead), colour and detail. */
const MARKS = {
  waiting: { glyph: 'waiting', colour: 'dim', detail: 'waiting' },
  running: { glyph: 'waiting', colour: 'cyan', detail: '' },
  done: { glyph: 'done', colour: 'green', detail: '' },
  warned: { glyph: 'warned', colour: 'yellow', detail: 'see the warnings' },
  failed: { glyph: 'failed', colour: 'red', detail: '' },
  skipped: { glyph: 'skipped', colour: 'dim', detail: 'skipped' },
} as const satisfies Record<Mark, { glyph: keyof Omit<Glyphs, 'spinner' | 'more'>; colour: Colour; detail: string }>;

const ANSI: Readonly<Record<Colour, string>> = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};
const RESET = '\x1b[0m';
/** Moves to the start of the line `n` lines up. */
const up = (n: number): string => '\r\x1b[' + n + 'A';
const CLEAR_LINE = '\x1b[2K';
const CLEAR_BELOW = '\x1b[J';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

const SPIN_MS = 80;
const TIME_WIDTH = 6;
/** Warnings shown under the live block (the rest wait for the end). */
const LIVE_WARNINGS = 4;
/** The tool names column of the summary (a longer name pushes its detail along). */
const TOOL_COLUMN = 24;
/** Tasks under a second are not worth naming as "slowest". */
const SLOW_MS = 1000;
const MIN_WIDTH = 40;

interface Segment {
  readonly text: string;
  readonly colour?: Colour;
}

class StageState {
  began: number | null = null;
  ended: number | null = null;
  finished = 0;
  skipped = 0;
  softFailed = false;
  error: string | null = null;
  printed = false;
  /** Task id -> what the row shows for it (its title, or the detail the boot gave it). */
  readonly running = new Map<string, string>();
  readonly lines: string[] = [];
  readonly problems: string[] = [];

  constructor(
    readonly stage: number,
    readonly name: string,
    readonly total: number,
  ) {}

  get complete(): boolean {
    return this.finished >= this.total;
  }

  mark(): Mark {
    if (this.error !== null) return 'failed';
    if (this.complete) {
      if (this.total > 0 && this.skipped === this.total) return 'skipped';
      return this.softFailed ? 'warned' : 'done';
    }
    return this.began === null ? 'waiting' : 'running';
  }

  /** How long the stage has run (from its first task's start to its last task's end, or to now). */
  elapsed(now: number): number | null {
    if (this.began === null) return null;
    return (this.ended ?? now) - this.began;
  }
}

/** "Node, Python, Rust +2 (5/13)": what the toolchain scheduler runs now. */
export function stepsDetail(active: readonly string[], done: number, total: number): string {
  const shown = active.slice(0, 3).join(', ') + (active.length > 3 ? ' +' + (active.length - 3) : '');
  return (shown || 'Developer tools') + (total > 0 ? ' (' + done + '/' + total + ')' : '');
}

/** "Ready in 46.8s (slowest: ...)" and, when work goes on, the line that says what still installs. */
export function readyLines(info: ReadyInfo): string[] {
  const slowest = [...info.outcomes]
    .filter((o) => o.state !== 'skipped' && o.ms >= SLOW_MS)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3)
    .map((o) => o.title + ' ' + duration(o.ms));
  const later = info.background;
  const names =
    later.length > 3 ? later.slice(0, 3).join(', ') + ' and ' + (later.length - 3) + ' more' : later.join(', ');
  return [
    'Ready in ' + duration(info.ms) + (slowest.length ? ' (slowest: ' + slowest.join(', ') + ')' : ''),
    ...(later.length
      ? ['Still installing in the background: ' + names + ' (a few minutes; it does not hold you up)']
      : []),
  ];
}

/** Word-wraps `text` to `width` columns; a word longer than that is cut. Linear in the text. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (let word of text.split(' ')) {
    while (word.length > width) {
      if (line) lines.push(line);
      lines.push(word.slice(0, width));
      word = word.slice(width);
      line = '';
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}

/** One boot's console: fed by the runner's events and the boot's lines, drawn on a screen. */
export class ProgressView {
  private readonly stages: StageState[];
  private readonly byStage = new Map<number, StageState>();
  private readonly taskById = new Map<string, ViewTask>();
  private readonly nameWidth: number;
  private readonly glyphs: Glyphs;
  private readonly warnings: string[] = [];
  private readonly notices: string[] = [];
  private tools: string[] = [];
  /** Lines of the live block on the screen now (the cursor is just below them). */
  private drawn = 0;
  private lastFrame = '';
  private asideDepth = 0;
  private released = false;

  constructor(
    stages: readonly ViewStage[],
    tasks: readonly ViewTask[],
    private readonly o: ViewOptions,
  ) {
    this.glyphs = o.glyphs ?? RICH_GLYPHS;
    this.stages = [...stages]
      .sort((a, b) => a.stage - b.stage)
      .map((s) => new StageState(s.stage, s.name, tasks.filter((t) => t.stage === s.stage).length));
    for (const s of this.stages) this.byStage.set(s.stage, s);
    for (const t of tasks) this.taskById.set(t.id, t);
    this.nameWidth = Math.max(0, ...stages.map((s) => s.name.length));
  }

  /**
   * Whether programs should hand their output to the log now: it would draw over the live block, or come out between
   * the plain stages. Not while a hook has the terminal.
   */
  get capturing(): boolean {
    return !this.released && this.asideDepth === 0;
  }

  /** The header line, then (live) the first frame. */
  start(header: string): void {
    this.o.screen.write(this.paint(header, 'bold') + '\n\n');
    if (this.o.live) {
      this.o.screen.write(HIDE_CURSOR);
      this.draw();
    }
  }

  started(task: ViewTask): void {
    const s = this.byStage.get(task.stage);
    if (!s) return;
    s.began ??= this.o.now();
    s.running.set(task.id, task.title);
  }

  finished(task: ViewTask, outcome: TaskOutcome): void {
    const s = this.byStage.get(task.stage);
    if (!s) return;
    s.running.delete(task.id);
    s.finished++;
    if (outcome.state === 'skipped') {
      s.skipped++;
      s.problems.push(this.glyphs.skipped + ' ' + task.title + ' skipped (' + (outcome.error ?? '') + ')');
    } else if (outcome.state === 'failed') {
      if (task.critical) {
        s.error ??= outcome.error ?? 'failed';
        s.problems.push(this.glyphs.failed + ' ' + task.title + ' failed: ' + (outcome.error ?? ''));
      } else s.softFailed = true;
    }
    if (s.began !== null && s.complete) s.ended = this.o.now();
    this.flushPlain();
  }

  /** What a running task's place on its row says instead of its title (null: its title again). */
  detail(taskId: string, text: string | null): void {
    const task = this.taskById.get(taskId);
    const s = task && this.byStage.get(task.stage);
    if (!s?.running.has(taskId)) return;
    s.running.set(taskId, text ?? task!.title);
  }

  /** An info line: the file has it; plain output shows it under its stage (or at once, outside a stage). */
  line(text: string, stage: number | undefined): void {
    if (this.released) return;
    if (this.asideDepth > 0) {
      this.o.screen.write(text + '\n');
      return;
    }
    if (this.o.live) return;
    const s = stage === undefined ? undefined : this.byStage.get(stage);
    if (s && !s.printed) s.lines.push(text);
    else this.o.screen.write((s ? this.indent() : '') + text + '\n');
  }

  warning(text: string): void {
    if (!this.warnings.includes(text)) this.warnings.push(text);
  }

  notice(text: string): void {
    if (!this.notices.includes(text)) this.notices.push(text);
  }

  /** The tool summary ("name: detail" lines), printed once at the end. */
  summary(lines: readonly string[]): void {
    this.tools = [...lines];
  }

  /** Redraws the live block (the boot calls it a few times a second). */
  tick(): void {
    if (this.o.live && !this.released && this.asideDepth === 0) this.draw();
  }

  /** Runs `work`, which writes to the terminal itself (the hooks): the live block steps aside until it is done. */
  aside<T>(work: () => T): T {
    if (!this.o.live || this.released) return work();
    this.erase();
    this.asideDepth++;
    const back = (): void => {
      this.asideDepth--;
      this.tick();
    };
    let result: T;
    try {
      result = work();
    } catch (e) {
      back();
      throw e;
    }
    if (result instanceof Promise) return result.finally(back) as T;
    back();
    return result;
  }

  /**
   * The boot is over (`ready`) or failed (null): the final block, warnings, tools, notices and the ready line, once.
   * The console is free afterwards (the first session takes it); nothing of this view prints again.
   */
  release(ready: ReadyInfo | null): void {
    if (this.released) return;
    if (this.o.live) this.erase();
    this.released = true;
    const width = this.o.live ? this.width() : Infinity;
    // Sections, a blank line between them.
    const sections: string[][] = [];
    if (this.warnings.length)
      sections.push([
        this.paint('Warnings', 'yellow'),
        ...this.warnings.flatMap((w) => this.hanging('  ! ', w, width, 'yellow')),
      ]);
    if (this.tools.length) sections.push([this.paint('Tools', 'bold'), ...this.toolRows(width)]);
    if (this.notices.length) sections.push(this.notices.flatMap((n) => this.hanging('', n, width)));
    if (ready) {
      const [first, ...rest] = readyLines(ready);
      sections.push([
        this.paint(first!, 'green'),
        ...rest.map((l) => this.paint(l, 'cyan')),
        this.paint('Log: ' + ready.logPath, 'dim'),
      ]);
    }
    const join = (parts: readonly string[][]): string => parts.map((p) => p.join('\n') + '\n').join('\n');
    if (this.o.live) {
      // The block again, still (no spinner), where the live one was.
      const rows = this.stages.map((s) => this.row(s, null));
      this.o.screen.write(join([rows, ...sections]) + SHOW_CURSOR);
      return;
    }
    // Plain: the stages not printed yet (a failed boot), then the sections after a blank line.
    const left = this.stages.filter((s) => !s.printed && s.began !== null).flatMap((s) => this.stageBlock(s));
    const text = (left.length ? left.join('\n') + '\n' : '') + (sections.length ? '\n' + join(sections) : '');
    if (text) this.o.screen.write(text);
  }

  /** The live block as it would be drawn now (no colours when `colour` is false): the tests read it. */
  frame(colour = true): string[] {
    const now = this.o.now();
    const rows = this.stages.map((s) => this.row(s, now, colour));
    if (!this.warnings.length) return rows;
    const width = this.width();
    const shown = this.warnings.slice(-LIVE_WARNINGS);
    const more = this.warnings.length - shown.length;
    return [
      ...rows,
      '',
      ...shown.map((w) => this.render([{ text: '  ! ' + w, colour: 'yellow' }], width, colour)),
      ...(more > 0
        ? [this.render([{ text: '  + ' + more + ' more (shown when ready)', colour: 'dim' }], width, colour)]
        : []),
    ];
  }

  private draw(): void {
    const lines = this.frame();
    const text = lines.map((l) => CLEAR_LINE + l + '\n').join('');
    if (text === this.lastFrame && this.drawn === lines.length) return;
    this.o.screen.write((this.drawn ? up(this.drawn) : '') + text + CLEAR_BELOW);
    this.lastFrame = text;
    this.drawn = lines.length;
  }

  private erase(): void {
    if (this.drawn) this.o.screen.write(up(this.drawn) + CLEAR_BELOW);
    this.drawn = 0;
    this.lastFrame = '';
  }

  /** Plain output: every finished stage whose earlier stages are printed, in stage order. */
  private flushPlain(): void {
    if (this.o.live || this.released) return;
    for (const s of this.stages) {
      if (s.printed) continue;
      if (!s.complete) return;
      this.o.screen.write(this.stageBlock(s).join('\n') + '\n');
    }
  }

  private stageBlock(s: StageState): string[] {
    s.printed = true;
    const time = s.elapsed(this.o.now());
    const state =
      s.error !== null ? '  FAILED' : !s.complete ? '  not finished' : s.mark() === 'skipped' ? '  skipped' : '';
    const head = '[' + s.stage + '/' + this.stages.length + '] ' + s.name.padEnd(this.nameWidth);
    return [
      head + (time === null ? '' : '  ' + duration(time).padStart(TIME_WIDTH)) + state,
      ...s.problems.map((p) => this.indent() + p),
      ...s.lines.map((l) => this.indent() + l),
    ];
  }

  private indent(): string {
    return ' '.repeat(('[9/' + this.stages.length + '] ').length);
  }

  /** One stage row; `now` null: the final, still row (no spinner). */
  private row(s: StageState, now: number | null, colour = true): string {
    const mark = s.mark();
    const look = MARKS[mark];
    const still = now === null;
    // A stage still running when the view is released (a failed boot) shows as unfinished, without a spinner.
    const spinning = mark === 'running' && !still;
    const glyph = spinning
      ? this.glyphs.spinner[Math.floor(now / SPIN_MS) % this.glyphs.spinner.length]!
      : this.glyphs[look.glyph];
    const elapsed = s.elapsed(now ?? this.o.now());
    const time = elapsed === null || (mark === 'running' && still) ? '' : duration(elapsed);
    const detail =
      mark === 'running'
        ? still
          ? 'not finished'
          : [...s.running.values()].join(', ') || 'waiting'
        : mark === 'failed'
          ? 'failed: ' + s.error
          : mark === 'waiting' && still
            ? 'not started'
            : look.detail;
    return this.render(
      [
        { text: '  ' },
        { text: glyph, colour: mark === 'running' && still ? 'dim' : look.colour },
        { text: ' ' + s.stage + '  ' },
        { text: s.name.padEnd(this.nameWidth), ...(mark === 'waiting' ? { colour: 'dim' as const } : {}) },
        { text: '  ' + time.padStart(TIME_WIDTH), colour: 'dim' },
        { text: detail ? '  ' + detail : '', colour: mark === 'failed' ? 'red' : 'dim' },
      ],
      now === null ? Infinity : this.width(),
      colour,
    );
  }

  /** The tool summary as two aligned columns, the detail wrapped under itself. */
  private toolRows(width: number): string[] {
    const rows = this.tools.map((line) => {
      const at = line.indexOf(': ');
      return at > 0 ? { name: line.slice(0, at), detail: line.slice(at + 2) } : { name: line, detail: '' };
    });
    const column = Math.min(TOOL_COLUMN, Math.max(0, ...rows.map((r) => r.name.length)));
    const lead = ' '.repeat(2 + column + 2);
    return rows.flatMap((r) => {
      const colour = r.name === 'PROTECTION MISSING' ? 'red' : undefined;
      if (!r.detail) return [this.paint('  ' + r.name, colour)];
      // A name longer than the column gets a line of its own; the detail stays in its column.
      if (r.name.length > column)
        return [this.paint('  ' + r.name, colour), ...this.hanging(lead, r.detail, width, colour)];
      return this.hanging('  ' + r.name.padEnd(column) + '  ', r.detail, width, colour);
    });
  }

  /** `lead` + `text`, wrapped to `width` with the next lines indented under the text. */
  private hanging(lead: string, text: string, width: number, colour?: Colour): string[] {
    const lines = width === Infinity ? [text] : wrap(text, Math.max(MIN_WIDTH / 2, width - lead.length));
    return lines.map((l, i) => this.paint((i === 0 ? lead : ' '.repeat(lead.length)) + l, colour));
  }

  /** The segments as one line of at most `width` columns, cut with the "more" mark. */
  private render(segments: readonly Segment[], width: number, colour = true): string {
    const total = segments.reduce((n, s) => n + s.text.length, 0);
    let room = total > width ? Math.max(0, width - this.glyphs.more.length) : Infinity;
    let out = '';
    for (const s of segments) {
      if (room <= 0) break;
      const text = s.text.slice(0, room);
      room -= text.length;
      out += colour && s.colour && text.trim() ? ANSI[s.colour] + text + RESET : text;
    }
    return total > width ? out.trimEnd() + this.glyphs.more : out.trimEnd();
  }

  private paint(text: string, colour: Colour | undefined): string {
    return this.o.live && colour ? ANSI[colour] + text + RESET : text;
  }

  /** The usable width: one column less than the terminal (a full line would wrap the cursor). */
  private width(): number {
    return Math.max(MIN_WIDTH, this.o.screen.columns() - 1);
  }
}
