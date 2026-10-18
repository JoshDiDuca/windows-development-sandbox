// A session's terminal inside the shell: a toolbar (back, which agent in which project, the connection's state, search,
// text size, full screen, detach) over xterm.js, and on touch screens a row of the keys a phone keyboard lacks.
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Paper,
  Text,
  TextInput,
  Tooltip,
  type MantineColor,
} from '@mantine/core';
import { useFullscreen, useHotkeys, useLocalStorage, useMediaQuery } from '@mantine/hooks';
import {
  IconArrowLeft,
  IconChevronDown,
  IconChevronUp,
  IconMaximize,
  IconMinimize,
  IconSearch,
  IconTextDecrease,
  IconTextIncrease,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useRef, useState } from 'react';
import { queryById, type SessionsList } from '../../../src/app/features/defs';
import { ItemIcon } from '../render/icons';
import { navigate, viewPath } from '../router';
import { useQueryData } from '../rpc/hooks';
import { FONT_SIZES, TerminalView, type TerminalHandle } from '../terminal/TerminalView';
import type { ConnectionState } from '../terminal/connection';

const SESSIONS = queryById('sessions.list');

const STATE_TEXT: Record<ConnectionState, { text: string; color: MantineColor }> = {
  connecting: { text: 'Connecting', color: 'gray' },
  connected: { text: 'Connected', color: 'green' },
  reconnecting: { text: 'Reconnecting', color: 'orange' },
  ended: { text: 'Ended', color: 'gray' },
  failed: { text: 'Cannot connect', color: 'red' },
};

/** The keys a phone keyboard does not have, as the bytes a terminal sends. */
const KEY_ROW: readonly { label: string; bytes: string }[] = [
  { label: 'Esc', bytes: '\x1b' },
  { label: 'Tab', bytes: '\t' },
  { label: 'Ctrl+C', bytes: '\x03' },
  { label: '↑', bytes: '\x1b[A' },
  { label: '↓', bytes: '\x1b[B' },
  { label: '←', bytes: '\x1b[D' },
  { label: '→', bytes: '\x1b[C' },
  { label: 'Enter', bytes: '\r' },
  { label: 'Shift+Tab', bytes: '\x1b[Z' },
];

function SearchBox({ terminal, close }: { readonly terminal: TerminalHandle | null; readonly close: () => void }) {
  const [text, setText] = useState('');
  const [missing, setMissing] = useState(false);
  const find = (backwards: boolean): void => setMissing(text !== '' && !terminal?.find(text, backwards));
  const done = (): void => {
    terminal?.clearFind();
    close();
    terminal?.focus();
  };
  return (
    <Paper className="terminal-search" shadow="md" p={6} withBorder>
      <Group gap={4} wrap="nowrap">
        <TextInput
          size="xs"
          w={220}
          autoFocus
          placeholder="Find in the terminal"
          value={text}
          error={missing}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') find(e.shiftKey);
            if (e.key === 'Escape') done();
          }}
          aria-label="Find in the terminal"
        />
        <ActionIcon aria-label="Previous" onClick={() => find(true)}>
          <IconChevronUp size={16} />
        </ActionIcon>
        <ActionIcon aria-label="Next" onClick={() => find(false)}>
          <IconChevronDown size={16} />
        </ActionIcon>
        <ActionIcon aria-label="Close search" onClick={done}>
          <IconX size={16} />
        </ActionIcon>
      </Group>
    </Paper>
  );
}

export function TerminalPage({ id }: { readonly id: string }) {
  const [state, setState] = useState<ConnectionState>('connecting');
  const [detail, setDetail] = useState<string | undefined>();
  const [searching, setSearching] = useState(false);
  const [fontSize, setFontSize] = useLocalStorage<number>({ key: 'terminal-font-size', defaultValue: 14 });
  const terminal = useRef<TerminalHandle | null>(null);
  const detach = useRef<() => void>(() => undefined);
  const { toggle: toggleFullscreen, fullscreen } = useFullscreen();
  const touch = useMediaQuery('(pointer: coarse)');
  const sessions = useQueryData(SESSIONS!, {}).data as SessionsList | undefined;
  const session = sessions?.sessions.find((s) => s.id === id);

  const onState = useCallback((next: ConnectionState, text?: string) => {
    setState(next);
    setDetail(text);
  }, []);
  const onReady = useCallback((close: () => void) => {
    detach.current = close;
  }, []);
  const resize = (step: number): void => {
    const at = FONT_SIZES.indexOf(fontSize as (typeof FONT_SIZES)[number]);
    const next = FONT_SIZES[Math.max(0, Math.min(FONT_SIZES.length - 1, (at < 0 ? 3 : at) + step))];
    setFontSize(next);
    terminal.current?.setFontSize(next);
  };
  useHotkeys([['mod+shift+F', () => setSearching(true)]], [], true);

  const shown = STATE_TEXT[state];
  const leave = (): void => {
    detach.current();
    navigate(viewPath('sessions'));
  };
  return (
    <div className="terminal-page" style={{ position: 'relative' }}>
      <Group gap="sm" px="sm" py={6} wrap="nowrap" className="terminal-toolbar">
        <Tooltip label="Back to sessions (the session keeps running)">
          <ActionIcon size="lg" aria-label="Back" onClick={leave}>
            <IconArrowLeft size={18} />
          </ActionIcon>
        </Tooltip>
        {session && <ItemIcon name={session.harness} size={28} />}
        <Box style={{ minWidth: 0 }}>
          <Text fw={650} size="sm" truncate lh={1.2}>
            {session ? session.harness + ' · ' + (session.projectName ?? session.cwd) : 'Session ' + id}
          </Text>
          <Text size="xs" c="dimmed" truncate lh={1.2} ff="monospace">
            {detail ?? id}
          </Text>
        </Box>
        <Badge color={shown.color} variant="dot" style={{ flex: 'none' }}>
          {shown.text}
        </Badge>
        <Group gap={2} ml="auto" wrap="nowrap">
          <Tooltip label="Find (Ctrl+Shift+F)">
            <ActionIcon size="lg" aria-label="Find" onClick={() => setSearching((s) => !s)}>
              <IconSearch size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Smaller text">
            <ActionIcon size="lg" aria-label="Smaller text" onClick={() => resize(-1)} visibleFrom="xs">
              <IconTextDecrease size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Bigger text">
            <ActionIcon size="lg" aria-label="Bigger text" onClick={() => resize(1)} visibleFrom="xs">
              <IconTextIncrease size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={fullscreen ? 'Leave full screen' : 'Full screen'}>
            <ActionIcon size="lg" aria-label="Full screen" onClick={() => void toggleFullscreen()}>
              {fullscreen ? <IconMinimize size={18} /> : <IconMaximize size={18} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Close this view; the session keeps running">
            <Button size="xs" variant="default" ml={6} onClick={leave}>
              Detach
            </Button>
          </Tooltip>
        </Group>
      </Group>
      {searching && <SearchBox terminal={terminal.current} close={() => setSearching(false)} />}
      <TerminalView ref={terminal} sessionId={id} fontSize={fontSize} onState={onState} onReady={onReady} />
      {touch && (
        <div className="key-bar" role="toolbar" aria-label="Keys">
          {KEY_ROW.map((k) => (
            <Button
              key={k.label}
              size="compact-sm"
              variant="default"
              onClick={() => {
                terminal.current?.type(k.bytes);
                terminal.current?.focus();
              }}
            >
              {k.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
