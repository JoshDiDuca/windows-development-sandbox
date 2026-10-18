// Picking a folder or a file of this PC (a browser cannot give full paths): the places to start from, a path you can
// type, the folder's contents from the shared core's files.browse, and Choose. Double-click opens a folder.
import { ActionIcon, Alert, Button, Group, Loader, ScrollArea, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconArrowUp, IconDeviceFloppy, IconFile, IconFolder, IconFolderCode } from '@tabler/icons-react';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import type { FolderListing } from '../../../src/app/features/defs';
import type { PathKind } from '../../../src/app/kernel/index';
import type { RpcClient } from '../rpc/client';
import { useRpc } from '../rpc/hooks';

const noQuestions = { ask: () => Promise.resolve(undefined) };

interface PickerProps {
  readonly kind: PathKind;
  readonly initial?: string;
  readonly done: (path: string | undefined) => void;
}

/** The folder a starting value sits in (a file's folder; nothing for "auto" and other words). */
function startFolder(kind: PathKind, initial: string | undefined): string | undefined {
  if (!initial || !/^[A-Za-z]:\\|^\\\\/.test(initial)) return undefined;
  if (kind === 'dir') return initial;
  const cut = initial.lastIndexOf('\\');
  return cut > 2 ? initial.slice(0, cut) : initial.slice(0, 3);
}

function Picker({ kind, initial, done }: PickerProps) {
  const rpc = useRpc();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [typed, setTyped] = useState(startFolder(kind, initial) ?? '');
  const [selected, setSelected] = useState<string | null>(kind === 'file' ? (initial ?? null) : null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useCallback(
    (folder: string | undefined) => {
      setBusy(true);
      setProblem(null);
      void browse(rpc, folder, kind === 'file').then(
        (next) => {
          setListing(next);
          setTyped(next.path);
          setSelected(null);
          setBusy(false);
        },
        (e: unknown) => {
          setProblem(e instanceof Error ? e.message : 'That folder cannot be opened.');
          setBusy(false);
        },
      );
    },
    [rpc, kind],
  );

  useEffect(() => open(startFolder(kind, initial)), [open, kind, initial]);

  const chosen = kind === 'dir' ? (selected ?? listing?.path ?? '') : (selected ?? '');
  const goTyped = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      open(typed.trim() || undefined);
    }
  };

  return (
    <Stack gap="sm">
      <Group gap="xs" wrap="nowrap">
        <Tooltip label="Up one folder">
          <ActionIcon
            size="lg"
            variant="default"
            aria-label="Up one folder"
            disabled={!listing?.path}
            onClick={() => open(listing?.parent ?? undefined)}
          >
            <IconArrowUp size={16} />
          </ActionIcon>
        </Tooltip>
        <TextInput
          style={{ flex: 1 }}
          value={typed}
          placeholder="Type a path and press Enter"
          onChange={(e) => setTyped(e.currentTarget.value)}
          onKeyDown={goTyped}
          ff="monospace"
          aria-label="Folder"
          rightSection={busy ? <Loader size={14} /> : null}
        />
      </Group>
      {problem && (
        <Alert color="red" variant="light" p="xs">
          {problem}
        </Alert>
      )}
      <Group align="stretch" gap="sm" wrap="nowrap">
        <Stack gap={2} w={170} visibleFrom="xs" style={{ flex: 'none' }}>
          <Text size="xs" fw={650} c="dimmed" tt="uppercase" px={6} pb={4}>
            Places
          </Text>
          {(listing?.places ?? []).map((p) => (
            <div key={p.path} className="picker-entry" onClick={() => open(p.path)} title={p.path}>
              {p.label.endsWith(':') ? <IconDeviceFloppy size={16} /> : <IconFolderCode size={16} />}
              <Text size="sm" truncate>
                {p.label}
              </Text>
            </div>
          ))}
        </Stack>
        <ScrollArea className="picker-list" style={{ flex: 1 }} type="auto">
          {!listing?.path && (
            <Text size="sm" c="dimmed" p="md">
              Pick a place on the left, or type a path.
            </Text>
          )}
          {listing?.path && listing.entries.length === 0 && (
            <Text size="sm" c="dimmed" p="md">
              {kind === 'dir' ? 'No folders in here.' : 'Nothing in here.'}
            </Text>
          )}
          {listing?.entries.map((entry) => (
            <div
              key={entry.path}
              className="picker-entry"
              data-selected={selected === entry.path}
              onClick={() => setSelected(entry.path)}
              onDoubleClick={() => (entry.kind === 'dir' ? open(entry.path) : done(entry.path))}
            >
              {entry.kind === 'dir' ? (
                <IconFolder size={16} color="var(--mantine-color-yellow-6)" />
              ) : (
                <IconFile size={16} color="var(--app-muted)" />
              )}
              <Text size="sm" truncate>
                {entry.name}
              </Text>
            </div>
          ))}
          {listing?.truncated && (
            <Text size="xs" c="dimmed" p="sm">
              Only the first entries are shown: type the rest of the path.
            </Text>
          )}
        </ScrollArea>
      </Group>
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Text size="xs" c="dimmed" ff="monospace" truncate style={{ minWidth: 0 }}>
          {chosen || (kind === 'file' ? 'Pick a file' : 'Pick a folder')}
        </Text>
        <Group gap="xs" wrap="nowrap" style={{ flex: 'none' }}>
          <Button variant="default" onClick={() => done(undefined)}>
            Cancel
          </Button>
          <Button disabled={!chosen} onClick={() => done(chosen)}>
            {kind === 'dir' ? 'Choose this folder' : 'Choose'}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

function browse(rpc: RpcClient, folder: string | undefined, files: boolean): Promise<FolderListing> {
  return rpc.call('files.browse', { path: folder, files }, noQuestions) as Promise<FolderListing>;
}

/** Asks for a folder or a file in a modal; resolves with its full path, or undefined when cancelled. */
export function pickPath(kind: PathKind, initial?: string, title?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (picked: string | undefined): void => {
      if (settled) return;
      settled = true;
      modals.close(id);
      resolve(picked);
    };
    const id = modals.open({
      title: title ?? (kind === 'dir' ? 'Choose a folder' : 'Choose a file'),
      size: 'xl',
      onClose: () => finish(undefined),
      children: <Picker kind={kind} initial={initial} done={finish} />,
    });
  });
}
