// The app's frame: the sidebar (the product, the sandbox's state, search, the navigation's groups with an icon per page
// and a count where it helps, who is signed in and the colour scheme), and the page beside it. On a phone the sidebar
// folds behind a header with a burger. Areas that are not in the web UI yet are named in a quiet line under their
// group, never as dead links.
import {
  ActionIcon,
  AppShell,
  Box,
  Burger,
  Group,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { spotlight } from '@mantine/spotlight';
import { IconBox, IconMoon, IconSearch, IconSun } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { NAV, queryById, type NavSection, type SessionsList } from '../../../src/app/features/defs';
import { navigate, viewPath } from '../router';
import { accessLabel, isOwner } from '../access';
import { AREA_ICONS } from '../render/icons';
import { useQueryData } from '../rpc/hooks';
import { CommandPalette } from './CommandPalette';
import { SandboxStatusCard } from './StatusPill';

const SESSIONS = queryById('sessions.list');

interface ShellProps {
  /** The view shown (its entry is highlighted). */
  readonly active?: string;
  /** The page fills the whole area (the terminal). */
  readonly bare?: boolean;
  readonly children: ReactNode;
}

function Brand() {
  return (
    <Group gap={10} wrap="nowrap">
      <div className="brand-mark" aria-hidden="true">
        <IconBox size={16} stroke={2} />
      </div>
      <Box style={{ minWidth: 0 }}>
        <Text fw={650} size="sm" lh={1.2}>
          Sandbox
        </Text>
        <Text size="xs" c="dimmed" lh={1.2}>
          Windows development sandbox
        </Text>
      </Box>
    </Group>
  );
}

function ColorSchemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const dark = useComputedColorScheme('light') === 'dark';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <Tooltip label={label}>
      <ActionIcon size="lg" aria-label={label} onClick={() => setColorScheme(dark ? 'light' : 'dark')}>
        {dark ? <IconSun size={17} stroke={1.7} /> : <IconMoon size={17} stroke={1.7} />}
      </ActionIcon>
    </Tooltip>
  );
}

function SearchButton() {
  return (
    <UnstyledButton onClick={() => spotlight.open()} className="search-button" aria-label="Search pages and settings">
      <IconSearch size={15} stroke={1.8} />
      <span className="search-button-text">Search</span>
      <span className="kbd-hint">Ctrl K</span>
    </UnstyledButton>
  );
}

/** Running sessions, shown beside the Sessions entry. */
function useRunningSessions(): number {
  const data = useQueryData(SESSIONS!, {}).data as SessionsList | undefined;
  return (data?.sessions ?? []).filter((s) => s.phase === 'running').length;
}

function NavItem({
  section,
  active,
  count,
  onPick,
}: {
  readonly section: NavSection;
  readonly active: boolean;
  readonly count?: number;
  readonly onPick: () => void;
}) {
  const Picture = AREA_ICONS[section.label] ?? IconBox;
  const view = section.view as string;
  return (
    <a
      href={viewPath(view)}
      className="nav-item"
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        onPick();
        navigate(viewPath(view));
      }}
    >
      <Picture size={17} stroke={1.7} className="nav-item-icon" />
      <span className="nav-item-label">{section.label}</span>
      {count !== undefined && count > 0 && (
        <span className="nav-count" aria-label={count + ' running'}>
          {count}
        </span>
      )}
    </a>
  );
}

function Navigation({ active, onPick }: { readonly active?: string; readonly onPick: () => void }) {
  const running = useRunningSessions();
  // Remote access is the owner's alone: another Windows user or a device does not see the entry.
  const shown = (s: NavSection): boolean => Boolean(s.view) && (s.view !== 'access' || isOwner());
  /** Top-level entries with a view of their own (none today) are listed before the groups. */
  const loose = NAV.filter((s) => s.view && !s.children?.length).filter(shown);
  const groups = NAV.filter((s) => s.children?.length);
  const item = (s: NavSection): ReactNode => (
    <NavItem
      key={s.label}
      section={s}
      active={s.view === active}
      count={s.view === 'sessions' ? running : undefined}
      onPick={onPick}
    />
  );
  return (
    <nav aria-label="Pages">
      <Stack gap={2}>
        {loose.map(item)}
        {groups.map((group) => {
          const children = group.children ?? [];
          const later = children.filter((c) => !c.view && c.elsewhere);
          const entries = children.filter(shown);
          if (!entries.length) return null;
          return (
            <Box key={group.label} className="nav-group" role="group" aria-label={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {entries.map(item)}
              {later.map((l) => (
                <Tooltip key={l.label} label={l.elsewhere} position="right" maw={260}>
                  <Text className="nav-elsewhere" size="xs" c="dimmed">
                    More in the terminal menu
                  </Text>
                </Tooltip>
              ))}
            </Box>
          );
        })}
      </Stack>
    </nav>
  );
}

export function Shell({ active, bare = false, children }: ShellProps) {
  const [opened, { toggle, close }] = useDisclosure(false);
  return (
    <AppShell
      header={{ height: { base: 56, sm: 0 } }}
      navbar={{ width: 248, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding={0}
    >
      <AppShell.Header className="app-header" hiddenFrom="sm">
        <Group h="100%" px="md" gap="sm" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} size="sm" aria-label="Open navigation" />
            <Brand />
          </Group>
          <ActionIcon size="lg" aria-label="Search" onClick={() => spotlight.open()}>
            <IconSearch size={18} />
          </ActionIcon>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar className="app-navbar" aria-label="Main">
        <Box className="app-navbar-sticky">
          <AppShell.Section px="md" pt="md" pb="sm" visibleFrom="sm">
            <Brand />
          </AppShell.Section>
          <AppShell.Section px="sm" pt={{ base: 'sm', sm: 0 }} pb="xs">
            <SandboxStatusCard />
          </AppShell.Section>
          <AppShell.Section px="sm" pb="xs" visibleFrom="sm">
            <SearchButton />
          </AppShell.Section>
          <AppShell.Section grow component={ScrollArea} px="sm" pb="md">
            <Navigation active={active} onPick={close} />
          </AppShell.Section>
          <AppShell.Section className="app-navbar-footer">
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                <span className="status-dot" style={{ ['--dot' as string]: 'var(--mantine-color-green-6)' }} />
                <Text size="xs" c="dimmed" truncate>
                  {accessLabel()}
                </Text>
              </Group>
              <ColorSchemeToggle />
            </Group>
          </AppShell.Section>
        </Box>
      </AppShell.Navbar>
      <AppShell.Main
        className="app-main"
        style={bare ? { display: 'flex', height: '100dvh', paddingBottom: 0 } : undefined}
      >
        {bare ? children : <div className="app-content">{children}</div>}
      </AppShell.Main>
      <CommandPalette />
    </AppShell>
  );
}
