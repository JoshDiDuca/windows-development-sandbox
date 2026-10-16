// The web UI server on this PC: whether it runs, and start, open and stop it. Pure: schemas, labels and the view;
// web.run.ts does the work. The web UI cannot control its own server (the page is the web UI), so every definition is
// CLI and menu only. Nothing here carries the login token: the address the page shows has none.
import { z } from 'zod';
import { action, defineOperation, defineQuery, defineView, type Page, type Surfaces } from '../../kernel/index.js';

const NOT_ON_WEB: Surfaces = { except: { web: 'the page is the web UI' } };

export const WebStatusSchema = z.object({
  running: z.boolean().describe('The web UI server answers'),
  port: z.number().nullable().describe('Its port on 127.0.0.1, when it runs'),
  address: z.string().nullable().describe('Its address (without the login token), when it runs'),
});
export type WebStatus = z.output<typeof WebStatusSchema>;

const MessageSchema = z.object({ message: z.string().describe('What happened') });

export const webStatus = defineQuery({
  id: 'web.status',
  title: 'Web UI',
  summary: 'whether the web UI server runs, and its address',
  input: z.object({}),
  output: WebStatusSchema,
  surfaces: NOT_ON_WEB,
  text: (o) =>
    o.running && o.port
      ? 'The web UI is running at http://127.0.0.1:' + o.port + '/ (sandbox web open signs you in).'
      : 'The web UI is not running (sandbox web start).',
  cli: { name: 'web', action: 'status', json: true },
});

export const startWeb = defineOperation({
  id: 'web.start',
  title: 'Start the web UI',
  summary: 'start the web UI server in the background (this PC only)',
  input: z.object({}),
  output: z.object({ port: z.number().describe('Its port'), message: z.string().describe('What happened') }),
  surfaces: NOT_ON_WEB,
  text: (o) => o.message,
  cli: { name: 'web', action: 'start' },
});

export const openWeb = defineOperation({
  id: 'web.open',
  title: 'Open the web UI',
  summary: 'start the web UI if needed and open it in your browser, signed in',
  input: z.object({}),
  output: MessageSchema,
  surfaces: NOT_ON_WEB,
  text: (o) => o.message,
  cli: { name: 'web', action: 'open' },
});

export const stopWeb = defineOperation({
  id: 'web.stop',
  title: 'Stop the web UI',
  summary: 'stop the web UI server',
  input: z.object({}),
  output: z.object({
    stopped: z.boolean().describe('It was running and stopped'),
    message: z.string().describe('What happened'),
  }),
  surfaces: NOT_ON_WEB,
  text: (o) => o.message,
  cli: { name: 'web', action: 'stop' },
});

/** The web UI's Maintenance category (the menu): running or not, its address, and the three actions. */
export function webPage(o: WebStatus): Page {
  const open = action(openWeb, {}, { key: 'o', verb: 'open' });
  const start = action(startWeb, {}, { key: 's', verb: 'start' });
  const stop = action(stopWeb, {}, { key: 'x', verb: 'stop' });
  return {
    title: 'Web UI',
    sections: [
      {
        id: 'web',
        facts: [
          {
            id: 'running',
            label: 'Running',
            value: o.running ? 'yes' : 'no',
            tone: o.running ? 'ok' : 'muted',
          },
          ...(o.address ? [{ id: 'address', label: 'Address', value: o.address + '  (this PC only)' }] : []),
        ],
        actions: o.running ? [open, stop] : [start, open],
        notes: [{ text: 'Loopback only, behind a token. Open signs you in.', tone: 'muted' as const }],
      },
    ],
  };
}

export const webView = defineView({
  id: 'web',
  title: 'Web UI',
  summary: 'The web UI server on this PC: start, open, stop.',
  queries: { status: webStatus },
  operations: [startWeb, openWeb, stopWeb],
  build: ({ status }) => webPage(status),
});
