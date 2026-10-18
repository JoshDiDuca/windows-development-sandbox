// The states every page shares: loading (a skeleton the shape of a page), failed (what went wrong and what to do),
// and empty (a picture, words and the next step). Pages never draw their own.
import { Button, Card, Center, Group, Skeleton, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconAlertTriangle, IconInbox, type Icon } from '@tabler/icons-react';
import type { ReactNode } from 'react';

export function PageSkeleton() {
  return (
    <Stack gap="lg" aria-busy="true" aria-label="Loading">
      <Group justify="space-between">
        <Stack gap={8}>
          <Skeleton h={26} w={180} radius="md" />
          <Skeleton h={14} w={320} radius="md" />
        </Stack>
        <Skeleton h={34} w={120} radius="md" />
      </Group>
      {[0, 1].map((i) => (
        <Card key={i}>
          <Stack gap="sm">
            <Skeleton h={16} w={140} radius="md" />
            <Skeleton h={12} radius="md" />
            <Skeleton h={12} w="80%" radius="md" />
            <Skeleton h={12} w="60%" radius="md" />
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}

interface EmptyStateProps {
  readonly title?: string;
  readonly text: string;
  readonly icon?: Icon;
  readonly action?: ReactNode;
  readonly tone?: 'neutral' | 'danger';
}

export function EmptyState({ title, text, icon: Picture = IconInbox, action, tone = 'neutral' }: EmptyStateProps) {
  return (
    <Card py={48}>
      <Center>
        <Stack gap="sm" align="center" maw={440} ta="center">
          <ThemeIcon size={52} radius="xl" variant="light" color={tone === 'danger' ? 'red' : 'indigo'}>
            <Picture size={26} stroke={1.6} />
          </ThemeIcon>
          {title && <Title order={3}>{title}</Title>}
          <Text c="dimmed" size="sm">
            {text}
          </Text>
          {action}
        </Stack>
      </Center>
    </Card>
  );
}

export function ErrorState({ message, fix, retry }: { message: string; fix?: string; retry?: () => void }) {
  return (
    <EmptyState
      tone="danger"
      icon={IconAlertTriangle}
      title={message}
      text={fix ?? 'Try again in a moment.'}
      action={
        retry && (
          <Button variant="default" onClick={retry}>
            Try again
          </Button>
        )
      }
    />
  );
}
