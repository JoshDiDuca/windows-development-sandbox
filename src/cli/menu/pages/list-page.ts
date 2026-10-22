// The common shape of a tab that is a list: it loads its data, builds a list screen from it, and acts on what the list
// returns. After every action the list is built again from fresh data, on the same entry. Opening a tab never makes
// the keys wait for a slow load: after a moment the tab shows "Loading…" (or the data it had), and the list is built
// when the data is there.
import {
  ListScreen,
  type App,
  type Category,
  type FrameParts,
  type Key,
  type ListOptions,
  type ListResult,
} from '../../tui/index.js';
import type { Size, Step } from '../../tui/index.js';
import type { Page, ShellExit } from '../shell.js';
import { errMsg } from '../../../core/util/index.js';
import { Theme } from '../../tui/index.js';

/** A tab whose data is not here after this long shows "Loading…" instead of holding up the keys. */
const QUICK_LOAD_MS = 120;

/** What a tab shows before its data has arrived. */
function loadingOptions<T>(): ListOptions<T> {
  return { path: [], items: [], empty: 'Loading…' };
}

/** What an action did: leave the shell, and/or what the rebuilt list shows. */
export interface Outcome<T> {
  readonly exit?: ShellExit;
  /** Keep the cursor on this entry (default: the one that was acted on). */
  readonly focus?: T;
  readonly notice?: string;
  /** Load the data again before rebuilding. */
  readonly reload?: boolean;
}

export abstract class ListPage<T> implements Page {
  abstract readonly label: string;
  readonly stages: boolean = false;
  private list: ListScreen<T> | undefined;
  private notice: string | undefined;
  /** The list has the keyboard (the menu's navigation does not). */
  private focused = true;
  /** The entry that was last acted on: the cursor returns to it when the section opens again. */
  private lastFocus: T | undefined;
  /** A search to start the next list with (restored from the last run); used once. */
  private pendingQuery: string | undefined;
  /** The data has arrived at least once (until then the list is "Loading…"). */
  private loaded = false;
  /** Counts loads, so that a slow one that was overtaken does not replace newer data. */
  private generation = 0;
  /** A category asked for before the data arrived: it opens when it does. */
  private wantedCategory: string | undefined;

  constructor(protected readonly app: App) {}

  /** Loads the data the list shows (called when the tab opens and after actions that change it). */
  protected abstract load(): Promise<void>;
  /** The list for the data loaded (pure: no I/O). */
  protected abstract options(): ListOptions<T>;
  /** The entry the cursor starts on the first time the section opens (default: the first). */
  protected initialFocus(): T | undefined {
    return undefined;
  }
  /** Does what the list returned. */
  protected abstract act(result: ListResult<T>): Promise<Outcome<T>>;

  /** The data has not arrived yet (the tab shows "Loading…"). */
  get loading(): boolean {
    return !this.loaded;
  }

  get capturing(): boolean {
    return this.list?.isSearching ?? false;
  }

  /** The id of the open category, if the list has any. */
  get category(): string | undefined {
    return this.list?.currentCategory;
  }

  /** The search typed in the list ('' when none). */
  get search(): string {
    return this.list?.searchText ?? '';
  }

  /** Shows the list with this search typed (the menu opens on the search it was left on). */
  restoreSearch(text: string): void {
    this.pendingQuery = text;
    if (this.loaded) this.rebuild(undefined);
  }

  categories(): readonly Category[] {
    return this.screen().categories;
  }

  async selectCategory(id: string): Promise<void> {
    if (!this.loaded) {
      this.wantedCategory = id;
      return;
    }
    this.screen().setCategory(id);
    await this.afterKey();
  }

  setFocus(list: boolean): void {
    this.focused = list;
    this.list?.setActive(list);
  }

  /** The list on screen, built when there is none yet. */
  private screen(): ListScreen<T> {
    return (this.list ??= this.build({}));
  }

  /** A list from the current data; its categories are shown by the menu's navigation. */
  private build(extra: Partial<ListOptions<T>>): ListScreen<T> {
    const startQuery = this.pendingQuery;
    this.pendingQuery = undefined;
    const list = new ListScreen<T>({
      ...(this.loaded ? this.options() : loadingOptions<T>()),
      startQuery,
      ...extra,
      categoryNav: 'external',
      escapeLabel: 'sections',
    });
    list.setActive(this.focused);
    return list;
  }

  /** The entries ticked in a multi-select list. */
  protected ticked(): T[] {
    return this.list?.ticked() ?? [];
  }

  /** Loads the data again; a slow load does not hold up the keys (the tab keeps what it showed, then updates). */
  async open(): Promise<void> {
    await this.reload(true);
  }

  /**
   * The section came on screen again: it shows what it had at once and loads the data again after that screen is
   * drawn (the list is rebuilt on the entry and search the user is on). The first time, it is open().
   */
  async show(): Promise<void> {
    if (!this.loaded) return this.open();
    const mine = ++this.generation;
    setImmediate(() => {
      if (mine !== this.generation) return;
      void this.loadData().then(() => {
        if (mine === this.generation) this.rebuildLate();
      });
    });
  }

  /**
   * Loads the data and waits for it at most QUICK_LOAD_MS. In time, the list is built here (`build`) or by the caller;
   * later, the list is built when the data arrives, on the entry and search the user has moved to meanwhile.
   */
  private async reload(build: boolean): Promise<void> {
    const mine = ++this.generation;
    let late = false;
    let timer: NodeJS.Timeout | undefined;
    const quick = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        late = true;
        resolve();
      }, QUICK_LOAD_MS);
    });
    const arrived = this.loadData().then(() => {
      if (mine !== this.generation) return;
      this.loaded = true;
      if (late) this.rebuildLate();
      else if (build) this.rebuildOpened();
    });
    await Promise.race([arrived, quick]);
    clearTimeout(timer);
  }

  private async loadData(): Promise<void> {
    try {
      // The first screen is drawn before the menu's facts (the process list) are known; loads wait for them.
      await this.app.ready;
      await this.load();
    } catch (e) {
      this.say(Theme.error(Theme.glyph.cross + ' ' + errMsg(e)));
    }
  }

  /** Back on the entry used last, when it is still in the category that is open. */
  private rebuildOpened(): void {
    this.rebuildOn(this.lastFocus ?? this.initialFocus());
    this.openWantedCategory();
  }

  /** Data that came after the keys stopped waiting: the cursor and the search stay where the user moved them. */
  private rebuildLate(): void {
    if (this.list) this.pendingQuery ??= this.list.searchText || undefined;
    this.rebuildOn(this.list?.current);
    this.openWantedCategory();
    this.app.requestRedraw();
  }

  private rebuildOn(wanted: T | undefined): void {
    const open = this.list?.currentCategory;
    const item = wanted === undefined ? undefined : this.options().items.find((i) => i.value === wanted);
    this.rebuild(item && (!open || !item.category || item.category === open) ? wanted : undefined);
  }

  private openWantedCategory(): void {
    if (!this.wantedCategory) return;
    this.list?.setCategory(this.wantedCategory);
    this.wantedCategory = undefined;
  }

  /** Builds the list again, on `focus` when it is still there. */
  protected rebuild(focus: T | undefined, notice?: string): void {
    const startCategory = this.list?.currentCategory;
    this.list = this.build({ startAt: focus, startCategory, notice: notice ?? this.notice });
    this.notice = undefined;
  }

  /** Shows `text` now, before slow work starts. */
  protected busy(text: string, focus?: T): void {
    this.rebuild(focus, text);
    this.app.redraw();
  }

  /** Shows a notice on the next draw. */
  protected say(text: string | undefined): void {
    this.notice = text;
  }

  render(size: Size): FrameParts {
    return this.screen().render(size);
  }

  async handle(key: Key): Promise<Step<ShellExit>> {
    const step = this.screen().handle(key);
    if (!step) return this.afterKey();
    const result = step.done;
    let outcome: Outcome<T>;
    try {
      outcome = result.kind === 'back' ? { exit: { kind: 'quit' } as ShellExit } : await this.act(result);
    } catch (e) {
      // Whatever an action does wrong, the menu stays: the problem is shown where the action was chosen.
      if (e instanceof Error && (e.name === 'ExitRequested' || e.name === 'ExitPromptError')) throw e;
      outcome = { notice: Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) };
    }
    if (outcome.exit) return { done: outcome.exit };
    // What the action changed (a stop, a restart) is known to the menu before the page loads again. An action that
    // loads nothing again changed nothing the menu shows, so the keys do not wait for it.
    if (outcome.reload) {
      await this.app.afterAction();
      await this.reload(false);
    }
    const here = result.kind === 'pick' || result.kind === 'action' ? result.value : undefined;
    this.lastFocus = outcome.focus ?? here ?? this.lastFocus;
    this.rebuild(outcome.focus ?? here, outcome.notice);
    return;
  }

  /** A key that did not finish the list was handled (the cursor moved, a search began ...). */
  protected afterKey(): Promise<Step<ShellExit>> | Step<ShellExit> {
    return;
  }
}
