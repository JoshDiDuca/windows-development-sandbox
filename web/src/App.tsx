// Signs in from the #k= fragment (the owner's link) or #w= (another Windows user's one-time link from sandbox remote
// --browser), then removes it from the address bar, and shows the page the address names inside the shell: a view, or a
// session's terminal. Not signed in: the sign-in page (on your network: the device code).
import { Center, Loader } from '@mantine/core';
import { useEffect, useState } from 'react';
import { setAccess } from './access';
import { api } from './api';
import { SignIn } from './pages/SignIn';
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

/** A Windows user's one-time token from #w=<token>, or null. */
export function onceFromFragment(hash: string): string | null {
  const match = /^#w=([0-9a-f]{64})$/.exec(hash);
  return match ? match[1] : null;
}

async function signIn(): Promise<Auth> {
  const token = tokenFromFragment(location.hash);
  const once = onceFromFragment(location.hash);
  if (token || once) {
    // The fragment never goes to the server, and must not stay in the address bar or the history.
    history.replaceState(null, '', location.pathname + location.search);
    try {
      if (token) await api.login(token);
      else if (once) await api.loginOnce(once);
    } catch {
      return 'out';
    }
  }
  try {
    setAccess((await api.me()).access);
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
  if (auth === 'out') return <SignIn onSignedIn={() => void signIn().then(setAuth)} />;
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
