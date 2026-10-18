// A page whose sections are categories of one long list (settings): the categories down the side with how many are
// changed in each, one category at a time, a search over all of them, and each item as a row with its control in
// place. #<section> opens a category and #item-<id> opens the one holding that item and points it out.
import { Badge, Box, Card, Group, NavLink, Stack, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { IconFileSettings, IconInfoCircle, IconSearch } from '@tabler/icons-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Item, Page, Section } from '../../../src/app/kernel/index';
import { ActionButton, offered } from './actions';
import { InlineField } from './InlineField';
import { filtered, ItemList, PageHeader, SecondaryActions, tidy } from './PageView';
import { EmptyState } from './states';

interface CategoryPageProps {
  readonly page: Page;
  readonly summary?: string;
  readonly toolbar?: ReactNode;
}

/** The DOM id of an item's row. */
export function itemAnchor(id: string): string {
  return 'item-' + id.replace(/[^A-Za-z0-9_-]/g, '_');
}

function changedCount(section: Section): number {
  return (section.items ?? []).filter((i) => i.badges?.length).length;
}

function ItemDetails({ item }: { readonly item: Item }) {
  if (!item.details?.length) return null;
  return (
    <Tooltip
      label={
        <Stack gap={0}>
          {item.details.map((d, i) => (
            <Text key={i} size="xs" ff="monospace" style={{ whiteSpace: 'pre' }}>
              {d}
            </Text>
          ))}
        </Stack>
      }
      maw={480}
      position="top-start"
    >
      <IconInfoCircle size={14} color="var(--app-muted)" style={{ flex: 'none', cursor: 'help' }} />
    </Tooltip>
  );
}

function CategoryRow({ item, flash }: { readonly item: Item; readonly flash: boolean }) {
  const primary = offered(item.primary) && !item.disabled ? item.primary : undefined;
  const inline = primary?.kind === 'operation' && primary.inline ? primary : undefined;
  const changed = Boolean(item.badges?.length);
  return (
    <div className={'setting-row' + (flash ? ' flash' : '')} id={itemAnchor(item.id)}>
      <Box style={{ minWidth: 0 }}>
        <Group gap={6} wrap="nowrap">
          {changed && <span className="modified-dot" title="Changed from the default" />}
          <Text fw={600} size="sm" truncate>
            {item.label}
          </Text>
          <ItemDetails item={item} />
        </Group>
        {item.code && <div className="setting-key">{item.code}</div>}
        {item.description && (
          <Text size="xs" c="dimmed" mt={4} lh={1.45}>
            {item.description}
          </Text>
        )}
        {item.disabled && (
          <Text size="xs" c="dimmed" fs="italic" mt={4}>
            {item.disabled}
          </Text>
        )}
      </Box>
      <Group gap={6} wrap="nowrap" justify="flex-end" align="flex-start">
        <Box style={{ flex: 1, minWidth: 0 }}>
          {inline ? (
            <InlineField action={inline} summary={item.hint} />
          ) : (
            <Group justify="flex-end" gap="sm" wrap="nowrap">
              {item.hint && (
                <Text size="sm" c="dimmed" ff="monospace" truncate>
                  {tidy(item.hint)}
                </Text>
              )}
              {primary && <ActionButton action={primary} size="xs" />}
            </Group>
          )}
        </Box>
        <Box w={28} style={{ flex: 'none' }}>
          <SecondaryActions actions={item.actions ?? []} />
        </Box>
      </Group>
    </div>
  );
}

/** The section and item an address names (#general, #item-sandbox_memoryMb). */
function fromHash(sections: readonly Section[]): { section?: string; item?: string } {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash.startsWith('item-')) {
    for (const s of sections) {
      const item = s.items?.find((i) => itemAnchor(i.id) === hash);
      if (item) return { section: s.id, item: item.id };
    }
  }
  return { section: sections.find((s) => s.id === hash)?.id };
}

export function CategoryPage({ page, summary, toolbar }: CategoryPageProps) {
  const sections = useMemo(() => page.sections.filter((s) => s.items?.length), [page]);
  const [current, setCurrent] = useState<string | undefined>(() => fromHash(sections).section ?? sections[0]?.id);
  const [flash, setFlash] = useState<string | undefined>(() => fromHash(sections).item);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const follow = (): void => {
      const at = fromHash(sections);
      if (at.section) setCurrent(at.section);
      if (at.item) {
        setSearch('');
        setFlash(at.item);
      }
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [sections]);

  useEffect(() => {
    if (!flash) return undefined;
    document.getElementById(itemAnchor(flash))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const timer = window.setTimeout(() => setFlash(undefined), 1800);
    return () => window.clearTimeout(timer);
  }, [flash, current]);

  const section = sections.find((s) => s.id === current) ?? sections[0];
  const results = search.trim() ? filtered({ ...page, sections }, search).sections : null;
  const choose = (id: string): void => {
    setSearch('');
    setCurrent(id);
    history.replaceState(null, '', location.pathname + location.search + '#' + id);
    window.scrollTo({ top: 0 });
  };
  const row = (item: Item): ReactNode => <CategoryRow key={item.id} item={item} flash={flash === item.id} />;

  return (
    <Stack gap="lg">
      <PageHeader title={page.title} summary={summary} toolbar={toolbar} actions={page.actions} />
      {page.notice && (
        <Group gap={8} wrap="nowrap" mt={-8}>
          <IconFileSettings size={16} color="var(--app-muted)" style={{ flex: 'none' }} />
          <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-all' }}>
            {page.notice.text}
          </Text>
        </Group>
      )}
      <div className="category-layout">
        <Stack gap="sm" className="category-nav">
          <TextInput
            leftSection={<IconSearch size={16} />}
            placeholder={'Search ' + page.title.toLowerCase()}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            aria-label={'Search ' + page.title.toLowerCase()}
          />
          <Stack gap={2} visibleFrom="md">
            {sections.map((s) => {
              const changed = changedCount(s);
              return (
                <NavLink
                  key={s.id}
                  label={s.title}
                  active={!results && s.id === section?.id}
                  onClick={() => choose(s.id)}
                  style={{ borderRadius: 'var(--mantine-radius-md)' }}
                  rightSection={
                    changed ? (
                      <Badge size="xs" circle variant="light">
                        {changed}
                      </Badge>
                    ) : null
                  }
                />
              );
            })}
          </Stack>
          <Box hiddenFrom="md">
            <Group gap={6}>
              {sections.map((s) => (
                <Badge
                  key={s.id}
                  size="lg"
                  variant={s.id === section?.id && !results ? 'filled' : 'light'}
                  color={s.id === section?.id && !results ? 'indigo' : 'gray'}
                  style={{ cursor: 'pointer' }}
                  onClick={() => choose(s.id)}
                >
                  {s.title}
                </Badge>
              ))}
            </Group>
          </Box>
        </Stack>
        <Stack gap="lg" style={{ minWidth: 0 }}>
          {results ? (
            results.length ? (
              results.map((s) => (
                <Stack key={s.id} gap="xs">
                  <Text size="xs" fw={650} tt="uppercase" c="dimmed">
                    {s.title} · {s.items?.length ?? 0}
                  </Text>
                  <Card className="list-card">
                    <ItemList items={s.items ?? []} render={row} />
                  </Card>
                </Stack>
              ))
            ) : (
              <EmptyState icon={IconSearch} title="Nothing found" text={'No setting matches "' + search + '".'} />
            )
          ) : (
            section && (
              <Stack gap="sm">
                <Box>
                  <Title order={2}>{section.title}</Title>
                  {section.description && (
                    <Text size="sm" c="dimmed" mt={4}>
                      {section.description}
                    </Text>
                  )}
                </Box>
                <Card className="list-card">
                  <ItemList items={section.items ?? []} render={row} />
                </Card>
              </Stack>
            )
          )}
        </Stack>
      </div>
    </Stack>
  );
}
