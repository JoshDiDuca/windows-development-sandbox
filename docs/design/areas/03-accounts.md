# 03 · Accounts

Read [00-worked-example.md](00-worked-example.md) first. This file says only what is special about accounts.

## What it does today

Saved logins per agent: list them, save the sandbox's (or this PC's) login under a name, make the sandbox use one,
set the default for new launches, rename, remove. Claude uses `AccountStore`, other agents with `home` in their
settings use `AgentAccountStore`; `AccountsService` hides the difference.

## Files today

| File | What it does |
| --- | --- |
| `src/cli/commands/accounts.ts` | `account(ctx)`: the hand-written `sandbox account <action> [name]` command (list table, save, use + restart, default, rename, remove with confirmation). All printing and prompting lives here. |
| `src/cli/manifest.ts` (entry `name: 'account'`, around line 302) | the command's args, options, examples (below) |
| `src/cli/args.ts` lines 299-302 | maps the parsed options: `fromHost`, `accountAgent` (`--agent`, only for `account`), `accountTo` (`--to`), `noRestart` (`o.restart === false`) |
| `src/cli/commands/registry.ts` | `HANDLERS.account` (grep `account`) |
| `src/cli/services/accounts-service.ts` | `AccountsService`: `agents()`, `list(agent)`, `activeName(agent)`, `save(name, fromHost, agent)`, `activate(name, agent)`, `hasRunningSessions(agent)`, `restart(agent)`, `setDefault`, `remove`, `rename`. Returns data, never prints. **Keep it; the run calls it.** |
| `src/host/profile/accounts.ts` | `AccountStore`, `AccountRow` (`name`, `email`, `isDefault`, `isActive`, `savedAt`), name rule `/^[A-Za-z0-9_-]{1,40}$/`, the fail texts (`Invalid account name "x".`, `Unknown account "x".`, `There is an account "x" already.`) |
| `src/cli/menu/pages/accounts-page.ts` | `AccountsPage` (menu section 6) and the pure `accountsOptions(model)`; does the work itself with its own dialogs (to be moved) |
| `src/cli/menu/menu.ts` line ~105 | `new AccountsPage(app, ctx)` |
| `src/cli/menu/command-form.ts` lines 72, 280 | the menu's command form: `choices: 'accounts'` lists Claude account names; `account save` asks the name as text. Unchanged by this area. |
| `src/cli/services/sandbox-service.ts` line ~113 | the status's `account` fact (`activeName()`); unchanged |
| `src/cli/validate.ts` lines ~98-110 | checks `--account <name>` of a launch against saved accounts; unchanged |
| `src/selftest/menu-screens.ts` | draws `accountsOptions(ACCOUNTS)` for the screen review (`ACCOUNTS` model at line ~41) |

## CLI surface to keep

The manifest entry, exactly (it **stays**: see "Registration and wiring"):

```ts
name: 'account',
summary: 'Claude logins: list, save, use, set the default, remove',
group: 'Projects & accounts',
examples: [
  'sandbox account save work          save the login you signed in with inside the sandbox',
  'sandbox account use work           the sandbox uses it (running sessions restart)',
],
args: [
  { name: 'action', description: 'what to do', required: false, choices: ['list', 'save', 'use', 'default', 'rename', 'remove'] },
  { name: 'name', description: 'account name', required: false, choices: 'accounts' },
],
options: [
  text('--to', 'name', '(rename) the new name', { when: 'rename', label: 'New name' }),
  text('--agent', 'name', 'whose login: an agent that keeps one (default: claude)', { choices: 'harnesses', label: 'Agent' }),
  bool('--from-host', "(save) save this PC's login instead of the sandbox's", { when: 'save' }),
  bool('--no-restart', '(use) do not restart running sessions', { when: 'use' }),
  bool('--yes', '(remove) do not ask first', { short: '-y', when: 'remove', noMenu: true }),
],
json,
```

Behaviour per action (from `src/cli/commands/accounts.ts`; `<agent>` defaults to `claude`):

| Command | Prints / does | Exit |
| --- | --- | --- |
| `sandbox account` / `account list [--agent a] [--json]` | table `['', 'NAME', 'EMAIL', 'SAVED']`, first cell `*` (active) + `D` (default), `SAVED` = `savedAt.slice(0, 16).replace('T', ' ')`, then a blank line and `* = active in the sandbox   D = default for new launches`. None saved: claude -> `No saved accounts. Sign in inside the sandbox, then: sandbox account save <name>   (or --from-host to save this PC's login)`; other agent -> `No saved <agent> accounts. Sign in inside the sandbox, then: sandbox account save <name> --agent <agent>`. `--json`: the `AccountRow[]` array as is. | 0 |
| `account save [name] [--from-host]` | name missing: asks `Name for this login:` (no terminal: fails, fix `Usage: sandbox account save <name>`). Prints `Saved account "<name>" (<email>).` (no email: without the brackets), then dim `Next: sandbox account use <name>   (the sandbox uses it)` | 0 |
| `account use [name] [--no-restart]` | name missing: picks from saved (`Which account?`, labels `"name" (email)`); none saved: fail `No saved accounts.` / `Sign in inside the sandbox, then run: sandbox account save <name>`. Prints `Sandbox now uses "<name>" (<email>).`, then the store's note if any, then, when a session of that agent runs and no `--no-restart`: `<sandbox message> with --continue; the conversation carries on under the new account.` | 0 |
| `account default [name]` | `Default account: <name>` | 0 |
| `account rename [name] [--to new]` | `--to` missing: asks `New name for "<name>":` (fix `Usage: sandbox account rename <name> --to <new-name>`). Prints `Renamed account <name> to <to>.` | 0 |
| `account remove [name] [-y]` | asks `Remove the saved account "<name>"? Its login cannot be recovered; you would sign in again.` unless `--yes` (no terminal: `Cannot ask here (no terminal).` / `Add --yes to remove it without asking.`). No: prints `Nothing removed.`, exit 1. Yes: `Removed account <name>.` | 0 / 1 |
| unknown action | rejected by commander's `choices` before the handler runs | 1 |

Errors from the store and service (keep, they come through unchanged): `Invalid account name "<n>".` /
`Use letters, numbers, - and _ only (max 40), e.g. work or personal.`; `Unknown account "<n>".` / `See your accounts
with: sandbox account list`; `There is an account "<to>" already.` / `Pick another name.`; `Unknown agent "<a>".` and
`"<a>" does not keep its login between sandboxes, so there is nothing to save.` (fix `Agents with saved logins: ...`);
`Saving this PC's <a> login is not supported.` / `Sign in inside the sandbox, then save that login.`

Tests that touch the CLI surface:

- `src/selftest/cli.test.ts:313-323`, check "--agent names the agent (--harness still works); sandbox claude leaves
  --agent to Claude": asserts `parseCli(['account', 'list', '--agent', 'codex']).accountAgent === 'codex'`. Keep
  `accountAgent` in `args.ts` (other code may still read it) and this test unchanged.
- `src/selftest/cli.test.ts:285-289`, "root help: the command groups come in the order Agents, Sessions, Projects &
  accounts, ...": `account` stays in group `Projects & accounts`.
- No test asserts the printed sentences above (grep found none); keep them anyway.

## Menu surface to keep

Section 6 **Accounts** (`SECTION_LABELS` in `src/cli/menu/shell.ts`). From `accountsOptions` in
`src/cli/menu/pages/accounts-page.ts`:

- Intro: `Logins saved on this PC, per agent. Use puts one into the sandbox; new launches start with the default.`
- One **category per agent** (`service.agents()` order: claude, other agents that keep a login, then the rest);
  description `Saved <agent> logins.` or, when not kept, `This agent's login is not kept between sandboxes: it cannot
  be pointed at a folder we control.`
- Kept agent rows: section `Save a login`: `+ Save the sandbox's login…` (value `@save-sandbox`, description `Saves the
  <agent> login you signed in with inside the sandbox, under a name you choose.`), and when `canSavePc`: `+ Save this
  PC's login…` (value `@save-pc`, `Saves the <agent> login of this PC, under a name you choose.`). Section
  `Saved logins`: one row per login, value `<agent>:<name>`, label the name, hint `in the sandbox` (ok) and/or
  `default` (accent) joined by ` · `, description `Enter makes the sandbox use this login.`, details `Agent  <agent>`,
  `Email  <email or ->`, `Saved  <yyyy-mm-dd hh:mm>`.
- Agent that is not kept: one muted row `This agent's login is not kept between sandboxes` (value `info:<agent>`,
  description `Sign in again in each new sandbox, or use an API key in the agent’s environment.`), no keys.
- Enter label: `save` on the two save rows, `use` on a login, nothing elsewhere.
- Keys (kept agents only): `s` save sandbox login (importance 3), `p` save PC login (3, only when `canSavePc`), and on a
  login row: `d` make default (1), `r` rename (2), `x` remove (1).
- Dialogs: save asks `Name for this login` (path `Accounts > Save the sandbox's <agent> login` / `Save this PC's <agent>
  login`, about `Saves the login you signed in with inside the sandbox.` / `Saves the <agent> login of this PC.`),
  checked with `Use letters, digits, - and _ (up to 40).`; rename asks the same field, initial the old name, about
  `The login keeps working under its new name.`, unchanged name = nothing; use asks `Restart the running <agent>
  sessions?` / `They restart and continue their conversation where the agent can, now under the new login.` /
  `Restart` only when a session of that agent runs; remove asks `Remove "<name>"?` / `The saved login is deleted from
  this PC.` / `Remove` (danger).
- Notices today: `Saved "<name>".`, `Renamed to "<to>".`, `The sandbox now uses "<name>" for <agent>.` (+ note,
  + restart message), `<name> is the default for new launches.`, `Removed "<name>".` These become the shared `text()`
  (CLI wording; see Pitfalls).

Menu tests: `src/selftest/menu.test.ts:831-836` "with no saved login, Accounts offers to save the sandbox login or
this PC login (Enter)" asserts `accountsOptions({ agents: [{ name: 'claude', kept: true, canSavePc: true }], rows: {} })`
item values are exactly `['@save-sandbox', '@save-pc']`. Section "accounts for every agent" (`menu.test.ts:935-1001`)
tests `AccountsService` directly (keep it). "every screen" (`menu.test.ts:1003`) renders `accountsOptions(ACCOUNTS)`
and checks no screen overflows.

## Definitions to write (`accounts.def.ts`)

`src/app/features/accounts/accounts.def.ts`. Pure: no `core/schema`, so `AccountRow` is written again in zod.

```ts
import { z } from 'zod';
import { action, defineOperation, defineQuery, defineView, type Item, type Page, type Section } from '../../kernel/index.js';

const AgentSchema = z.string().default('claude').describe('whose login: an agent that keeps one (default: claude)');
const NameSchema = z.string().optional().describe('account name');

export const AccountRowSchema = z.object({
  name: z.string().describe('The saved login'),
  email: z.string().nullable().describe('Its email, when the agent says'),
  isDefault: z.boolean().describe('New launches start with it'),
  isActive: z.boolean().describe('The sandbox uses it now'),
  savedAt: z.string().describe('When it was saved (ISO time)'),
});
export const AgentAccountsSchema = z.object({
  name: z.string().describe('The agent'),
  kept: z.boolean().describe('Its login can be saved and switched'),
  canSavePc: z.boolean().describe("This PC's login can be saved"),
  accounts: z.array(AccountRowSchema).describe('Its saved logins (empty when not kept)'),
});
export const AccountsListSchema = z.object({
  agent: z.string().describe('The agent asked for (the CLI table shows only it)'),
  agents: z.array(AgentAccountsSchema).describe('Every agent, Claude first'),
});
export type AccountsList = z.output<typeof AccountsListSchema>;
const MessageSchema = z.object({ message: z.string().describe('What happened') });

export const listAccounts = defineQuery({
  id: 'accounts.list',
  title: 'Accounts',
  summary: 'Claude logins: list, save, use, set the default, remove',
  input: z.object({ agent: AgentSchema }),
  output: AccountsListSchema,
  cli: {
    name: 'account', action: 'list', json: true,
    flags: { agent: { flag: '--agent', value: 'name', choices: 'harnesses', label: 'Agent' } },
    // `sandbox account list --json` has always printed the rows of the one agent.
    shapeJson: (o) => o.agents.find((a) => a.name === o.agent)?.accounts ?? [],
  },
});

export const saveAccount = defineOperation({
  id: 'accounts.save',
  title: "Save the sandbox's login",
  summary: "save the sandbox's (or this PC's) login under a name",
  input: z.object({
    agent: AgentSchema,
    name: NameSchema,
    fromHost: z.boolean().default(false).describe("(save) save this PC's login instead of the sandbox's"),
  }),
  output: z.object({ name: z.string().describe('The saved login'), message: z.string().describe('What happened') }),
  text: (o) => o.message,
  cli: { name: 'account', action: 'save', positional: ['name'],
    flags: { agent: { flag: '--agent' }, fromHost: { flag: '--from-host' } } },
});

export const useAccount = defineOperation({
  id: 'accounts.use',
  title: 'Use this login',
  summary: 'make the sandbox use a saved login (running sessions restart)',
  input: z.object({
    agent: AgentSchema,
    name: NameSchema,
    noRestart: z.boolean().default(false).describe('(use) do not restart running sessions'),
  }),
  output: z.object({ lines: z.array(z.string()).describe('What happened, line by line') }),
  text: (o) => o.lines.join('\n'),
  cli: { name: 'account', action: 'use', positional: ['name'],
    flags: { agent: { flag: '--agent' }, noRestart: { flag: '--no-restart' } } },
});

export const defaultAccount = defineOperation({ id: 'accounts.default', title: 'Make default', /* ... */
  input: z.object({ agent: AgentSchema, name: NameSchema }), output: MessageSchema, text: (o) => o.message,
  cli: { name: 'account', action: 'default', positional: ['name'], flags: { agent: { flag: '--agent' } } } });

export const renameAccount = defineOperation({ id: 'accounts.rename', title: 'Rename…',
  input: z.object({ agent: AgentSchema, name: NameSchema, to: z.string().optional().describe('(rename) the new name') }),
  output: MessageSchema, text: (o) => o.message,
  cli: { name: 'account', action: 'rename', positional: ['name'], flags: { agent: { flag: '--agent' }, to: { flag: '--to' } } } });

export const removeAccount = defineOperation({ id: 'accounts.remove', title: 'Remove…', danger: true,
  input: z.object({ agent: AgentSchema, name: NameSchema }), output: MessageSchema, text: (o) => o.message,
  cli: { name: 'account', action: 'remove', positional: ['name'], flags: { agent: { flag: '--agent' } },
    yes: '(remove) do not ask first' } });
```

Notes on the hints:

- These are **actions of the hand-written `account` command** (`action:`), so the manifest entry stays and gives
  `--help` its args, options, `when` and examples (`withActions()` only adds action names to the first argument's
  choices; the options a definition reads must exist in the manifest entry). The `flags` map the hand-written options
  to input fields: `cliInput()` reads `options.raw[<camelCase of the flag>]`. `yes` on `remove` is answered by the
  manifest's `--yes`.
- **`--no-restart` does not map today**: commander stores it as `raw.restart === false`, but `attribute('--no-restart')`
  in `src/cli/operations/input.ts` gives `noRestart`. Add negated flags there (small change, test it):
  ```ts
  /** --no-restart is stored by commander as restart: false; the input field is true then. */
  function flagValue(raw: Readonly<Record<string, unknown>>, flag: string): unknown {
    const negated = /^--no-/.test(flag) ? attribute('--' + flag.slice(5)) : undefined;
    if (negated) return raw[negated] === false ? true : undefined;
    return raw[attribute(flag)];
  }
  ```
  and use it for both `flag.shownAs` and `flag.flag` in `cliInput()`.
- Keep the old descriptions word for word (`'(rename) the new name'`, `"(save) save this PC's login instead of the
  sandbox's"`, `'(use) do not restart running sessions'`): the menu's command form shows them.

The view (no static tabs: `ViewTabs.choices` are fixed at definition time, but the agents come from the settings):

```ts
/** One agent's part of the page: its save rows, its logins (each: Enter uses, d/r/x), or the "not kept" row. */
export function agentSection(a: AccountsList['agents'][number]): Section { /* items as below */ }

/** The accounts page: one section per agent (the CLI prints only `agent`'s table through accountsTable()). */
export function accountsPage(o: AccountsList): Page {
  return { title: 'Accounts', sections: o.agents.map(agentSection) };
}

export const accountsView = defineView({
  id: 'accounts',
  title: 'Accounts',
  summary: 'Logins saved on this PC, per agent. Use puts one into the sandbox; new launches start with the default.',
  queries: { accounts: listAccounts },
  operations: [saveAccount, useAccount, defaultAccount, renameAccount, removeAccount],
  build: ({ accounts }) => accountsPage(accounts),
});
```

`agentSection(a)` for a kept agent: `id: a.name`, `title: a.name`, items:

- `{ id: '@save-sandbox', label: "+ Save the sandbox's login…", group: 'Save a login', description: ..., primary:
  action(saveAccount, { agent: a.name, fromHost: false }, { verb: 'save', key: 's', importance: 3 }) }`
- when `canSavePc`: `{ id: '@save-pc', label: "+ Save this PC's login…", ..., primary: action(saveAccount, { agent:
  a.name, fromHost: true }, { verb: 'save', key: 'p', importance: 3 }) }`
- per login: `{ id: a.name + ':' + r.name, label: r.name, group: 'Saved logins', hint: ['in the sandbox' if active,
  'default' if default].join(' · '), badges (web), description: 'Enter makes the sandbox use this login.', details:
  ['Agent  ' + a.name, 'Email  ' + (r.email ?? '-'), 'Saved  ' + r.savedAt.slice(0, 16).replace('T', ' ')], primary:
  action(useAccount, { agent, name }, { verb: 'use' }), actions: [action(defaultAccount, {agent, name}, { key: 'd',
  verb: 'make default', importance: 1 }), action(renameAccount, {agent, name}, { key: 'r', verb: 'rename',
  importance: 2 }), action(removeAccount, {agent, name}, { key: 'x', verb: 'remove', importance: 1 })] }`

Not kept: one item `{ id: 'info:' + a.name, label: "This agent's login is not kept between sandboxes", tone: 'muted',
description: 'Sign in again in each new sandbox, or use an API key in the agent’s environment.' }`.

**The CLI text of `account list` comes from `text`, not from the view.** A query without `text` prints the page of the
view that shows only it (`printOutput` in `src/cli/operations/handler.ts`); that would print every agent, but the
command prints only `o.agent`'s table. A query's `text` is used only by the CLI (the menu and the web read queries
without it), so give `listAccounts` a pure `text` that rebuilds today's output exactly:

```ts
/** `sandbox account list`: the table of one agent, as cli/output's table() pads it (two spaces, last column not padded). */
export function accountsText(o: AccountsList): string {
  const rows = o.agents.find((a) => a.name === o.agent)?.accounts ?? [];
  if (!rows.length)
    return o.agent === 'claude'
      ? "No saved accounts. Sign in inside the sandbox, then: sandbox account save <name>   (or --from-host to save this PC's login)"
      : 'No saved ' + o.agent + ' accounts. Sign in inside the sandbox, then: sandbox account save <name> --agent ' + o.agent;
  const table = [
    ['', 'NAME', 'EMAIL', 'SAVED'],
    ...rows.map((a) => [(a.isActive ? '*' : ' ') + (a.isDefault ? 'D' : ' '), a.name, a.email ?? '-',
      a.savedAt.slice(0, 16).replace('T', ' ')]),
  ];
  const widths = table[0].map((_, i) => Math.max(...table.map((r) => r[i].length)));
  const lines = table.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] + 2))).join(''));
  return [...lines, '', '* = active in the sandbox   D = default for new launches'].join('\n');
}
```

and `text: accountsText` in `listAccounts`. The handler prints `--json` before `text`, so `--json` is unaffected.
(The email comes from the sandbox's login file: the run passes it through `safeText`.)

## Run functions (`accounts.run.ts`)

All over `new AccountsService(ctx)`; never print; `safeText` on `email`, `note` and the sandbox's restart message.

- `listAccountsRun(ctx, { agent })`: `service.agents()`; for each kept agent `service.list(a.name)` (the menu
  swallowed errors per agent: keep that, `[]` on error, comment why); for not-kept agents `[]`. If `agent` is not a
  kept agent, call `service.list(agent)` once so the old fail texts (`Unknown agent ...`, `... does not keep its
  login ...`) still come out on the CLI.
- **Name resolution** (shared helper `accountName(io, service, verb, agent, given)` in the run file): `given` wins.
  For `save`: `io.text({ title: 'Name for this login:', validate: v => /^[A-Za-z0-9_-]{1,40}$/.test(v.trim()) || 'Use
  letters, digits, - and _ (up to 40).' })`; undefined -> `cancelled()`. For the others: `service.list(agent)`; none ->
  `fail('No saved accounts.', 'Sign in inside the sandbox, then run: sandbox account save <name>')`; else
  `io.choose({ title: 'Which account?', choices: rows.map(a => ({ value: a.name, label: '"' + a.name + '"' + (a.email ?
  ' (' + a.email + ')' : '') })) })`; undefined -> `cancelled()`.
- `saveAccountRun`: name, then `service.save(name.trim(), input.fromHost, agent)`; message `'Saved account ' +
  label(saved) + '.'`.
- `useAccountRun`: name; `const used = service.activate(name, agent)`; lines = [`Sandbox now uses ${label(used)}.`,
  note?]. If `service.hasRunningSessions(agent) && !input.noRestart`: `io.confirm({ title: 'Restart the running ' +
  agent + ' sessions?', lines: ['They restart and continue their conversation where the agent can, now under the new
  login.'], yes: 'Restart', implied: true })` (the CLI never asked; the menu did); yes -> push `safeText(await
  service.restart(agent)) + ' with --continue; the conversation carries on under the new account.'`. A "no" here is
  **not** `cancelled()` (the switch already happened): just skip the restart line.
- `defaultAccountRun`: `service.setDefault(name, agent)`; message `'Default account: ' + name`.
- `renameAccountRun`: `to = input.to ?? await io.text({ title: 'New name for "' + name + '":', initial: name, validate
  })`; undefined or unchanged -> `cancelled()`; `service.rename(name, to.trim(), agent)`; message `'Renamed account ' +
  name + ' to ' + to + '.'`.
- `removeAccountRun`: name; `io.confirm({ title: 'Remove the saved account "' + name + '"?', lines: ['Its login cannot
  be recovered; you would sign in again.'], yes: 'Remove', danger: true, noTerminal: { message: 'Cannot ask here (no
  terminal).', fix: 'Add --yes to remove it without asking.' } })`; no -> `cancelled('Nothing removed.')` (the CLI
  prints the message and exits 1, as today); `service.remove(name, agent)`; message `'Removed account ' + name + '.'`.

## Registration and wiring

- `src/app/features/accounts/index.ts` barrel; `defs.ts`: import from `./accounts/accounts.def.js`, add the five
  operations to `OPERATIONS`, `listAccounts` to `QUERIES`, `accountsView` to `VIEWS`; `NAV`: replace
  `{ label: 'Accounts', elsewhere: ... }` with `{ label: 'Accounts', view: 'accounts' }` (top level, no children).
- `registry.ts`: the six runs.
- `menu/views.ts`: `{ view: accountsView, section: 'Accounts' }`.
- `src/cli/commands/registry.ts`: `account: definitionHandler(listAccounts)` (import from `../operations/index.js`)
  so a bare `sandbox account` (no action, which `definitionFor` does not match) lists, as today. Delete
  `src/cli/commands/accounts.ts`.
- `src/cli/manifest.ts`: the `account` entry stays as it is (args, options with `when`, examples, `json`).
- `src/cli/operations/input.ts`: the `--no-` change above.
- Menu page `accounts-page.ts` becomes a renderer, one category per agent:
  - `load()`: `this.model = await readQuery(listAccounts, this.ctx)`.
  - `accountsOptions(m: AccountsList)`: categories as today (from `m.agents`, descriptions as today, intro as today);
    `items` = for each agent `menuView({ title: 'Accounts', sections: [agentSection(a)] }, { category: a.name,
    refresh: false }).items` concatenated (no prefix: item values stay `@save-sandbox`, `@save-pc`, `<agent>:<name>`,
    `info:<agent>`, so the menu test keeps passing); `actions: (category) => viewOf(category).actions` (empty for a
    not-kept agent); `enterLabel: (category, id) => viewOf(category).enterLabel(category, id)`.
  - `act(result)`: `const chosen = viewOf(this.category).resolve(result)` — **only the open category's view** (see
    [00, the menu](00-worked-example.md#5-the-menu)); then `this.operations.perform(chosen.action, [this.label], ...)`.
  - The test calls `accountsOptions({ agents: [{ name, kept, canSavePc }], rows: {} })`: change that call to the new
    model shape `{ agent: 'claude', agents: [{ name: 'claude', kept: true, canSavePc: true, accounts: [] }] }` (output
    moved, not changed) and update `ACCOUNTS` in `menu-screens.ts` the same way.
- `src/cli/menu/io-menu.ts` `run()`: show a multi-line `text` on one notice line
  (`text.replace(/\n+/g, ' ')`), because `accounts.use` returns several lines.

## Web page

`/v/accounts`: one card per agent (section title = agent). Save buttons are rows with a click action; each login row
shows `in the sandbox` / `default` badges, a click uses it, and buttons Make default, Rename…, Remove… (red; the run
asks in a modal). Rename and save ask the name in a text modal (from `io.text`). Nothing is secret here: the output
holds names, emails and dates only, never credentials (`AccountStore` keeps those sealed; do not add them).

## Delete or shrink afterwards

- Delete `src/cli/commands/accounts.ts` and its import in `src/cli/commands/registry.ts` / `commands/index.ts` (grep
  `accounts.js`).
- `accounts-page.ts`: delete `save`, `rename`, `use`, `remove`, `askName`, `NAME`, `accountActions`, the
  `AccountsService` field; keep only categories, `load`, `options`, `act`.
- `AccountsService` stays (the run uses it; `command-form.ts` and `sandbox-service.ts` too).

## Tests

Keep passing: suites `accounts`, `credentials`, `menu` (checks quoted above), `cli`, `app`, `layout`.

Add to `src/selftest/app.test.ts`, `t.section('accounts')`, with a temp context like the settings checks
(`storageRoot: t.dir('app-acc', 'storage')`, `dataPath: t.dir('app-acc', 'data')`, `loaded: { config:
structuredClone(DEFAULTS), configPath: null, base: t.temp }`), writing a fake codex `auth.json` as the "accounts for
every agent" menu test does:

1. "accounts: save asks a name when none is given, and refuses a bad one": `runDefinition('accounts.save', ctx, {
   agent: 'codex' }, fakeIO(['bad name', 'main']).io)`; `seen.questions[0].kind === 'text'`, two questions asked,
   message `Saved account "main".`
2. "accounts: list shows Claude first and the saved codex login": `readQuery(listAccounts, ctx, { agent: 'codex' })`
   -> `agents[0].name === 'claude'`, codex `accounts[0].name === 'main'`; `listAccounts.cli.shapeJson(output)` is the
   codex rows array.
3. "accounts: remove asks first; no is Nothing removed.": `t.throws(() => runDefinition('accounts.remove', ctx, {
   agent: 'codex', name: 'main' }, fakeIO([false]).io), 'Nothing removed.', ...)`; with `[true]` the message is
   `Removed account main.`
4. "accounts: the page offers use on Enter and d/r/x on a login": `menuView({ title: 'Accounts', sections:
   [agentSection(codex)] })` -> `enterLabel(undefined, 'codex:main') === 'use'`, keys include `s`, `d`, `r`, `x`.
5. "a --no- flag reaches the input": `cliInput(definitionFor('account', ['use'])!, parseCli(['account', 'use', 'work',
   '--no-restart']))` equals `{ name: 'work', noRestart: true }`; without the flag `noRestart` is absent.

## Pitfalls

- **One hand-written command, many definitions.** Keep the manifest entry; do not add a command named `account` from a
  hint (the hints all have `action`). Bare `sandbox account` must still list (the `HANDLERS` line above).
- **Texts differ between CLI and menu today.** The shared `text()` uses the CLI's sentences (`Saved account "x".`,
  `Default account: x`, ...). The menu's notices change to these words: say so in the report. The CLI's dim
  `Next: sandbox account use <name>   (the sandbox uses it)` after save has no place in a shared `text()`; **drop it**
  and say so (no test asserts it), unless the reviewer wants it as a second `text` line.
- **Missing name without a terminal**: the old fix was `Usage: sandbox account use <name>`; through `io.choose` it is
  now `Run it in a terminal, or give the value on the command line.` Accept and report.
- **Restart after use is not a cancel**: the switch is done before the question.
- **No secrets**: never put `credentials`/`oauthAccount` from `AccountStore` into an output.
- `--agent` is mapped to `accountAgent` only for `account` in `args.ts`; the definitions read it from `raw.agent`, so
  this works; keep `accountAgent` (the cli test asserts it).

## Checklist

1. Write `accounts.def.ts`, `accounts.run.ts`, `index.ts`; register in `defs.ts`, `registry.ts`, `menu/views.ts`, `NAV`.
2. `input.ts` `--no-` change; `HANDLERS.account = definitionHandler(listAccounts)`; delete `commands/accounts.ts`.
3. Rewrite `accounts-page.ts` as a renderer; update `menu.test.ts:831` and `menu-screens.ts` `ACCOUNTS` to the new
   model shape; `io-menu.ts` one-line notice.
4. docs/commands.md: lines 156-160 still true; adjust only if a sentence changed.
5. Run ([commands](00-worked-example.md#commands-to-run)):
   ```
   npm run build
   npm run lint
   npm run format:check
   npm test -- app,accounts,credentials,menu,cli,layout
   npm test
   ```
   Gate on `ALL TESTS PASSED`. Check against [common mistakes](00-worked-example.md#common-mistakes).

## Report template

```
Area 3 (accounts) — branch web-ui/accounts
Moved: <files> -> src/app/features/accounts/
Deleted: <files/functions>
CLI: account list|save|use|default|rename|remove unchanged except: <list changed lines, e.g. the dropped Next: line, the no-terminal fix text>
Menu: rows/keys unchanged; notices now use the CLI wording: <yes/no>
input.ts: --no- flags mapped (test: <name>)
Tests added: <names>; tests changed (output moved): <names + why>
npm test: ALL TESTS PASSED <yes/no>; parity gaps: <none/list>
Unsure / left undone: <...>
```
