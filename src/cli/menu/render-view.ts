// A view's Page as the menu's list: facts and items become rows (under their section or group), section actions become
// rows of their own, the empty state becomes the row that offers the next step, and every action with a key goes in
// the key bar. resolve() turns what the list returned back into the page's action, so a menu page only runs it.
import type { Action, Page, Tone } from '../../app/kernel/index.js';
import { pageHasContent } from '../../app/kernel/index.js';
import { safeText } from '../../core/util/index.js';
import { Theme, type ListAction, type ListItem, type ListResult } from '../tui/index.js';

/** The row that stands for the empty state. */
export const EMPTY_ROW = '@empty';
const FACT = 'fact:';
const ACTION = 'action:';
const REFRESH_KEY = 'l';

const PAINT: Readonly<Record<Tone, (text: string) => string>> = {
  ok: Theme.ok,
  warn: Theme.warn,
  danger: Theme.error,
  muted: Theme.muted,
  accent: Theme.accent,
};

const paint = (text: string | undefined, tone: Tone | undefined): string | undefined =>
  text === undefined ? undefined : tone ? PAINT[tone](safeText(text)) : safeText(text);

/** What the list returned, as the page means it. */
export type Chosen = { readonly kind: 'refresh' } | { readonly kind: 'action'; readonly action: Action };

export interface MenuView {
  readonly items: ListItem<string>[];
  readonly actions: ListAction<string>[];
  /** What Enter does on a row ("" = it only shows information). */
  enterLabel(category: string | undefined, id: string | undefined): string;
  resolve(result: ListResult<string>): Chosen | undefined;
}

export interface MenuViewOptions {
  /** Every row goes in this category (a view that is one category of a page). */
  readonly category?: string;
  /** Put before every row's value, so the rows cannot clash with the page's own rows. */
  readonly prefix?: string;
  /** Offer l to load the data again (default: yes). */
  readonly refresh?: boolean;
}

/** The menu's rows, keys and Enter labels for a page. */
export function menuView(page: Page, o: MenuViewOptions = {}): MenuView {
  const category = o.category ? { category: o.category } : {};
  const prefix = o.prefix ?? '';
  const items: ListItem<string>[] = [];
  /** The action Enter runs, by row. */
  const enter = new Map<string, Action>();
  /** Key actions that apply to one row, by row. */
  const keyed = new Map<string, Action[]>();
  /** Key actions that apply everywhere. */
  const everywhere: Action[] = [...(page.actions ?? [])];

  if (!pageHasContent(page) && page.empty) {
    const e = page.empty;
    items.push({
      value: prefix + EMPTY_ROW,
      label: e.action?.label ?? e.text,
      section: e.title,
      description: e.text,
      ...category,
    });
    if (e.action) enter.set(prefix + EMPTY_ROW, e.action);
  }
  // Section.text (a log's lines) is not a row: the menu shows a log on the normal screen (menu.ts view), not here.
  for (const section of page.sections) {
    const heading = section.title ?? page.title;
    for (const f of section.facts ?? [])
      items.push({
        value: prefix + FACT + f.id,
        label: f.label,
        hint: paint(f.value, f.tone),
        description: f.description,
        details: f.details?.map(safeText),
        section: heading,
        ...category,
      });
    for (const item of section.items ?? []) {
      const id = prefix + item.id;
      items.push({
        value: id,
        label: safeText(item.label),
        hint: paint(item.hint, item.tone),
        description: [item.description, item.keys].filter(Boolean).join(' ') || undefined,
        details: item.details?.map(safeText),
        section: item.group ?? heading,
        keywords: item.keywords,
        ...(item.disabled ? { disabled: item.disabled } : {}),
        ...category,
      });
      if (item.primary && !item.disabled) enter.set(id, item.primary);
      if (item.actions?.length) keyed.set(id, [...item.actions]);
    }
    (section.actions ?? []).forEach((a, i) => {
      const id = prefix + ACTION + section.id + ':' + i;
      items.push({ value: id, label: a.label, hint: '', description: a.description, section: 'Actions', ...category });
      enter.set(id, a);
      everywhere.push(a);
    });
  }

  const keys: ListAction<string>[] = [];
  const addKey = (a: Action, applies?: (id: string) => boolean): void => {
    if (!a.key || keys.some((k) => k.key === a.key && k.label === (a.verb ?? a.label))) return;
    keys.push({ key: a.key, label: a.verb ?? a.label, importance: a.importance ?? 2, ...(applies ? { applies } : {}) });
  };
  for (const a of everywhere) addKey(a);
  for (const list of keyed.values())
    for (const a of list) addKey(a, (row) => keyed.get(row)?.some((x) => x.key === a.key) ?? false);
  if (o.refresh !== false) keys.push({ key: REFRESH_KEY, label: 'refresh', importance: 3 });

  return {
    items,
    actions: keys,
    enterLabel: (_category, id) => {
      const a = id === undefined ? undefined : enter.get(id);
      return a ? (a.verb ?? a.label.toLowerCase()) : '';
    },
    resolve: (result) => {
      if (result.kind === 'pick') {
        const a = enter.get(result.value);
        return a ? { kind: 'action', action: a } : undefined;
      }
      if (result.kind !== 'action') return undefined;
      if (result.key === REFRESH_KEY && o.refresh !== false) return { kind: 'refresh' };
      const own = result.value === undefined ? undefined : keyed.get(result.value)?.find((a) => a.key === result.key);
      const shared = everywhere.find((a) => a.key === result.key);
      const a = own ?? shared;
      return a ? { kind: 'action', action: a } : undefined;
    },
  };
}
