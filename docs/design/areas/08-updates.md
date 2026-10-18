# 08 · Updates

Read [00-worked-example.md](00-worked-example.md) first. This file only says what is special about updates.

## What it does today

`sandbox update` installs the newest release of a managed install (or `--check`s, `--rollback`s, switches
`--auto on|off`); `sandbox migrate` brings your saved settings up to date with this version (`--dry-run`,
`--restore <backup>`). The menu shows both under Maintenance > Updates.

## Files today

| File | What it does |
| --- | --- |
| `src/cli/services/update-service.ts` | `UpdateService` (`forPackage(packageRoot, feed?, { userDir })`, `managed`, `status(): UpdateStatus`, `check(): Promise<CheckResult>`, `run(): Promise<UpdateResult \| null>`, `rollback(): string`, `setAuto(on)`, `autoUpdateDue()`, `notice()`, `markNoticeSeen()`), `NPM_UPDATE_COMMAND = 'npm install -g windows-development-sandbox'`, `runsAsSystem()`. |
| `src/cli/services/migrate-service.ts` | `MigrateService` (`plan(): string[]`, `run(note): Promise<{ applied, postponed }>`, `restore(folder)`, `versionChanged()`), `autoMigrates()`, `continuesAfterFailedMigration()`. |
| `src/cli/commands/maintenance/update.ts` | `UpdateRequest`, `describeResult(result, unattended): { line, code }` (every sentence an update run can end with), `runUpdate(service, request, print)` (the command's logic), `update(options)` (the handler), `updatesBeforeCommand(entry, command)` (startup notice + background check; **not** part of this area's move). |
| `src/cli/commands/maintenance/migrate.ts` | `whereOf(ctx)` (where backups go when an upgrade has not pinned the old storage folder yet), `runMigrate(service, options, print)`, `migrate(ctx)` (the handler), `migrateBeforeCommand(ctx, command)` (startup migration; **not** moved). |
| `src/host/update/*` | the installer layout, feeds, `UpdateResult`, state files. Untouched. |
| `src/cli/manifest.ts` | entries `name: 'update'` and `name: 'migrate'` (below). |
| `src/cli/args.ts` | `CliOptions.autoUpdate` from `--auto` via `updateAuto()` (fails `--auto needs on or off.` / `Use sandbox update --auto on, or --auto off.`); `resume` also has a boolean `--auto`. |
| `src/cli/commands/registry.ts` / `src/cli/commands/index.ts` | `HANDLERS.migrate` (there is no `HANDLERS.update`: `update` is dispatched in `src/cli/index.ts` before the context, see decision 7); the barrel exports `runUpdate`, `runMigrate`, `migrateBeforeCommand`, `updatesBeforeCommand`. |
| `src/cli/menu/pages/maintenance-page.ts` | category `updates` (`'Which version is installed, installing a newer one, and bringing your saved settings up to date.'`), `updateItems()`, the `settings` rows, the `updates` keys in `maintenanceActions()`, `updates(key)`, `updateSettings()`, `updateKey(id)`, `readSettings()`, `updateStatus()`, field `latest`. |

## CLI surface to keep

`sandbox update` (`summary: 'install the newest version, or check, go back, or switch automatic updates'`, group
`Health`, no positionals). Options, in today's order (descriptions word for word):

| Flag | Type | Description |
| --- | --- | --- |
| `--check` | boolean | `only look whether a newer version exists` |
| `--rollback` | boolean | `go back to the version before the last update` |
| `-y, --yes` | boolean, noMenu | `(--rollback) do not ask first` |
| `--auto <on\|off>` | string, choices `on`,`off` | `install new versions by themselves (for everyone on this PC: needs an admin terminal)` |
| `--unattended` | boolean, noMenu, advanced | `used by automatic updates: no questions, short output` |
| `--feed <folder>` | string, noMenu, advanced | `take the release from this folder (a feed.json and the package) instead of GitHub` |

What it prints (one line on stdout) and exits with, from `runUpdate` / `describeResult`:

- npm install: `This copy was installed with npm. Update it with: npm install -g windows-development-sandbox` (0).
- `--unattended` with automatic updates off and no `--auto`: nothing (0).
- `--auto on|off`: `Automatic updates are on.` / `Automatic updates are off.` (0).
- `--rollback`: asks `Go back from version <v> to version <p>?` (or `... to the version before the last update?`);
  no terminal: `Error: Cannot ask here (no terminal).` + `Fix:  Add --yes to go back without asking.`; no:
  `Nothing was changed.` (1); yes: `Went back to version <v>.` (0).
- `--check`: `Version <x> is available (you have <y>). Run: sandbox update` / `A newer version exists but failed to
  install before; you have <y>.` / `You have the newest version (<y>).` (0).
- install: `describeResult()`'s line: `Another update is running right now.` (0), `Updated from <a> to <b>. Open a new
  terminal to use it.` (0), `Update to <v> failed: <reason>. ...` (1), `You have the newest version (<v>).` (0),
  `A Windows Sandbox is running, so nothing was installed. Close it (sandbox stop), then update again.` (1 by hand,
  0 unattended), `The newest version failed to install before. ...` (0), `No release was found.` (0),
  `Looked a short while ago; nothing to do yet.` (0).

`sandbox migrate` (`summary: 'bring your saved settings up to date with this version'`, group `Health`):
`--dry-run` (`only list what would change`), `--restore <backup>` (`put back the files saved before an update (a
folder under <storage>\backups)`, advanced), `-y, --yes` (`(--restore) do not ask first`, noMenu). Prints:
`Would update:` + `  <line>` per change, or `Nothing to update.`; a run prints each note dimmed, then
`Updated: <a>, <b>.` or `Nothing to update.`, and `Waiting for no sandbox to run: <names>.`; `--restore` asks
`Put back the files saved in <folder>? Your current settings files are replaced.` (no terminal fix `Add --yes to put
them back without asking.`; no: `Nothing was changed.`, 1), then `Put back the files saved in <folder>.`.

Tests that assert these (they call `runUpdate`, `runMigrate`, `describeResult` directly):

- `src/selftest/update-service.test.ts:225` "a task that cannot be removed does not stop the rollback; an unattended
  run with updates off does nothing" (`runUpdate(svc2, { check: false, rollback: false, unattended: true }, ...) === 0`).
- `:280` "an npm install is not managed, is told the npm command, and cannot turn on automatic updates" (lines include
  `npm install -g windows-development-sandbox`).
- `:297-299` "--auto on/off creates and removes the scheduled task of an all-users install; it never updates from a
  CLI start".
- `:315` "--check names the newer version and exits 0" (`Version 1.0.1 is available`).
- `:322` "exit codes: a running sandbox fails by hand but just waits unattended; a failed update exits 1"
  (`describeResult(...)` codes and `from 1.0.0 to 1.0.1`).
- `:195` the auto-off sentence `The update to 1.0.2 failed and was undone (you are on 1.0.0). Automatic updates are
  off; turn them back on in Maintenance > Updates or with sandbox update --auto on.` (status text; do not change).
- `:254` "update options parse; update --auto is not resume --auto" (`parseCli(['update', '--auto', 'on']).autoUpdate
  === 'on'` and `.auto === false`).
- `src/selftest/migrate.test.ts:252-272` "a dry run lists the pending change and changes nothing; a run applies it and
  moves the record on" (`Updated: 2026-10-unpin-config-defaults.`, `Nothing to update.`) and "the run kept one backup
  and --restore puts the saved files back".

## Menu surface to keep

Maintenance > **Updates**, section `This program` (`updateItems()`), values `updates:<id>`:

- Not managed: `Version` (hint version, description `Installed with npm, so npm updates it: <npm command>`) and
  `Update` (hint `with npm`, `Run <npm command> in a terminal.`).
- Managed: `Version` (`Installed for you.` / `Installed for everyone on this PC.`), `Newest version` (hint the found
  version in warn colour or `not looked yet`; `Enter installs it.` / `Enter looks on GitHub for a newer version.`;
  Enter label `install` / `look`), `Automatic updates` (`on`/`off`; Enter label `switch`; description depends on
  scope), optional `Automatic updates turned off` (when `autoOffText`), optional `Previous version` (Enter label
  `go back`, `Enter goes back to it.`), optional `Last failed update` (details: the reason and `It is not tried again
  until a newer version is released.`).
- Section `Saved settings`: one row per pending migration (label = text before `:`, hint `to update`, Enter label
  `update`, `Enter updates your saved settings (a backup is kept first).`), or `Up to date` (`OK`, `Nothing to
  update.`), or an error row.
- Keys (managed only): `c` `check now`, `u` `update now`, `a` `automatic on/off` (on the auto row), `r` `roll back`
  (on the previous row, when there is one); `s` `update saved settings` (on settings rows, when some are pending).
- Rollback asks `Go back to version <p>?`, line `Takes effect the next time you start it.`, button `Go back`.
- Notices today: `Automatic updates are on.`, `Went back to version <v>.`, `Version <x> is available.` /
  `You have the newest version.`, `describeResult` line, `Saved settings updated.` / `Waiting until no sandbox runs:
  ...`, npm: `Installed with npm: update it with <cmd>.`.

Wording decision: the menu now shows **the CLI's sentences** (one wording on every surface, as the sandbox area
did). So `Version 1.5.0 is available (you have 1.4.3). Run: sandbox update`, `Updated: <names>.`, `Waiting for no
sandbox to run: <names>.`, `This copy was installed with npm. Update it with: ...`. Rows, keys, Enter labels and the
rollback dialog's line and button stay.

## Decisions for this area

1. **One operation per command.** `sandbox update` is one command with mode flags, and the CLI maps one command name
   to one definition (`definitionFor` in `src/cli/operations/input.ts`). So `updates.update` is one operation whose
   input has `check`, `rollback`, `auto`, `unattended`, `feed` (like `runUpdate` today); the page offers it several
   times with different inputs (`{ check: true }`, `{}`, `{ auto: 'on' }`, `{ rollback: true }`), each with its own
   label and key. Same for `updates.migrate` (`dryRun`, `restore`).
2. **Exit code 1 becomes `fail(line)`.** Where `describeResult` returns `code: 1` (failed update, sandbox running by
   hand), the run calls `fail(line)`: exit 1 as before, red in the menu and the web. Deliberate, visible change: the
   line now goes to **stderr** with `Error: ` in front. Name it in your report.
3. **`--feed` is only honoured from this process's own command line**: the run uses `input.feed` only when
   `input.feed === ctx.options.feed` (the web server's and the menu's `ctx.options.feed` are undefined), else
   `fail('--feed works only on the command line.')`. The browser can send any input over RPC; installing from a
   folder it names must not be possible.
4. **"Newest version" is not a query** (it needs GitHub). `updatesPage(status, latest)` takes the version the last
   `check` found; the menu page remembers the last `updates.update` output with `check: true` (as it remembers
   `this.latest` today: view state, not logic); the web passes `null` (its check shows the CLI's sentence as a
   notification).
5. **`updates.status` is CLI-exempt**: no command prints it today (`sandbox --version` and `sandbox update --check`
   cover the CLI). Reason: `'no command shows this page; sandbox update --check and --version cover the command line'`.
7. **`sandbox update` runs without settings.** `src/cli/index.ts` has `if (options.command === 'update') return
   commands.update(options);` before `createContext` ("update works on the install, not on a sandbox: it needs no
   settings (and a broken file must not stop it)"). Keep that branch, but make it run the definition with a context
   that does not need the settings: extract the fallback of `repairCommand` (`src/cli/commands/repair/run.ts`: the
   `DEFAULTS`-based context built when `createContext` throws a `UserError`) into
   `contextOrDefaults(packageRoot, entry, options): Context` in `src/cli/commands/context.ts`, use it in
   `repairCommand` too, and write the branch as `return definitionHandler(runUpdate)(commands.contextOrDefaults(
   PACKAGE_ROOT, entry, options));` (`definitionHandler` from `src/cli/operations/index.ts`, `runUpdate` from
   `src/app/features/defs.ts`). The operation's run reads only `ctx.packageRoot` and `ctx.options.feed`. Without this
   the generic dispatch would build the context first and a broken settings file would stop `sandbox update`.
6. **Startup hooks stay where they are**: `updatesBeforeCommand` and `migrateBeforeCommand` run before every command,
   print to stderr and are not user operations. Leave them in `src/cli/commands/maintenance/`.

## Definitions to write (`src/app/features/updates/updates.def.ts`)

```ts
// The program's own updates (install, check, go back, automatic on/off) and your saved settings brought up to date.
// Pure: schemas, labels and the view; updates.run.ts does the work through UpdateService and MigrateService.
import { z } from 'zod';
import { action, defineOperation, defineQuery, defineView, type Item, type Page } from '../../kernel/index.js';

export const UpdatesStatusSchema = z.object({
  managed: z.boolean().describe('Installed by the installer, so it can update itself'),
  version: z.string().describe('The version installed'),
  scope: z.enum(['user', 'machine']).nullable().describe('Installed for you, or for everyone on this PC'),
  autoUpdate: z.boolean().describe('New versions install by themselves'),
  autoOffText: z.string().nullable().describe('Why automatic updates were turned off, if they were'),
  previous: z.string().nullable().describe('The version an update replaced (roll back goes there)'),
  failed: z.object({ version: z.string(), reason: z.string() }).nullable().describe('The last update that failed'),
  npmCommand: z.string().describe('How an npm install is updated'),
  error: z.string().nullable().describe('Why the status could not be read'),
  settings: z
    .object({ pending: z.array(z.string()), error: z.string().nullable() })
    .describe('Changes still to make to your saved settings'),
});
export type UpdatesStatus = z.output<typeof UpdatesStatusSchema>;

export const updatesStatus = defineQuery({
  id: 'updates.status',
  title: 'Updates',
  summary: 'which version is installed and what your saved settings still need',
  input: z.object({}),
  output: UpdatesStatusSchema,
  surfaces: { except: { cli: 'no command shows this page; sandbox update --check and --version cover the command line' } },
});

const LineSchema = z.object({ line: z.string().describe('What happened, in one sentence') });

export const runUpdate = defineOperation({
  id: 'updates.update',
  title: 'Update now',
  summary: 'install the newest version, or check, go back, or switch automatic updates',
  input: z.object({
    check: z.boolean().default(false).describe('only look whether a newer version exists'),
    rollback: z.boolean().default(false).describe('go back to the version before the last update'),
    auto: z
      .enum(['on', 'off'])
      .optional()
      .describe('install new versions by themselves (for everyone on this PC: needs an admin terminal)'),
    unattended: z.boolean().default(false).describe('used by automatic updates: no questions, short output'),
    feed: z
      .string()
      .optional()
      .describe('take the release from this folder (a feed.json and the package) instead of GitHub'),
  }),
  output: LineSchema.extend({ latest: z.string().nullable().describe('The newer version a check found') }),
  text: (o) => o.line,
  cli: {
    name: 'update',
    group: 'Health',
    flags: {
      check: { flag: '--check' },
      rollback: { flag: '--rollback' },
      auto: { flag: '--auto', value: 'on|off' },
      unattended: { flag: '--unattended', noMenu: true, advanced: true },
      feed: { flag: '--feed', value: 'folder', noMenu: true, advanced: true },
    },
    yes: '(--rollback) do not ask first',
  },
});

export const migrateSettings = defineOperation({
  id: 'updates.migrate',
  title: 'Update saved settings',
  summary: 'bring your saved settings up to date with this version',
  input: z.object({
    dryRun: z.boolean().default(false).describe('only list what would change'),
    restore: z
      .string()
      .optional()
      .describe('put back the files saved before an update (a folder under <storage>\\backups)'),
  }),
  output: LineSchema,
  text: (o) => o.line,
  cli: {
    name: 'migrate',
    group: 'Health',
    flags: { dryRun: { flag: '--dry-run' }, restore: { flag: '--restore', value: 'backup', advanced: true } },
    yes: '(--restore) do not ask first',
  },
});

export function updatesPage(s: UpdatesStatus, latest: string | null): Page { ... }

export const updatesView = defineView({
  id: 'updates',
  title: 'Updates',
  summary: 'Which version is installed, installing a newer one, and bringing your saved settings up to date.',
  queries: { status: updatesStatus },
  operations: [runUpdate, migrateSettings],
  build: ({ status }) => updatesPage(status, null),
});
```

Check after `npm run build` (add it as a test, see Tests): the generated `--help` options equal today's flags,
descriptions, `value`s and choices (`--auto` gets choices `on`,`off` from the `z.enum`). Known difference: `-y,
--yes` moves to the **end** of the list (the hint's `yes` is appended last by `commandSpecOf`). Accept it and say so.

`updatesPage(s, latest)`: copy `updateItems()` and the settings rows **row for row** (same ids `updates:<id>` and
`settings:<i>` / `settings:none` / `settings:error`, labels, hints as text, descriptions, details, sections
`This program` and `Saved settings`), turning colours into `tone` and Enter into `primary`:

- `updates:latest`: `primary: latest ? action(runUpdate, {}, { label: 'Install ' + latest, verb: 'install' }) :
  action(runUpdate, { check: true }, { label: 'Check now', verb: 'look' })`.
- `updates:auto`: `primary: action(runUpdate, { auto: s.autoUpdate ? 'off' : 'on' }, { verb: 'switch', label:
  'Automatic updates ' + (s.autoUpdate ? 'off' : 'on') })`, `actions: [ same with key 'a', verb 'automatic on/off' ]`.
- `updates:previous`: `primary: action(runUpdate, { rollback: true }, { label: 'Roll back', verb: 'go back' })`,
  `actions: [ same with key 'r', verb 'roll back' ]`.
- pending settings rows: `primary: action(migrateSettings, {}, { verb: 'update' })`, `actions: [ same, key 's', verb
  'update saved settings' ]`.
- page `actions` (managed only): `action(runUpdate, { check: true }, { key: 'c', verb: 'check now', label: 'Check now'
  })`, `action(runUpdate, {}, { key: 'u', verb: 'update now', label: 'Update now' })`.
- `s.error`: one item `updates:error` with the text, nothing else in that section.

## Run functions (`src/app/features/updates/updates.run.ts`)

Move `describeResult`, `runUpdate`'s and `runMigrate`'s logic and `whereOf` here (a plain helper file in the folder,
e.g. `update-lines.ts`, may hold `describeResult`; it is Node-side because it uses `UpdateResult` from
`host/update`). Shape them so the tests can still drive them with a service of their own:

```ts
/** sandbox update's work, given the service (tests pass their own). */
export async function updateWith(service: UpdateService, input: InputOf<typeof runUpdate>, io: OperationIO):
  Promise<OutputOf<typeof runUpdate>> { ... }
export const runUpdateRun = implement(runUpdate, (ctx, input, io) => {
  if (input.feed !== undefined && input.feed !== ctx.options.feed) fail('--feed works only on the command line.');
  return updateWith(UpdateService.forPackage(ctx.packageRoot, input.feed, { userDir: userDir() }), input, io);
});
```

`updateWith`, in `runUpdate`'s order:

1. Not managed: return `{ line: 'This copy was installed with npm. Update it with: ' + NPM_UPDATE_COMMAND, latest: null }`.
2. `unattended && !auto && !service.status().autoUpdate`: return `{ line: '', latest: null }` (prints nothing: `text`
   returns `''` and the handler prints nothing for an empty text).
3. `auto`: `io.progress('Turning automatic updates ' + auto)`, `service.setAuto(auto === 'on')`, return
   `Automatic updates are <auto>.` (`setAuto` fails by itself with "needs admin" for an all-users install without
   admin: let it).
4. `rollback`: target as today; `const yes = await io.confirm({ title: 'Go back from version ' + version + ' to ' +
   target + '?', lines: ['Takes effect the next time you start it.'], yes: 'Go back', noTerminal: { message: 'Cannot
   ask here (no terminal).', fix: 'Add --yes to go back without asking.' } })`; no: `cancelled('Nothing was
   changed.')`; yes: `Went back to version <v>.`. **Not** `implied`: the command asks today, `--yes` answers it.
5. `check`: `io.progress('Looking for a newer version')`; the three sentences; `latest` = the found version when
   `available`, else `null`.
6. otherwise: `io.progress('Installing the newest version')`; `const done = describeResult(await service.run(),
   input.unattended)`; `done.code !== 0` -> `fail(done.line)`; else `{ line: done.line, latest: null }`.

`migrateWith(service, input, io)` (and `migrateSettingsRun` building `new MigrateService(whereOf(ctx))`):

- `restore`: `io.confirm({ title: 'Put back the files saved in ' + restore + '? Your current settings files are
  replaced.', yes: 'Put back', noTerminal: { message: 'Cannot ask here (no terminal).', fix: 'Add --yes to put them
  back without asking.' } })`; no: `cancelled('Nothing was changed.')`; then `service.restore(restore)`, `Put back the
  files saved in <restore>.`.
- `dryRun`: each plan line through `io.log('  ' + line)` after `io.log('Would update:')`, `text` = `''`; or
  `Nothing to update.`. (Check the printed order is unchanged: log lines print as they come, the text last.)
- run: `service.run((line) => io.log(line, 'muted'))`; then the same lines as `runMigrate`: `Updated: ...` /
  `Nothing to update.` and `Waiting for no sandbox to run: ...` (two sentences: log the first, return the last).

`updatesStatusRun`: `service.status()` (catch -> `error: errMsg(e)` with the rest defaulted), `migrate.plan()` (catch
-> `settings.error`), mapped into the schema (`state.previous ?? null`, `state.failed` -> `{ version, reason }`).
Both services use the same construction as the menu today (`UpdateService.forPackage(ctx.packageRoot, undefined,
{ userDir: userDir() })`, `MigrateService(whereOf(ctx))`). Using `whereOf` in the menu too is a small fix (the menu
used `ctx.storageRoot` directly); mention it.

No `requireOnPc` (the commands never had it; updating inside a sandbox reports "installed with npm" or works on the
sandbox's own copy as before).

## Registration and wiring

- `index.ts` barrel; `defs.ts`: `runUpdate`, `migrateSettings` in `OPERATIONS`, `updatesStatus` in `QUERIES`,
  `updatesView` in `VIEWS`; `registry.ts`: the three runs.
- `NAV`: Maintenance child `{ label: 'Updates', view: 'updates' }` (Maintenance children come from
  [04-data.md](04-data.md); navigation nesting from [02-projects.md](02-projects.md)).
- `MENU_VIEWS`: `{ view: updatesView, section: 'Maintenance' }`.
- CLI: remove the `update` and `migrate` manifest entries and `HANDLERS.migrate`; change the `update` branch of `src/cli/index.ts` as decision 7 says; delete `update(options)`,
  `runUpdate`, `describeResult` from `update.ts` (keep `updatesBeforeCommand` and `NO_STARTUP_UPDATE`), and
  `runMigrate`, `migrate(ctx)` from `migrate.ts` (keep `migrateBeforeCommand`; it needs `whereOf`: import it from the
  feature's helper file, or keep a copy there and say which). Update the barrel `src/cli/commands/index.ts`.
- `CliOptions.autoUpdate` / `updateAuto()` in `args.ts`: after the move nothing reads `autoUpdate`; the input comes
  from `options.raw.auto` through `cliInput`. Keep `autoUpdate` (the test at `update-service.test.ts:254` reads it)
  unless you also update that test; do not remove `updateAuto()`'s check silently (the enum now refuses other words
  with zod's message; say which message users get).
- Menu (`maintenance-page.ts`): the `updates` rows and keys come from `menuView(updatesPage(status, this.latest), {
  category: 'updates', refresh: false })`; `act()` asks this view's `resolve()` only when `this.category ===
  'updates'` and runs the action with `MenuOperations.perform`. The page must remember what a check found
  (`this.latest`), but `perform` and `run` return only the notice. So add an optional last parameter
  `onOutput?: (output: unknown) => void` to `MenuOperations.perform` and `MenuOperations.run` (in
  `src/cli/menu/io-menu.ts`), called with the output on success; the page passes
  `(o) => { this.latest = (o as { latest: string | null }).latest; }` only for the check action (`input.check ===
  true`) and the install action (input without `check`, `rollback` or `auto`: it returns `latest: null`, which clears
  the row as today). Switching automatic updates and rolling back leave `this.latest` alone. This is a menu-surface change (no
  feature logic); add a check in the `app` suite that `onOutput` is called once with the output.
- Delete from the page: `updateItems()`, the settings rows, the `updates` case of `maintenanceActions()`,
  `updates()`, `updateSettings()`, `updateKey()`, `readSettings()`, `updateStatus()`, the `describeResult` import,
  `UpdateService`/`MigrateService` fields (load the status with `readQuery(updatesStatus, this.ctx)` in `load()`).
- `MaintenanceModel.updates`/`settings`/`latest` become `{ status: UpdatesStatus; latest: string | null }`: update
  the fixture in `src/selftest/menu-screens.ts` (same values, new shape).

## Web page

Maintenance > Updates: a "This program" card (version, newest version once checked, automatic updates with a switch
button, previous version with Roll back, the last failed update in red with its reason) and header buttons Check now
/ Update now; a "Saved settings" card with the pending changes and an Update button. Roll back asks in a modal with
the same words. Not managed: the version and "update with npm" text, no buttons. After a successful install the
notification says `Updated from <a> to <b>. Open a new terminal to use it.`; the web server keeps running the old
version until it is restarted: add a section note `{ text: 'The web page keeps running the version it started with
until you run sandbox web stop and sandbox web start.', only: 'web' }` under "This program" (unverified whether the
installer refuses while the web server runs; check `src/host/update` and say what you found).

## Delete or shrink afterwards

`src/cli/commands/maintenance/update.ts` (only `updatesBeforeCommand` left), `migrate.ts` (only
`migrateBeforeCommand` left), the manifest entries, `HANDLERS.migrate`, the updates code of
`maintenance-page.ts` listed above.

## Tests

Keep passing: `update-service`, `update`, `migrate`, `install`, `app`, `menu`, `cli`, `layout`.

Change (logic moved, words not): in `update-service.test.ts` replace `runUpdate(service, request, print)` with
`updateWith(service, input, io)` where `const { io, seen } = fakeIO([...])`, and compare the returned `line` (plus
`seen.logs`) where the test compared printed lines; "exit codes" checks become: code 1 cases throw (`t.throws(...,
'failed', ...)`), code 0 cases return. `describeResult` keeps its signature (moved import path). In `migrate.test.ts`
replace `runMigrate(service, options, say)` with `migrateWith(service, input, io)` and read the lines from
`seen.logs` + the returned line; the restore call passes `fakeIO([true])` instead of `yes: true`.

Add to `app.test.ts`, section `'updates'`:

- "update and migrate keep their flags and help": `JSON.stringify(commandSpec('update')?.options.map((o) => [o.flag,
  o.short ?? '', o.type, o.description]))` equals today's six options (with `--yes` last), same for `migrate`.
- "update --auto on reaches the input": `cliInput(definitionFor('update', [])!, parseCli(['update', '--auto',
  'on']))` equals `{ auto: 'on' }`; `parseCli(['resume', '--auto'])` still gives `auto === true`.
- "update runs with a broken settings file": `contextOrDefaults(...)` with `options.config` pointing at a file containing `broken` returns a context (no throw) whose `loaded.config` equals `DEFAULTS`.
- "--feed from the web is refused": `runDefinition('updates.update', ctx with options.feed undefined, { feed:
  'C:\\x' }, fakeIO().io)` throws `--feed works only on the command line.`.
- "the updates page": `updatesPage(status, '1.5.0')` has rows `updates:version`, `updates:latest` (primary installs),
  `updates:auto`, `updates:previous`; `menuView(..., { category: 'updates', refresh: false }).actions` keys are `c, u,
  a, r, s` (with a pending migration); not managed -> no keys.

## Pitfalls

- **The updater replaces the program on disk.** The menu and the web keep running the old code after an install;
  only say "Open a new terminal" (already in the line). Never restart anything yourself.
- **All-users installs need admin** for `--auto` (scheduled task): `setAuto` fails with "needs admin"; the menu and
  the web show that message; do not try to elevate.
- **`--unattended` runs from a scheduled task** with no terminal: never ask there (`rollback` is not combined with
  it; `auto`, check and install never ask).
- **`resume --auto` vs `update --auto`**: two commands, one attribute name `auto`. Test both after the change.
- Startup hooks (`updatesBeforeCommand`, `migrateBeforeCommand`) must keep working: `src/cli/index.ts:100,124`.
- The failed-update sentence in status (`autoOffText`) is built by the service; show it as is.

## Checklist

1. `updates.def.ts`, `updates.run.ts` (+ helper file), `index.ts`.
2. `defs.ts`, `registry.ts`, `NAV` child, `MENU_VIEWS`; `onOutput` in `io-menu.ts`.
3. Remove the manifest entries and handlers; shrink `update.ts`/`migrate.ts`; the Maintenance page; the fixture.
4. Move the tests as described; add the new ones.
5. Run:
   ```
   npm run build
   npm run lint
   npm run format:check
   npm test -- app,update-service,update,migrate,install,menu,cli,layout
   npm test
   ```
   Gate on `ALL TESTS PASSED` ([commands to run](00-worked-example.md#commands-to-run)); re-read
   [common mistakes](00-worked-example.md#common-mistakes).
6. `node dist/bin/agent-sandbox.js update --help` and `migrate --help`: same flags and words (only `--yes` moved).

## Report template

```
Area 8 (updates) — branch web-ui/updates
Moved: updates.status (cli exempt), updates.update, updates.migrate, updatesView (menu + web: Maintenance > Updates)
CLI: flags/help unchanged except --yes order? <yes/no>; failures now "Error: <line>" on stderr (decision 2)
Menu: rows/keys unchanged? <yes/no>; wording now the CLI's; onOutput added to MenuOperations
--feed guard: <done>; installer while the web runs: <what you found>
Tests moved: <names>; added: <names>; npm test: ALL TESTS PASSED <yes/no>
Unsure / left undone: <...>
```
