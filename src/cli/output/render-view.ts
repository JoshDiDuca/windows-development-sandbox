// A view's Page as plain text for the command line: facts as aligned label/value rows, items as lines (or a table when
// the section has columns), titled sections after a blank line, notes dimmed. Actions are for the menu and the web.
import type { Item, Note, Page, Section, Tone } from '../../app/kernel/index.js';
import { pageHasContent } from '../../app/kernel/index.js';
import { safeText } from '../../core/util/index.js';
import { c } from './colors.js';
import { tableLines } from './print.js';

const PAINT: Readonly<Record<Tone, (text: string) => string>> = {
  ok: (t) => t,
  warn: c.yellow,
  danger: c.red,
  muted: c.dim,
  accent: (t) => t,
};

const forCli = (n: Note): boolean => n.only === undefined || n.only === 'cli';

function itemLine(item: Item): string {
  const label = item.tone ? PAINT[item.tone](item.label) : item.details?.length ? c.bold(item.label) : item.label;
  return (item.marked ? '* ' : '  ') + label + (item.hint ? '  ' + item.hint : '');
}

function sectionLines(section: Section): string[] {
  const items = section.items ?? [];
  const lines: string[] = [];
  if (section.title) lines.push(c.bold(section.title) + (section.summary ? '  ' + section.summary : ''));
  if (section.facts?.length) lines.push(...tableLines(section.facts.map((f) => [f.label, f.value])));
  if (section.text?.length) lines.push(...section.text);
  if (section.columns && items.length) {
    const columns = section.columns;
    lines.push(
      ...tableLines([
        columns.map((col) => col.label),
        ...items.map((i) => columns.map((col) => i.cells?.[col.key] ?? '')),
      ]),
    );
  } else
    for (const item of items) {
      lines.push(itemLine(item));
      for (const detail of item.details ?? []) lines.push('      ' + detail);
    }
  for (const note of (section.notes ?? []).filter(forCli))
    lines.push(note.tone ? PAINT[note.tone](note.text) : note.text);
  return lines;
}

/** The page as lines of text (text that came from the sandbox was made safe by the feature; this makes sure). */
export function pageLines(page: Page): string[] {
  const out: string[] = [];
  if (page.notice) out.push(c.bold(page.notice.text));
  if (!pageHasContent(page) && page.empty) {
    out.push(page.empty.cliText ?? page.empty.text);
    return out.map(safeText);
  }
  for (const section of page.sections) {
    const lines = sectionLines(section);
    if (!lines.length) continue;
    if (section.title && out.length) out.push('');
    out.push(...lines);
  }
  return out.map(safeText);
}

export function printPage(page: Page): void {
  for (const line of pageLines(page)) console.log(line);
}
