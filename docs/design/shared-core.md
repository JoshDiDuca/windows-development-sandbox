# One core for the CLI, the menu and the web UI (design and plan)

Status: **built**. The kernel, the three surfaces' renderers and IO, the RPC endpoint and the Mantine web shell are in,
and every area of the tool (agents, projects, accounts, data, storage, apps, health, updates, logs, VPN, engine, web,
settings export and import) is a feature in `src/app/features/`, shown by the command line, the menu and the web UI
(1.11.0 and 1.11.1). This document is the contract every contributor (human or agent) follows; [As built](#as-built)
says where the code differs from the sketches below and why, and [How to add a feature](#how-to-add-a-feature-walkthrough)
walks through one.

## The rule

A feature is written **once**, in the shared core: what it takes, what it does, what it shows, what it asks. The three
surfaces only render it:

| Surface | Renders | Talks to the core |
| --- | --- | --- |
| Command line (`sandbox <command>`) | plain text and `--json` | in-process |
| Menu (`sandbox`, full-screen) | the TUI toolkit (`src/cli/tui`) | in-process |
| Web UI (`sandbox web`) | React + Mantine | typed RPC over the existing loopback server (WebSocket) |

Change a feature in the core and all three change. A self-test fails when an operation is not reachable from every
surface (unless it declares why, e.g. "attach takes over a real terminal; the web UI has the terminal page instead").

## Not a multi-package monorepo, on purpose

This repo lives on a mapped folder (Windows Sandbox) where npm workspaces, `file:` dependencies and symlinked packages
fail (CLAUDE.md, Gotchas). So "packages" are folders with barrels and ESLint boundary rules in one package, built by
tsc (CLI) and esbuild (web). The boundaries are as strict as separate packages and could be split out later without
code changes.

## Layers

```
src/app/                         THE SHARED CORE (no terminal, no DOM, no printing)
  kernel/                        pure: may be imported by the web bundle
    define.ts                    defineOperation / defineQuery / defineView
    fields.ts                    zod -> Field descriptors (one form model for TUI and web)
    view.ts                      view-model types (Page, Section, Item, Action, Table, Tone, Badge)
    io.ts                        the questions an operation may ask (confirm, choose, text, secret, path, checklist)
    errors.ts                    UserError -> { message, fix } (from core/util fail())
    rpc.ts                       the RPC message schemas (zod), shared by server and browser
  features/<area>/               one folder per area (sessions, sandbox, agents, projects, accounts, data, storage,
    <area>.def.ts                  settings, apps, health, updates, logs, vpn, engine, web)
                                 pure: ids, zod input/output, labels, groups, danger, view builders, parity exemptions
    <area>.run.ts                Node: the implementations (call today's services in src/cli/services and host/*)
    index.ts                     barrel; the web bundle imports only *.def.ts through features/defs.ts
  registry.ts                    every feature, by id (Node side); features/defs.ts = the pure half for the web
src/cli/                         surface 1 + 2
  args.ts / manifest.ts          commander built from operation definitions (CLI hints: positional args, flags,
                                 aliases) — manifest.ts shrinks to the CLI-only hints over time
  output/render-view.ts          view model -> plain text table / list / key-values; --json prints the output schema
  menu/render-view.ts            view model -> ListScreen items, categories, actions; Field -> the existing editors
  io-cli.ts / menu/io-menu.ts    OperationIO via @inquirer/prompts (CLI) and TUI dialogs (menu)
src/host/web/                    the RPC endpoint on the existing server (same auth, Host/Origin/CSRF checks)
web/src/                         surface 3
  rpc/                           typed client (types inferred from features/defs.ts), TanStack Query hooks
  render/                        view model -> Mantine components; Field -> Mantine inputs (@mantine/form + zod)
  pages/                         thin: a page = a view id (+ the terminal page, which is special)
```

Layering is enforced by ESLint `no-restricted-imports` (existing boundary config): `app/kernel` and `*.def.ts` import
only zod, lodash-es-free pure helpers and `core/schema`; `web/` imports only `app/kernel`, `app/features/defs.ts` and
`shared/web`; `*.run.ts` never imports `src/cli/tui` or React.

## Contracts

### Operation (does something)

```ts
export const restartSessions = defineOperation({
  id: 'sessions.restart',
  title: 'Restart sessions',            // menu row / web button / CLI summary
  summary: 'Restart this project\'s running agents in place; they resume their conversation.',
  group: 'Sessions',
  input: z.object({ all: z.boolean().default(false).describe('every project') }),
  output: z.object({ restarted: z.number() }),
  danger: false,                        // true: confirm first (text from `confirm`)
  surfaces: 'all',                      // or { except: { web: 'reason' } }
  cli: { name: 'restart', positional: [], flags: { all: '--all' } },
});
// sessions.run.ts
export const restartSessionsRun = implement(restartSessions, async (ctx, input, io) => {
  io.progress('Restarting…');
  ...
  return { restarted: n };
});
```

- Input and output are zod; every surface validates input before `run` and output after (the web gets typed data).
- `io` is the only way to interact: `io.progress(text)`, `io.log(line)`, `await io.confirm(...)`, `io.choose`,
  `io.text`, `io.secret`, `io.path` (the path picker in the menu, a picker dialog in the web), `io.checklist`. No
  `console.log`, no `@inquirer` in features. Without a way to ask (CLI with no TTY), `io` fails with the existing
  "Add --yes" message (core/prompt.ts askRequired).
- Errors: `fail(message, fix)` as today; every surface shows message + fix the same way.
- Long work streams progress (spinner in the CLI, notice line in the menu, progress bar/toast in the web).

### Query (reads something, optionally live)

```ts
export const listSessions = defineQuery({
  id: 'sessions.list',
  input: z.object({ wide: z.boolean().default(false) }),
  output: ListedSessionsSchema,
  live: { everyMs: 2500 },              // the menu's LiveStatus and the web's subscriptions use the same rule
});
```

### View (what a screen shows)

```ts
export const sessionsView = defineView({
  id: 'sessions',
  title: 'Sessions',
  queries: { sessions: listSessions },
  build: ({ sessions }): Page => ({
    sections: [{ title: 'Running', items: sessions.map(s => ({ id: s.id, label: ..., hint: ..., tone: ...,
      actions: [action(restartSessions, { all: false }), action(attachSession, { id: s.id })] })) }],
    empty: { text: 'No sessions.', action: action(startAgent, {}) },
  }),
});
```

- A view is pure: queries in, a `Page` out. The menu turns a `Page` into a ListScreen (sections, categories, hints,
  key bar from actions); the web turns it into Mantine cards/tables/menus; the CLI prints it (status, sessions, data).
- Tones (`ok`, `warn`, `danger`, `muted`, `accent`) map to the TUI theme and to Mantine colours: one palette.

### Fields (forms)

`fields.ts` turns any zod schema (operation inputs, the whole config schema for Settings) into `Field`s:
kind (`boolean`, `enum`, `number` with min/max, `text`, `secret` — from `secret()`, `path` with file/folder — from the
existing `pathKindOf`, `list`, `map`, `object`), label, help (from `.describe()`), default, validation (the schema
itself). The menu's settings editors and the web's forms both consume `Field`s, so a new setting or option is
editable everywhere the moment it is in the schema. (The existing `menu/settings/schema-node.ts` and
`path-kind.ts` move into the kernel; the TUI editors stay in `menu/` and render Fields.)

### RPC (web only)

One WebSocket per page session on the existing server, after the existing cookie login and Origin check:
`{t:'call', id, op, input}` -> `{t:'progress'|'log'|'ask'|'result'|'error', id, ...}`; `{t:'answer', id, value}` answers an
`ask`; `{t:'subscribe', query, input}` -> `{t:'data', ...}` for live queries. All messages are zod schemas in
`app/kernel/rpc.ts`; the server validates every message and runs only registered operations whose `surfaces` include
`web`. The terminal bridge (`/api/sessions/:id/terminal`) stays as it is.

## Libraries

- Kept: zod 4 (all schemas), lodash (host side), commander 14, @inquirer/prompts 7, ws, React 18, xterm.js.
- Web: **Mantine 7** (`@mantine/core`, `@mantine/hooks`, `@mantine/form`, `@mantine/notifications`, `@mantine/modals`)
  with `mantine-form-zod-resolver`, **@tanstack/react-query 5** for queries/subscriptions, `@tabler/icons-react`.
  Mantine replaces Bootstrap: it gives accessible forms, modals, tables, notifications and dark/light theming out of the
  box, which is most of the web UI. All web libraries are dev dependencies bundled by esbuild; nothing new ships to
  the CLI.
- No new host runtime dependency is needed for the core (zod + the existing `ws`).
- Sandbox-side communication (C# ptyhost, the run\ file channel) is enough for 1:1; any upgrade there (e.g. hvsocket
  for the HCS engine) is done in C# 5 per CLAUDE.md, behind the same core operations.

## How to add a feature (checklist)

1. `features/<area>/<area>.def.ts`: the operation/query/view definitions (zod in/out, labels, CLI hints).
2. `<area>.run.ts`: the implementation, using services and `io` only.
3. Register the implementation in `app/registry.ts` and the definitions in `features/defs.ts`.
4. An operation on a view that is already shown needs nothing else: the CLI command comes from its hint, the menu key
   and the web button from the view's Page. A new area's view goes in `NAV` (web) and `menu/views.ts` with a menu page
   that renders it (`menu/render-view.ts` does the drawing). If a surface cannot have it, declare
   `surfaces: { except: { web: 'reason' } }`.
5. Tests: one test of `run` with `fakeIO`; the parity test (`npm test app`) checks reachability; check the Page.
6. Docs: docs/commands.md. The [walkthrough](#how-to-add-a-feature-walkthrough) goes through it with a real example.

## Plan

1. **Kernel** (built): define.ts, fields.ts (moved from menu/settings), view.ts, io.ts, errors.ts, rpc.ts; the
   CLI/menu/web renderers of views and fields; the three IO adapters; the RPC endpoint and the web client; the parity
   and boundary tests; Mantine shell (layout with left navigation mirroring the menu's sections, theme, notifications).
2. **Reference features** (built), end to end on all three surfaces: `sandbox.status` + `sandbox.stop` + window show/hide,
   `sessions.list` + `sessions.restart` (+ the terminal page), `settings` (view + get/set/reset via Fields). These are
   the examples every later feature copies.
3. **Parity, area by area** (built): agents, projects, accounts, data, storage, apps, health, updates, logs, vpn, engine,
   web, settings export and import. Each moved the logic behind the menu page and the CLI command into its feature, and
   the duplicated menu and CLI code was deleted.
4. **Web UI completion** (built): every view works in the browser; the phone layout; the key row for the terminal.

Acceptance for 1:1 (met): every menu page is a view; every CLI command is an operation or query, or a command of an
area that is not a feature (see [Deviations](#deviations-and-why)); the parity test (`npm test app`) lists no gaps; the
menu looks and behaves as before.

## As built

Where the code differs from the sketches above, and why. The code is the reference; these notes say where to look.

### Files

```
src/app/
  kernel/            define.ts, view.ts, fields.ts, io.ts, errors.ts, rpc.ts, plus schema-node.ts (zod introspection,
                     moved from menu/settings; fields.ts builds Fields from it) and text.ts (ago, plural, humanize: one
                     wording on every surface)
  features/defs.ts   OPERATIONS, QUERIES, VIEWS (typed tuples the web client infers from), NAV (the web's sections)
  features/<area>/   <area>.def.ts (pure), <area>.run.ts (Node), index.ts; settings also has categories.def.ts (pure
                     labels), settings-file.ts (ConfigFile, moved from menu/settings) and settings-rows.ts (rows)
  context.ts         AppContext (= the CLI's Context) and implement() bound to it; typedConfirm(io)
  registry.ts        IMPLEMENTATIONS, runDefinition, readQuery (typed, no questions), createRpcHost (web-allowed only)
src/cli/operations/  spec.ts (CLI hints -> manifest commands and actions), input.ts (command line -> input),
                     io-cli.ts (OperationIO on the terminal), handler.ts (run + print), index.ts
src/cli/output/render-view.ts   Page -> text lines
src/cli/menu/        render-view.ts (Page -> ListScreen rows, keys, Enter labels, resolve()), io-menu.ts
                     (MenuOperations: perform an Action, run with the TUI dialogs), views.ts (MENU_VIEWS: which views the
                     menu shows, read by the parity test)
src/host/web/rpc.ts  RpcSession: one browser's RPC socket; server.ts upgrades /api/rpc after the usual checks
web/src/             rpc/ (client, typed run(), hooks), render/ (PageView, FieldInput, ActionForm, QuestionModal,
                     actions, tones), shell/Shell.tsx, pages/ (ViewPage, TerminalPage, NewSessionModal)
```

### Contracts, as built

- **CLI hints** (`TypedCliHint` in define.ts): `{ name, action?, group, summary?, positional?: [field], flags?:
  { field: { flag, short?, shownAs?, value?, choices?, noMenu?, advanced?, label? } }, yes?: '<help line>', json?,
  shapeJson?(output), examples? }`. Field names are checked against the input at compile time. A hint with `action`
  adds an action to a hand-written command (`config get|set|reset|list`); without one it is a command of its own,
  added to `COMMANDS` (so `--help`, the parser and the menu's command list see it like any other). Help text comes from
  the schema's `.describe()`. `shapeJson` keeps a command's old `--json` shape (status, sessions) while the output
  schema is the one the web uses. Why: the menu's command forms and `--help` already read the manifest, so generating
  manifest entries kept both unchanged.
- **`text(output)`** (not `done`) is on operations and queries: one line for the CLI's output, the menu's notice and the
  web's notification (`config get` prints its value through it). A query without `text` prints the page of the view
  that shows only it (status, sessions, config list), or JSON.
- **`danger: true`** marks an operation red on every surface; it does not ask by itself. The operation asks through
  `io.confirm`, because what to say depends on what it finds (stop names the sessions that end). `ConfirmQuestion`
  grew `implied` (a typed command is answer enough: the CLI does not ask, the menu and web still do), `typed` (type a
  word: another user's sandbox) and `noTerminal` (the CLI's message and fix without a terminal; default "Add --yes").
  `-y/--yes` (from the hint's `yes`) answers confirmations on the CLI. A declined question ends the operation with
  `cancelled()`: the CLI prints "Nothing changed." and exits 1, the menu and web say nothing.
- **IO**: every surface builds its `OperationIO` from one `Asker` (`ioFromAsker`); typed questions take an in-process
  `validate` and are asked again with `problem` (so the web needs no functions over the wire). `fakeIO([...answers])`
  is the test double; `NO_QUESTIONS` is the IO for queries. The menu shows what an operation logged above its next
  question.
- **Views** declare `operations` (everything the page may offer: the parity test reads it), optional `tabs` (a
  parameter switched with tabs: Settings' scope) and `inputs(params)`. `AnyView` is the type for lists of views.
- **Page** (view.ts): `notice`, `sections` (`facts`, `items`, `columns` + `columnsOn`, `actions`, `notes` with
  `only: 'cli'`), page `actions` (key bar / header buttons), `empty` (`text`, `action`, `cliText`). An `Action` is an
  operation (`input`, optional `fields` + `initial` to ask first) or a link to a `Target`: `terminal` (menu: attach;
  web: terminal page), `start-agent` (menu: launch; web: new-session dialog), `view`, or `command` (a command line of
  an area that is not a feature yet: the menu runs it, the web hides it; these go away as areas move).
- **RPC**: subscriptions carry an id (`subscribe {id, query, input}`, `data {id, output}`, `unsubscribe {id}`), so a page
  can follow several queries; an `error` on a subscription does not end it. One question per call at a time, so
  `answer {id, value}` needs no question id. The server checks the answer against the question's kind.
- **Fields**: `fieldOf(schema | SchemaNode, key)`; kinds `boolean`, `enum` (with `open` when a value of your own is
  allowed: `"auto"` or a number), `number`, `text`, `secret`, `path`, `list`, `map`, `object`, `json`. The menu's
  `ValueEditor` dispatches on the Field's kind and keeps the SchemaNode for checking as you type; the web's
  `FieldInput` renders the Field and `ActionForm` checks with the operation's input schema (zod resolver) plus
  `fieldProblem`. On the web a `path` question opens the folder picker (`files.browse`, `web/src/render/FolderPicker.tsx`).

### Deviations and why

- **Settings in the menu** keep their own page (drafts staged until Ctrl+S, two scopes, the Data folder, VPN login and
  export/import rows), but its rows are the feature's (`settingsOf`, `settingRow` with a draft-aware `SettingsSource`):
  which settings exist, labels, sections, Fields, values with secrets as `***`. The web and the CLI write at once
  through `settings.set`/`settings.reset`. Moving the draft model into the core is not worth it until another surface
  wants staging.
- **The Sandbox page in the menu** shows the sandbox view as its Status category (rows prefixed `status:`); Projects is a
  feature and its category renders the projects view; Databases stays the page's own (no feature yet).
- **Text output changed a little** where a page is now shared: `status` lists a Sessions row and the repo guard also
  when no sandbox runs, other projects' sessions under their own heading; `show` prints "Sandbox window shown.";
  the menu's Status rows use the CLI's words (Running, Phase, Uptime, Helper ...). `--json`, flags, names, exit codes
  and every other line are as before. New: `sandbox config reset <setting>` and `sandbox config list [--json]`.
- **`settings.get`** is CLI only (`surfaces: { except: { menu, web } }`): the Settings pages show every value.
- **Not a package boundary but a lint one**: `npm run lint` enforces that the kernel and `*.def.ts` import only zod,
  the kernel, other `*.def.ts` and `core/util/errors`; that host code imports only `app/kernel`; that `*.run.ts` never
  imports the TUI, the menu, output or React; that `web/` imports only `src/shared/web`, `src/app/kernel` and
  `src/app/features/defs`. The `layout` self-test checks the same on the compiled code.
- **Bundle size**: the web bundle is about 1.3 MB (zod 4 is a third of it). It is served from this PC only.

## How to add a feature (walkthrough)

Using `sessions.restart` (src/app/features/sessions) as the example.

1. **Define it** in `sessions.def.ts`: id, title, summary, zod `input` and `output` with `.describe()` on every field,
   `text` (the one line it says), the CLI hint (`{ name: 'restart', group: 'Agents', flags: { harness: { flag:
   '--harness', shownAs: '--agent', value: 'name', choices: 'harnesses' }, all: { flag: '--all' } } }`).
2. **Implement it** in `sessions.run.ts` with `implement(restartSessions, async (ctx, input, io) => ...)`: use the
   services, ask with `io.confirm({ ..., implied: true })`, report with `io.progress`, end a "no" with `cancelled()`,
   fail with `fail(message, fix)`. Never print, never prompt, never import the TUI.
3. **Register** the definition in `features/defs.ts` (`OPERATIONS`) and the implementation in `app/registry.ts`
   (`IMPLEMENTATIONS`).
4. **Offer it** in a view: `sessionsView.operations` lists it and `sessionsPage` puts
   `action(restartSessions, { all: false }, { key: 'r', verb: 'restart agents' })` in the page's actions. The menu's
   Sessions page (it renders `sessionsView`, listed in `menu/views.ts`) shows the `r` key and runs it with dialogs; the
   web's Sessions page (the view is in `NAV`) shows a button and runs it over RPC; `sandbox restart` exists because of
   the hint. A new area's view goes in `NAV` (web) and in `MENU_VIEWS` with a page that renders it (menu).
5. **Delete** the old command and menu code that did the same (here: `commands/sessions/control.ts` and the restart
   branch of the Sessions page).
6. **Test**: `npm test app` (parity: no gaps; your page in the reference-view checks if it has rules worth pinning);
   a test of `run` with `fakeIO` where it needs no sandbox (see the settings checks in `app.test.ts`).
7. **Docs**: docs/commands.md when a command changed.
