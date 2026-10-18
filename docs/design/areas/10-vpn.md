# 10 · VPN

Read [00-worked-example.md](00-worked-example.md) first. This file only says what is special about the VPN area.

## What it does today

`sandbox vpn [status|login|logout]` shows the VPN settings and the running sandbox's tunnel, saves the VPN login
(typed hidden, sealed with DPAPI) and deletes it. The menu offers only the login, as a row of Settings > Network.

## Files today

| File | What it does |
| --- | --- |
| `src/cli/commands/vpn.ts` | the hand-written command: `status` (table + warnings, `--json`), `login` (prints the steps, asks two secrets with `askSecret`), `logout`; exports `VPN_WARNINGS` (2 lines) |
| `src/cli/services/vpn-service.ts` | `VpnService`: `report()` (`VpnReport`), `provider`, `loginState()`, `save(credentials)`, `remove()`; exports `NORD_STEPS` (4 lines) |
| `src/cli/menu/vpn-login.ts` | `VPN_LOGIN = '@vpn-login'`, `vpnLoginRow(ctx)` (label/hint/description of the Settings row), `VpnLoginFlow` (message box with the steps, two masked text fields, save) |
| `src/cli/menu/pages/settings-page.ts` | adds the row (`{ value: VPN_LOGIN, category: 'network', ...vpnLoginRow(this.ctx) }`, line 177), Enter label `change` (line 136), runs `VpnLoginFlow` on Enter (lines 213-215) |
| `src/host/vpn/login.ts` | `VpnLogin` (sealed file `<storage>\vpn\<provider>.json`): `save`, `read` (launch only), `state` -> `'none' \| 'saved' \| 'unreadable'`, `savedAt`, `remove`; `loginProblem()` (empty, control characters, too long) |
| `src/host/vpn/status.ts` | `hostPublicIp()` (one request to `https://api.ipify.org`), `vpnLine()`, `readVpnLine(dataPath, hostIp)` -> `{ level: 'ok'\|'warn'\|'bad', text }` or null; text from the sandbox goes through `safeText` |
| `src/host/vpn/prepare.ts`, `nordvpn.ts` | the launch side (`prepareVpn`, NordVPN server pick). **Not part of this area**: do not touch |
| `src/core/schema/vpn.ts` | `VPN_PROVIDERS = ['nordvpn', 'openvpn-file', 'wireguard-file']`, `VpnSchema` (the `vpn.*` settings) |
| `src/cli/manifest.ts` (entry `name: 'vpn'`, around line 571; the file is being edited by another change, so search for it) | the command spec |
| `src/cli/commands/registry.ts` | `vpn: vpn` in `HANDLERS` |

## CLI surface to keep

Manifest entry today (copy these words exactly):

```ts
{
  name: 'vpn',
  summary: 'the VPN for the sandbox: save your login, see whether it is on (NordVPN first)',
  group: 'Advanced',
  args: [{ name: 'action', description: 'status, login or logout', required: false, choices: ['status', 'login', 'logout'] }],
  options: [],
  json: true,
  examples: ['sandbox vpn login', 'sandbox vpn status'],
}
```

| Command | Today |
| --- | --- |
| `sandbox vpn` / `sandbox vpn status` | no `requireOnPc`. `--json` prints `VpnReport` as is: `{ enabled, provider, protocol, country, killSwitch, login, loginSavedAt, running }` (`running` is `{ level, text }` or `null`; no secret in it). Text: a table with rows `VPN`, `Provider`, `Protocol`, `Country`, `Kill switch`, `Login`, and `Running now` when a sandbox with the VPN runs; then `Next: sandbox vpn login` when no login is saved (not for wireguard-file); then `Only the Windows user that saved it can read it. Save it again: sandbox vpn login` when unreadable; then the two `VPN_WARNINGS`. Exit 0 |
| `sandbox vpn login` | `requireOnPc('vpn login')`. wireguard-file: prints `A WireGuard config needs no login: the keys are in the file vpn.configFile points to.`, exit 0. Otherwise prints the intro (`NordVPN needs its service credentials, not your usual login. To get them:` + the numbered `NORD_STEPS`, or `Type the user name and password your VPN profile asks for.`), the dim line `What you type is not shown. It is kept encrypted for your Windows user and never printed.`, asks `Service user name`/`Service password` (NordVPN) or `User name`/`Password` with `askSecret` (no terminal: fix `Run sandbox vpn login in a terminal.`), saves, prints `Saved. Turn the VPN on with: sandbox config set vpn.enabled true` and the warnings. A bad login fails in `VpnLogin.save` with `loginProblem()`'s text and fix `Type the service credentials again.` |
| `sandbox vpn logout` | `requireOnPc('vpn logout')`; prints `The saved VPN login is deleted.` or `No VPN login was saved.`; exit 0 |
| `sandbox vpn <other>` | `fail('Unknown VPN action "<x>".', 'Use: sandbox vpn status \| login \| logout')` |

Table row values to keep (from `status()` in `vpn.ts`): `VPN` = `on` or `off  (turn on: sandbox config set vpn.enabled true)`;
`Provider` = `NordVPN` / `your own WireGuard .conf` / `your own .ovpn file`; `Country` = the country or `best available`;
`Kill switch` = `on (no internet if the tunnel fails)` or `off`; `Login` = `not saved` / `saved (encrypted)` (+ the
date, first 10 characters of `loginSavedAt`) / `cannot be read`, or `not needed (the keys are in your config)` for
wireguard-file.

Tests that assert CLI text of this command: **none found** (grep of `src/selftest` for `vpn status`, `Saved.`,
`login is deleted` finds nothing). The `vpn` suite tests the host side; keep it passing unchanged.

## Menu surface to keep

- Settings page, category `network` (label "Network"), one row `@vpn-login`:
  - wireguard-file: label `VPN login`, hint `not needed`, description `A WireGuard file carries its own keys (vpn.configFile): there is no login to set.`
  - otherwise: label `Set NordVPN login…` or `Set VPN login…`, hint `saved` / `cannot be read` / `not saved`,
    description `The login the VPN uses (for NordVPN the service credentials from Nord Account > NordVPN > Set up NordVPN manually, not your account password). Typed hidden, kept encrypted for your Windows user, never shown. ` + the warnings.
  - Enter label `change`. Enter runs the flow: a message box (title `NordVPN service credentials` or `VPN login`)
    with the steps and the warnings, then two masked fields (`validate`: `Type the user name.` / `Type the password.`),
    then the notice `✓ The VPN login is saved (encrypted). Turn the VPN on under Settings > Network.`
  - The row is only on the "All projects" tab (rows in `extra` are left out for the project file: `settingsOptions`).
- No status, no logout in the menu today.

## Definitions to write (`src/app/features/vpn/vpn.def.ts`)

The def may not import `core/schema` (lint): write the provider enum again in zod.

```ts
import { z } from 'zod';
import { defineOperation, defineQuery, defineView, action, type Fact, type Page } from '../../kernel/index.js';

const ProviderSchema = z.enum(['nordvpn', 'openvpn-file', 'wireguard-file']).describe('Which VPN (setting vpn.provider)');
const LoginStateSchema = z.enum(['none', 'saved', 'unreadable']).describe('Whether a login is saved and can be opened by you');

export const VPN_WARNINGS = [ /* the two lines, moved here from commands/vpn.ts word for word */ ] as const;
export const NORD_STEPS = [ /* the four lines, moved here from services/vpn-service.ts word for word */ ] as const;

export const VpnStatusSchema = z.object({
  enabled: z.boolean().describe('The VPN is on (setting vpn.enabled)'),
  provider: ProviderSchema,
  protocol: z.enum(['udp', 'tcp']).describe('udp or tcp (setting vpn.protocol)'),
  country: z.string().describe('The NordVPN country; empty = the best server anywhere'),
  killSwitch: z.boolean().describe('No internet when the tunnel fails (setting vpn.killSwitch)'),
  login: LoginStateSchema,
  loginSavedAt: z.string().nullable().describe('When the login was saved'),
  running: z
    .object({ level: z.enum(['ok', 'warn', 'bad']).describe('How the tunnel is doing'), text: z.string().describe('What the sandbox reported') })
    .nullable()
    .describe("The running sandbox's tunnel, when one runs with the VPN on"),
});
export type VpnStatus = z.output<typeof VpnStatusSchema>;

export const vpnStatus = defineQuery({
  id: 'vpn.status',
  title: 'VPN',
  summary: 'the VPN settings, whether a login is saved, and the running tunnel',
  input: z.object({
    tunnel: z.boolean().default(true).describe("also ask the running sandbox how its tunnel is doing (one request to api.ipify.org)"),
  }),
  output: VpnStatusSchema,
  cli: { name: 'vpn', action: 'status', json: true },   // --json prints the output: the same keys as VpnReport
});

export const vpnLogin = defineOperation({
  id: 'vpn.login',
  title: 'Save the VPN login…',
  summary: 'save the VPN login (typed hidden, kept encrypted, never printed)',
  input: z.object({}),                                   // NEVER put the user name or password in the input
  output: z.object({ message: z.string().describe('What happened') }),
  text: (o) => o.message,
  cli: { name: 'vpn', action: 'login' },
});

export const vpnLogout = defineOperation({
  id: 'vpn.logout',
  title: 'Delete the VPN login',
  summary: 'delete the saved VPN login',
  input: z.object({}),
  output: z.object({ deleted: z.boolean().describe('A login was saved and is gone'), message: z.string().describe('What happened') }),
  danger: true,
  text: (o) => o.message,
  cli: { name: 'vpn', action: 'logout' },
});

/** The Settings row of the menu (label, hint, description), from the status. Pure; replaces vpnLoginRow(ctx). */
export function vpnLoginRowOf(s: VpnStatus): { label: string; hint: string; description: string } { /* same texts as vpn-login.ts */ }

export function vpnPage(s: VpnStatus): Page { /* below */ }

export const vpnView = defineView({
  id: 'vpn',
  title: 'VPN',
  summary: "The sandbox's VPN: whether it is on, the saved login, and the tunnel.",
  queries: { status: vpnStatus },          // exactly one query: then `sandbox vpn status` prints this page
  operations: [vpnLogin, vpnLogout],
  build: ({ status }) => vpnPage(status),
});
```

`vpnPage(s)` (the CLI prints it for `sandbox vpn status`, the web shows it):

- `sections[0]` `{ id: 'vpn', facts: [...] }` with facts `VPN`, `Provider`, `Protocol`, `Country`, `Kill switch`,
  `Login`, and `Running now` only when `s.running` — values exactly as in "CLI surface to keep" (no colours: give
  `tone: 'ok'` to `on`/`saved (encrypted)`, `'warn'` to kill switch off / `not saved`, `'danger'` to `cannot be read`;
  `running.level` maps `ok`->`ok`, `warn`->`warn`, `bad`->`danger`).
- `notes`: `{ text: 'Next: sandbox vpn login', tone: 'muted', only: 'cli' }` when provider is not wireguard-file and
  login is `none`; `{ text: 'Only the Windows user that saved it can read it. Save it again: sandbox vpn login', tone: 'muted' }`
  when unreadable; then each `VPN_WARNINGS` line with `tone: 'muted'`.
- `sections[0].actions` (not for wireguard-file): `action(vpnLogin, {}, { key: 'v', verb: 'save login' })` and, when
  login is not `none`, `action(vpnLogout, {}, { key: 'x', verb: 'delete login' })`.
- No `empty` (facts are always there).

## Run functions (`src/app/features/vpn/vpn.run.ts`)

- `vpnStatusRun`: `const report = await new VpnService(ctx).report()`; when `input.tunnel` is false, build the same
  object without calling `hostPublicIp` (add `report({ tunnel = true } = {})` to `VpnService`, which then sets
  `running: null` without the request when `tunnel` is false). Return the report. No questions.
- `vpnLoginRun(ctx, _input, io)`:
  1. `requireOnPc('vpn login')`.
  2. `const service = new VpnService(ctx)`; wireguard-file: return `{ message: 'A WireGuard config needs no login: the keys are in the file vpn.configFile points to.' }`.
  3. `io.log` the intro line, each `NORD_STEPS` line numbered `'  ' + (i + 1) + '. ' + s` (NordVPN only), and
     `What you type is not shown. It is kept encrypted for your Windows user and never printed.` (tone `muted`).
  4. `const username = await io.secret({ title: nord ? 'Service user name' : 'User name', validate: (v) => (v.trim() ? true : 'Type the user name.') })`;
     `undefined` -> `cancelled()`. Same for the password (`'Service password'` / `'Password'`, `validate: (v) => (v ? true : 'Type the password.')`).
  5. `service.save({ username, password })` (its `fail()` texts stay).
  6. `VPN_WARNINGS.forEach((w) => io.log(w, 'muted'))`; return `{ message: 'Saved. Turn the VPN on with: sandbox config set vpn.enabled true' }`.
- `vpnLogoutRun(ctx, _input, io)`: `requireOnPc('vpn logout')`; when `loginState() === 'none'` return
  `{ deleted: false, message: 'No VPN login was saved.' }`; else `io.confirm({ title: 'Delete the saved VPN login?', yes: 'Delete', danger: true, implied: true })`
  (implied: the CLI never asked), `cancelled()` on no, then `service.remove()` and
  `{ deleted: true, message: 'The saved VPN login is deleted.' }`.

Never return, log or progress-print the user name or password. Do not put them in `fields` of an action either
(Fields travel to the browser with their `initial` values).

## Registration and wiring

- `src/app/features/vpn/index.ts` barrel; `defs.ts`: `vpnLogin, vpnLogout` in `OPERATIONS`, `vpnStatus` in `QUERIES`,
  `vpnView` in `VIEWS` (import from `./vpn/vpn.def.js`); `registry.ts`: the three runs.
- **CLI**: `vpn` stays a hand-written manifest entry (keep it as it is: summary, group, args, `json: true`, examples).
  The three hints are `action`s of it. Because `definitionFor()` (`src/cli/operations/input.ts`) only matches when
  `positionals[0]` equals the action, **`sandbox vpn` with no action does not reach `vpn.status`**: keep
  `src/cli/commands/vpn.ts` as a 10-line forwarder:

  ```ts
  export function vpn(ctx: Context): Promise<number> {
    const action = ctx.options.positionals[0];
    if (action === undefined) return definitionHandler(vpnStatus)(ctx);
    return fail('Unknown VPN action "' + action + '".', 'Use: sandbox vpn status | login | logout');
  }
  ```

  (`definitionHandler` from `../operations/index.js`, `vpnStatus` from `../../app/features/vpn/index.js`.) Commander
  already refuses an action outside `choices` (`src/cli/args.ts`), so the `fail` line is only a safety net.
- **Menu**: `MENU_VIEWS` gets `{ view: vpnView, section: 'Settings' }`. The Settings page keeps its own row:
  - `load()` reads `this.vpn = await readQuery(vpnStatus, this.ctx, { tunnel: false })` (no network request from the
    menu); `options()` uses `vpnLoginRowOf(this.vpn)` instead of `vpnLoginRow(this.ctx)`.
  - Enter on `VPN_LOGIN` (`result.kind === 'pick'`): `return this.operations.perform(action(vpnLogin, {}), ['Settings', 'Network', 'VPN login'], (t) => this.busy(t))`
    (add a `MenuOperations` field like `sessions-page.ts`).
  - New key `x` "delete VPN login", applying to the `@vpn-login` row only when `this.vpn.login !== 'none'`: add an
    optional parameter `extraActions: readonly ListAction<string>[] = []` to `settingsOptions` (appended to its
    `actions`), pass it from `options()`, and in `act()` run `action(vpnLogout, {})` through `perform` for
    `result.kind === 'action' && result.key === 'x' && result.value === VPN_LOGIN`. (`r` and `z` are taken.)
  - Delete `vpn-login.ts` (move `VPN_LOGIN` into `settings-page.ts`).
- **Web**: VPN goes under Settings in the navigation (uses `NavSection.children` from area 2, 02-projects.md):
  `{ label: 'Settings', children: [{ label: 'Settings', view: 'settings' }, { label: 'VPN', view: 'vpn' }] }`.
  If area 13 or another change already made Settings a parent, add the VPN child to it.

## Web page

`/v/vpn` is drawn by `ViewPage`: the facts card (with the tunnel line when a sandbox runs), the warnings as notes, and
the buttons "Save the VPN login…" and "Delete the VPN login" (red). Save asks the two `secret` questions in
`QuestionModal` (a `PasswordInput`, already supported) after showing the logged steps; the answers travel once over the
signed-in loopback RPC socket and are never sent back. No new Field kind, question kind or target.

`vpn.status` is not live: it makes a request to api.ipify.org when a sandbox runs, so do not add `live`.

## Delete or shrink afterwards

- `src/cli/commands/vpn.ts`: shrinks to the forwarder above (`VPN_WARNINGS` moves to the def).
- `src/cli/menu/vpn-login.ts`: deleted.
- `src/cli/services/vpn-service.ts`: `NORD_STEPS` moves to the def; update `src/cli/services/index.ts` (it exports
  `NORD_STEPS`).
- `docs/commands.md` line for `sandbox vpn` stays true; update only if a text changed.

## Tests

Keep passing unchanged: `npm test -- vpn` (sections "the saved login", "the login never lands in session.json, the
launch folder or --json", "what the host says about the tunnel" ...), `secrets`, `menu`, `app`.

Add (in `src/selftest/app.test.ts`, `t.section('vpn')`, or in `vpn.test.ts`):

- "vpn status page: the facts, the next step on the command line only, the warnings" — `pageLines(vpnPage(sample))`
  contains `Next: sandbox vpn login` for a nordvpn sample with `login: 'none'`, contains both warnings, and has no
  `Running now` row when `running` is null.
- "vpn: wireguard needs no login and offers no login actions" — `pageActions(vpnPage({ ...sample, provider: 'wireguard-file' }))` is empty.
- "vpn login and logout refuse inside the sandbox" — `runDefinition('vpn.login', ctx, {}, fakeIO().io)` throws
  `inside the sandbox already` (the self-test runs in a sandbox; see Pitfalls), and asks no question first.
- "vpn status reads the saved login without the tunnel request" — a ctx `{ storageRoot: t.dir('app-vpn'), loaded: { config: { vpn: { ...DEFAULTS.vpn, provider: 'nordvpn' } } } } as unknown as AppContext`;
  `runDefinition('vpn.status', ctx, { tunnel: false }, fakeIO().io)` gives `login: 'none'`, `running: null`.
  (`VpnService` builds `new VpnLogin(ctx.storageRoot)` with `SecretStore.standard()` = DPAPI; to test a saved login,
  add an optional `SecretStore` parameter to `VpnService` and use `SecretStore.memory()` like `vpn.test.ts` does.)
- Parity: nothing to add; "the parity list shows no gaps" covers it.

## Pitfalls

- **Secrets**: the login is a secret. Not in input, output, `io.log`, `io.progress`, a Field's `initial`, a test's
  printed detail, or `--json`. `printJson` scrubs your settings' secrets, not this login: never put it in an output.
- **`requireOnPc` inside the self-test**: the self-test runs inside a Windows Sandbox, where `requireOnPc` fails with
  `You are inside the sandbox already, ...`. So the login/logout run tests above will hit that guard first. Test the
  guard and test the saving through `VpnService` directly. `insideSandbox()` (`src/host/sandbox/platform.ts`) is false
  when the environment variable `AGENT_SANDBOX_HOST_ONLY` is set; other suites set it only in the environment of a
  child process (`f.runBin(..., { env: { ...process.env, AGENT_SANDBOX_HOST_ONLY: '1' } })` in `engine.test.ts`).
  Setting it on `process.env` inside a test is not done anywhere yet: do not, unless the reviewer agrees. Mark in your
  report which you did.
- `sandbox vpn` with no action: see the forwarder; do not delete `HANDLERS.vpn`.
- The no-terminal fix text for the two secrets changes from `Run sandbox vpn login in a terminal.` to the generic
  `Run it in a terminal, or give the value on the command line.` (io-cli's `NO_TERMINAL_FIX`). No test asserts the old
  text; mention it in your report.
- Colours of the status table (green "on", yellow "not saved") become tones; the CLI's `render-view.ts` paints `warn`
  yellow and `danger` red, `ok` stays plain. Accept it; say so in the report.
- Do not touch `src/host/vpn/prepare.ts` (the launch) or the `vpn.*` settings schema.

## Checklist

1. Write `vpn.def.ts`, `vpn.run.ts`, `index.ts`; register in `defs.ts` and `registry.ts`.
2. Shrink `commands/vpn.ts`; Settings page wiring; delete `menu/vpn-login.ts`; NAV child.
3. Commands (see [00-worked-example.md#commands-to-run](00-worked-example.md#commands-to-run)):

```
npm run build
npm run lint
npm run format:check
npm test -- app,vpn,secrets,menu
npm test
```

`npm test` must print `ALL TESTS PASSED`. Check by hand: `node dist/bin/agent-sandbox.js vpn --help`,
`node dist/bin/agent-sandbox.js vpn status --json` and `node dist/bin/agent-sandbox.js vpn` print what they printed
before (the self-test sandbox has no login saved). Re-read [00-worked-example.md#common-mistakes](00-worked-example.md#common-mistakes).

## Report template

```
Area 10 (vpn) — branch web-ui/vpn
Moved: vpn status/login/logout -> src/app/features/vpn (vpn.status, vpn.login, vpn.logout, view vpn)
Deleted: src/cli/menu/vpn-login.ts; shrunk: src/cli/commands/vpn.ts to the no-action forwarder
Menu: Settings > Network row unchanged; new key x "delete VPN login"
Web: Settings > VPN page
Text changes on the CLI (with reason): ...
Tests added: ...
requireOnPc in tests: how I handled it ...
Unsure / left undone: ...
```
