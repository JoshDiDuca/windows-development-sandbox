# 01 · Agents

Read [00-worked-example.md](00-worked-example.md) first. This file only says what is special about agents.

## What it does today

The menu's **Agents** section lists the agents you can start in a folder (Enter starts one with `launch`), adds,
makes default and removes agents in your settings, and holds the start options. The web starts an agent in a project
of the running sandbox through `POST /api/sessions` and `web/src/pages/NewSessionModal.tsx`.

## Files today

| Path | What it does |
| --- | --- |
| `src/cli/menu/pages/agents-page.ts` | The menu page. Pure helpers `addedAgents`, `agentActions`, `hostAgentsToShow`, `startArgv`, `agentCategories`, `agentsOptions`; class `AgentsPage` (rows, Enter, keys `d`/`x`, the Folder picker, the start forms). Reads "ready" from `<dataPath>\tools\agents\<name>` and the last command from `readHistory()` (`src/cli/history.ts`). |
| `src/cli/menu/add-agent.ts` | "Add an agent…": `AddAgent` (questions), pure `agentNameProblem`, `commandFromPackage`, `newAgent`, `withAgent`, `withoutAgent`, and the writers `writeOrStage`, `makeDefaultAgent`, `removeAgent` (write to your config file now, or join the Settings page's unsaved changes). |
| `src/cli/menu/several.ts` | "Start several agents…": builds a `launch --session agent@folder ...` command line (`candidateFolders`, `severalAgentsArgv`). |
| `src/cli/menu/command-form.ts` | The menu's form for a manifest command ("More start options…", "Sandbox without an agent…"). |
| `src/cli/commands/launch/*` | `launch` (also `sandbox <agent>`, `generate`), `start`. `running.ts` opens sessions in a running sandbox (`openSession`, `launchIntoRunning`, `startIntoRunning`). Takes over the terminal (boot progress, attach). |
| `src/cli/manifest.ts` | `launch`, `start`, `generate` entries (`AGENT_OPTIONS`, `SANDBOX_OPTIONS`, `LABELS`). |
| `src/cli/args.ts` | `buildProgram(record, wrapper)`: the `sandbox <agent>` spelling (`--agent` stays the agent's own flag there, only `--harness` is ours). |
| `src/cli/validate.ts` | `validateOptions`: `checkHarness` for `launch`, `generate`, `restart`, `doctor`. |
| `src/cli/services/web-service.ts` | `WebService.create(request)`: starts an agent in a project of the running sandbox (sharing rules, `channel.requestSession`, `waitForSession`). `info()` lists agents and projects for the dialog. |
| `src/host/web/server.ts` | `POST /api/sessions` (CSRF + Origin, `newSessionRequest` name check `/^[A-Za-z0-9_.-]{1,64}$/`), `GET /api/info`. |
| `src/host/web/backend.ts` | `WebBackend.create(request)`. |
| `src/shared/web/protocol.ts` | `NewSessionRequest`, `WebInfo`. |
| `web/src/pages/NewSessionModal.tsx` | `openNewSession(agent?)`: the web's "Start" dialog (agent + project selects). |
| `web/src/api.ts` | `api.create` (POST /api/sessions), `api.info` (also used by `web/src/App.tsx` for the login check). |
| `web/src/render/actions.tsx` | `useAct()`: `start-agent` target -> `openNewSession(target.agent)`. |
| `src/cli/menu/io-menu.ts` | `follow()`: `start-agent` -> `{ kind: 'run', argv: ['launch', '--harness', target.agent] }`. |
| `src/app/features/sessions/sessions.def.ts` | `sessionsPage` uses `link({ kind: 'start-agent', agent }, 'Start ' + agent, { verb: 'start' })` (empty state and "start" section). |

Out of scope here: `sandbox agent-commands` (`src/cli/commands/agent-commands.ts`) and `sandbox host <agent>`; the
menu's "On this PC" rows only run `host <agent>`.

## CLI surface to keep

Nothing in this area becomes a new CLI command, and **`launch`, `start`, `generate` and `attach` stay hand-written**
(manifest entries unchanged, handlers in `HANDLERS` unchanged). Reason: they boot Windows Sandbox with live progress,
ask trust questions and attach the terminal; none of that fits an operation's `io`. They are not definitions, so the
parity test does not look at them. Keep, unchanged:

- `launch` (`summary: 'start the sandbox and an agent (or another session in the running sandbox)'`, group `Agents`,
  `passthrough: 'agent'`, `interactive: true`, options `AGENT_OPTIONS`: `--harness` shown as `--agent <name>`,
  `--session <agent@folder>` (list), `--account <name>`, `-t/--terminal`, `--headless`, `--new`, `--workspace <dir>`,
  `--node`, `--python`, `--database` (list, choices postgres/mysql/mongodb/redis/dynamodb), `--script` (list),
  `--window`, `--trust-config`, `--no-local-config`, `--yes`, `--no-agent`).
- `start` (`SANDBOX_OPTIONS` without `--new`), `generate` (group `Advanced`), `sandbox <agent>`.

Existing checks that must keep passing (they test parsing, not this area's new code): `src/selftest/projects.test.ts:574`
"--session: the first @ splits agent from folder; ..." and the `cli` suite.

Today's CLI equivalents of the new operations (state them in docs, do not add commands):
`sandbox config set defaultHarness <name>` (make default), `sandbox config set harnesses ...` (add/remove).

## Menu surface to keep

Section **Agents** (`SECTION_LABELS[0]`), page `AgentsPage`, categories from `agentCategories`:

- **Start** (`id: 'start'`, description `'Agents you can start in ' + folder + '. Add an agent at the end of the list.'`):
  - `repeat` "Repeat last" (only when there is history), section `Quick start`, hint = the last command line
    (truncated to 50), Enter label `run again`.
  - one row per agent, value `agent:<name>`, section `'Start in ' + basename(folder)`, the default agent first; hint
    `default  ` (accent) + `ready` (ok) or `installs on first start` (muted); description `Starts <name> in
    <folder name>.` plus ` It is the default agent.` / ` You added it: x removes it.` / ` You added it. Make another
    agent the default to remove it.`; details `Command  <launch command line>`; Enter label `start`.
  - `add` "Add an agent…", Enter label `add`.
  - keys: `d` "make default" (on any agent but the default), `x` "remove" (on an agent you added that is not the
    default), both importance 1. **No** refresh key on this page today.
- **Options** (`id: 'options'`): `opt:attach` "Attach this terminal" (hint yes/no, Enter `switch`), `opt:window`
  "Sandbox window" (hint `as configured`/`hidden`/`shown`, Enter `change`), `opt:folder` "Folder" (Enter `choose`,
  the path picker "Choose the project folder", check `That folder does not exist.`), then section `Start differently`:
  `more` "More start options…", `several` "Start several agents…", `noagent` "Sandbox without an agent…" (Enter
  `open`). No keys.
- **On this PC** (`id: 'host'`, only with entries): `host:<agent>` "<agent> (not sandboxed)", Enter `run`.

Dialogs: Remove asks `Remove <name>?` / `It is taken out of your settings. Its files in the sandbox stay until you
clean them up.` / button `Remove`, danger. Add asks: choose "How does the agent get into the sandbox?" (`npm` "An npm
package", `uv` "A Python package", `host` "A program on this PC", with their descriptions), text "Name of the agent"
(checked by `agentNameProblem`), then for host the file picker "Choose the program (.exe)", else text "npm package" /
"Python package" and text "Command" (initial `commandFromPackage(package)`, check `Letters, numbers, . - and _ only.`).
Notices: `✓ <name> is the default agent.`, `✓ Removed <name>.`, `✓ Added <name>.` + ` Enter starts it.` (saved) or
` Ctrl+S saves it.` (staged).

## Definitions to write (`agents.def.ts`)

Move the **pure** helpers `agentNameProblem`'s message texts, `commandFromPackage`, `withAgent`, `withoutAgent` into
the def only if they need no `core/schema` (`agentNameProblem` uses `NameSchema` from `core/schema`: it stays in the
run side; put it in `src/app/features/agents/agent-entry.ts`, a Node helper the run imports, together with `newAgent`,
`withAgent`, `withoutAgent`, `commandFromPackage`).

```ts
// src/app/features/agents/agents.def.ts
import { z } from 'zod';
import { action, defineOperation, defineQuery, defineView, link, type Item, type Page } from '../../kernel/index.js';

/** Agent and project names as the old POST /api/sessions accepted them. */
const NameText = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

export const AgentRowSchema = z.object({
  name: z.string().describe('The agent'),
  ready: z.boolean().describe('Installed in the sandbox already (starts without an install)'),
  isDefault: z.boolean().describe('The agent that starts by default'),
  removable: z.boolean().describe('You added it (built-in agents cannot be removed)'),
});
export type AgentRow = z.output<typeof AgentRowSchema>;

export const AgentsListSchema = z.object({
  folder: z.string().describe('The folder a start works on (the current folder)'),
  defaultAgent: z.string().describe('The default agent'),
  agents: z.array(AgentRowSchema).describe('Every agent in your settings, built in or added'),
});
export type AgentsList = z.output<typeof AgentsListSchema>;

export const listAgents = defineQuery({
  id: 'agents.list',
  title: 'Agents',
  summary: 'the agents you can start, and which one is the default',
  input: z.object({}),
  output: AgentsListSchema,
  surfaces: { except: { cli: 'sandbox config list shows the agents (harnesses) and the default (defaultHarness)' } },
});

export const startAgent = defineOperation({
  id: 'agents.start',
  title: 'Start an agent',
  summary: 'start an agent in a project of the running sandbox',
  input: z.object({
    agent: NameText.describe('The agent to start'),
    project: NameText.optional().describe('The project of the running sandbox (asked when there are several)'),
  }),
  output: z.object({
    session: z.string().describe('The new session'),
    message: z.string().describe('What happened'),
  }),
  text: (o) => o.message,
  surfaces: {
    except: {
      cli: 'sandbox <agent> and sandbox launch start agents on the command line (they boot the sandbox and can attach the terminal)',
      menu: 'the menu starts agents with launch, which can boot the sandbox and attach this terminal',
    },
  },
});

export const addAgent = defineOperation({
  id: 'agents.add',
  title: 'Add an agent…',
  summary: 'add an agent by its npm or Python package, or a program on this PC',
  input: z.object({}),
  output: z.object({ name: z.string().describe('The new agent'), message: z.string().describe('What happened') }),
  text: (o) => o.message,
  surfaces: { except: { cli: 'sandbox config set harnesses adds agents on the command line' } },
});

export const makeDefaultAgent = defineOperation({
  id: 'agents.makeDefault',
  title: 'Make default',
  summary: 'make an agent the one that starts by default',
  input: z.object({ name: z.string().describe('The agent') }),
  output: z.object({ message: z.string().describe('What happened') }),
  text: (o) => o.message,
  surfaces: { except: { cli: 'sandbox config set defaultHarness <name> does this on the command line' } },
});

export const removeAgent = defineOperation({
  id: 'agents.remove',
  title: 'Remove',
  summary: 'take an agent you added out of your settings',
  input: z.object({ name: z.string().describe('The agent') }),
  output: z.object({ message: z.string().describe('What happened') }),
  danger: true,
  text: (o) => o.message,
  surfaces: { except: { cli: 'sandbox config set harnesses removes agents on the command line' } },
});
```

The page builder (pure). Item ids **must** be `agent:<name>` and `add`, because `menu.test.ts` checks row values:

```ts
function agentItem(a: AgentRow, o: AgentsList): Item {
  const where = o.folder.split(/[\\/]/).pop() ?? o.folder; // no node:path in a def
  return {
    id: 'agent:' + a.name,
    label: a.name,
    hint: (a.isDefault ? 'default  ' : '') + (a.ready ? 'ready' : 'installs on first start'),
    tone: a.ready ? 'ok' : 'muted',
    badges: [...(a.isDefault ? [{ text: 'default', tone: 'accent' as const }] : []),
      { text: a.ready ? 'ready' : 'installs on first start', tone: a.ready ? ('ok' as const) : ('muted' as const) }],
    description: 'Starts ' + a.name + ' in ' + where + '.' + /* the three endings from agentsOptions, copied */ '',
    primary: link({ kind: 'start-agent', agent: a.name }, 'Start ' + a.name, { verb: 'start' }),
    actions: [
      ...(a.isDefault ? [] : [action(makeDefaultAgent, { name: a.name }, { key: 'd', verb: 'make default', importance: 1 })]),
      ...(a.removable && !a.isDefault ? [action(removeAgent, { name: a.name }, { key: 'x', verb: 'remove', importance: 1 })] : []),
    ],
  };
}

/** The agents page: the default agent first, then the others, then "Add an agent…". */
export function agentsPage(o: AgentsList): Page {
  const sorted = [...o.agents].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const where = o.folder.split(/[\\/]/).pop() ?? o.folder;
  return {
    title: 'Agents',
    sections: [{
      id: 'start',
      title: 'Start in ' + where,
      items: [
        ...sorted.map((a) => agentItem(a, o)),
        { id: 'add', label: 'Add an agent…',
          description: 'Add another agent by its npm or Python package, or a program on this PC. It is saved in your settings and appears in this list.',
          primary: action(addAgent, {}, { verb: 'add' }) },
      ],
    }],
  };
}

export const agentsView = defineView({
  id: 'agents',
  title: 'Agents',
  summary: 'The agents you can start: start one, add one, choose the default.',
  queries: { agents: listAgents },
  operations: [startAgent, addAgent, makeDefaultAgent, removeAgent],
  build: ({ agents }) => agentsPage(agents),
});
```

Copy the description endings exactly from `agentsOptions` (they depend on `removable` and `isDefault`).

## Run functions (`agents.run.ts`)

Use `ConfigFile.user(ctx.loaded.configPath)` (`src/app/features/settings/settings-file.ts`) for every write, like
`settings.run.ts`. A result that is an object fails with `'It could not be saved: ' + result.problems.join('; ')`
(the text of `writeOrStage`).

- **`listAgentsRun`**: `harnesses = file.userConfig().harnesses`; for each name: `ready` = the `installed()` check
  moved from `AgentsPage` (a file `hostExecutable`, `npmBin + '.cmd'` or `uvBin + '.exe'` exists in
  `path.join(ctx.dataPath, 'tools', 'agents', name)`); `isDefault` = name equals `file.userConfig().defaultHarness`;
  `removable` = `!(name in DEFAULTS.harnesses)` (from `addedAgents`). `folder` = `hereDir(ctx)`
  (`src/cli/commands/projects/here.ts`). No questions.
- **`startAgentRun`**: the body of `WebService.create`, moved, with a question for the project:
  1. not running (`!insideSandbox() && isSandboxRunning()` false): `fail('No Windows Sandbox is running.', 'Start one with sandbox claude, then try again.')`.
  2. `const view = lookAtSandbox(ctx)`; when `view.owner` is another user's: `ownerRule(view.owner, { kind: 'use' })`,
     refuse -> `fail(rule.reason, rule.fix)`.
  3. projects: the `projects(view)` logic of `WebService` (move it to a shared exported function, e.g.
     `runningProjects(view)` in `src/cli/services/web-service.ts`, so `info()` and this run use one copy).
  4. no `input.project`: one project -> use it; several -> `io.choose({ title: 'Which project?', choices:
     projects.map((p) => ({ value: p.name, label: p.name, description: p.guest })) })`; undefined -> `cancelled()`.
  5. unknown project: `fail('The running sandbox has no project "' + name + '".')`; unknown agent:
     `fail('There is no agent called "' + input.agent + '".')`.
  6. `io.progress('Starting ' + agent + ' (the first time sets things up and can take a while)')`, then
     `channel.requestSession(...)` and `channel.waitForSession(id, SESSION_START_MS, () => undefined)` exactly as
     `create` does. Return `{ session: session.id, message: 'Started ' + agent + ' in ' + project + '.' }`.
- **`addAgentRun`**: the questions of `AddAgent.run()` through `io`: `io.choose` (same title, choices and
  descriptions), `io.text({ title: 'Name of the agent', lines: [...], validate: (v) => agentNameProblem(v, taken) })`,
  for host `io.path({ title: 'Choose the program (.exe)', lines: [...], pathKind: 'file', validate })`, else two
  `io.text` (package; command with `initial: commandFromPackage(pkg)`). Any `undefined` -> `cancelled()`. Then
  `HarnessSchema.safeParse` (fail `'That agent is not valid: ' + describeIssues(...).join('; ')`) and
  `file.set(['harnesses'], withAgent(file.valueInFile(['harnesses']), name, harness))`. Return
  `{ name, message: 'Added ' + name + '.' }`.
- **`makeDefaultAgentRun`**: unknown name -> `fail('There is no agent called "' + name + '".')`; `file.set(['defaultHarness'], name)`;
  `{ message: name + ' is the default agent.' }`.
- **`removeAgentRun`**: the checks of `removeAgent` with the same texts (`name + ' is built in, so it cannot be
  removed.'`; `name + ' is the default agent.'` + fix `'Make another agent the default first.'`), then
  `io.confirm({ title: 'Remove ' + name + '?', lines: ['It is taken out of your settings. Its files in the sandbox stay until you clean them up.'], yes: 'Remove', danger: true, implied: true })`,
  no -> `cancelled()`; write `withoutAgent(...)` (or `undefined` when nothing of your own is left);
  `{ message: 'Removed ' + name + '.' }`.

**Decision (unsaved Settings changes):** the operations write at once, like `settings.set`. The menu's old
"join the unsaved changes" path (`writeOrStage` when the Settings draft has `harnesses` or `defaultHarness`) goes:
before `perform()` of `agents.add`, `agents.makeDefault` or `agents.remove`, the Agents page checks
`draft.has(file, ['harnesses']) || draft.has(file, ['defaultHarness'])` and, when true, shows the notice
`Agents have unsaved changes in Settings: save them (Ctrl+S) or undo them first.` and does nothing. This is a
deliberate behaviour change; say so in the commit message.

## Registration and wiring

1. `src/app/features/agents/index.ts` barrel; `defs.ts`: import from `./agents/agents.def.js`, add `startAgent,
   addAgent, makeDefaultAgent, removeAgent` to `OPERATIONS`, `listAgents` to `QUERIES`, `agentsView` to `VIEWS`.
2. `registry.ts`: the five runs.
3. `NAV`: `{ label: 'Agents', view: 'agents' }` (replaces the `elsewhere`).
4. `MENU_VIEWS`: `{ view: agentsView, section: 'Agents' }`.
5. Menu page `agents-page.ts`:
   - `load()`: `readQuery(listAgents, ctx)` plus the menu-only facts it reads today (`AgentCommandsService.statusAsync()`
     for "On this PC", `readHistory()[0]?.argv` for "Repeat last").
   - The Start category = `menuView(agentsPage({ ...list, folder: this.folder }), { category: 'start', refresh: false })`
     with the `repeat` row put first and each `agent:` row given the `Command  <startArgv(...)>` details line (the
     menu's own options decide that command line, so `startArgv` stays in the page: it is the menu's way to build a
     `launch` command, not feature logic). `refresh: false` keeps the key bar to `d`/`x` (the test expects 2 keys).
   - `actions: (category) => category === 'start' ? view.actions : []`; `enterLabel` from the view for `start` rows,
     `ENTER` for the rest.
   - `act()`: `view.resolve(result)`; a `start-agent` link keeps running `startArgv(model, agent, cwd)` (not
     `follow()`'s plain `launch --harness`, which would drop the options); an operation action goes to
     `this.operations.perform(...)` after the draft check above; the Options and On this PC rows stay as they are.
   - Delete `agentActions` (its behaviour is now the item actions) and the `action()`/`add()` methods.
6. Web: `useAct()` in `web/src/render/actions.tsx`: `start-agent` runs the operation instead of the dialog:
   `await run({ kind: 'operation', op: 'agents.start', input: { agent: target.agent }, label: 'Start ' + target.agent })`;
   then navigate to the terminal page: make `useRunAction` return the output (change its type to
   `Promise<unknown>`), and when it has a `session` string, `navigate('/s/' + session)`. The menu's `follow()` for
   `start-agent` stays `launch --harness <agent>` (Sessions page).
7. Remove the `start-agent` mention from `NAV`'s old `elsewhere` and from the comment in `view.ts` ("the web opens its
   new-session dialog" -> "the web runs agents.start").

## Web page

Agents (`/v/agents`): one card/row per agent (label, badges `default` / `ready` or `installs on first start`), click =
Start (runs `agents.start`; a "Which project?" modal when the sandbox has several; then the terminal page), buttons
"Make default" and "Remove" (red, confirmation modal), and an "Add an agent…" row that runs `agents.add` (its questions
as modals; the program path is a text field until area 5 adds the folder browser). No options panel on the web:
attach and the window are about the PC's terminal and desktop, and the folder is the project question. (This narrows
the table's "options panel"; it is a decision, not an omission.) Starting when no sandbox runs shows the fail message
and its fix; the web cannot boot a sandbox.

## Delete or shrink afterwards

- `web/src/pages/NewSessionModal.tsx` (delete), `api.create` in `web/src/api.ts` (keep `login`, `info`, `sessions`).
- `POST /api/sessions` branch and `newSessionRequest` in `src/host/web/server.ts`; `create` in `WebBackend`
  (`backend.ts`) and `WebService`; `NewSessionRequest` in `src/shared/web/protocol.ts`; the fake backend's `create` in
  `src/selftest/web.test.ts`.
- `src/cli/menu/add-agent.ts`: everything moves to the feature; the file goes.
- From `agents-page.ts`: `agentActions`, `addedAgents` (moved to the run), `installed()`, the add/remove/default code.

## Tests

Keep passing (update only where code moved):

- `menu` suite, section `agents` (`src/selftest/menu.test.ts:318`): "Agents: Repeat last, the default agent first, the
  others, then Add an agent; no "On this PC" while it is empty" (values `['repeat', 'agent:codex', 'agent:claude',
  'add']`), "Agents > Options holds the start options and the other ways to start; "On this PC" appears with entries".
  `AgentsModel` changes shape (it now carries the `agents.list` output); adapt the fixture, not the expectations.
- "a new agent name is checked (letters, no duplicates); the command is guessed from the package" (`menu.test.ts:355-370`,
  strings `'Claude is an agent already.'`, `'Use letters, numbers, - and _ only.'`, `'Type a name.'`, `'my-cli'`):
  change only the import to the new helper file.
- Section `agents: make default and remove` (`menu.test.ts:741`): "Make default shows on any other agent, Remove only on
  one you added; neither on built-in agents or other rows" — build `keyFor` from
  `agentsOptions(model).actions('start')` and `applies`; keep `actions('start').length === 2` and
  `actions('options').length === 0`.
- "Add an agent writes it to your config file (comments and the built-in agents stay)", "the default agent is not
  removed" (`'default agent'`), "a built-in agent is not removed" (`'built in'`), "Make default and Remove change your
  config file (comments stay; the built-in agents stay)": rewrite as runs: `runDefinition('agents.add', ctx, {},
  fakeIO(['npm', 'my-agent', '@me/my-agent@latest', 'my-agent']).io)` with a temp `AppContext`
  (`loaded: { configPath }`, `dataPath`), same assertions on the file.
- "with unsaved changes to the agents, the new agent joins them instead of being written" (`menu.test.ts:405`): this
  behaviour is removed by decision. Replace it with "with unsaved changes to the agents, the menu asks to save them
  first" and say so in the report.
- `web` suite: 'a new session needs CSRF and Origin', 'odd names are refused', 'a new session is requested'
  (`web.test.ts:390-407`) go with the endpoint; keep 'a signed-in browser lists sessions' and 'and reads the info'.
- `app` suite: parity, "every view is shown somewhere...".

Add (in `app.test.ts`, `t.section('agents')`):

- "agents: the default first, Add last, d/x only where they apply" — `agentsPage` of a hand-made list.
- "agents.start refuses odd names" — `t.throws(() => runDefinition('agents.start', ctx, { agent: '../x' }, quiet), 'That does not work for start an agent', ...)`.
- "agents.start without a running sandbox says how to start one" — expects `No Windows Sandbox is running.`. This
  is deterministic in the self-test: it runs only inside a Windows Sandbox (where `insideSandbox()` is true, so the
  "running" check is false) or on GitHub Actions (no sandbox).
- "agents.remove asks, and a no changes nothing" — `fakeIO([false])` -> `Nothing changed.`, file unchanged.

## Pitfalls

- `agents.start` is web only by design; the parity test accepts it because `agentsView` (in `NAV`) lists it and it
  declares CLI and menu exemptions with reasons.
- The web runs inside the server process: `hereDir(ctx)` there is the server's folder, not the browser user's
  project. That is why `agents.start` asks for a project of the running sandbox and never takes a folder.
- Sharing: another user's sandbox may be used only when shared (`ownerRule(..., { kind: 'use' })`). Keep the check.
- `useRunAction` currently returns `void`; changing its return type touches `actions.tsx` only. Keep notifications.
- The agent name list in `--agent` choices (`'harnesses'`) is unchanged; do not add `choices` to `agents.start`'s
  input (agents are dynamic).
- **`resume` is not in this area.** Sessions' "Reopen last sessions" (`link({ kind: 'command', argv: ['resume'] })`)
  stays a command link: `sandbox resume` starts the sandbox again when none runs (`launch` in `resume.ts`), which
  takes over the terminal like `launch`. No area in the table owns it. Proposal: leave it hand-written; if a web
  "Reopen" is wanted later, a `sessions.reopen` operation for a *running* sandbox only (`reopenSessions` in
  `src/cli/commands/sessions/reopen.ts`) belongs to the sessions feature. Say so in your report; do not do it here.
- Lint: `agents.def.ts` cannot import `NameSchema`/`HarnessSchema`/`DEFAULTS`; those are used in the run or
  `agent-entry.ts`.

## Checklist

1. `git worktree add <folder> -b web-ui/agents master`; read 00-worked-example.md.
2. Write `agents.def.ts`, `agent-entry.ts`, `agents.run.ts`, `index.ts`; register (defs, registry, NAV, MENU_VIEWS).
3. Rewire `agents-page.ts`; change `useAct`/`useRunAction`; delete the files listed above.
4. Update the tests listed above; add the new ones.
5. `npm run build`
6. `npm run lint`
7. `npm run format:check` (fix with `npm run format`)
8. `npm test -- app,menu,web,projects`
9. `npm test` -> must print `ALL TESTS PASSED` (gate on the text; rerun once if a live suite flakes).
10. Commit ("agents: one feature for the menu and the web; agents.start replaces POST /api/sessions"). Stop and report.

See [Commands to run](00-worked-example.md#commands-to-run), [Writing a run test](00-worked-example.md#writing-a-run-test)
and [Common mistakes](00-worked-example.md#common-mistakes).

## Report template

```
Area: 01 agents       Branch: web-ui/agents       Commit: <hash>
Build / lint / format: pass | fail (<why>)
npm test: ALL TESTS PASSED (runs: <n>)   Parity gaps for agents.*: none
Moved: <files -> src/app/features/agents/...>
Deleted: <files>
Tests changed (moved, same words): <list>      Tests replaced by decision: <list, with the reason>
New tests: <names>
Behaviour changes: <e.g. the unsaved-Settings notice>
Unsure / left undone: <list>
```
