// The app's frame: the sidebar (the sandbox's state, the areas that are in the web UI in the menu's order, search and
// the colour scheme), and the page beside it. On a phone the sidebar folds behind a header with a burger. Areas that
// are not in the web UI yet are listed by name at the bottom with where to find them, never as dead links.
import {
  ActionIcon,
  AppShell,
  Box,
  Burger,
  Group,
  NavLink,
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
import { NAV, navViews, type NavSection, type ViewId } from '../../../src/app/features/defs';
import { navigate, viewPath } from '../router';
import { isOwner } from '../access';
import { AREA_ICONS } from '../render/icons';
import { CommandPalette } from './CommandPalette';
import { SandboxStatusCard } from './StatusPill';

interface ShellProps {
  /** The view shown (its area is highlighted). */
  readonly active?: string;
  /** The page fills the whole area (the terminal). */
  readonly bare?: boolean;
  readonly children: ReactNode;
}

function Brand() {
  return (
    <Group gap={10} wrap="nowrap">
      <div className="brand-mark">
        <IconBox size={17} stroke={2} />
      </div>
      <Box>
        <Text fw={700} size="sm" lh={1.1}>
          Sandbox
        </Text>
        <Text size="xs" c="dimmed" lh={1.1}>
          Development sandbox
        </Text>
      </Box>
    </Group>
  );
}

function ColorSchemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const dark = useComputedColorScheme('light') === 'dark';
  return (
    <Tooltip label={dark ? 'Light mode' : 'Dark mode'}>
      <ActionIcon size="lg" aria-label="Switch dark or light" onClick={() => setColorScheme(dark ? 'light' : 'dark')}>
        {dark ? <IconSun size={18} stroke={1.6} /> : <IconMoon size={18} stroke={1.6} />}
      </ActionIcon>
    </Tooltip>
  );
}

function SearchButton() {
  return (
    <UnstyledButton
      onClick={() => spotlight.open()}
      px="sm"
      py={7}
      w="100%"
      style={{
        border: '1px solid var(--app-border)',
        borderRadius: 'var(--mantine-radius-md)',
        background: 'var(--app-bg)',
      }}
      aria-label="Search and commands"
    >
      <Group gap={8} wrap="nowrap">
        <IconSearch size={15} color="var(--app-muted)" />
        <Text size="sm" c="dimmed" style={{ flex: 1 }}>
          Search…
        </Text>
        <span className="kbd-hint">Ctrl K</span>
      </Group>
    </UnstyledButton>
  );
}

function Navigation({ active, onPick }: { readonly active?: string; readonly onPick: () => void }) {
  // Remote access is the owner's alone: another Windows user or a device does not see the entry.
  const here = NAV.filter((s) => (s.view || s.children?.length) && (s.view !== 'access' || isOwner()));
  const later = NAV.filter((s) => !s.view && !s.children?.length);
  /**
   * One entry: a link to its view, or a parent whose children are links under it (open when one of them is shown).
   * Areas have an icon; the entries under a parent do not (the parent's icon is their group).
   */
  const renderSection = (section: NavSection, nested = false): ReactNode => {
    const Picture = AREA_ICONS[section.label] ?? IconBox;
    const icon = nested ? undefined : <Picture size={17} stroke={1.7} />;
    if (section.children?.length)
      return (
        <NavLink
          key={section.label}
          label={section.label}
          leftSection={icon}
          childrenOffset={28}
          defaultOpened={navViews(section.children).includes(active as ViewId)}
          style={{ borderRadius: 'var(--mantine-radius-md)' }}
        >
          {section.children.map((child) => renderSection(child, true))}
        </NavLink>
      );
    const view = section.view as string;
    return (
      <NavLink
        key={section.label}
        label={section.label}
        leftSection={icon}
        active={view === active}
        href={viewPath(view)}
        style={{ borderRadius: 'var(--mantine-radius-md)' }}
        onClick={(e) => {
          e.preventDefault();
          onPick();
          navigate(viewPath(view));
        }}
      />
    );
  };
  return (
    <Stack gap={2}>
      <div className="nav-group-label">Workspace</div>
      {here.map((section) => renderSection(section))}
      {later.length > 0 && (
        <>
          <div className="nav-group-label">In the terminal menu</div>
          <Text size="xs" c="dimmed" px={12} lh={1.5}>
            {later.map((s) => s.label).join(', ')}: open{' '}
            <Text span ff="monospace" size="xs">
              sandbox
            </Text>{' '}
            in a terminal on this PC.
          </Text>
        </>
      )}
    </Stack>
  );
}

export function Shell({ active, bare = false, children }: ShellProps) {
  const [opened, { toggle, close }] = useDisclosure(false);
  return (
    <AppShell
      header={{ height: { base: 52, sm: 0 } }}
      navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding={0}
    >
      <AppShell.Header className="app-header" hiddenFrom="sm">
        <Group h="100%" px="md" gap="sm" justify="space-between">
          <Group gap="sm">
            <Burger opened={opened} onClick={toggle} size="sm" aria-label="Navigation" />
            <Brand />
          </Group>
          <ActionIcon size="lg" aria-label="Search" onClick={() => spotlight.open()}>
            <IconSearch size={18} />
          </ActionIcon>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar className="app-navbar" aria-label="Main">
        <Box className="app-navbar-sticky">
          <AppShell.Section p="md" pb="xs" visibleFrom="sm">
            <Brand />
          </AppShell.Section>
          <AppShell.Section px="md" py="xs">
            <SandboxStatusCard />
          </AppShell.Section>
          <AppShell.Section px="md" pb="xs" visibleFrom="sm">
            <SearchButton />
          </AppShell.Section>
          <AppShell.Section grow component={ScrollArea} px="xs">
            <Navigation active={active} onPick={close} />
          </AppShell.Section>
          <AppShell.Section p="sm" style={{ borderTop: '1px solid var(--app-border)' }}>
            <Group justify="space-between">
              <Text size="xs" c="dimmed" pl={6}>
                Loopback only · signed in
              </Text>
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
