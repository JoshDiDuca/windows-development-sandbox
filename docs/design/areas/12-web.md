# 12 · Web (the `sandbox web` command)

Read [00-worked-example.md](00-worked-example.md) first. This file only says what is special about this area. It is
about **controlling** the web UI server (start, stop, status, open), not about the web UI's pages.

## What it does today

`sandbox web [start|stop|status|open]` runs the web UI server in the background (as the hidden `sandbox _web`), stops
it, says whether it runs, and opens it in the browser already signed in. The menu does not offer it today.

## Files today

| File | What it does |
| --- | --- |
| `src/cli/commands/web.ts` | `web(ctx)` (the four actions, `requireOnPc('web')` first, default action `status`), `startServer()` (spawn `_web`, wait up to `START_WAIT_MS = 15000`), and `webServer(ctx)` = the body of `sandbox _web` (builds `WebRunner` with `new WebService(ctx)` and `createRpcHost(ctx)`) |
| `src/host/web/control.ts` | `WebControl`: `status()` -> `{ running, state }` (GET `/api/health` with a 3 s timeout), `url(state)` (`http://127.0.0.1:<port>/#k=<token>`: **holds the login token**), `stop(state)` (logs in with the token, POST `/api/stop`), `clear()` |
| `src/host/web/state.ts` | `WebStore` (the state file `server.json`: pid, port, token, startedAt) |
| `src/host/web/browser.ts` | `openBrowser(url)` (only `http://127.0.0.1:<port>/` with an optional `#k=<64 hex>`; `refuseInSelfTest('open a browser')`) |
| `src/host/sandbox/platform.ts` | `spawnDetached(entry, args)` (`refuseInSelfTest('start background programs')`) |
| `src/cli/services/web-service.ts` | `WebService`: the server's backend for `/api/info`, `/api/sessions`, `POST /api/sessions` (area 1 replaces the last one). **Not this area** |
| `src/cli/manifest.ts` (entries `name: 'web'` around line 615 and the hidden `name: '_web'`; the file is being edited by another change, search for them) | the command specs |
| `src/cli/commands/registry.ts` | `web: web`, `_web: webServer` in `HANDLERS` |

## CLI surface to keep

Manifest entry today (keep it unchanged, see "Registration"):

```ts
{
  name: 'web',
  summary: '(beta) your sandbox sessions in a browser on this PC: start, stop, status or open',
  group: 'Web',
  examples: ['sandbox web open               start the web UI and open it in your browser'],
  args: [{
    name: 'action',
    description: 'start the server, stop it, show whether it runs, or open it in your browser',
    required: false,
    choices: ['start', 'stop', 'status', 'open'],
  }],
  options: [],
  json,
}
```

Every action calls `requireOnPc('web')` first. Exit 0 unless a `fail`.

| Command | Prints |
| --- | --- |
| `sandbox web` / `sandbox web status` | `--json`: `{ running, port, address }` (`port` and `address` null when not running; `address` = `http://127.0.0.1:<port>/`, **no token**). Text: `The web UI is running at http://127.0.0.1:<port>/ (sandbox web open signs you in).` or `The web UI is not running (sandbox web start).` |
| `sandbox web start` | already running: `The web UI is already running on port <port>.` Otherwise, when `web.enabled` is off, first `web.enabled is off: this starts the web UI for now only. Set it to true in Settings to keep it allowed.`; a stale state file is cleared; then after it answers `The web UI is running at http://127.0.0.1:<port>/ (this PC only).` and `Open it already signed in with: sandbox web open`. Not answering in 15 s: `fail('The web UI did not start.', 'Run sandbox _web to see why (the port <web.port> may be taken: change web.port).')` |
| `sandbox web open` | starts it as above (same lines), then `fail('The web UI stopped right away.', 'Run sandbox web start again.')` if the state is gone, else opens the browser and prints `Opened in your browser.` |
| `sandbox web stop` | no state: `The web UI is not running.`; asks it to stop (or clears a dead state), prints `The web UI stopped.`; not stopping: `fail('The web UI did not stop.', 'End the process <pid> in Task Manager.')` |

Tests asserting these CLI texts: **none found** (`src/selftest/web.test.ts` tests the server, auth, RPC and the state
file, not the command). Keep the texts anyway (docs/commands.md line 86 and docs/web-ui.md describe them).

## Menu surface to keep

None today (grep of `src/cli/menu` finds no web start/stop). This area **adds** a Maintenance category "Web UI".

## Definitions to write (`src/app/features/web/web.def.ts`)

Every definition here is CLI and menu only:

```ts
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
  cli: { name: 'web', action: 'status', json: true },     // --json: { running, port, address } as before
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
  output: z.object({ stopped: z.boolean().describe('It was running and stopped'), message: z.string().describe('What happened') }),
  surfaces: NOT_ON_WEB,
  text: (o) => o.message,
  cli: { name: 'web', action: 'stop' },
});

export function webPage(o: WebStatus): Page { /* below */ }

export const webView = defineView({
  id: 'web',
  title: 'Web UI',
  summary: 'The web UI server on this PC: start, open, stop.',
  queries: { status: webStatus },
  operations: [startWeb, openWeb, stopWeb],
  build: ({ status }) => webPage(status),
});
```

Check that `Surfaces` is exported from the kernel (`src/app/kernel/define.ts` exports `type Surfaces`); if the
assignment does not type-check, write the `surfaces` object in each definition instead.

`webPage(o)`:

- `sections: [{ id: 'web', facts: [ { id: 'running', label: 'Running', value: o.running ? 'yes' : 'no', tone: o.running ? 'ok' : 'muted' },
  ...(o.address ? [{ id: 'address', label: 'Address', value: o.address + '  (this PC only)' }] : []) ],
  actions: o.running ? [open, stop] : [start, open] }]` with
  `open = action(openWeb, {}, { key: 'o', verb: 'open' })`, `start = action(startWeb, {}, { key: 's', verb: 'start' })`,
  `stop = action(stopWeb, {}, { key: 'x', verb: 'stop' })`.
- `notes: [{ text: 'Loopback only, behind a token. Open signs you in.', tone: 'muted' }]` (optional; keep it short).

## Run functions (`src/app/features/web/web.run.ts`)

Move the work of `src/cli/commands/web.ts` here (a module function `startServer(ctx, io, control)` in this file, not
exported from the barrel). `controlOf(ctx)` = `new WebControl(new WebStore(ctx.storageRoot))`.

- `webStatusRun(ctx)`: `requireOnPc('web')`; `const { running, state } = await controlOf(ctx).status()`;
  `port = running && state ? state.port : null`; return `{ running, port, address: port ? 'http://127.0.0.1:' + port + '/' : null }`.
  **Never** return `state` or `control.url(state)` (they hold the token).
- `startServer(ctx, io, control)` -> `{ port, message }`:
  1. already running: return `{ port, message: 'The web UI is already running on port ' + port + '.' }`.
  2. stale state: `control.clear()`.
  3. `web.enabled` off: `io.log('web.enabled is off: this starts the web UI for now only. Set it to true in Settings to keep it allowed.')`.
  4. `io.progress('Starting the web UI')`; `spawnDetached(ctx.entry, ['_web', ...(configFile ? ['--config', path.resolve(configFile)] : [])])`
     with `configFile = ctx.options.config`; poll `control.status()` every 300 ms (`sleep` from `core/util`) up to
     15000 ms.
  5. answering: `io.log('The web UI is running at http://127.0.0.1:' + port + '/ (this PC only).')` and return
     `{ port, message: 'Open it already signed in with: sandbox web open' }` (the CLI prints the log line, then
     `text` = the second line: the same two lines as today).
  6. else `fail('The web UI did not start.', 'Run sandbox _web to see why (the port ' + config.web.port + ' may be taken: change web.port).')`.
- `startWebRun(ctx, _input, io)`: `requireOnPc('web')`; return `startServer(...)`.
- `openWebRun(ctx, _input, io)`: `requireOnPc('web')`; `await startServer(...)`; re-read `status()`; no state ->
  `fail('The web UI stopped right away.', 'Run sandbox web start again.')`; `openBrowser(control.url(state))`;
  return `{ message: 'Opened in your browser.' }`. Do not log the URL.
- `stopWebRun(ctx)`: `requireOnPc('web')`; no state -> `{ stopped: false, message: 'The web UI is not running.' }`;
  `if (!running || (await control.stop(state))) control.clear(); else fail('The web UI did not stop.', 'End the process ' + state.pid + ' in Task Manager.')`;
  return `{ stopped: true, message: 'The web UI stopped.' }`. No confirmation (the command never asked).

## Registration and wiring

- `src/app/features/web/index.ts` barrel; `defs.ts`: `startWeb, openWeb, stopWeb` in `OPERATIONS`, `webStatus` in
  `QUERIES`, `webView` in `VIEWS` (import `./web/web.def.js`); `registry.ts`: the four runs. `createRpcHost` refuses
  them on the web by itself (`onSurface(impl.def, 'web')`), so a browser can never start, stop or open.
- **NAV: no entry.** The view is not shown on the web; the parity check "every view is shown somewhere" is satisfied
  by `MENU_VIEWS`.
- **CLI**: the `web` manifest entry stays hand-written and unchanged (the four hints are `action`s of it). `sandbox web`
  with no action is `status` today and does not match an action, so `web()` in `src/cli/commands/web.ts` becomes:

  ```ts
  /** `sandbox web` with no action is `sandbox web status` (the actions run as definitions). */
  export function web(ctx: Context): Promise<number> {
    return definitionHandler(webStatus)(ctx);
  }
  ```

  `webServer(ctx)` (the hidden `_web` body) stays in that file as it is: it is the server process, not a feature.
  Commander refuses an action outside `choices` (`src/cli/args.ts`), so no unknown-action branch is needed.
- **Menu**: `MENU_VIEWS` gets `{ view: webView, section: 'Maintenance' }`. In `src/cli/menu/pages/maintenance-page.ts`
  add a category (after `logs`, before `more`): `{ id: 'web', label: 'Web UI', description: 'The web UI server on this PC: start it, open it in your browser, stop it.' }`.
  Its rows and keys: `menuView(webPage(status), { category: 'web', prefix: 'web:', refresh: false })` with `status`
  from `readQuery(webStatus, this.ctx)` (a 3 s localhost request at most; read it when the category is opened or in
  `load()` like the logs list). In `act()`, when the open category is `web`, run `resolve()` of this view only (see
  the warning in [00-worked-example.md](00-worked-example.md), section 5) and `perform()` the action;
  `perform` returns `reload: true`, so the facts update after start/stop.
  `open` from the menu starts a browser on the desktop: that is fine (no terminal is taken over).

## Web page

None: `surfaces: { except: { web: 'the page is the web UI' } }` on every definition. The browser already has its own
way to stop the server (`POST /api/stop`, tested in `web.test.ts` "a signed-in browser can stop it"); leave it.

## Delete or shrink afterwards

- `src/cli/commands/web.ts`: `startServer`, `controlOf`, `START_WAIT_MS` and the action switch move to `web.run.ts`;
  the file keeps `web()` (forwarder) and `webServer()`.
- docs/commands.md line 86: still true; docs/web-ui.md: add that the menu has Maintenance > Web UI.

## Tests

Keep passing: `npm test -- web,app,menu` (all of `web.test.ts`: "the token and the cookie", "Host, Origin and CSRF
checks", "the RPC socket", "stopping", "the state file" ...).

Add (in `src/selftest/app.test.ts`, `t.section('web')`):

- "web: CLI and menu only, never runnable from a browser" — every definition with an id starting `web.` has
  `exemption(def, 'web') === 'the page is the web UI'`, and `createRpcHost(ctx).kind('web.start') === undefined`
  (`createRpcHost` from `../app/registry.js`; any `ctx` cast works, nothing runs).
- "web page: start and open when stopped, open and stop when running" — `pageActions(webPage({ running: false, port: null, address: null }))`
  ops are `web.start,web.open`; for `{ running: true, port: 47800, address: 'http://127.0.0.1:47800/' }` they are
  `web.open,web.stop`, and `pageLines(...)` includes `Address` and never `#k=`.
- "web status reads the state file without a token" — ctx with `storageRoot: t.dir('app-web')` (no state file):
  `runDefinition('web.status', ...)` -> `requireOnPc` throws `inside the sandbox already` in the self-test sandbox;
  assert that, and test the shape through `webPage` instead (see Pitfalls).
- "web actions are actions of web" — `definitionFor('web', ['open'])?.id === 'web.open'`, `definitionFor('web', [])`
  is undefined, `commandSpec('web')?.args[0].choices` still lists `start, stop, status, open`.

## Pitfalls

- **The token**: `WebControl.url(state)` and `WebStore` state contain the login token. Never in an output, a log, a
  progress line or a test detail. `address` is the address without `#k=`.
- **Self-test guards**: `spawnDetached` and `openBrowser` call `refuseInSelfTest`, and every run calls
  `requireOnPc('web')`, which fails inside a Windows Sandbox (where the self-test runs). So start/open/stop cannot be
  run in tests; test the pages, the exemptions and the CLI wiring.
- **The server runs the RPC host**: never offer stop/start on the web (the exemption does this). The web page that
  would offer them is the page being served.
- `sandbox _web` stays hand-written and hidden; do not give it a hint.
- The CLI keeps its two-line start output only because the first line is an `io.log` and the second is `text`. In the
  menu, logs without a following question are not shown, so the menu's notice after Start is
  `✓ Open it already signed in with: sandbox web open`; the Address fact (after the reload) shows where it runs. That is
  acceptable; mention it in the report.

## Checklist

1. `web.def.ts`, `web.run.ts`, `index.ts`; `defs.ts` (no NAV entry), `registry.ts`.
2. `commands/web.ts` shrinks to `web()` forwarder + `webServer()`.
3. Maintenance category "Web UI"; `MENU_VIEWS`.
4. Commands (see [00-worked-example.md#commands-to-run](00-worked-example.md#commands-to-run)):

```
npm run build
npm run lint
npm run format:check
npm test -- app,web,menu
npm test
```

`npm test` must print `ALL TESTS PASSED`. By hand: `node dist/bin/agent-sandbox.js web --help` lists the same actions.
(`web status` fails inside the sandbox with the `requireOnPc` message, as it does today.) Re-read
[00-worked-example.md#common-mistakes](00-worked-example.md#common-mistakes) and
[00-worked-example.md#writing-a-run-test](00-worked-example.md#writing-a-run-test).

## Report template

```
Area 12 (web) — branch web-ui/web
Moved: sandbox web start/stop/status/open -> src/app/features/web (web.status, web.start, web.open, web.stop, view web; all except web)
Shrunk: src/cli/commands/web.ts -> web() forwarder + webServer()
Menu: new Maintenance category "Web UI" (keys s/o/x)
Web: none (exempt)
CLI text changes: none / ...
Tests added: ...
Unsure / left undone: ...
```
