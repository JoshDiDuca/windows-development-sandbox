# 07 · Health (doctor, repair, setup)

Read [00-worked-example.md](00-worked-example.md) first. This is the hardest area: read all of this file before you
change anything, and do it in the three steps at the end (7a, 7b, 7c), one commit each.

## What it does today

`sandbox doctor` and `sandbox repair` run one engine of checks (grouped, a line per result as it finishes), list what
can be fixed, ask once, fix, look again; repair also writes a log. `sandbox setup` checks this PC can run Windows
Sandbox and offers to turn the feature on (admin prompt) and to restart Windows.

## Files today

**Mid-change:** another agent is editing `src/cli/commands/repair/checks/pc.ts` and `checks/sandbox.ts` (memory /
heavy-load checks; see `git status`). Rebase on the latest `master` first and do not edit the checks themselves:
this area moves **who runs** the checks, not the checks.

| File | What it does |
| --- | --- |
| `src/cli/commands/repair/engine.ts` | `HealthRun(checks, env, hooks?)` with `look()` and `fix(found)`, `summarize()`, `RunHooks { lookStart, lookEnd, fixStart, fixEnd }`. Pure engine, no printing. **Stays.** |
| `src/cli/commands/repair/checks/*.ts` | every check (`ALL_CHECKS` in `checks/index.ts`), grouped by `CHECK_GROUPS`. **Stay.** |
| `src/cli/commands/repair/types.ts` | `Check`, `Finding`, `CheckResult`, `RepairResult`, `Summary`, `RepairEnv`, `CHECK_GROUPS`, `RepairStatus`. **Stays.** |
| `src/cli/commands/repair/env.ts` | `buildEnv(ctx, configError?)`: the `RepairEnv`. **Stays.** |
| `src/cli/commands/repair/log.ts` | `logName`, `logText`, `writeRepairLog(storageRoot, text, when)` (`<storage>\logs\repair-<time>.log`, null when the storage folder does not exist). **Stays.** |
| `src/cli/commands/repair/printer.ts` | `HealthPrinter` (the CLI's renderer: headings, `✔`/`[ok]` marks, in-place "… Checking …" lines on a terminal, "What it means", "Fix", `plan()`, `summary()`), `summaryText()`. |
| `src/cli/commands/repair/run.ts` | `runHealth(env, printer, plan, checks?, confirmFix?)` (the look -> ask -> fix decision), `runDoctor(ctx)`, `runRepair(ctx, configError)`, `repairCommand(packageRoot, entry, options)` (falls back to `DEFAULTS` when the settings file is broken). Imports `@inquirer/prompts` and `cli/output`. |
| `src/cli/commands/repair/index.ts` | exports `repairCommand`, `runDoctor`, `runRepair`. |
| `src/cli/commands/maintenance/doctor.ts` | `doctor(ctx)` -> `runDoctor(ctx)`. |
| `src/cli/commands/setup/index.ts` | `setup(ctx)` (prints the checklist, asks to turn the feature on, enables, prints again, offers a restart; exit 1 while something needs action), `offerSetupWhenOff(ctx)` (used by `launch` on a PC without the feature). |
| `src/cli/commands/setup/checks.ts`, `facts.ts` | `buildChecks(facts)`, `canEnableFeature(facts)`, `Check { name, status: 'ok'\|'warn'\|'action', detail }`, `gatherFacts(storageRoot)`, `ENABLE_COMMAND`. **Stay.** |
| `src/cli/services/health-service.ts` | `HealthService`: `doctor()` (the "Details" rows; reads `ctx.options.harness`), `assertWindows()`, `setupReport(): SetupReport`, `enableFeature()` (elevated PowerShell through `scripts/run-elevated.ps1`, `stdio: 'inherit'`, refused in the self-test). |
| `src/cli/index.ts` | `if (options.command === 'repair') { ...; return commands.repairCommand(PACKAGE_ROOT, entry, options); }` before the context is created ("repair must run even when the config file is broken"). |
| `src/cli/manifest.ts` | entries `setup`, `doctor`, `repair` (below). `src/cli/commands/registry.ts`: `doctor`, `setup` handlers. |
| `src/cli/menu/pages/maintenance-page.ts` | category `health`: rows `health:check`, `doctor:<i>`, `repair:<i>` / `repair:run`, `setup:<i>` / `setup:error`; keys `f`, `l`, `e`; `loadDoctor()`, `loadSetup()`, `repair()` (leaves the menu to run `repair`), `enable()` (asks, stops the TUI, `enableFeature()`, starts it again). |

## CLI surface to keep

All three stay hand-written commands (decision 1). Their flags, texts, `--json` shapes and exit codes do not change.

- `sandbox doctor` (`summary: 'check this PC, the install, your settings and the sandbox, and offer to fix what it
  finds'`, group `Health`, `json`): `--agent <name>` (flag `--harness` shown as `--agent`, choices `harnesses`, `agent
  to check`), `--fix` (`fix what can be fixed without asking`, noMenu). Prints the title `Checking this PC, the
  install, your settings and the sandbox...`, the results, asks `<n> problem(s) can be fixed. Fix it/them now?`
  (terminal only, default yes), the summary, `<n> problem(s) can be fixed: run sandbox repair (or sandbox doctor
  --fix).` when nothing was changed, then `Details` and the aligned rows. Inside a sandbox: only the rows. `--json`:
  `{ checks, summary, details }`. Exit 0.
- `sandbox repair` (`summary: 'find and fix problems (install, data folder, settings, stale state, half-installed
  tools)'`, group `Health`, `json`): `-y, --yes` (`do not ask before fixing`, noMenu). Same title and results; asks
  `Fix this problem?` / `Fix these <n> problems?`; `Repair will change:` list; summary; `<n> problem(s) can be fixed:
  run sandbox repair --yes.` without a terminal; `Log of what was found and changed: <path>` or `No log was written
  (the storage folder does not exist yet).`. `--json`: `{ checks, summary, changed, log }`. Exit 1 when something
  still needs you. Not inside a sandbox (`requireOnPc('repair')`). Runs with a broken settings file.
- `sandbox setup` (`summary: 'check this PC can run Windows Sandbox and offer to turn it on'`, group `Health`, no
  options): `Checking this PC for Windows Sandbox...`, the table (`OK` / `WARNING` / `ACTION NEEDED`), `Turn on
  Windows Sandbox now? Windows will ask for admin permission.`, `Enabling Windows Sandbox (this can take a
  minute)...`, `Done. Restart Windows to finish, then run sandbox setup again.`, `Restart Windows now?`, `Windows
  restarts in 30 seconds. To cancel: shutdown /a`, or `To do it yourself, in an admin PowerShell run:` +
  `ENABLE_COMMAND`; last line `<n> thing(s) to fix before the sandbox can start (see ACTION NEEDED above).` (exit 1)
  or `This PC is ready. cd into a project and run sandbox claude (or sandbox for no agent).` (exit 0). Failures:
  `Windows Sandbox only runs on Windows.` / `Run sandbox setup on a Windows 10/11 Pro, Enterprise or Education PC.`;
  `Windows Sandbox could not be enabled (or the admin prompt was declined).` / `In an admin PowerShell run: <cmd>,
  then restart Windows.`.

Tests that assert this output (all in `src/selftest/health.test.ts`, suite `health`):

- `:220` "summary line" (`'6 ok, 1 fixed, 1 needs you, 1 warning'`) and `:225` "summary line plurals"
  (`'0 ok, 2 need you, 1 skipped'`).
- `:231` "a result prints as JSON with id, group, name, status, detail, fixable, ms (and applied after a fix)".
- `:254-268` "without --yes and without a terminal nothing is changed or asked", "a "no" changes nothing", "a "yes"
  fixes, then looks again", "--yes fixes without asking" (they call `runHealth(env, null, plan, checks, ask)`).
- `:270-297` section `'printer and log'`: `'\nThis PC\n  [ok] Windows: p1 is fine'`, `'What it means: it hurts'`,
  `'Fix: sandbox repair will mend the cracks'`, `'Fix: check your VPN'`, `'Repair will change:'`, `'[fixed] Cracks:
  mended the cracks'` (a `HealthPrinter` with `animate = false`), "the repair log is named by the time"
  (`repair-20261015-093012.log`), "the log has what was found, changed, before and after", "no log is written when
  the storage folder does not exist".
- `src/selftest/setup.test.ts` sections `'reading what Windows reports'`, `'judging each item'` (facts and checks;
  untouched by this area). `src/selftest/repair.test.ts` (`'tools folder'`, `'state files'`: checks; untouched).

## Menu surface to keep

Maintenance > **Health** (`'Checks this PC and your settings, repairs problems, and sets up Windows Sandbox.'`):

- Before any check: row `Check this PC` (section `Doctor`, Enter label `check`, description `Looks at this PC: Windows
  features, the install, the folders and the sandbox. It takes a few seconds, so it only runs when you ask.`).
- After a check: section `Doctor` with one row per detail row (label = name, hint = detail cut to 50, details = the
  detail); section `Set up this PC` with one row per setup check (hint `OK` / `WARNING` / `ACTION NEEDED`) or the error.
- Section `Repair`: before a repair `Run the checks and fix what can be fixed` (Enter label `check and fix`,
  description `Checks the install, data folder, settings and sandbox, lists what it would change, and asks before it
  fixes anything.`); after one, one row per result (hint `OK`/`FIXED`/`NEEDS YOU`/`WARNING`/`SKIPPED`, description =
  detail).
- Keys: `f` `check and fix`, `l` `check` (`check again` after a check), `e` `turn on Windows Sandbox` (only when the
  setup report says it can be turned on).
- `e` asks `Turn on Windows Sandbox?`, line `Windows asks for admin permission, then you restart Windows to finish.`,
  button `Turn on`; notices `Done. Restart Windows to finish.` / `Windows Sandbox could not be turned on (or the admin
  prompt was declined).`.

Changes (decided here): `f` now runs the repair **inside the menu** (progress as notices, "Repair will change:" shown
above the question, the result as a notice and as rows) instead of leaving for the normal screen; results survive a
reload because they are saved (decision 3). Rows, sections, keys and Enter labels stay.

## Decisions for this area

1. **The CLI commands `doctor`, `repair` and `setup` stay hand-written**, as renderers of the feature's functions:
   `repair` must start before a context can be built (broken settings file), and `doctor`/`repair` redraw lines in
   place on a terminal and print `--json` with no other output, which `definitionHandler` and `cliIO` cannot do. The
   **logic** (build the env, look, decide, ask, fix, write the log, save the result) moves into the feature as
   exported functions the CLI handlers call; the handlers keep only printing. Every health definition therefore
   declares a `cli` exemption with the reason below. Name this deviation in your report.
2. **The engine stays where it is** (`src/cli/commands/repair/{engine,env,log,types}.ts`, `checks/`): it is the
   service layer of this area. Only `runHealth` moves out of `run.ts` (which imports `@inquirer` and `cli/output`)
   into a new `src/cli/commands/repair/health-run.ts` with no surface imports, so the feature can import it.
3. **Results are saved**, so the menu and the web can show them as a page: every check or repair writes
   `<storage>\health\last.json` (zod schema, `JsonFile`, `assertNoLinks(storageRoot, dir)` first), read by the query
   `health.last`. Today the menu keeps them in memory only.
4. **Streaming is `io.log`/`io.progress`** from the engine's hooks (an adapter `ioEvents(io)`), not a live query: the
   checks run once per press and a query must not change things or ask. The lines use the plain marks (`[ok]`,
   `[fixed]`, `[!]`, `[x]`, `[-]`), the same text `HealthPrinter` writes with `animate = false`.
5. **Turning the feature on is not offered on the web**: Windows shows the admin prompt on this PC's desktop and the
   web server may be a background process with no console. `health.enableSandbox` declares
   `web: 'Windows asks for admin permission on this PC; use the menu or sandbox setup'`.

## Definitions to write (`src/app/features/health/health.def.ts`)

```ts
// The health of this PC and the sandbox: the last check or repair (saved), checking, repairing, and turning Windows
// Sandbox on. Pure: schemas, the line format both the menu/web output and the page use, and the view.
import { z } from 'zod';
import { action, ago, defineOperation, defineQuery, defineView, type Item, type Page, type Tone } from '../../kernel/index.js';

const CLI_DOCTOR = 'sandbox doctor and sandbox repair are hand-written renderers of this run (lines redrawn in place, --json alone, repair before the settings load)';

export const StatusSchema = z.enum(['ok', 'fixed', 'needs-you', 'warn', 'skipped']).describe('What the check found');
export const CheckRowSchema = z.object({
  id: z.string().describe('The check'),
  group: z.string().describe('Its heading (This PC, Install ...)'),
  name: z.string().describe('What was checked'),
  status: StatusSchema,
  detail: z.string().describe('What was found'),
  means: z.string().optional().describe('What it means for you'),
  fix: z.string().optional().describe('What to do yourself'),
  plan: z.string().optional().describe('What repair would change'),
  lines: z.array(z.string()).optional().describe('More lines (a diff, folders)'),
  fixable: z.boolean().describe('Repair can mend it'),
  timedOut: z.boolean().optional().describe('It took too long'),
  applied: z.object({ done: z.string(), before: z.string(), after: z.string() }).optional().describe('What a fix changed'),
  error: z.string().optional().describe('Why a fix did not work'),
});
export const SummarySchema = z.object({
  total: z.number(), ok: z.number(), fixed: z.number(), warn: z.number(),
  needsYou: z.number(), skipped: z.number(), fixable: z.number(),
}).describe('How many checks ended how');
export const SetupRowSchema = z.object({
  name: z.string().describe('What was looked at'),
  status: z.enum(['ok', 'warn', 'action']).describe('OK, a warning, or something to do'),
  detail: z.string().describe('What was found'),
});
export const HealthLastSchema = z.object({
  at: z.string().describe('When it ran (ISO time)'),
  mode: z.enum(['check', 'repair']).describe('A check or a repair'),
  checks: z.array(CheckRowSchema).describe('The results'),
  summary: SummarySchema,
  details: z.array(z.tuple([z.string(), z.string()])).describe('The doctor details: name and value'),
  setup: z
    .object({ checks: z.array(SetupRowSchema), canEnable: z.boolean(), error: z.string().nullable() })
    .nullable()
    .describe('What sandbox setup found'),
  log: z.string().nullable().describe('The repair log, if one was written'),
});
export type HealthLast = z.output<typeof HealthLastSchema>;

/** "6 ok, 1 fixed, 1 needs you, 1 warning": moved here from repair/printer.ts (printer.ts re-exports it). */
export function summaryText(s: z.output<typeof SummarySchema>): string { /* the body of today's summaryText */ }

/** The lines of one result as the plain printer writes them (no colour; tone for the surfaces that paint). */
export function resultLines(r: z.output<typeof CheckRowSchema>): { text: string; tone?: Tone }[] { ... }

export const lastHealth = defineQuery({
  id: 'health.last',
  title: 'Health',
  summary: 'the last check or repair of this PC and the sandbox',
  input: z.object({}),
  output: z.object({ last: HealthLastSchema.nullable().describe('Nothing yet: no check has run') }),
  surfaces: { except: { cli: 'the command line prints results as it checks (sandbox doctor)' } },
});

const OutcomeSchema = z.object({
  summary: SummarySchema,
  changed: z.boolean().describe('Fixes were applied'),
  log: z.string().nullable().describe('The repair log, if one was written'),
});

export const checkHealth = defineOperation({
  id: 'health.check',
  title: 'Check this PC',
  summary: 'check this PC, the install, your settings and the sandbox (changes nothing)',
  input: z.object({ harness: z.string().optional().describe('agent to check') }),
  output: OutcomeSchema,
  text: (o) => 'Summary: ' + summaryText(o.summary),
  surfaces: { except: { cli: CLI_DOCTOR } },
});

export const repairHealth = defineOperation({
  id: 'health.repair',
  title: 'Run the checks and fix what can be fixed',
  summary: 'find and fix problems (install, data folder, settings, stale state, half-installed tools)',
  input: z.object({}),
  output: OutcomeSchema,
  text: (o) =>
    'Summary: ' + summaryText(o.summary) + (o.log ? '. Log: ' + o.log : '. No log was written (the storage folder does not exist yet).'),
  surfaces: { except: { cli: CLI_DOCTOR } },
});

export const enableSandbox = defineOperation({
  id: 'health.enableSandbox',
  title: 'Turn on Windows Sandbox',
  summary: 'turn on the Windows Sandbox feature (Windows asks for admin permission; restart to finish)',
  input: z.object({}),
  output: z.object({ message: z.string().describe('What happened') }),
  text: (o) => o.message,
  surfaces: {
    except: {
      cli: 'sandbox setup asks and turns it on (hand-written: it also offers to restart Windows)',
      web: 'Windows asks for admin permission on this PC; use the menu or sandbox setup',
    },
  },
});

export function healthPage(o: { last: HealthLast | null }): Page { ... }

export const healthView = defineView({
  id: 'health',
  title: 'Health',
  summary: 'Checks this PC and your settings, repairs problems, and sets up Windows Sandbox.',
  queries: { last: lastHealth },
  operations: [checkHealth, repairHealth, enableSandbox],
  build: ({ last }) => healthPage(last),
});
```

`resultLines(r)` must produce exactly what `HealthPrinter.result()` writes with `animate = false`, without the
heading (the caller adds `group` lines): `'  ' + MARK[r.status] + ' ' + r.name + ': ' + r.detail + (r.timedOut ? '
(took too long)' : '')`, then, when not ok, `'      What it means: ' + means`, `'      Fix: sandbox repair will ' +
plan` (fixable) or `'      Fix: ' + fix`, up to 6 `'        ' + line` and `'        ... and <n> more'`. `MARK` =
`{ ok: '[ok]', fixed: '[fixed]', warn: '[!]', 'needs-you': '[x]', skipped: '[-]' }`. Tones: ok none, fixed
`accent`, warn `warn`, needs-you `danger`, skipped `muted`.

`healthPage({ last })`, pure, copying the menu rows (ids are the menu's row values, keep them):

- `last === null`: section `Doctor` with item `health:check` (`Check this PC`, the description above, `primary:
  action(checkHealth, {}, { verb: 'check' })`); section `Repair` with item `repair:run` (`primary:
  action(repairHealth, {}, { verb: 'check and fix' })`).
- otherwise: a first section without title whose `summary` is `(last.mode === 'repair' ? 'Repaired ' : 'Checked ') +
  ago(last.at)` and, when `last.log`, a fact `Log` = the path. Section `Doctor`: items `doctor:<i>` from
  `last.details` (label name, hint the detail cut to 50 characters, details `[detail]`). Section `Repair`: items
  `repair:<i>` from `last.checks` (label `name`, hint `OK`/`FIXED`/`NEEDS YOU`/`WARNING`/`SKIPPED` with tones ok,
  accent, danger, warn, muted, description `detail`, details `resultLines(r).map((l) => l.text.trim())` minus the
  first). Section `Set up this PC`: items `setup:<i>` (hint `OK`/`WARNING`/`ACTION NEEDED`, tones ok/warn/danger,
  description `detail`) or `setup:error`.
- Page actions: `action(repairHealth, {}, { key: 'f', verb: 'check and fix', importance: 1 })`, `action(checkHealth,
  {}, { key: 'l', verb: last ? 'check again' : 'check', importance: 2 })`, and when `last?.setup?.canEnable`:
  `action(enableSandbox, {}, { key: 'e', verb: 'turn on Windows Sandbox', importance: 3 })`.
- The menu draws this with `refresh: false` (`l` is "check" here, not refresh).

## Run functions (`src/app/features/health/health.run.ts`)

Step 7a first creates `src/cli/commands/repair/health-run.ts`:

```ts
/** Where results go while the checks run: the CLI's HealthPrinter, or ioEvents(io). */
export interface HealthEvents {
  hooks(): RunHooks;
  plan(fixable: readonly CheckResult[]): void;
  line(text: string): void;
}
export interface HealthPlan { readonly yes: boolean; readonly ask: boolean; readonly question: (n: number) => string; }
export async function runHealth(env, events: HealthEvents | null, plan: HealthPlan, checks = ALL_CHECKS,
  confirmFix: (question: string) => Promise<boolean>): Promise<HealthReport> { /* today's body, printer -> events */ }
```

`HealthPrinter` already has `hooks()`, `plan()` and `line()`, so it is a `HealthEvents` as it is. `run.ts` imports
`runHealth` from there and passes `(q) => confirm({ message: q, default: true })` itself; keep `export { runHealth }
from './health-run.js'` in `run.ts` so `health.test.ts` keeps its import (or change the import there: moved, not
changed).

The feature's shared function (the CLI handlers call it too):

```ts
export interface HealthSurface {
  readonly events: HealthEvents | null;          // null: --json
  readonly mayAsk: boolean;                       // CLI: a terminal and not --json; menu and web: true for repair
  readonly confirmFix: (question: string) => Promise<boolean>;
}
export interface HealthRequest {
  readonly mode: 'doctor' | 'repair';
  readonly yes: boolean;                          // --fix / --yes
  readonly harness?: string;                      // --agent
  readonly configError?: UserError | null;        // repair with a broken settings file
  readonly setup?: HealthLast['setup'];           // what checkHealthRun found, saved with the rest (default null)
}
export async function healthWith(ctx: AppContext, request: HealthRequest, surface: HealthSurface): Promise<{
  report: HealthReport; details: string[][]; log: string | null;
}>
```

`healthWith`, in today's order (`runDoctor` / `runRepair`):

1. `repair`: `requireOnPc('repair')`.
2. `const env = buildEnv(ctx, request.configError ?? null)`.
3. `runHealth(env, surface.events, { yes: request.yes, ask: surface.mayAsk, question }, ALL_CHECKS,
   surface.confirmFix)` with today's questions: doctor `quote(n, 'problem') + ' can be fixed. Fix ' + (n === 1 ? 'it' :
   'them') + ' now?'`, repair `'Fix ' + (n === 1 ? 'this problem' : 'these ' + n + ' problems') + '?'`.
4. `doctor`: `details = new HealthService(ctx).doctor(request.harness)` (change `doctor()` to take the agent; default
   `ctx.options.harness ?? ctx.loaded.config.defaultHarness` as today). `repair`: write the log exactly as
   `runRepair` does (`writeRepairLog(ctx.storageRoot, logText({ ..., command: 'sandbox repair' + (yes ? ' --yes' :
   '') }), when)`).
5. Save `last.json` (decision 3) with `mode: request.mode === 'repair' ? 'repair' : 'check'`, the final results
   mapped to `CheckRowSchema` (drop `ms`), `summary`, `details` (each cell through `safeText`), `setup` (see
   `checkHealthRun`; `null` from the CLI), `log`. A write that fails must not fail the command: catch and say why in
   a comment (like `writeRepairLog`).

`ioEvents(io): HealthEvents` (in `health.run.ts`): `hooks()` returns `lookStart: (c) => io.progress('Checking ' +
(c.checking ?? c.name.toLowerCase()))`, `lookEnd: (r) => { heading(r.group); for (const l of resultLines(r))
io.log(l.text, l.tone); }`, `fixStart: (r) => io.progress('Fixing: ' + (r.plan ?? r.name))`, `fixEnd: (r) =>
io.log(...)` with the printer's fixed/failed wording (`'  [fixed] ' + name + ': ' + done` / `'  [x] ' + name + ':
the fix did not work' + (error ? ' (' + error + ')' : '')`); `heading(group)` logs `group` (tone `accent`) when it
changes; `plan(fixable)` logs `Repair will change:`, the numbered lines and `Nothing is deleted except leftovers;
your settings, logins and projects are never removed.`; `line(text)` logs it.

The definitions' runs:

- `checkHealthRun(ctx, input, io)`: `io.progress('Checking this PC')`; `healthWith(ctx, { mode: 'doctor', yes: false,
  harness: input.harness }, { events: ioEvents(io), mayAsk: false, confirmFix: () => Promise.resolve(false) })`
  (never fixes); then the setup report like `loadSetup()`: `health.assertWindows(); health.setupReport()` mapped to
  `{ checks, canEnable, error: null }`, or `{ checks: [], canEnable: false, error: errMsg(e) }`; save it into
  `last.json` (healthWith takes an optional `setup` for that). Return `{ summary, changed: false, log: null }`.
- `repairHealthRun(ctx, _input, io)`: `healthWith(ctx, { mode: 'repair', yes: false }, { events: ioEvents(io),
  mayAsk: true, confirmFix: (q) => io.confirm({ title: q, yes: 'Fix' }) })`; a "no" is not `cancelled()`: today
  repair prints `Nothing was changed.` and still writes the log, so return normally (`runHealth` logs `Nothing was
  changed.` through `events.line`).
- `enableSandboxRun(ctx, _input, io)`: `requireOnPc('setup')`; `const health = new HealthService(ctx);
  health.assertWindows();` `const yes = await io.confirm({ title: 'Turn on Windows Sandbox?', lines: ['Windows asks
  for admin permission, then you restart Windows to finish.'], yes: 'Turn on' })`; no: `cancelled()`;
  `io.progress('Turning on Windows Sandbox')`; `health.enableFeature('ignore')` (add a `stdio: 'inherit' |
  'ignore'` parameter, default `'inherit'` for `sandbox setup`; with `'ignore'` the menu needs no `terminal.stop()`;
  unverified that `run-elevated.ps1` works without a console: try it and report); return `{ message: 'Done. Restart
  Windows to finish.' }` or `fail('Windows Sandbox could not be turned on (or the admin prompt was declined).', 'In an
  admin PowerShell run: ' + ENABLE_COMMAND + ', then restart Windows.')`. Then refresh `last.json`'s setup part
  (call the setup report again and save).
- `lastHealthRun(ctx)`: read `last.json` with `JsonFile(HealthLastSchema, file).read()` (null when missing or
  invalid); return `{ last }`.

The CLI handlers become renderers:

```ts
// src/cli/commands/repair/run.ts
export async function runDoctor(ctx: Context): Promise<number> {
  const health = new HealthService(ctx);
  if (insideSandbox()) { table(health.doctor()); return 0; }
  const json = ctx.options.json;
  const printer = json ? null : new HealthPrinter(stdout);
  printer?.title('Checking this PC, the install, your settings and the sandbox...');
  const { report, details } = await healthWith(ctx, { mode: 'doctor', yes: ctx.options.fix, harness: ctx.options.harness },
    { events: printer, mayAsk: !json && interactive(), confirmFix: (q) => confirm({ message: q, default: true }) });
  if (printJson(ctx, { checks: report.final, summary: report.summary, details })) return 0;
  /* the same printing as today: summary, "can be fixed" line, Details, table(details) */
}
```

`runRepair(ctx, configError)` likewise (`healthWith(ctx, { mode: 'repair', yes: ctx.options.yes, configError },
...)`, then today's JSON / summary / log lines and `return report.summary.needsYou ? 1 : 0`). `repairCommand` and the
`repair` branch in `src/cli/index.ts` stay as they are. `setup(ctx)` keeps its flow and texts; it may call
`HealthService` directly (it is a renderer with its own questions: `askYesNo` answers no without a terminal, which
`io.confirm` cannot express).

## Registration and wiring

- `index.ts` barrel; `defs.ts`: `checkHealth`, `repairHealth`, `enableSandbox` in `OPERATIONS`, `lastHealth` in
  `QUERIES`, `healthView` in `VIEWS`; `registry.ts`: the four runs.
- `NAV`: Maintenance child `{ label: 'Health', view: 'health' }` (children from [04-data.md](04-data.md), nesting from
  [02-projects.md](02-projects.md)).
- `MENU_VIEWS`: `{ view: healthView, section: 'Maintenance' }`.
- Menu (`maintenance-page.ts`): load `readQuery(lastHealth, this.ctx)`; health rows and keys from
  `menuView(healthPage(last), { category: 'health', refresh: false })`; in `act()`, only when `this.category ===
  'health'`, `resolve()` then `this.operations.perform(...)`. Delete `loadDoctor()`, `loadSetup()`, `repair()`,
  `enable()`, the `health` part of `maintenanceOptions()` (`check`, `doctor`, `repair`, `setup` rows) and of
  `maintenanceActions()`, the fields `doctorRows`, `repairRows`, `setupReport`, `health`, and the `REPAIR_LABEL`
  table. `MaintenanceModel.doctor`/`repair`/`setup` become `health: { last: HealthLast | null }`: update the fixture
  in `src/selftest/menu-screens.ts` (same rows, new shape) so `7 Maintenance · health (80x24)` still renders (the
  "every screen" check names it).
- The manifest entries and `HANDLERS` for `doctor`, `repair`, `setup` stay (decision 1).

## Web page

Maintenance > Health: before any check, two buttons in cards ("Check this PC", "Run the checks and fix what can be
fixed") with their descriptions. While one runs, the progress notification shows "Checking <thing>…"; the result
lines arrive with the result (the web shows logged lines in the notification on failure; on success the page reloads
and shows the saved results). After a check: "Checked 3 min ago", a Doctor card (name/value rows), a Repair card (one
row per check with a coloured badge and, under it, What it means / Fix), a Set up this PC card, and the repair log
path as a fact. Repair asks in a modal whose text starts with the "Repair will change:" lines. No "Turn on Windows
Sandbox" button (decision 5); show a note `{ text: 'Turn Windows Sandbox on from the menu or with sandbox setup.',
only: 'web' }` in Set up this PC when `canEnable`. 360 px: rows wrap; badges stay next to names.

## Delete or shrink afterwards

- `run.ts`: `runHealth` moves to `health-run.ts`; `runDoctor`/`runRepair` keep only printing.
- `maintenance-page.ts`: everything listed under Registration.
- `HealthPrinter` stays (CLI renderer). `summaryText` moves to `health.def.ts`; `printer.ts` re-exports it.

## Tests

Keep passing: `health`, `repair`, `setup`, `app`, `menu`, `layout`, `hostile-input`.

Add to `src/selftest/health.test.ts` (it already has `fakeEnv`, `check`, `bad` helpers), section `'the shared core'`:

- "ioEvents writes what the plain printer writes": run `runHealth(env, ioEvents(fake.io), { yes: true, ask: false,
  question: () => '' }, <the three checks of 'printer and log'>, () => Promise.resolve(true))` and check
  `fake.seen.logs.map((l) => l.text).join('\n')` includes `'  [ok] Windows: p1 is fine'`, `'What it means: it hurts'`,
  `'Fix: sandbox repair will mend the cracks'`, `'Repair will change:'`, `'[fixed] Cracks: mended the cracks'`.
- "summaryText moved and reads the same": the two summary-line checks against the `health.def.ts` export.
- "a check is saved and read back": `healthWith` against `fakeEnv`'s folders is hard (it calls `buildEnv`); instead
  test the save/read pair: write a `HealthLast` with the save helper into `t.dir(...)`, read it with `lastHealth`'s
  run through `runDefinition('health.last', ctx, {}, fakeIO().io)`; a corrupt file reads as `{ last: null }`.
- "the health page": `healthPage({ last: null })` offers `health.check` and `health.repair` with menu ids
  `health:check`, `repair:run`; with a sample `last` it has `doctor:0`, `repair:0`, `setup:0`; keys from
  `menuView(..., { category: 'health', refresh: false }).actions` are `f, l` (plus `e` when `canEnable`); Enter label
  of `repair:run` is `check and fix`.
- In `app.test.ts`: the parity line shows no gap (all four have reasons for cli; enable has one for web).

## Pitfalls

- **Admin prompts**: only `enableFeature()` elevates (`run-elevated.ps1`); repair never elevates. Never add
  elevation anywhere else, and never run `enableFeature` in the self-test (`refuseInSelfTest` guards it).
- **Repair with a broken settings file** must keep working: do not route `repair` through `createContext`; keep the
  `src/cli/index.ts` branch and `repairCommand`.
- **`--json` prints only JSON**: the CLI passes `events: null` and `mayAsk: false` under `--json`.
- **The checks are slow and run programs**: never put them in a query, never make the view read them on load.
- **Check text can quote what the sandbox wrote** (stale records, run state): `safeText` on what you save and log.
- **Mid-change checks** (`pc.ts`, `sandbox.ts`): do not edit; rebase.
- Keys: `f` and `l` mean something else in other Maintenance categories; resolve only for the open category.

## Checklist

- 7a: `health-run.ts` + `HealthEvents`; `run.ts` uses it; `npm test -- health` still passes unchanged.
- 7b: `health.def.ts`, `health.run.ts` (`healthWith`, `ioEvents`, the four runs, `last.json`), registration, `NAV`,
  `MENU_VIEWS`; CLI handlers call `healthWith`; Maintenance page wiring; fixture; new tests.
- 7c: `enableFeature(stdio)`, `health.enableSandbox` in the menu; try the admin prompt by hand only on a throwaway PC
  (never on a real one).
- Run after each step:
  ```
  npm run build
  npm run lint
  npm run format:check
  npm test -- app,health,repair,setup,menu,layout
  npm test
  ```
  Gate on `ALL TESTS PASSED` ([commands to run](00-worked-example.md#commands-to-run)); re-read
  [common mistakes](00-worked-example.md#common-mistakes).
- By hand: `node dist/bin/agent-sandbox.js doctor --help`, `repair --help`, `setup --help` unchanged.

## Report template

```
Area 7 (health) — branch web-ui/health
Steps: 7a <commit>, 7b <commit>, 7c <commit>
Moved: health.last, health.check, health.repair, health.enableSandbox (cli exempt: decision 1; enable web exempt)
CLI: doctor/repair/setup output, --json and exit codes unchanged? <yes/no + diff>
Menu: rows/keys unchanged? <yes/no>; repair now runs in the menu; results saved in <storage>\health\last.json
enableFeature('ignore') works without a console? <yes/no/untested>
Tests added: <names>; npm test: ALL TESTS PASSED <yes/no>
Unsure / left undone: <...>
```
