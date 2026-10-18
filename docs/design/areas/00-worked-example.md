# 00 · Worked example: how the sessions feature is built

Mandatory reading before any area file (01 to 13). It walks through **one** finished feature, `sessions`, file by
file, with code copied from the repository, and says what you must copy for your own area. When an area file says
"like sessions", it means "like this file".

Read [shared-core.md](../shared-core.md) first (the contract). This file is the practical version of its "How to add a
feature" section. If the code and this file disagree, the code wins: say so in your report.

## The files of one feature

| File | What it holds | May import |
| --- | --- | --- |
| `src/app/features/sessions/sessions.def.ts` | ids, zod input/output, labels, CLI hints, `text()`, the view and its pure page builder | `zod`, `../../kernel/index.js`, other `*.def.ts` of the folder, `core/util/errors` |
| `src/app/features/sessions/sessions.run.ts` | `implement(def, async (ctx, input, io) => ...)` for each definition: the work, over the services | services (`src/cli/services`), host modules, `cli/commands/context.js`, `cli/commands/shared-use.js`, `core/util` |
| `src/app/features/sessions/index.ts` | the barrel: `export * from './sessions.def.js'; export * from './sessions.run.js';` | its own two files only |
| `src/app/features/defs.ts` | adds the definitions to `OPERATIONS` / `QUERIES` / `VIEWS`, and the view to `NAV` | `*.def.ts` files **directly** (never a barrel) |
| `src/app/registry.ts` | adds the run functions to `IMPLEMENTATIONS` | the feature's barrel |
| `src/cli/menu/views.ts` | `MENU_VIEWS`: which menu section shows the view | the feature's barrel |
| `src/cli/menu/pages/sessions-page.ts` | the menu page: draws the view with `menuView`, runs actions with `MenuOperations` | barrel, `registry.ts`, the TUI |
| `web/src/...` | nothing for sessions: `ViewPage` draws every view in `NAV` | only `src/app/features/defs`, `src/app/kernel`, `src/shared/web` |

Settings has a few more files (`categories.def.ts`, `settings-file.ts`, `settings-rows.ts`). That is allowed: a pure
helper goes in another `*.def.ts`, a Node helper in a plain `.ts` file of the folder (imported by `*.run.ts` only).

## 1. The definition (`sessions.def.ts`)

### Imports

```ts
import { z } from 'zod';
import {
  action,
  ago,
  defineOperation,
  defineQuery,
  defineView,
  link,
  type Item,
  type Page,
  type Section,
} from '../../kernel/index.js';
```

Nothing else. **A `*.def.ts` cannot import `core/schema`** (only `core/util/errors` from core), nor `node:` modules,
lodash, services or another feature's barrel. If you need a schema that exists in `src/core/schema`, write the shape
you need again in zod inside your def (only the fields the surfaces show). `npm run lint` enforces this
(`eslint.config.mjs`, "The kernel and *.def.ts are pure").

### Output schemas: every field the surfaces see, with `.describe()`

```ts
export const SessionRowSchema = z.object({
  id: z.string().describe('The session'),
  launchId: z.string(),
  harness: z.string().describe('The agent'),
  cwd: z.string().describe('Its folder in the sandbox'),
  project: z.string().optional(),
  phase: z.enum(['starting', 'running', 'exited', 'failed']).describe('What it is doing'),
  ...
  /** It runs and its terminal can be reached from this PC. */
  canOpen: z.boolean(),
});
export type SessionRow = z.output<typeof SessionRowSchema>;
```

- Output schemas are what the web receives. **Never put a secret, a token or an attach address in one**: the sessions
  row deliberately leaves out `attach` (see `sessionRow()` in the run file).
- The reference features do not describe every output field (only inputs are strict). For new areas the rule in
  web-ui-tasks.md is stricter: **`.describe()` on every input and output field.** Do it.
- Export the `type X = z.output<typeof XSchema>` so the page builder and tests can use it.

### A query (reads something)

```ts
export const listSessions = defineQuery({
  id: 'sessions.list',
  title: 'Sessions',
  summary: 'list agent sessions and who is attached',
  input: z.object({ wide: z.boolean().default(false).describe("also show each session's folder") }),
  output: SessionsListSchema,
  live: { everyMs: 2500 },
  cli: {
    name: 'sessions',
    group: 'Sessions',
    json: true,
    flags: { wide: { flag: '--wide', noMenu: true } },
    // The --json shape `sandbox sessions` has always printed: the session records, without the web's field.
    shapeJson: (o) => o.sessions.map(({ canOpen: _canOpen, ...s }) => s),
  },
});
```

Every part:

- `id`: `<area>.<verb>` in camelCase after the dot (`sessions.list`, `sandbox.showWindow`). Unique; the web calls it.
- `title`: the menu row / web heading / button text. `summary`: lower case, no full stop; it is `--help`'s line
  unless `cli.summary` overrides it. **Copy the old manifest `summary` exactly**, or `--help` changes.
- `input`: `z.object({...})`, every field with `.describe()`. The describe text becomes the `--help` text of the
  flag and the label help in the menu and the web. **Copy the old manifest option description exactly** (the `app`
  suite compares `[flag, short, shownAs, type, description]` for the reference commands, and your area's existing
  tests may print `--help`). Use `.default(...)` for flags that have a default, `.optional()` for ones that may be
  left out.
- `live: { everyMs }`: only for queries that change by themselves (status, sessions, logs follow). The menu's page
  and the web's subscription re-read it that often.
- `cli` (the CLI hint, `TypedCliHint` in `src/app/kernel/define.ts`):
  - `name`: the command (`sandbox sessions`). Must equal the old manifest `name`.
  - `group`: one of `'Agents' | 'Sessions' | 'Projects & accounts' | 'Data' | 'Web' | 'Health' | 'Advanced'`
    (the `--help` group); required for a command of its own. Copy it from the old manifest entry.
  - `action`: only when the definition is one action of a **hand-written** command (`config get`); see
    `settings.def.ts` (`cli: { name: 'config', action: 'get', positional: ['key'], json: true }`). Then the
    hand-written command keeps its manifest entry and its other actions; `withActions()` in
    `src/cli/operations/spec.ts` adds yours to the first argument's choices.
  - `positional: ['field', ...]`: input fields given as positional arguments, in order (after the action, if any). A
    missing required one fails with `Missing <field>.` and `Usage: sandbox <name> [action] <field>`
    (`src/cli/operations/input.ts`).
  - `flags: { field: { flag, short?, shownAs?, value?, choices?, noMenu?, advanced?, label? } }`:
    - `flag`: the long flag (`'--wide'`); with `shownAs`, `flag` is the **old, hidden** spelling still accepted and
      `shownAs` the one `--help` shows. Example from restart: `harness: { flag: '--harness', shownAs: '--agent',
      value: 'name', choices: 'harnesses' }` gives `--agent <name>` in help and still accepts `--harness`.
    - `short`: `'-t'` style one-letter alias.
    - `value`: the placeholder in `--help` (`<name>`); default: the field name.
    - `choices`: a fixed list, or `'harnesses' | 'accounts' | 'sessions'` (filled in at run time for the menu's
      command form). A `z.enum` input gets its choices automatically.
    - `noMenu: true`: the menu's command form does not offer it (`--wide`, `--yes`). `advanced: true`: shown under
      "advanced" in the form.
    - The option type comes from the zod field: boolean -> switch flag, number -> number, array -> list, the rest
      string (`OPTION_TYPES` in `spec.ts`).
  - `yes: '<help line>'`: adds `-y/--yes`, which answers confirmations on the command line (see `stopSandbox`:
    `yes: "do not ask when other projects' sessions would end"`). Do **not** also put `yes` in the input.
  - `json: true`: adds `--json`. Without `shapeJson` it prints the output as is.
  - `shapeJson(output)`: when the old `--json` shape differs from the new output (here: the old command printed the
    array of sessions; the new output is an object with more fields). **Whenever an area has a `--json` today, compare
    the old JSON with your output and add `shapeJson` if they differ.** Scripts depend on it.
  - `examples`: extra `--help` examples, copied from the old manifest entry if it had any.

### An operation (does something)

```ts
export const restartSessions = defineOperation({
  id: 'sessions.restart',
  title: 'Restart agents',
  summary: "restart this project's running agents in place; they resume their conversation",
  input: z.object({
    harness: z.string().optional().describe('only this agent'),
    all: z.boolean().default(false).describe("every project's sessions, not only this folder's"),
  }),
  output: z.object({ message: z.string().describe("The sandbox's answer") }),
  text: (o) => o.message,
  cli: {
    name: 'restart',
    group: 'Agents',
    flags: {
      harness: { flag: '--harness', shownAs: '--agent', value: 'name', choices: 'harnesses' },
      all: { flag: '--all' },
    },
  },
});
```

- `text(output)`: the **one line** the CLI prints, the menu shows as a notice (`✓ ...`) and the web as a green
  notification. Keep the exact sentence the old command printed (tests grep for it). An operation that printed several
  lines prints the extra ones through `io.log` in its run, and `text` is the last line.
- A query without `text` prints, on the CLI, the page of the view that shows only that query (here: `sandbox
  sessions` prints `sessionsPage`); otherwise its JSON. See `printOutput` in `src/cli/operations/handler.ts`.
- `danger: true` (see `stopSandbox`) only paints it red; the run still asks with `io.confirm`.
- `surfaces`: omit it (= everywhere) or `surfaces: { except: { web: 'why not' } }`. The reason must be a real
  sentence; the parity test ignores an empty reason.

### The view (what a screen shows)

```ts
export const sessionsView = defineView({
  id: 'sessions',
  title: 'Sessions',
  summary: 'The agent sessions of the running sandbox: open one, restart the agents.',
  queries: { sessions: listSessions },
  operations: [restartSessions],
  build: ({ sessions }) => sessionsPage(sessions),
});
```

- `queries`: name -> query. `build` receives the outputs under the same names.
- `operations`: **every** operation the page may offer, also ones only in `empty` or on items. The parity test reads
  this list to decide that the menu and the web can reach them; the `app` suite also checks the page offers only
  operations listed here ("the page offers only operations its view declares").
- `tabs` (optional, see `settingsView`): a parameter switched with tabs (`{ param: 'scope', choices: [{ value:
  'user', label: 'All projects' }, ...] }`) and `inputs(params)` that turns it into query inputs.
- `build` must be pure: no clock other than `ago()`, no I/O. Put the builder in an exported function
  (`sessionsPage`) so tests and the menu page can call it with a hand-made model.

### The page builder (`sessionsPage`): the shapes you will use

```ts
export function sessionsPage(o: SessionsList): Page {
  const sessions = orderedSessions(o.sessions);
  const agent = o.defaultAgent;
  const start = link({ kind: 'start-agent', agent }, 'Start ' + agent, { verb: 'start' });
  ...
  return {
    title: 'Sessions',
    ...(o.owner ? { notice: { text: o.owner, tone: 'accent' } } : {}),
    sections: [
      {
        id: 'sessions',
        columns: [{ key: 'here', label: '' }, { key: 'id', label: 'ID' }, ... ],
        items: sessions.map((s) => sessionItem(s, o.wide)),
        notes: [
          ...(sessions.some((s) => s.here) ? [{ text: '* = the project of this folder', tone: 'muted' as const }] : []),
          ...(o.wide ? [] : [{ text: 'Folders: sandbox sessions --wide', tone: 'muted' as const, only: 'cli' as const }]),
        ],
      },
      ...startSection,
    ],
    actions: [
      ...(sessions.length
        ? [action(restartSessions, { all: false }, { key: 'r', verb: 'restart agents', importance: 1 })]
        : []),
      link({ kind: 'command', argv: ['resume'] }, 'Reopen last sessions', { key: 'o', verb: 'reopen last sessions', importance: 2 }),
    ],
    empty: {
      title: o.sandboxRunning ? 'No sessions' : 'No sandbox is running',
      text: o.sandboxRunning ? 'No agent is running. Start ' + agent + ' in this folder.' : '...',
      action: start,
      cliText: 'No sessions. Start one with: sandbox claude',
    },
  };
}
```

What each part becomes on each surface (types in `src/app/kernel/view.ts`):

| Page part | CLI (`src/cli/output/render-view.ts`) | Menu (`src/cli/menu/render-view.ts`) | Web (`web/src/render/PageView.tsx`) |
| --- | --- | --- | --- |
| `notice` | bold first line | not drawn by `menuView` (a page may show it itself) | an alert at the top |
| `section.title` / `summary` | bold heading after a blank line | the rows' section heading | card title |
| `section.facts` | aligned `Label  value` rows | one row per fact (value as hint) | label/value grid |
| `section.items` | one line each (`* ` when `marked`), `details` indented | one row each; `group` overrides the heading | rows, badges, buttons |
| `section.columns` (+ `item.cells`) | a table | ignored (rows) | a table unless `columnsOn: 'cli'` |
| `section.notes` | dimmed lines (`only: 'cli'` = CLI only) | not shown | small text (`only: 'web'` = web only) |
| `section.actions` | not shown | a row each under "Actions" | buttons on the card |
| `page.actions` | not shown | key bar keys (`key`, `verb`, `importance`) | header buttons |
| `item.primary` | not shown | what Enter does (Enter label = `verb`) | click on the row |
| `item.actions` | not shown | keys that apply to that row only | buttons on the row |
| `item.disabled` | not shown | greyed row with the reason | greyed, reason shown |
| `empty` (no facts and no items) | `cliText` (or `text`) | one row offering `empty.action` | text + button |

Actions:

- `action(def, input, extra)` runs an operation with that input. `extra` holds `key` (one menu letter), `verb` (the key
  bar / Enter word), `importance` (0 never hidden, bigger hides earlier in a narrow key bar), `description`, and
  `fields` + `initial` to ask values first (see `settingsPage`: `fields: [valueField]` edits a setting).
- `link(target, label, extra)` goes somewhere: `{ kind: 'terminal', session }` (menu attaches, web opens the terminal
  page), `{ kind: 'start-agent', agent }` (menu runs `launch --harness <agent>`, web opens `NewSessionModal`; area 1
  replaces it), `{ kind: 'view', view }`, and `{ kind: 'command', argv }` (**temporary**: the menu runs the command,
  the web hides it; each area removes the `command` links that point at it).
- Keys must not clash on one page; `l` is taken by refresh (`REFRESH_KEY` in `src/cli/menu/render-view.ts`).
- Copy the menu's **current** keys and Enter labels for your area (each area file lists them); the menu tests check them.
- Text that came from the sandbox goes through `safeText` in the run file, never in the def (the def cannot import it).

## 2. The run (`sessions.run.ts`)

```ts
import { safeText } from '../../../core/util/index.js';
import { hostEndpoint } from '../../../host/channel/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { requireOnPc, requireRunning } from '../../../cli/commands/context.js';
import { lookAtSandbox, useSharedSandbox } from '../../../cli/commands/shared-use.js';
import { SessionsService, type ListedSession } from '../../../cli/services/index.js';
import { implement, typedConfirm } from '../../context.js';
import { cancelled } from '../../kernel/index.js';
import { listSessions, restartSessions, type SessionRow } from './sessions.def.js';
```

A run may import services, host modules, `core/util`, `cli/commands/context.js` and `cli/commands/shared-use.js`. It
may **not** import `src/cli/tui`, `src/cli/menu`, `src/cli/output`, React, Mantine or `@inquirer` (lint rule
"Features talk through io and never draw"). It never calls `console.log`.

### A query's run

```ts
export const listSessionsRun = implement(listSessions, async (asked, input) => {
  // Another user's sandbox: shared, its sessions are listed from their folders; not shared, only whose it is.
  const view = lookAtSandbox(asked);
  const base = {
    sandboxRunning: isSandboxRunning(),
    defaultAgent: asked.loaded.config.defaultHarness,
    wide: input.wide,
    ...(view.line ? { owner: view.line } : {}),
  };
  if (view.limited) return { ...base, sessions: [] };
  const list = await new SessionsService(view.ctx).list();
  return { ...base, sessions: list.map(sessionRow) };
});
```

- `implement(def, async (ctx, input, io) => output)` (from `src/app/context.ts`). `ctx` is the CLI's `Context`
  (settings in `ctx.loaded.config`, `ctx.storageRoot`, `ctx.options`...). `input` is already parsed (defaults filled).
  The returned value is checked against the output schema by `invoke()`: a missing field throws.
- Queries never ask questions (the menu and web read them with `NO_QUESTIONS`; a question there is a bug).
- Reading another user's sandbox: `lookAtSandbox(ctx)` gives `{ ctx, line, limited }`; use `view.ctx` to read, show
  `view.line`, and return nothing more when `limited`.

### An operation's run

```ts
export const restartSessionsRun = implement(restartSessions, async (ctx, input, io) => {
  requireOnPc('restart');
  requireRunning();
  await useSharedSandbox(ctx, { kind: 'owner-only', what: 'restart the agents' }, typedConfirm(io));
  const service = new SessionsService(ctx);
  const scope = service.restartScope(input.all);
  if (scope.notAProject)
    io.log(scope.folder + ' is not a project of the running sandbox: restarting every session.', 'muted');
  const what = scope.guest ? 'the agents of ' + scope.projectName : 'every agent';
  const yes = await io.confirm({
    title: 'Restart ' + what + '?',
    lines: ['The agents are started again and continue their conversations where they can.'],
    yes: 'Restart',
    implied: true,
  });
  if (!yes) cancelled();
  io.progress('Restarting the agents' + (scope.guest ? ' of ' + scope.projectName : ''));
  return { message: safeText(await service.restart(input.harness ?? null, scope.guest)) };
});
```

The pieces to copy:

- **Guards first**: `requireOnPc('<command>')` for anything that controls the sandbox from outside, `requireRunning()`
  when a running sandbox is needed. They `fail(message, fix)` with the texts users already know.
- **Another user's sandbox**: `await useSharedSandbox(ctx, { kind: 'owner-only', what: '<what you do>' },
  typedConfirm(io))` before changing anything. It asks to type the owner's name through `io` (typed confirm) and
  returns the context to use. Look at `stopSandboxRun` for the variant that needs the owner's data folder.
- **`io.log(text, tone?)`**: a line worth keeping (CLI prints it; menu shows it above the next question; web shows it
  with the result). **`io.progress(text)`**: what is happening now (spinner / notice / loading notification), no
  trailing "…" (the surfaces add it).
- **`io.confirm({...})`** fields (`ConfirmQuestionSchema` in `src/app/kernel/io.ts`):
  - `title`, `lines`, `yes` (button word), `danger`.
  - `implied: true`: the CLI does **not** ask (typing the command was the decision), the menu and web still ask. Use it
    wherever the old command did not ask.
  - Without `implied`: the CLI asks on a terminal, `--yes` answers it, and without a terminal it fails with
    `noTerminal: { message, fix }` (default "Cannot ask here (no terminal)." / "Add --yes to answer yes.").
    Use it wherever the old command asked (and copy its message/fix texts into `noTerminal`).
  - `typed: '<word>'`: the user must type the word (another user's name); `typedConfirm(io)` builds this for you.
- **`io.choose`, `io.text`, `io.secret`, `io.path`, `io.checklist`** return `undefined` when backed out. `text`,
  `secret` and `path` take `validate: (v) => true | 'what is wrong'` and are asked again with the problem. On the CLI
  they need a terminal ("Run it in a terminal, or give the value on the command line."), so an input that the CLI
  passes as a flag or positional should be in the **input**, and the run asks only when the input left it out.
- **`cancelled()`** after a "no" or a backed-out question: the CLI prints `Nothing changed.` and exits 1; the menu
  and the web say nothing.
- **`fail(message, fix)`** (from `core/util`) for errors the user can act on. Keep the old texts word for word.
- **Never print** and never return anything secret. Text from the sandbox goes through `safeText`.

## 3. Registration

`src/app/features/defs.ts` (pure; imports the def file directly, never the barrel, or the web bundle pulls in Node
code):

```ts
import { listSessions, restartSessions, sessionsView } from './sessions/sessions.def.js';

export const OPERATIONS = [showWindow, hideWindow, stopSandbox, restartSessions, setSetting, resetSetting] as const;
export const QUERIES = [sandboxStatus, listSessions, listSettings, getSetting] as const;
export const VIEWS = [sandboxView, sessionsView, settingsView] as const;
...
export const NAV: readonly NavSection[] = [
  { label: 'Agents', elsewhere: 'Start agents from the menu (sandbox) or with sandbox <agent>.' },
  { label: 'Sessions', view: 'sessions' },
  ...
];
```

`src/app/registry.ts` (Node):

```ts
import { listSessionsRun, restartSessionsRun } from './features/sessions/index.js';

export const IMPLEMENTATIONS: readonly Implementation<AnyDefinition, AppContext>[] = [
  ...
  listSessionsRun,
  restartSessionsRun,
  ...
];
```

`src/cli/menu/views.ts`:

```ts
export const MENU_VIEWS: readonly MenuViewPlace[] = [
  { view: sessionsView, section: 'Sessions' },
  { view: sandboxView, section: 'Sandbox' },
  { view: settingsView, section: 'Settings' },
];
```

`section` is one of `SECTION_LABELS` in `src/cli/menu/shell.ts`:
`'Agents', 'Sessions', 'Sandbox', 'Apps', 'Settings', 'Accounts', 'Maintenance'`.

Rules the `app` suite enforces ("parity: every operation and query on every surface"):

- every definition in `OPERATIONS`/`QUERIES` has exactly one implementation in `IMPLEMENTATIONS` and vice versa;
- CLI: a definition is reachable when it has a `cli` hint (or a CLI exemption);
- menu: when a view in `MENU_VIEWS` lists it (`operations` or `queries`), or it has a menu exemption;
- web: when a view in `NAV` lists it, or it has a web exemption;
- every view in `VIEWS` is in `NAV` or `MENU_VIEWS`, and every `NAV` entry without a view has an `elsewhere` text;
- every name in a CLI hint's `positional`/`flags` is a field of the input; every command of its own has a `group`.

## 4. The command line: nothing to write, something to delete

The hint makes the command. `withOperationCommands()` (`src/cli/operations/spec.ts`) turns each hint into a manifest
`CommandSpec` (so `--help`, the parser and the menu's command list see it), and `src/cli/index.ts` runs it through
`operationHandler()` before looking in `HANDLERS`. What you **delete** is the old hand-written copy. For sessions, the
commit that moved it removed from `src/cli/manifest.ts`:

```ts
-  {
-    name: 'restart',
-    summary: "restart this project's running agents in place; they resume their conversation",
-    group: 'Agents',
-    args: [],
-    options: [
-      text('--harness', 'name', 'only this agent', { choices: 'harnesses', shownAs: '--agent' }),
-      bool('--all', "every project's sessions, not only this folder's"),
-    ],
-  },
```

from `src/cli/commands/registry.ts` the `restart: restart, sessions: sessions, ...` handlers, and the files
`src/cli/commands/sessions/control.ts`, `list.ts`, `status.ts`, `window.ts`. Compare the old entry with your hint line
by line: `name`, `summary`, `group`, every option's flag/short/shownAs/value/choices/description, `json`, `examples`.
A command that keeps some actions hand-written keeps its manifest entry and gets yours added as `action`s.

Then update docs/commands.md if anything a user types or reads changed.

## 5. The menu

`src/cli/menu/pages/sessions-page.ts` (the whole page, 52 lines):

```ts
function view(m: SessionsModel): MenuView {
  return menuView(sessionsPage({ ...m, wide: false }));
}

export function sessionsOptions(m: SessionsModel): ListOptions<string> {
  const v = view(m);
  return { path: [], items: v.items, actions: v.actions, enterLabel: v.enterLabel };
}

export class SessionsPage extends ListPage<string> {
  readonly label = 'Sessions';
  ...
  protected async load(): Promise<void> {
    this.model = await readQuery(listSessions, this.ctx);
  }
  protected options(): ListOptions<string> {
    return sessionsOptions(this.model);
  }
  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    const chosen = view(this.model).resolve(result);
    if (!chosen) return {};
    if (chosen.kind === 'refresh') return { reload: true };
    return this.operations.perform(chosen.action, [this.label], (text) => this.busy(text));
  }
}
```

- `load()` reads the view's queries with `readQuery(def, ctx, input?)` (typed, no questions).
- `options()` is pure and exported (`sessionsOptions`) so `menu.test.ts` can check rows and keys without a screen.
- `menuView(page, { category?, prefix?, refresh? })` turns the Page into rows, the key bar and Enter labels.
- `act()` = `resolve(result)` then `MenuOperations.perform(action, where, busy)`: it asks the action's `fields` with
  the settings editors, runs the operation with the TUI dialogs as `io`, and returns `{ reload, notice }`, or
  `{ exit }` for links that leave the menu (attach, launch, a `command` link).
- **A view that is one category of a bigger page** (several areas live inside Maintenance, projects inside Sandbox):
  copy `src/cli/menu/pages/sandbox-page.ts`. It draws the sandbox view as its `status` category with
  `menuView(sandboxPage(m.report), { category: 'status', prefix: 'status:', refresh: false })`, puts those rows next
  to its own, gives the key bar per category (`actions: (category) => category === 'projects' || ... ?
  sandboxActions(category) : [...status.actions, REFRESH]`), and in `act()` first asks `statusView(model).resolve(result)`:
  an action found there is run with `perform`, anything else is the page's own row. **Careful:** `resolve()` matches
  page-level keys whatever row is highlighted. When a page holds several category views (Maintenance will), call
  `resolve()` only on the view of the category that is open (the page knows it, e.g. `this.category` in
  `maintenance-page.ts`), or a key of one category fires in another.
- The page keeps **no feature logic**: no service calls except `readQuery`, no confirmations of its own, no texts that
  the CLI also prints.

## 6. The web

For sessions there is **no web code at all**: `NAV` has `{ label: 'Sessions', view: 'sessions' }`, the shell links
`/v/sessions`, `web/src/pages/ViewPage.tsx` reads the view's queries over RPC (subscribing to live ones), calls the
same `build()` in the browser and draws it with `PageView`. Operation actions run through `useRunAction()`
(`web/src/rpc/hooks.tsx`): questions become modals (`QuestionModal.tsx`), progress and `text()` notifications,
errors a red notification with the fix.

You write web code only when:

- **A new kind of value**: a new Field kind in `src/app/kernel/fields.ts`, its input in
  `web/src/render/FieldInput.tsx`, its editor in `src/cli/menu/settings/value-editor.ts`. Never a one-off form.
- **A new kind of target** in `Target` (`view.ts`): handle it in `follow()` (`src/cli/menu/io-menu.ts`),
  `useAct()` (`web/src/render/actions.tsx`) and wherever `target.kind` is switched on (grep for it).
- **A new question kind or a picker** (area 5 adds the folder browser to the path question).
- **Navigation** (area 2 adds nested `NAV` sections).

The web may import only `src/app/features/defs`, `src/app/kernel` and `src/shared/web` (lint). Mantine components
only; every page works at 360 px wide.

## 7. Tests

### What the `app` suite already checks for you (`src/selftest/app.test.ts`)

- "every definition has exactly one implementation and every implementation is registered"
- "the parity list shows no gaps" (prints `<id> on <surface>: <why>` for each gap)
- "every view is shown somewhere, and a web section without a view says where the area is"
- "every CLI hint names fields of its input, and every command of its own has a group"
- "with the flags and help they had" (restart, stop, sessions) and "<view>: the page offers only operations its view
  declares" (for the views it has a sample of). Add your area's commands to such checks (see below).

### Writing a run test

Put new checks in `src/selftest/app.test.ts` (in a `t.section('<area>')`) or, when the area already has a suite
(`accounts.test.ts`, `data.test.ts`...), in that suite. The pattern, from the settings checks in `app.test.ts`:

```ts
t.section('settings, run against a config file');
const configFile = t.writeJson(t.at('app-settings', 'config.json'), {
  storage: { root: t.dir('app-settings', 'storage') },
  ...
});
const ctx = {
  loaded: { configPath: configFile },
  options: { workspace: t.dir('app-settings', 'project') },
  storageRoot: t.at('app-settings', 'storage'),
} as unknown as AppContext;
const quiet = fakeIO().io;
const set = (await runDefinition('settings.set', ctx, { key: 'sandbox.memoryMb', value: '8192' }, quiet)) as {
  message: string;
};
t.check(set.message === 'sandbox.memoryMb is 8192.' && ..., 'set reads text like the command line, ...', set.message);
await t.throws(
  () => runDefinition('settings.set', ctx, { key: 'sandbox.memoryMb', value: 'lots' }, quiet),
  'does not work for sandbox.memoryMb',
  'a value that does not fit is refused with what is allowed',
);
```

Rules:

- **Only temp folders**: `t.dir(...)`, `t.at(...)`, `t.writeJson(...)` (under the harness's temp folder). Never the
  real `~/.agent-sandbox`, registry, PATH or profile; never read or set HOME/USERPROFILE.
- Build only the parts of `AppContext` your run reads, cast with `as unknown as AppContext`.
- Run through `runDefinition('<id>', ctx, input, io)` (checks input and output like every surface).
- `fakeIO([answers])` answers questions in order (`true`/`false` for confirm, a string for choose/text/path, an array
  for checklist, `undefined` to back out); `seen.questions`, `seen.logs`, `seen.progress` record what happened. Running
  out of answers fails with `No answer for: <title>`. Check that a "no" ends with `Cancelled`:
  `await t.throws(() => runDefinition(id, ctx, input, fakeIO([false]).io), 'Nothing changed.', '...')`.
- Pages: call your exported page builder with a hand-made output (like `STATUS` and `running()` in `app.test.ts`),
  then check `pageActions(page)`, items, `pageLines(page)` (the CLI text) and `menuView(page)` (rows, `actions` keys,
  `enterLabel`, `resolve`).
- Anything that needs a running sandbox cannot run here: test the pure parts (page, scope decisions) and the failure
  path (`requireRunning` -> `No Windows Sandbox is running.`).

## Commands to run

From the root of your worktree, in this order:

```
npm run build              # tsc + bundles + schemas; fix every error
npm run lint               # boundaries: def purity, no TUI in runs, web imports
npm run format:check       # if it fails: npm run format, then check the diff
npm test -- app            # parity, reference views; read the "parity list shows no gaps" line
npm test -- app,<suites>   # plus the area's own suites (each area file names them)
npm test                   # everything; must print ALL TESTS PASSED
```

Gate on the text `ALL TESTS PASSED`, not the exit code. Live suites can flake under load: run once more before calling
a failure real. If `schemas/*.json` changed after `npm run build`, commit them.

## Common mistakes

Each of these has failed a review or a test before; check your change against all of them.

1. **Importing a barrel or Node code from a def.** `defs.ts` imports `./<area>/<area>.def.js`, never
   `./<area>/index.js` (the barrel re-exports the run, which pulls Node into the web bundle). A def importing
   `core/schema`, `node:path`, lodash or a service fails `npm run lint`.
2. **Forgetting `.describe()`.** The flag's `--help` text and the web's label help come from it. A changed or missing
   description changes `--help` and breaks "with the flags and help they had"-style checks.
3. **A definition not in a view.** An operation only reachable from the CLI shows as a parity gap on menu and web. Add
   it to the view's `operations` (and offer it on the page), or declare `surfaces: { except: { web: '<reason>' } }`.
4. **Registering half.** A def in `OPERATIONS` without its run in `IMPLEMENTATIONS` (or the other way round) fails
   "every definition has exactly one implementation".
5. **Keeping the old manifest entry.** The command then exists twice (the app suite checks this for the reference
   commands: "status, sessions, restart, stop, show and hide are commands (once each)"; add yours to such a check) or
   the old handler wins. Remove the manifest entry and its `HANDLERS` line together, or turn the hint into an `action`.
6. **Changing what the CLI prints.** `text()` must return the old sentence; extra lines go through `io.log`; `--json`
   keeps its shape through `shapeJson`. Tests in `cli.test.ts`, the area's suite and docs quote these texts.
7. **Asking where the CLI never asked.** A confirmation the old command did not have needs `implied: true`, or scripts
   suddenly fail with "Add --yes". A confirmation it did have must keep working with `--yes` (hint `yes`) and keep its
   no-terminal message (`noTerminal`).
8. **Questions in a query.** Queries run with `NO_QUESTIONS`; asking throws "A query asked a question".
9. **Logic in pages.** A menu page or web page that calls a service, decides what to confirm, or builds the text the
   CLI also prints is feature logic in the wrong place. Pages call `readQuery`, `menuView`, `resolve`, `perform`.
10. **Printing.** `console.log` in a feature, or importing `cli/output`, `cli/tui`, `cli/menu`, `@inquirer`, React.
11. **Secrets in outputs.** Output schemas go to the browser. Logins, tokens, attach addresses, environment values:
    never. Use `***` like `settings-rows.ts` does, or leave the field out.
12. **Unsafe text from the sandbox.** Names, messages and folders read from `run/` or the guest go through `safeText`
    in the run.
13. **Key clashes.** Two actions with the same `key` on one page, or using `l` (refresh).
14. **Forgetting `cancelled()`.** Returning normally after a "no" prints a success line.
15. **Leaving `command` links.** After your area moves, grep `kind: 'command'` for argv that start with your command
    and replace them with `action(...)` of your operation.
16. **Editing tests to pass.** Update a test only where output moved (same words, new place). Never weaken or delete
    one; if a test is wrong, say so in the report.
17. **Writing files with backslashes through the shell.** Heredocs and `node -e` eat backslashes; use your editor's
    file tools. Never `sed -i` on this mapped folder.
