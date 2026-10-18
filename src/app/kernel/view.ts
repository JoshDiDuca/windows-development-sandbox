// What a screen shows, as data: a view's build() turns query results into a Page, and each surface draws the Page its
// own way (the CLI as text, the menu as a list screen, the web with Mantine). One palette of tones, one set of shapes.
import type { z } from 'zod';
import type { OperationDef } from './define.js';
import type { Field } from './fields.js';

/** The one palette: the TUI theme and the web colours both map these. */
export type Tone = 'ok' | 'warn' | 'danger' | 'muted' | 'accent';

/** A short label the web shows as a pill next to an item ("running"); the menu and the CLI show the hint. */
export interface Badge {
  readonly text: string;
  readonly tone?: Tone;
}

/** Where a link goes. Each surface maps a target to what it can do (attach / terminal page / a command to type). */
export type Target =
  /** A running session's terminal: the menu attaches, the web opens its terminal page. */
  | { readonly kind: 'terminal'; readonly session: string }
  /** Start an agent: the menu runs `launch`, the web runs agents.start and opens the session's terminal. */
  | { readonly kind: 'start-agent'; readonly agent: string }
  /** A command line of an area that is not a feature yet: the menu runs it, the web does not offer it. */
  | { readonly kind: 'command'; readonly argv: readonly string[] }
  /** Another view. */
  | { readonly kind: 'view'; readonly view: string; readonly params?: Readonly<Record<string, string>> };

interface ActionBase {
  /** The words on a button or a row ("Stop the sandbox…"). */
  readonly label: string;
  /** One word for a key bar or an Enter hint ("stop"). */
  readonly verb?: string;
  /** The menu key that does it (one letter). */
  readonly key?: string;
  /** How long it survives in a narrow key bar: 0 never goes, bigger goes earlier (menu). */
  readonly importance?: number;
  readonly description?: string;
}

/** Runs an operation with this input (plus the answers to `fields`, asked first). */
export interface OperationAction extends ActionBase {
  readonly kind: 'operation';
  readonly op: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** Asks for a confirmation before running (from the operation's `danger`). */
  readonly danger?: boolean;
  /** Values to ask for before running; each answer goes into the input under the field's name. */
  readonly fields?: readonly Field[];
  /** What `fields` start as (the current value of a setting), by field name. */
  readonly initial?: Readonly<Record<string, unknown>>;
  /** Its one field can be changed in place (the web shows the control in the row; the menu opens its editor). */
  readonly inline?: boolean;
}

export interface LinkAction extends ActionBase {
  readonly kind: 'link';
  readonly target: Target;
}

export type Action = OperationAction | LinkAction;

/** One label: value line (a status fact, a setting). */
export interface Fact {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly tone?: Tone;
  readonly description?: string;
  readonly details?: readonly string[];
  /** How full something is (memory used of total): a bar on the web, the value text elsewhere. */
  readonly meter?: { readonly value: number; readonly max: number };
}

/** A column of a section shown as a table (CLI table, web table); items fill it through `cells`. */
export interface Column {
  readonly key: string;
  readonly label: string;
}

/** One entry of a list. */
export interface Item {
  readonly id: string;
  readonly label: string;
  /** The right-hand text (a state, a value). */
  readonly hint?: string;
  /** Its name in files and commands (a setting's key), shown small in monospace on the web. */
  readonly code?: string;
  readonly tone?: Tone;
  readonly badges?: readonly Badge[];
  readonly description?: string;
  /** Words about the menu's keys ("x deletes it."): the menu shows them after the description; the web does not. */
  readonly keys?: string;
  /** Extra lines (the menu's details pane, the CLI's indented lines, the web's card body). */
  readonly details?: readonly string[];
  /** A heading inside the section ("This folder's project"). */
  readonly group?: string;
  /** Marked as "the one this is about" (the project of this folder): `*` in the CLI. */
  readonly marked?: boolean;
  /** The values for the section's columns. */
  readonly cells?: Readonly<Record<string, string>>;
  /** What Enter / a click does. */
  readonly primary?: Action;
  readonly actions?: readonly Action[];
  /** Why it cannot be used now. */
  readonly disabled?: string;
  /** What picture fits it: an agent's name (claude), or project, folder, database, session. Only the web shows it. */
  readonly icon?: string;
  /** More words a search finds it by. */
  readonly keywords?: string;
}

/** A line under a section; `only` limits it to one surface (a CLI flag hint). */
export interface Note {
  readonly text: string;
  readonly tone?: Tone;
  readonly only?: 'cli' | 'menu' | 'web';
}

export interface Section {
  readonly id: string;
  readonly title?: string;
  /** A short line next to the title ("2 folders guarded"). */
  readonly summary?: string;
  readonly description?: string;
  readonly facts?: readonly Fact[];
  readonly items?: readonly Item[];
  /** Show the items as a table with these columns where a surface can (CLI, web). */
  readonly columns?: readonly Column[];
  /** Where `columns` is used: everywhere (default), or only on the command line (the web lists the items in full). */
  readonly columnsOn?: 'all' | 'cli';
  /** The items are things to pick from (sessions, agents): the web shows them as cards rather than rows. */
  readonly cards?: boolean;
  readonly actions?: readonly Action[];
  readonly notes?: readonly Note[];
  /** Preformatted lines (a log): monospace, shown as they are. */
  readonly text?: readonly string[];
}

/** What a page shows when it has nothing: the text and the next step (the CLI prints `cliText`, naming a command). */
export interface Empty {
  readonly title?: string;
  readonly text: string;
  readonly action?: Action;
  readonly cliText?: string;
}

export interface Page {
  readonly title: string;
  /** One line above everything (whose sandbox this is). */
  readonly notice?: Note;
  readonly sections: readonly Section[];
  /** Actions for the whole page (refresh-like, start). */
  readonly actions?: readonly Action[];
  /** Shown instead of the sections when they have no facts and no items. */
  readonly empty?: Empty;
  /**
   * The sections are categories of one long list (settings): the web shows one at a time beside a list of them, with
   * a search over all; the menu and the CLI show them as they always do.
   */
  readonly categories?: boolean;
}

/** An action that runs `def` with `input` (typed from its input schema; `fields` may ask for the rest). */
export function action<I extends z.ZodType, O extends z.ZodType>(
  def: OperationDef<I, O>,
  input: Partial<z.input<I>>,
  extra: Partial<Omit<OperationAction, 'kind' | 'op' | 'input'>> = {},
): OperationAction {
  return {
    kind: 'operation',
    op: def.id,
    input: input as Readonly<Record<string, unknown>>,
    label: def.title,
    ...(def.danger ? { danger: true } : {}),
    ...extra,
  };
}

/** An action that goes somewhere. */
export function link(
  target: Target,
  label: string,
  extra: Partial<Omit<LinkAction, 'kind' | 'target'>> = {},
): LinkAction {
  return { kind: 'link', target, label, ...extra };
}

/** Does the page show anything besides its empty state? */
export function pageHasContent(page: Page): boolean {
  return page.sections.some(
    (s) => (s.facts?.length ?? 0) > 0 || (s.items?.length ?? 0) > 0 || (s.text?.length ?? 0) > 0,
  );
}

/** Every action a page offers, wherever it sits (for parity checks and key bars). */
export function pageActions(page: Page): Action[] {
  const fromItem = (i: Item): Action[] => [...(i.primary ? [i.primary] : []), ...(i.actions ?? [])];
  return [
    ...(page.actions ?? []),
    ...(page.empty?.action ? [page.empty.action] : []),
    ...page.sections.flatMap((s) => [...(s.actions ?? []), ...(s.items ?? []).flatMap(fromItem)]),
  ];
}
