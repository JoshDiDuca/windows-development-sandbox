// The sandbox's state at the top of the sidebar, always in view: a dot (green ready, amber while it sets up, grey when
// stopped), its phase, how long it has run and how many agents run in it. A click opens the Sandbox page. It reads the
// same live query as that page (sandbox.status).
import { Group, Skeleton, Stack, Text, UnstyledButton } from '@mantine/core';
import { queryById, type SandboxStatus } from '../../../src/app/features/defs';
import { ago } from '../../../src/app/kernel/index';
import { navigate, viewPath } from '../router';
import { useQueryData } from '../rpc/hooks';

const STATUS = queryById('sandbox.status');

function describe(status: SandboxStatus): { color: string; title: string; line: string; busy: boolean } {
  const s = status.sandbox;
  if (status.shared?.limited)
    return { color: 'gray', title: 'Another user’s sandbox', line: 'Not shared', busy: false };
  if (!s.running) return { color: 'gray', title: 'Stopped', line: 'Start an agent to start it', busy: false };
  const sessions = status.projects.reduce((n, p) => n + p.sessions.length, 0) + status.otherSessions.length;
  const ready = s.phase === 'ready';
  const up = s.startedAt ? 'up ' + ago(s.startedAt).replace(' ago', '') : 'running';
  return {
    color: ready ? 'green' : 'yellow',
    title: ready ? 'Running' : s.phase.charAt(0).toUpperCase() + s.phase.slice(1),
    line: up + ' · ' + sessions + (sessions === 1 ? ' agent' : ' agents'),
    busy: !ready,
  };
}

export function SandboxStatusCard() {
  const { data, error } = useQueryData(STATUS!, {});
  const shown = data
    ? describe(data as SandboxStatus)
    : error
      ? { color: 'red', title: 'Cannot reach the sandbox', line: 'Is sandbox web still running?', busy: false }
      : null;
  return (
    <UnstyledButton
      onClick={() => navigate(viewPath('sandbox'))}
      p="sm"
      w="100%"
      style={{ border: '1px solid var(--app-border)', borderRadius: 'var(--mantine-radius-md)' }}
      aria-label="Sandbox status"
    >
      {shown ? (
        <Group gap="sm" wrap="nowrap">
          <span
            className={'status-dot' + (shown.busy ? ' pulse' : '')}
            style={{ ['--dot' as string]: `var(--mantine-color-${shown.color}-6)` }}
          />
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="sm" fw={600} truncate>
              {shown.title}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {shown.line}
            </Text>
          </Stack>
        </Group>
      ) : (
        <Stack gap={6}>
          <Skeleton h={12} w="60%" />
          <Skeleton h={10} w="80%" />
        </Stack>
      )}
    </UnstyledButton>
  );
}
