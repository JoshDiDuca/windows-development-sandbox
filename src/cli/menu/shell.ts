// The menu's shell: the sections down the left (1-7, the open one shows its categories), one page per section, and the
// one rule for unsaved changes (Ctrl+S saves them all; leaving asks Save / Discard / Cancel). The keyboard is either in
// the list or in the navigation: Left or Esc in the list goes to the navigation, Right or Enter comes back. A page that
// needs the terminal (attach, a log, a start) ends the shell with what to run; the menu comes back afterwards.
import type { App, Category, FrameParts, Key, KeyHint, NavState, Screen, Size, Step } from '../tui/index.js';
import { Theme } from '../tui/index.js';
import type { Draft, DraftResult } from './settings/draft.js';

/** Why the shell closed. */
export type ShellExit =
  | { kind: 'quit' }
  /** Run a command line on the normal screen (attach, start, logs -f ...). */
  | { kind: 'run'; argv: string[] }
  /** Show the end of a log file on the normal screen. */
  | { kind: 'view'; file: string };

/** Where one section was left: its open category and its search. */
export interface ScreenView {
  readonly category?: string;
  readonly search?: string;
}

/** Which section the menu shows, and where each section was left (by section name). */
export interface MenuView {
  readonly section: number;
  readonly screens: Readonly<Record<string, ScreenView>>;
}

/** One section of the menu. */
export interface Page {
  readonly label: string;
  /** This page stages changes in the Draft (its section is marked while something is unsaved). */
  readonly stages: boolean;
  /** Typing goes into a search box: digits are text, not section numbers. */
  readonly capturing: boolean;
  /** The categories listed under the section while it is open (none: the section is one list). */
  categories(): readonly Category[];
  /** The id of the open category. */
  readonly category: string | undefined;
  /** The data is still loading: its categories are not known yet (a category asked for opens when they are). */
  readonly loading?: boolean;
  /** The search typed in the list ('' or missing: none). */
  readonly search?: string;
  /** Types a search into the list (the menu opens on the one it was left on). */
  restoreSearch?(text: string): void;
  /** Opens a category (the navigation moved onto it). */
  selectCategory(id: string): Promise<void>;
  /** Whether the list has the keyboard (its highlight is softer while the navigation has it). */
  setFocus(list: boolean): void;
  /** The section was opened (or the shell came back from a command): load what it shows again. */
  open(): Promise<void>;
  /** The section came on screen again: show what it had at once and load it again in the background (default open). */
  show?(): Promise<void>;
  render(size: Size): FrameParts;
  /** A `quit` from the page means "Esc with nothing left to close": the shell moves to the navigation. */
  handle(key: Key): Promise<Step<ShellExit>> | Step<ShellExit>;
}

/** The section names, in order. Number keys 1-7 open them. */
export const SECTION_LABELS = ['Agents', 'Sessions', 'Sandbox', 'Apps', 'Settings', 'Accounts', 'Maintenance'] as const;

const NAV_KEYS: KeyHint[] = [
  ['↑↓', 'move', 1],
  ['→', 'open', 1],
  ['1-7', 'jump', 4],
  ['/', 'search', 6],
  ['esc', 'quit', 0],
];

export class Shell implements Screen<ShellExit> {
  private active = 0;
  private focus: 'nav' | 'list' = 'list';
  private notice: string | undefined;
  /** Where each section was left, by name; a section takes its entry the first time it opens in this shell. */
  private readonly screens = new Map<string, ScreenView>();
  private readonly restored = new Set<number>();

  constructor(
    private readonly app: App,
    readonly pages: readonly Page[],
    readonly draft: Draft,
    /** Told after a save (the menu applies settings that act on this PC) and returns a note to add. */
    private readonly afterSave: (result: DraftResult) => string | undefined = () => undefined,
  ) {
    app.nav = () => this.nav();
  }

  get page(): Page {
    return this.pages[this.active];
  }

  /** Which pane has the keyboard. */
  get focused(): 'nav' | 'list' {
    return this.focus;
  }

  nav(): NavState {
    const unsaved = this.draft.count() > 0;
    const current = this.page.category;
    return {
      sections: this.pages.map((p, i) => ({
        label: p.label,
        marked: p.stages && unsaved,
        categories: i === this.active ? p.categories().map((c) => ({ label: c.label, current: c.id === current })) : [],
      })),
      active: this.active,
      focused: this.focus === 'nav',
    };
  }

  /** Notes where the open section is (its category and search). */
  private remember(): void {
    // A section that was never opened here keeps what the last run knew about it.
    if (!this.restored.has(this.active)) return;
    const { category, search } = this.page;
    if (category || search) this.screens.set(this.page.label, { category, search: search || undefined });
    else this.screens.delete(this.page.label);
  }

  /** The section that is open and where every section was left (the menu opens there again, also in a later run). */
  view(): MenuView {
    this.remember();
    return { section: this.active, screens: Object.fromEntries(this.screens) };
  }

  /** Opens the section a view names and puts each section back where it was (what is gone is ignored). */
  async restore(view: MenuView): Promise<void> {
    this.restored.clear();
    for (const [label, screen] of Object.entries(view.screens)) this.screens.set(label, screen);
    await this.openTab(view.section);
  }

  /** Opens a section by index (loads its data); the first time, it goes back to the category and search it had. */
  async openTab(index: number): Promise<void> {
    this.remember();
    this.active = Math.max(0, Math.min(this.pages.length - 1, index));
    this.page.setFocus(this.focus === 'list');
    await (this.page.show ?? this.page.open).call(this.page);
    if (this.restored.has(this.active)) return;
    this.restored.add(this.active);
    const wanted = this.screens.get(this.page.label);
    if (wanted?.category && (this.page.loading || this.page.categories().some((c) => c.id === wanted.category)))
      await this.page.selectCategory(wanted.category);
    if (wanted?.search) this.page.restoreSearch?.(wanted.search);
  }

  /** Puts the keyboard in the navigation or in the list. */
  setFocus(focus: 'nav' | 'list'): void {
    this.focus = focus;
    this.page.setFocus(focus === 'list');
  }

  /** Loads the open section again (after a command ran). */
  reload(): Promise<void> {
    return this.page.open();
  }

  render(size: Size): FrameParts {
    const parts = this.page.render(size);
    const unsaved = this.draft.count();
    const status = parts.status ?? this.app.status();
    const category = this.page.categories().find((c) => c.id === this.page.category);
    const keys = this.focus === 'nav' ? NAV_KEYS : parts.keys;
    return {
      ...parts,
      path: parts.path.length ? parts.path : [this.page.label, ...(category ? [category.label] : [])],
      status: unsaved ? Theme.changed('unsaved: ' + unsaved) + '   ' + status : status,
      notice: this.notice ?? parts.notice,
      keys: unsaved ? [['ctrl+s', 'save (' + unsaved + ')', 0], ...keys] : keys,
    };
  }

  /** Writes the staged changes; the notice says what happened. */
  save(): string {
    const result = this.draft.apply();
    if (result.problems.length) return Theme.error(Theme.glyph.cross + ' Not saved: ' + result.problems.join('; '));
    if (!result.saved) return Theme.muted('Nothing to save.');
    const extra = this.afterSave(result);
    const where = result.files.some((f) => f.isProject)
      ? ' The next launch asks you to approve the project file again.'
      : ' New sandboxes use it.';
    return (
      Theme.ok(Theme.glyph.ok + ' Saved ' + result.saved + ' change' + (result.saved === 1 ? '' : 's') + '.') +
      Theme.muted(where) +
      (extra ? ' ' + extra : '')
    );
  }

  async handle(key: Key): Promise<Step<ShellExit>> {
    this.notice = undefined;
    if (key.ctrl && key.name === 's') {
      this.notice = this.draft.count() ? this.save() : Theme.muted('Nothing to save.');
      await this.page.open();
      return;
    }
    if (!this.page.capturing && !key.ctrl && !key.meta && /^[1-7]$/.test(key.text)) {
      const index = Number(key.text) - 1;
      if (index < this.pages.length && index !== this.active) await this.openTab(index);
      return;
    }
    if (this.focus === 'nav') return this.navKey(key);
    const step = await this.page.handle(key);
    if (step && step.done.kind === 'quit') {
      // Esc (or Left) in the list: nothing left to close there, so go to the navigation.
      this.setFocus('nav');
      return;
    }
    return step;
  }

  /** A key while the navigation has the keyboard. */
  private async navKey(key: Key): Promise<Step<ShellExit>> {
    if (key.name === 'up' || key.name === 'down') {
      await this.move(key.name === 'up' ? -1 : 1);
      return;
    }
    if (key.name === 'right' || key.name === 'return') {
      this.setFocus('list');
      return;
    }
    if (key.name === 'escape') return this.leave();
    // The scopes of Settings and Apps switch from anywhere; "/" starts a search in the list.
    if (key.name === 'tab') return this.page.handle(key);
    if (key.text === '/') {
      this.setFocus('list');
      return this.page.handle(key);
    }
    return;
  }

  /** One stop up or down the tree: the categories of the open section, then the next section. */
  private async move(by: 1 | -1): Promise<void> {
    const categories = this.page.categories();
    const at = categories.findIndex((c) => c.id === this.page.category);
    const next = at + by;
    if (categories.length && next >= 0 && next < categories.length) {
      await this.page.selectCategory(categories[next].id);
      return;
    }
    const section = this.active + by;
    if (section < 0 || section >= this.pages.length) return;
    await this.openTab(section);
    const entered = this.page.categories();
    if (entered.length) await this.page.selectCategory(entered[by === 1 ? 0 : entered.length - 1].id);
  }

  /** Leaving with unsaved changes asks what to do with them. */
  private async leave(): Promise<Step<ShellExit>> {
    const count = this.draft.count();
    if (!count) return { done: { kind: 'quit' } };
    const answer = await this.app.dialog<'save' | 'discard' | 'cancel'>({
      title: 'Unsaved changes',
      lines: ['You have ' + count + ' unsaved change' + (count === 1 ? '' : 's') + ' in Settings and Apps.'],
      choices: [
        { value: 'save', label: 'Save', key: 's' },
        { value: 'discard', label: 'Discard', key: 'd', danger: true },
        { value: 'cancel', label: 'Cancel', key: 'c' },
      ],
      escape: 'cancel',
    });
    if (answer === 'cancel') return;
    if (answer === 'discard') {
      this.draft.discard();
      return { done: { kind: 'quit' } };
    }
    this.notice = this.save();
    if (this.draft.count()) return;
    return { done: { kind: 'quit' } };
  }
}
