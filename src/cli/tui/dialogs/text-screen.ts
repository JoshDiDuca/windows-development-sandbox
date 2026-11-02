// The small screens: typing a value (with checking as you type), yes/no, and a message to read.
import type { FrameParts } from '../frame.js';
import type { Screen, Size, Step } from '../screen.js';
import type { Key } from '../terminal.js';
import { Text } from '../text.js';
import { Theme } from '../theme.js';
import { paragraphs } from './paragraphs.js';

export interface TextOptions {
  path: string[];
  label: string;
  /** Explanation above the field (plain lines). */
  about?: string[];
  initial?: string;
  placeholder?: string;
  /** true = fine, a string = what is wrong (shown under the field). */
  validate?: (value: string) => true | string;
  /** Allow an empty answer (otherwise Enter on an empty field cancels). */
  allowEmpty?: boolean;
  /** Only characters this matches can be typed (a number field takes digits only). */
  accept?: RegExp;
  /** A muted line under the field while nothing is wrong (what is allowed: "1 to 65536"). */
  hint?: string;
  /** A secret: the field shows * for each character (a password, an API key). */
  masked?: boolean;
}

/** One line of text. Resolves to the text, or undefined when you press Esc. */
export class TextScreen implements Screen<string | undefined> {
  private value: string;
  private cursor: number;
  private problem: string | undefined;

  constructor(private readonly o: TextOptions) {
    this.value = o.initial ?? '';
    this.cursor = [...this.value].length;
  }

  render(size: Size): FrameParts {
    const width = Math.min(size.width - 4, 100);
    const chars = [...this.value].map((ch) => (this.o.masked ? '*' : ch));
    // Scroll the field so the cursor stays visible.
    const inner = width - 4;
    const start = Math.max(0, this.cursor - inner + 1);
    const shown = chars.slice(start, start + inner);
    const before = shown.slice(0, this.cursor - start).join('');
    const at = shown[this.cursor - start] ?? ' ';
    const after = shown.slice(this.cursor - start + 1).join('');
    const text =
      this.value === '' && this.o.placeholder
        ? Theme.muted(this.o.placeholder)
        : before + (Theme.colour ? '\x1b[7m' + at + '\x1b[27m' : '_') + after;
    const body = [
      '',
      '  ' + Theme.bold(this.o.label),
      ...(this.o.about?.length ? paragraphs(this.o.about, size.width).map((l) => Theme.muted(l)) : []),
      '',
      '  ' + Theme.accent('╭' + '─'.repeat(width - 2) + '╮'),
      '  ' + Theme.accent('│') + ' ' + Text.fit(text, inner) + ' ' + Theme.accent('│'),
      '  ' + Theme.accent('╰' + '─'.repeat(width - 2) + '╯'),
      this.problem
        ? '  ' + Theme.error(Theme.glyph.cross + ' ' + this.problem)
        : this.o.hint
          ? '  ' + Theme.muted(this.o.hint)
          : '',
    ];
    return {
      path: this.o.path,
      body,
      keys: [
        ['↵', 'save'],
        ['esc', 'cancel'],
        ['ctrl+u', 'clear'],
        ['←→', 'move'],
      ],
    };
  }

  handle(key: Key): Step<string | undefined> {
    const chars = [...this.value];
    const set = (next: string[], cursor: number): void => {
      this.value = next.join('');
      this.cursor = Math.max(0, Math.min(next.length, cursor));
      this.check();
    };
    if (key.name === 'escape') return { done: undefined };
    if (key.name === 'return') {
      if (this.value === '' && !this.o.allowEmpty) return { done: undefined };
      const verdict = this.o.validate?.(this.value) ?? true;
      if (verdict !== true) {
        this.problem = verdict;
        return;
      }
      return { done: this.value };
    }
    if (key.name === 'left') {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (key.name === 'right') {
      this.cursor = Math.min(chars.length, this.cursor + 1);
      return;
    }
    if (key.name === 'home') {
      this.cursor = 0;
      return;
    }
    if (key.name === 'end') {
      this.cursor = chars.length;
      return;
    }
    if (key.name === 'backspace') {
      if (this.cursor > 0) set([...chars.slice(0, this.cursor - 1), ...chars.slice(this.cursor)], this.cursor - 1);
      return;
    }
    if (key.name === 'delete') {
      set([...chars.slice(0, this.cursor), ...chars.slice(this.cursor + 1)], this.cursor);
      return;
    }
    if (key.ctrl && key.name === 'u') {
      set([], 0);
      return;
    }
    if (key.text) {
      const accept = this.o.accept;
      // Line breaks and the bracketed-paste markers a terminal wraps around pasted text are not part of the text.
      const add = [...key.text.replace(/\x1b?\[20[01]~/g, '').replace(/[\r\n]/g, '')].filter((c) => !accept || accept.test(c));
      if (!add.length) return;
      set([...chars.slice(0, this.cursor), ...add, ...chars.slice(this.cursor)], this.cursor + add.length);
    }
    return;
  }

  private check(): void {
    const verdict = this.value === '' ? true : (this.o.validate?.(this.value) ?? true);
    this.problem = verdict === true ? undefined : verdict;
  }
}
