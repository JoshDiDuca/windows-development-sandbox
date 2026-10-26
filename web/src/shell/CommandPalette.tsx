// Ctrl+K (or /): one search over everything the web UI can reach: its pages, starting a session, the running sessions'
// terminals, and every setting by name or key (it opens the setting in Settings). Built from the same queries the pages
// read, so it never lists what a page would not offer.
import { useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { Spotlight, type SpotlightActionData, type SpotlightActionGroupData } from '@mantine/spotlight';
import { IconAdjustments, IconMoon, IconPlus, IconSearch, IconTerminal2 } from '@tabler/icons-react';
import { useMemo } from 'react';
import { NAV, navGroupOf, navSections, queryById, type SessionsList, type SettingsList } from '../../../src/app/features/defs';
import { AREA_ICONS, ItemIcon } from '../render/icons';
import { itemAnchor } from '../render/CategoryPage';
import { navigate, viewPath } from '../router';
import { useQueryData } from '../rpc/hooks';

const SESSIONS = queryById('sessions.list');
const SETTINGS = queryById('settings.list');

export function CommandPalette() {
  const sessions = useQueryData(SESSIONS!, {}).data as SessionsList | undefined;
  const settings = useQueryData(SETTINGS!, { scope: 'user' }).data as SettingsList | undefined;
  const { setColorScheme } = useMantineColorScheme();
  const dark = useComputedColorScheme('light') === 'dark';

  const actions = useMemo((): (SpotlightActionGroupData | SpotlightActionData)[] => {
    // Every page, with the group it sits in ("Sandbox › Overview").
    const pages: SpotlightActionData[] = navSections(NAV)
      .filter((s) => s.view)
      .map((s) => {
        const parent = navGroupOf(NAV, s.view as string)?.label;
        const Picture = AREA_ICONS[s.label] ?? IconSearch;
        return {
          id: 'view:' + s.view,
          label: s.label === 'Overview' && parent ? parent + ' overview' : s.label,
          description: parent ? parent + ' › ' + s.label : undefined,
          keywords: parent ? [parent] : undefined,
          leftSection: <Picture size={18} stroke={1.6} />,
          onClick: () => navigate(viewPath(s.view as string)),
        };
      });
    const commands: SpotlightActionData[] = [
      {
        id: 'new-session',
        label: 'New session',
        description: 'Start an agent in one of the sandbox’s projects',
        leftSection: <IconPlus size={18} />,
        onClick: () => navigate(viewPath('agents')),
      },
      {
        id: 'scheme',
        label: dark ? 'Switch to light mode' : 'Switch to dark mode',
        description: 'Change the colour scheme of the web UI',
        leftSection: <IconMoon size={18} />,
        onClick: () => setColorScheme(dark ? 'light' : 'dark'),
      },
    ];
    const running: SpotlightActionData[] = (sessions?.sessions ?? [])
      .filter((s) => s.phase === 'running' && s.canOpen)
      .map((s) => ({
        id: 'session:' + s.id,
        label: s.harness + ' · ' + (s.projectName ?? s.cwd),
        description: 'Open the terminal · session ' + s.id,
        keywords: [s.id, s.cwd],
        leftSection: <ItemIcon name={s.harness} size={24} />,
        rightSection: <IconTerminal2 size={16} />,
        onClick: () => navigate('/s/' + s.id),
      }));
    const rows: SpotlightActionData[] = (settings?.rows ?? []).map((r) => ({
      id: 'setting:' + r.id,
      label: r.label,
      description: r.id + (r.field.help ? ' · ' + r.field.help : ''),
      keywords: [r.id, r.category],
      leftSection: <IconAdjustments size={18} stroke={1.6} />,
      onClick: () => navigate(viewPath('settings') + '#' + itemAnchor(r.id)),
    }));
    return [
      { group: 'Pages', actions: pages },
      { group: 'Commands', actions: commands },
      ...(running.length ? [{ group: 'Sessions', actions: running }] : []),
      ...(rows.length ? [{ group: 'Settings', actions: rows }] : []),
    ];
  }, [sessions, settings, dark, setColorScheme]);

  return (
    <Spotlight
      actions={actions}
      shortcut={['mod + K', '/']}
      limit={12}
      highlightQuery
      scrollable
      maxHeight={480}
      nothingFound="No pages, sessions or settings match"
      searchProps={{ leftSection: <IconSearch size={18} />, placeholder: 'Search pages, sessions and settings…' }}
    />
  );
}
