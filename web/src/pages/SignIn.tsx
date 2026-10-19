// The page before signing in. On this PC: how to open the web UI signed in. On your network (HTTPS, LAN mode): the
// one-time code the PC shows under Remote access > Allow a new device, and a name for this device; the server then
// remembers the device for the days the owner chose.
import { Alert, Button, Card, Center, Stack, Text, TextInput, ThemeIcon, Title } from '@mantine/core';
import { IconDeviceMobile, IconLock } from '@tabler/icons-react';
import { useState } from 'react';
import { api } from '../api';

/** A name for this device from its browser ("iPhone", "Android phone"), which the owner can tell apart. */
function guessName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Device';
}

function OnThisPc() {
  return (
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
      <Text c="dimmed" size="xs">
        Another Windows user of this PC, allowed by its owner, runs{' '}
        <Text span ff="monospace" fw={600}>
          sandbox remote --browser
        </Text>{' '}
        instead.
      </Text>
    </Stack>
  );
}

function OnYourNetwork({ onSignedIn }: { readonly onSignedIn: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState(guessName);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await api.pair(code, name);
      onSignedIn();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Stack gap="sm">
        <Stack gap={4} align="center" ta="center">
          <ThemeIcon size={52} radius="xl" variant="light">
            <IconDeviceMobile size={26} stroke={1.6} />
          </ThemeIcon>
          <Title order={2}>Sign in this device</Title>
          <Text c="dimmed" size="sm">
            On the PC, open Remote access and choose Allow a new device. Type the code it shows.
          </Text>
        </Stack>
        <TextInput
          label="Code"
          placeholder="ABCD-EFGH"
          value={code}
          onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
          autoCapitalize="characters"
          autoComplete="one-time-code"
          spellCheck={false}
          maxLength={12}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', letterSpacing: 2, fontSize: 20 } }}
          data-autofocus
        />
        <TextInput
          label="Name for this device"
          description="The PC lists it by this name."
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          maxLength={40}
        />
        {problem && (
          <Alert color="red" variant="light">
            {problem}
          </Alert>
        )}
        <Button type="submit" loading={busy} disabled={code.replace(/[\s-]/g, '').length !== 8}>
          Sign in
        </Button>
        <Text c="dimmed" size="xs" ta="center">
          Your browser warned about the certificate the first time: that is expected once. If it warns again later, stop
          and ask the owner of the PC.
        </Text>
      </Stack>
    </form>
  );
}

export function SignIn({ onSignedIn }: { readonly onSignedIn: () => void }) {
  const lan = location.protocol === 'https:';
  return (
    <Center h="100dvh" p="md" style={{ background: 'var(--app-bg)' }}>
      <Card maw={440} w="100%" p="xl">
        {lan ? <OnYourNetwork onSignedIn={onSignedIn} /> : <OnThisPc />}
      </Card>
    </Center>
  );
}
