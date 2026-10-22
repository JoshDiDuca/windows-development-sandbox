// The menu as an application: screens are shown one at a time in the frame, each until it is done. Commands that print
// (or take over the terminal) run with the terminal handed back, and the next screen takes it again.
import { ConfirmScreen, type ConfirmOptions } from './dialogs/confirm-screen.js';
import { MessageScreen } from './dialogs/message-screen.js';
import { TextScreen, type TextOptions } from './dialogs/text-screen.js';
import { PathPickerScreen, type PathPickerOptions } from './dialogs/path-picker.js';
import { OverlayScreen, type OverlayOptions } from './dialogs/overlay.js';
import { Frame } from './frame.js';
import type { NavState } from './nav.js';
import { ListScreen } from './list/list-screen.js';
import { type ListOptions, type ListResult } from './list/list-types.js';
import { Terminal } from './terminal.js';
import { Theme } from './theme.js';
import type { Screen } from './screen.js';

/** Changes that arrive together (a resize, fresh facts) are drawn once, this long after the first. */
const REDRAW_DELAY_MS = 16;
/** While keys are waiting, the screen is still drawn at least this often. */
const MAX_STALE_MS = 100;

export class App {
  /** The status line for screens that do not set their own (read on every draw: it must not wait for anything). */
  status: () => string = () => '';
  /** Awaited after an action changed something, before the screen loads what it shows again. */
  afterAction: () => Promise<void> = () => Promise.resolve();
  /** Settles when the facts pages load from are known (the first screen is drawn without waiting for it). */
  ready: Promise<void> = Promise.resolve();
  /** Told about every key (after it was handled and drawn): someone is looking at the screen. */
  onKey: () => void = () => undefined;
  /** The navigation on the left of every screen (none: no navigation column). */
  nav: () => NavState | undefined = () => undefined;
  /** The screens being shown, innermost last: a dialog is drawn over the one below it. */
  private readonly shown: Screen<unknown>[] = [];
  private redrawNow: (() => void) | null = null;
  private redrawTimer: NodeJS.Timeout | undefined;

  constructor(readonly terminal: Terminal = new Terminal()) {
    terminal.onResized(() => this.requestRedraw());
  }

  /** Draws the screen on top again now (before a slow piece of work, so its notice is visible). */
  redraw(): void {
    this.redrawNow?.();
  }

  /** Draws it again soon: what happens between two keys (a resize, fresh facts) is drawn once, not once each. */
  requestRedraw(): void {
    if (this.redrawTimer) return;
    this.redrawTimer = setTimeout(() => {
      this.redrawTimer = undefined;
      if (this.terminal.running) this.redrawNow?.();
    }, REDRAW_DELAY_MS);
  }

  /** Shows `screen` until its handler says it is done, and returns what it returned. */
  async show<T>(screen: Screen<T>): Promise<T> {
    this.terminal.start();
    this.shown.push(screen);
    const outer = this.redrawNow;
    const draw = (): void => {
      const { width, height } = this.terminal;
      const nav = this.nav();
      // A screen over the menu (a dialog, an editor) leaves the navigation visible but grey.
      const covered = this.shown.length > 1;
      const parts = screen.render({ width: Frame.bodyWidth(width, nav), height: Frame.bodyHeight(height) });
      this.terminal.render(
        Frame.render(
          { ...parts, status: parts.status ?? this.status(), nav: nav && { ...nav, dimmed: nav.dimmed || covered } },
          width,
          height,
        ),
      );
    };
    this.redrawNow = draw;
    let drawnAt = 0;
    try {
      for (;;) {
        // Keys that are already waiting (a held arrow, a paste) are handled first: the screen shows the result of the
        // last one, but never stays stale for longer than MAX_STALE_MS.
        if (!this.terminal.hasKeys || Date.now() - drawnAt >= MAX_STALE_MS) {
          draw();
          drawnAt = Date.now();
        }
        const step = await screen.handle(await this.terminal.key());
        this.onKey();
        if (step) return step.done;
      }
    } finally {
      this.shown.pop();
      this.redrawNow = outer;
    }
  }

  /** A dialog over the screen below (Save / Discard / Cancel, Yes / No ...). */
  dialog<T>(o: OverlayOptions<T>): Promise<T> {
    const below = this.shown[this.shown.length - 1];
    return this.show(new OverlayScreen(below ?? { render: () => ({ path: [], body: [], keys: [] }) }, o));
  }

  /** Yes or no over the current screen; Esc is no. */
  ask(title: string, lines: readonly string[], yes = 'Yes', danger = false): Promise<boolean> {
    return this.dialog<boolean>({
      title,
      lines,
      choices: [
        { value: true, label: yes, key: 'y', danger },
        { value: false, label: 'Cancel', key: 'n' },
      ],
      initial: danger ? 1 : 0,
      escape: false,
    });
  }

  list<T>(o: ListOptions<T>): Promise<ListResult<T>> {
    return this.show(new ListScreen(o));
  }
  text(o: TextOptions): Promise<string | undefined> {
    return this.show(new TextScreen(o));
  }
  /** Choose a folder (or a file): the path on top, the folders to browse below. Undefined = cancelled. */
  pickPath(o: PathPickerOptions): Promise<string | undefined> {
    return this.show(new PathPickerScreen(o));
  }
  confirm(o: ConfirmOptions): Promise<boolean> {
    return this.show(new ConfirmScreen(o));
  }
  message(o: ConstructorParameters<typeof MessageScreen>[0]): Promise<void> {
    return this.show(new MessageScreen(o));
  }

  /** One of a few values (undefined = back). */
  async choose<T>(
    path: string[],
    intro: string,
    choices: { value: T; label: string; description?: string; hint?: string }[],
    current?: T,
  ): Promise<T | undefined> {
    const picked = await this.list({
      path,
      intro,
      items: choices.map((c) => ({
        ...c,
        icon: c.value === current ? Theme.ok(Theme.glyph.on) : Theme.muted(Theme.glyph.off),
      })),
      startAt: current,
    });
    return picked.kind === 'pick' ? picked.value : undefined;
  }

  /** Runs `work` on the normal screen (command output, interactive commands); the next show() takes the screen back. */
  async suspend<T>(work: () => Promise<T>): Promise<T> {
    this.terminal.stop();
    return work();
  }

  /** Leaves the alternate screen for good. */
  close(): void {
    this.terminal.stop();
  }
}
