// The page before signing in. On this PC: how to open the web UI signed in. On your network (HTTPS, LAN mode): the
// one-time code the PC shows under Remote access > Allow a new device, and a name for this device; the server then
// remembers the device for the days the owner chose.
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  CopyButton,
  Group,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconBox, IconCheck, IconCopy, IconDeviceMobile, IconLock } from '@tabler/icons-react';
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

/** A command to type, with a button that copies it. */
function Command({ text }: { readonly text: string }) {
  return (
    <span className="command-chip">
      {text}
      <CopyButton value={text}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? 'Copied' : 'Copy'}>
            <ActionIcon size="sm" aria-label={'Copy ' + text} onClick={copy}>
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </span>
  );
}

function OnThisPc() {
  return (
    <Stack gap="md" align="center" ta="center">
      <ThemeIcon size={48} radius="md" variant="light">
        <IconLock size={24} stroke={1.6} />
      </ThemeIcon>
      <Stack gap={6} align="center">
        <Title order={2}>Sign in to Sandbox</Title>
        <Text c="dimmed" size="sm" maw={340}>
          For your security, the web UI opens signed in from a terminal on this PC. Run:
        </Text>
      </Stack>
      <Command text="sandbox web open" />
      <Text c="dimmed" size="xs" maw={340}>
        Another Windows user of this PC, if the owner allowed it, runs{' '}
        <Text span ff="monospace" size="xs">
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
      setProblem(e instanceof Error ? e.message : 'Sign-in failed. Check the code and try again.');
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
          <ThemeIcon size={48} radius="md" variant="light">
            <IconDeviceMobile size={24} stroke={1.6} />
          </ThemeIcon>
          <Title order={2} mt={6}>
            Sign in this device
          </Title>
          <Text c="dimmed" size="sm">
            On the PC, open Remote access and choose Allow a new device, then enter the code it shows.
          </Text>
        </Stack>
        <TextInput
          label="Pairing code"
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
          description="Shown in the PC’s list of devices."
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
          A certificate warning the first time is expected. If it appears again later, stop and ask the owner of the
          PC.
        </Text>
      </Stack>
    </form>
  );
}

export function SignIn({ onSignedIn }: { readonly onSignedIn: () => void }) {
  // #device shows the device form on this PC too (the preview's screenshots); signing in still needs the LAN listener.
  const lan = location.protocol === 'https:' || location.hash === '#device';
  return (
    <main className="signin-page">
      <Stack gap="lg" align="center" w="100%" maw={420}>
        <Group gap={10}>
          <div className="brand-mark" aria-hidden="true">
            <IconBox size={16} stroke={2} />
          </div>
          <Text fw={650}>Sandbox</Text>
        </Group>
        <Card w="100%" p="xl">
          {lan ? <OnYourNetwork onSignedIn={onSignedIn} /> : <OnThisPc />}
        </Card>
      </Stack>
    </main>
  );
}
