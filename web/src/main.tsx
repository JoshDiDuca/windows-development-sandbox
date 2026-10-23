// The web UI's entry: Mantine (its static stylesheets: no CSS-in-JS script, so the CSP holds), dark or light with the
// operating system, notifications and modals, TanStack Query, and the RPC client.
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '@mantine/spotlight/styles.css';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RpcClient } from './rpc/client';
import { RpcProvider } from './rpc/hooks';
import { theme } from './theme';
import './app.css';

const queries = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
const rpc = new RpcClient();
// A hidden tab reads nothing but keeps its idle connection (the server stays while a page is open); a closed one closes
// it at once (the server frees it), and one the browser brings back from its cache connects again.
document.addEventListener('visibilitychange', () => rpc.setHidden(document.hidden));
window.addEventListener('pagehide', () => rpc.release());
window.addEventListener('pageshow', (event) => {
  if (event.persisted) rpc.resume();
});

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <QueryClientProvider client={queries}>
        <RpcProvider client={rpc}>
          <ModalsProvider>
            <Notifications position="bottom-right" limit={4} />
            <App />
          </ModalsProvider>
        </RpcProvider>
      </QueryClientProvider>
    </MantineProvider>,
  );
