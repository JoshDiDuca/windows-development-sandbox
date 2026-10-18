// Signs in from the #k= fragment (then removes it from the address bar), and shows the page the address names inside
// the shell: a view, or a session's terminal.
import { Card, Center, Loader, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { api } from './api';
import { TerminalPage } from './pages/TerminalPage';
import { ViewPage } from './pages/ViewPage';
import { useRoute } from './router';
import { Shell } from './shell/Shell';

type Auth = 'checking' | 'in' | 'out';

/** The token from #k=<token>, or null. */
export function tokenFromFragment(hash: string): string | null {
  const match = /^#k=([0-9a-f]{64})$/.exec(hash);
  return match ? match[1] : null;
}

async function signIn(): Promise<Auth> {
  const token = tokenFromFragment(location.hash);
  if (token) {
    // The fragment never goes to the server, and must not stay in the address bar or the history.
    history.replaceState(null, '', location.pathname + location.search);
    try {
      await api.login(token);
    } catch {
      return 'out';
    }
  }
  try {
    await api.info();
    return 'in';
  } catch {
    return 'out';
  }
}

export function App() {
  const [auth, setAuth] = useState<Auth>('checking');
  const route = useRoute();
  useEffect(() => {
    void signIn().then(setAuth);
  }, []);

  if (auth === 'checking')
    return (
      <Center h="100dvh">
        <Loader />
      </Center>
    );
  if (auth === 'out')
    return (
      <Center h="100dvh" p="md" style={{ background: 'var(--app-bg)' }}>
        <Card maw={440} p="xl">
          <Stack gap="sm" align="center" ta="center">
            <ThemeIcon size={52} radius="xl" variant="light">
              <IconLock size={26} stroke={1.6} />
            </ThemeIcon>
            <Title order={2}>Not signed in</Title>
            <Text c="dimmed" size="sm">
              This page only opens from this PC. In a terminal, run{' '}
              <Text span ff="monospace" fw={600}>
                sandbox web open
              </Text>{' '}
              : it opens the web UI already signed in.
            </Text>
          </Stack>
        </Card>
      </Center>
    );
  if (route.page === 'terminal')
    return (
      <Shell active="sessions" bare>
        <TerminalPage id={route.id} />
      </Shell>
    );
  return (
    <Shell active={route.view}>
      <ViewPage view={route.view} params={route.params} />
    </Shell>
  );
}
