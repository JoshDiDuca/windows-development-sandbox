// A view's Page drawn for the web, the same Page the menu and the CLI show: a header with the page's actions, the
// notice, each section as a card (facts as tiles, items as rows, cards or a table, notes, actions), the empty state with
// its next step, and a search box on long pages. Pages whose sections are categories (settings) go to CategoryPage.
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Code,
  Collapse,
  Group,
  Progress,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconAlertTriangle, IconChevronDown, IconChevronRight, IconInfoCircle, IconSearch } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  pageHasContent,
  type Action,
  type Fact,
  type Item,
  type Note,
  type Page,
  type Section,
} from '../../../src/app/kernel/index';
import { ActionButton, ActionIconButton, ActionMenu, offered, useAct } from './actions';
import { CategoryPage, type CategoryExtra } from './CategoryPage';
import { ItemIcon } from './icons';
import { InlineField } from './InlineField';
import { EmptyState } from './states';
import { toneColor } from './tones';

/** Pages with more items than this get a search box. */
const SEARCH_FROM = 12;
/** Details shown before "more". */
const DETAILS_SHOWN = 3;

/** "claude  api" (columns in a terminal) as "claude · api". */
export function tidy(text: string): string {
  return text.replace(/ +-> +/g, ' → ').replace(/\s{2,}/g, ' · ');
}

/**
 * Does the item's hint add anything? The menu shows states as a hint ("in the sandbox · default"); the web shows them
 * as badges, so a hint made only of the badges' words is left out.
 */
export function hintShown(item: Item): boolean {
  if (!item.hint) return false;
  const badges = new Set((item.badges ?? []).map((b) => b.text.toLowerCase()));
  if (!badges.size) return true;
  return !tidy(item.hint)
    .split(' · ')
    .every((part) => badges.has(part.trim().toLowerCase()));
}

/** The action a page leads with: starting something, else none. */
function isLead(action: Action): boolean {
  return action.kind === 'link' && action.target.kind === 'start-agent';
}

interface PageHeaderProps {
  readonly title: string;
  readonly summary?: string;
  readonly toolbar?: ReactNode;
  readonly actions?: readonly Action[];
}

export function PageHeader({ title, summary, toolbar, actions = [] }: PageHeaderProps) {
  const shown = actions.filter(offered);
  return (
    <Group justify="space-between" align="flex-start" gap="md" wrap="wrap">
      <Stack gap={4} style={{ minWidth: 0 }}>
        <Title order={1}>{title}</Title>
        {summary && (
          <Text c="dimmed" size="sm">
            {summary}
          </Text>
        )}
      </Stack>
      <Group gap="xs">
        {toolbar}
        {shown.map((a, i) => (
          <ActionButton key={i} action={a} primary={isLead(a)} />
        ))}
      </Group>
    </Group>
  );
}

export function NoticeBar({ note }: { readonly note: Note }) {
  return (
    <Alert
      color={toneColor(note.tone) ?? 'gray'}
      variant="light"
      p="sm"
      radius="md"
      icon={<IconInfoCircle size={18} />}
      styles={{ message: { fontSize: 'var(--mantine-font-size-sm)' } }}
    >
      {note.text}
    </Alert>
  );
}

function FactTile({ fact }: { readonly fact: Fact }) {
  const color = toneColor(fact.tone);
  return (
    <div className="fact-tile" title={fact.description}>
      <Text size="xs" c="dimmed" fw={600} tt="uppercase" lts={0.3}>
        {fact.label}
      </Text>
      <Group gap={6} wrap="nowrap" mt={4}>
        {color && <span className="status-dot" style={{ ['--dot' as string]: `var(--mantine-color-${color}-6)` }} />}
        <Text size="sm" fw={600} style={{ wordBreak: 'break-word' }}>
          {fact.value}
        </Text>
      </Group>
      {fact.meter && (
        <Progress
          mt={8}
          size="sm"
          radius="xl"
          value={Math.min(100, (fact.meter.value / Math.max(1, fact.meter.max)) * 100)}
          color={color ?? 'indigo'}
        />
      )}
      {fact.details?.map((d, i) => (
        <Text key={i} size="xs" c="dimmed" mt={2}>
          {d}
        </Text>
      ))}
    </div>
  );
}

export function Facts({ facts }: { readonly facts: readonly Fact[] }) {
  return (
    <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} spacing="sm" verticalSpacing="sm">
      {facts.map((f) => (
        <FactTile key={f.id} fact={f} />
      ))}
    </SimpleGrid>
  );
}

/** Two texts say the same thing (case and surrounding spaces ignored). */
function same(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** An item's description and details as the web shows them: lines that repeat the hint are left out. */
export function linesShown(item: Item): { readonly description?: string; readonly details: readonly string[] } {
  return {
    description: item.description && !same(item.description, item.hint) ? item.description : undefined,
    details: (item.details ?? []).filter((d) => !same(d, item.hint) && !same(d, item.description)),
  };
}

/** "Label: value" (or "Label   value", as the cards write it) with a short capitalised label. */
const KEY_COLON = /^([A-Z][A-Za-z ]{1,24}):\s+(.+)$/;
const KEY_GAP = /^([A-Z][A-Za-z]*(?: [A-Za-z]+){0,3}) {2,}(.+)$/;
/** A value that is a path or a command is shown in monospace. */
const CODE_VALUE = /[\\/]|^(sandbox|npm) /;

export function splitDetail(line: string): { readonly label: string; readonly value: string } | undefined {
  const m = KEY_COLON.exec(line) ?? KEY_GAP.exec(line);
  if (!m) return undefined;
  return { label: m[1].trim(), value: m[2].trim() };
}

/** One detail line: a label in dimmed text and the value beside it (under it on a phone), or the plain line. */
function DetailLine({ line }: { readonly line: string }) {
  const kv = splitDetail(line);
  if (!kv)
    return (
      <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
        {line}
      </Text>
    );
  return (
    <Group gap={8} wrap="wrap" align="flex-start" mt={2}>
      <Text size="xs" c="dimmed" miw={110} style={{ flex: 'none' }}>
        {kv.label}
      </Text>
      <Text
        size="xs"
        ff={CODE_VALUE.test(kv.value) ? 'monospace' : undefined}
        style={{ flex: '1 1 120px', minWidth: 0, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}
      >
        {kv.value}
      </Text>
    </Group>
  );
}

/** An item's extra lines: the first few, the rest behind "more". */
export function Details({ lines }: { readonly lines: readonly string[] }) {
  const [open, setOpen] = useState(false);
  if (!lines.length) return null;
  const head = lines.slice(0, DETAILS_SHOWN);
  const rest = lines.slice(DETAILS_SHOWN);
  const line = (d: string, i: number): ReactNode => <DetailLine key={i} line={d} />;
  return (
    <Box mt={4}>
      {head.map(line)}
      {rest.length > 0 && (
        <>
          <Collapse in={open}>{rest.map((d, i) => line(d, i + DETAILS_SHOWN))}</Collapse>
          <UnstyledButton onClick={() => setOpen(!open)} mt={2}>
            <Group gap={2}>
              {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
              <Text size="xs" c="indigo">
                {open ? 'Less' : rest.length + ' more'}
              </Text>
            </Group>
          </UnstyledButton>
        </>
      )}
    </Box>
  );
}

export function Badges({ item }: { readonly item: Item }) {
  return (
    <>
      {item.badges?.map((b) => (
        <Badge key={b.text} size="sm" color={toneColor(b.tone) ?? 'gray'}>
          {b.text}
        </Badge>
      ))}
    </>
  );
}

/** An item's status as a coloured dot before its label (muted items keep a dimmed label instead). */
function ToneDot({ tone }: { readonly tone: Item['tone'] }) {
  const color = tone && tone !== 'muted' ? toneColor(tone) : undefined;
  if (!color) return null;
  return (
    <span
      className="status-dot"
      aria-hidden="true"
      style={{ ['--dot' as string]: `var(--mantine-color-${color}-6)` }}
    />
  );
}

/** The item's main action when the web can do it and the item is usable. */
function primaryOf(item: Item): Action | undefined {
  return offered(item.primary) && !item.disabled ? item.primary : undefined;
}

/** An item's main action: its control in place when it changes one value (a switch, a choice), else a button. */
function PrimaryControl({
  action,
  hint,
  light,
}: {
  readonly action: Action;
  readonly hint?: string;
  readonly light?: boolean;
}) {
  if (action.kind === 'operation' && action.inline)
    return (
      <Box miw={160} maw={300} onClick={(e) => e.stopPropagation()}>
        <InlineField action={action} summary={hint} />
      </Box>
    );
  return <ActionButton action={action} size="xs" variant={light ? 'light' : 'default'} />;
}

/** Two actions that do the same thing (the same operation and input, or the same place). */
function sameAction(a: Action, b: Action): boolean {
  if (a.kind === 'operation' && b.kind === 'operation')
    return a.op === b.op && JSON.stringify(a.input) === JSON.stringify(b.input);
  if (a.kind === 'link' && b.kind === 'link') return JSON.stringify(a.target) === JSON.stringify(b.target);
  return false;
}

/** An item's other actions, without the one its main button already does. */
function othersThan(actions: readonly Action[] | undefined, primary: Action | undefined): Action[] {
  return (actions ?? []).filter((a) => !primary || !sameAction(a, primary));
}

/** Secondary actions: one or two as icon buttons, more behind "…". */
export function SecondaryActions({ actions }: { readonly actions: readonly Action[] }) {
  const shown = actions.filter(offered);
  if (shown.length > 2) return <ActionMenu actions={shown} />;
  return (
    <>
      {shown.map((a, i) => (
        <ActionIconButton key={i} action={a} />
      ))}
    </>
  );
}

function ItemRow({ item }: { readonly item: Item }) {
  const act = useAct();
  const primary = primaryOf(item);
  const clickable = primary?.kind === 'link';
  const { description, details } = linesShown(item);
  return (
    <div
      className={'item-row' + (clickable ? ' clickable' : '')}
      tabIndex={clickable ? 0 : undefined}
      role={clickable ? 'button' : undefined}
      onClick={clickable ? () => void act(primary) : undefined}
      onKeyDown={clickable ? (e) => e.key === 'Enter' && void act(primary) : undefined}
      style={item.disabled ? { opacity: 0.65 } : undefined}
    >
      <Group justify="space-between" wrap="wrap" align="center" gap="md">
        <Group gap="sm" wrap="nowrap" align="flex-start" style={{ minWidth: 0, flex: '1 1 240px' }}>
          {item.icon && <ItemIcon name={item.icon} size={34} />}
          <Box style={{ minWidth: 0 }}>
            <Group gap={8} wrap="wrap">
              {item.tone !== 'muted' && <ToneDot tone={item.tone} />}
              <Text fw={600} size="sm" c={item.tone === 'muted' ? toneColor(item.tone) : undefined}>
                {tidy(item.label)}
              </Text>
              {item.marked && (
                <Badge size="xs" variant="dot" color="indigo">
                  this folder
                </Badge>
              )}
              <Badges item={item} />
            </Group>
            {hintShown(item) && (
              <Text size="sm" c="dimmed" style={{ wordBreak: 'break-word' }}>
                {tidy(item.hint ?? '')}
              </Text>
            )}
            {description && (
              <Text size="xs" c="dimmed" mt={2}>
                {description}
              </Text>
            )}
            <Details lines={details} />
            {item.disabled && (
              <Text size="xs" c="dimmed" fs="italic" mt={2}>
                {item.disabled}
              </Text>
            )}
          </Box>
        </Group>
        <Group gap={6} wrap="nowrap" className="row-actions" style={{ flex: 'none' }}>
          <SecondaryActions actions={othersThan(item.actions, primary)} />
          {primary && <PrimaryControl action={primary} hint={item.hint} light={clickable} />}
        </Group>
      </Group>
    </div>
  );
}

/**
 * An item that only does something ("Save this PC's login..."): no state, no details, no icon. Its description (what
 * the action does) is kept as the card's tooltip rather than shown.
 */
function isAddItem(item: Item): boolean {
  return !!primaryOf(item) && !item.hint && !item.details?.length && !item.badges?.length && !item.marked && !item.icon;
}

function ItemCard({ item }: { readonly item: Item }) {
  const act = useAct();
  const primary = primaryOf(item);
  const clickable = primary?.kind === 'link';
  if (primary && isAddItem(item))
    return (
      <Card
        padding="md"
        title={item.description}
        style={{ alignSelf: 'start', borderStyle: 'dashed', background: 'transparent' }}
      >
        <Group justify="center" gap={6}>
          <SecondaryActions actions={othersThan(item.actions, primary)} />
          <PrimaryControl action={primary} light />
        </Group>
      </Card>
    );
  const { details } = linesShown(item);
  return (
    <Card
      className={'item-card' + (clickable ? ' clickable' : '')}
      padding="md"
      onClick={clickable ? () => void act(primary) : undefined}
      style={item.disabled ? { opacity: 0.7 } : undefined}
    >
      <Stack gap="sm" h="100%">
        <Group gap="sm" wrap="nowrap" align="flex-start">
          {item.icon && <ItemIcon name={item.icon} />}
          <Box style={{ minWidth: 0, flex: 1 }}>
            <Text fw={650} size="sm" style={{ overflowWrap: 'anywhere' }}>
              {tidy(item.label)}
            </Text>
            {(item.marked || !!item.badges?.length) && (
              <Group gap={4} mt={4} wrap="wrap">
                {item.marked && (
                  <Badge size="sm" variant="dot" color="indigo">
                    this folder
                  </Badge>
                )}
                <Badges item={item} />
              </Group>
            )}
            {hintShown(item) && (
              <Text size="xs" c="dimmed" truncate mt={4}>
                {tidy(item.hint ?? '')}
              </Text>
            )}
          </Box>
        </Group>
        <Details lines={details} />
        {item.disabled && (
          <Text size="xs" c="dimmed" fs="italic">
            {item.disabled}
          </Text>
        )}
        {(primary || item.actions?.length) && (
          <Group justify="flex-end" gap={6} mt="auto">
            <SecondaryActions actions={othersThan(item.actions, primary)} />
            {primary && <PrimaryControl action={primary} hint={item.hint} light />}
          </Group>
        )}
      </Stack>
    </Card>
  );
}

function ItemsTable({ section }: { readonly section: Section }) {
  const columns = section.columns ?? [];
  return (
    <Table.ScrollContainer minWidth={560}>
      <Table highlightOnHover verticalSpacing={8} horizontalSpacing="md" fz="sm">
        <Table.Thead>
          <Table.Tr>
            {columns.map((c) => (
              <Table.Th key={c.key} fz="xs" c="dimmed" tt="uppercase">
                {c.label}
              </Table.Th>
            ))}
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(section.items ?? []).map((item) => {
            const primary = primaryOf(item);
            return (
              <Table.Tr key={item.id} style={item.disabled ? { opacity: 0.6 } : undefined}>
                {columns.map((c) => (
                  <Table.Td key={c.key}>{item.cells?.[c.key] ?? ''}</Table.Td>
                ))}
                <Table.Td ta="right">{primary && <ActionButton action={primary} size="compact-xs" />}</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** Items in a card, under their group headings ("This folder's project"). */
export function ItemList({
  items,
  render = (i) => <ItemRow key={i.id} item={i} />,
}: {
  readonly items: readonly Item[];
  readonly render?: (item: Item) => ReactNode;
}) {
  const out: ReactNode[] = [];
  let group: string | undefined;
  for (const item of items) {
    if (item.group && item.group !== group)
      out.push(
        <div key={'g:' + item.group} className="group-heading">
          {item.group}
        </div>,
      );
    group = item.group;
    out.push(render(item));
  }
  return <>{out}</>;
}

function SectionHeader({ section }: { readonly section: Section }) {
  const actions = (section.actions ?? []).filter(offered);
  if (!section.title && !section.summary && !actions.length) return null;
  return (
    <Group justify="space-between" align="flex-end" gap="sm">
      <Box style={{ minWidth: 0 }}>
        {section.title && <Title order={3}>{section.title}</Title>}
        {section.summary && (
          <Text size="sm" c="dimmed">
            {section.summary}
          </Text>
        )}
      </Box>
      {actions.length > 0 && (
        <Group gap="xs">
          {actions.map((a, i) => (
            <ActionButton key={i} action={a} primary={isLead(a)} size="xs" />
          ))}
        </Group>
      )}
    </Group>
  );
}

function SectionNotes({ notes }: { readonly notes: readonly Note[] }) {
  // Marked items carry a "this folder" badge here, so the "* = …" legend of the text surfaces is left out.
  const shown = notes.filter((n) => (n.only === undefined || n.only === 'web') && !n.text.startsWith('* ='));
  if (!shown.length) return null;
  // Warnings are read together in one box (the worst tone colours it); other notes stay quiet lines under the card.
  const warnings = shown.filter((n) => n.tone === 'warn' || n.tone === 'danger');
  const quiet = shown.filter((n) => !warnings.includes(n));
  return (
    <Stack gap="xs">
      {warnings.length > 0 && (
        <Alert
          color={warnings.some((n) => n.tone === 'danger') ? 'red' : 'yellow'}
          variant="light"
          radius="md"
          p="sm"
          icon={<IconAlertTriangle size={18} />}
        >
          <Stack gap={4}>
            {warnings.map((n, i) => (
              <Text key={i} size="sm">
                {n.text}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
      {quiet.length > 0 && (
        <Stack gap={2}>
          {quiet.map((n, i) => (
            <Text key={i} size="xs" c={toneColor(n.tone) ?? 'dimmed'}>
              {n.text}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/** Preformatted lines (a log): a monospace box of its own height that keeps its end in view as the lines grow. */
function TextBlock({ lines }: { readonly lines: readonly string[] }) {
  const viewport = useRef<HTMLDivElement>(null);
  const joined = lines.join('\n');
  useEffect(() => {
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [joined]);
  return (
    <Card>
      <ScrollArea h={400} viewportRef={viewport} type="auto">
        <Code block>{joined}</Code>
      </ScrollArea>
    </Card>
  );
}

export function SectionBlock({ section }: { readonly section: Section }) {
  const items = section.items ?? [];
  const facts = section.facts ?? [];
  const actions = (section.actions ?? []).filter(offered);
  const text = section.text ?? [];
  if (!facts.length && !items.length && !actions.length && !section.summary && !text.length) return null;
  const table = section.columns && section.columnsOn !== 'cli';
  return (
    <Stack gap="sm">
      <SectionHeader section={section} />
      {section.description && (
        <Text size="sm" c="dimmed" mt={-4}>
          {section.description}
        </Text>
      )}
      {facts.length > 0 && (
        <Card>
          <Facts facts={facts} />
        </Card>
      )}
      {text.length > 0 && <TextBlock lines={text} />}
      {items.length > 0 &&
        (section.cards ? (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
            {items.map((i) => (
              <ItemCard key={i.id} item={i} />
            ))}
          </SimpleGrid>
        ) : (
          <Card className="list-card">{table ? <ItemsTable section={section} /> : <ItemList items={items} />}</Card>
        ))}
      <SectionNotes notes={section.notes ?? []} />
    </Stack>
  );
}

/** The page with only the items whose words contain `text` (sections without a match are left out). */
export function filtered(page: Page, text: string): Page {
  const words = text.trim().toLowerCase();
  if (!words) return page;
  const hit = (i: Item): boolean =>
    [i.label, i.hint, i.description, i.keywords, i.group, i.code].some((w) => w?.toLowerCase().includes(words));
  return {
    ...page,
    sections: page.sections
      .map((s) => ({ ...s, facts: [], actions: [], items: (s.items ?? []).filter(hit) }))
      .filter((s) => s.items.length > 0 || (s.text?.length ?? 0) > 0),
  };
}

interface PageViewProps {
  readonly page: Page;
  /** The view's one line under the title. */
  readonly summary?: string;
  /** Controls beside the page's actions (a view's tabs). */
  readonly toolbar?: ReactNode;
  /** More categories for a page with categories (other views drawn in its place: Settings > VPN). */
  readonly extras?: readonly CategoryExtra[];
}

export function PageView({ page, summary, toolbar, extras }: PageViewProps) {
  if (page.categories) return <CategoryPage page={page} summary={summary} toolbar={toolbar} extras={extras} />;
  return <PlainPage page={page} summary={summary} toolbar={toolbar} />;
}

function PlainPage({ page, summary, toolbar }: PageViewProps) {
  const act = useAct();
  const [search, setSearch] = useState('');
  const count = useMemo(() => page.sections.reduce((n, s) => n + (s.items?.length ?? 0), 0), [page]);
  const shown = useMemo(() => filtered(page, search), [page, search]);
  const empty = page.empty;
  const emptyAction = offered(empty?.action) ? empty?.action : undefined;
  return (
    <Stack gap="xl">
      <PageHeader title={page.title} summary={summary} toolbar={toolbar} actions={page.actions} />
      {page.notice && <NoticeBar note={page.notice} />}
      {count > SEARCH_FROM && (
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder={'Search ' + page.title.toLowerCase()}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          aria-label="Search this page"
        />
      )}
      {!pageHasContent(page) && empty ? (
        <EmptyState
          title={empty.title}
          text={empty.text}
          action={
            emptyAction && (
              <Button mt="xs" onClick={() => void act(emptyAction)}>
                {emptyAction.label}
              </Button>
            )
          }
        />
      ) : (
        shown.sections.map((s) => <SectionBlock key={s.id} section={s} />)
      )}
    </Stack>
  );
}
