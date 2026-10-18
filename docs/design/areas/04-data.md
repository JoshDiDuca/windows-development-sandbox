# 04 · Data

Read [00-worked-example.md](00-worked-example.md) first. This file only says what is special about the data area.

## What it does today

`sandbox data` measures what the sandbox keeps between runs (toolchains, databases, agent state, logs, what this PC
keeps) and `sandbox data clean` deletes chosen parts of it; `sandbox clean` prunes old launch folders, logs and
leftovers. In the menu all of it is the **Data & storage** category of Maintenance.

## Files today

| Path | What it does |
| --- | --- |
| `src/cli/manifest.ts` (entry `name: 'data'`, ~line 331) | `data [action] [targets...]`, actions `show`/`clean` (aliases `info`, `list`, `remove`), `--yes`/`-y`, `--json`, two examples |
| `src/cli/manifest.ts` (entry `name: 'clean'`, ~line 410) | `clean`, `--days <n>` (number, default 7), `--yes`/`-y` |
| `src/cli/commands/data/index.ts` | `data()` dispatch (`info`/`show`/`list` -> `dataInfo`, `clean`/`remove` -> `dataClean`, else fail) and `dataInfo` (prints disks, groups, total) |
| `src/cli/commands/data/clean.ts` | `dataClean`: picks targets (checkbox list) when none typed, plans, prints the table, asks, removes, prints the result |
| `src/cli/commands/data/collect.ts` | `collectDataEntries(dataPath, storageRoot)`, `cleanTargetOf(entry)`, `DataEntry`, `DataArea` (Node, no printing) |
| `src/cli/commands/data/remove.ts` | `removeTree(p, root)`: deletes without following links |
| `src/cli/services/data-service.ts` | `DataService`: `entries()`, `report()`, `plan(inputs)` (fails while a sandbox runs, `assertNoLinks`), `clean(plan)` |
| `src/cli/services/data-targets.ts` | `resolveCleanTargets(inputs, dataPath, storageRoot)`: pure target checks and their `fail()` texts |
| `src/cli/commands/maintenance/clean.ts` | `clean()`: `pruneStorage(..., { dryRun: true })`, asks, prunes, prints |
| `src/host/storage/cleanup.ts` | `pruneStorage`, `describePrune`, `DEFAULT_PRUNE` |
| `src/core/disk.ts` | `sizeOf`, `diskUsage`, `humanBytes`, `DiskUsage` |
| `src/cli/commands/registry.ts` | `HANDLERS`: `clean: clean`, `data: data` |
| `src/cli/menu/pages/maintenance-page.ts` | category `data` ("Data & storage"): `dataItems()`, `AREA_LABEL`, keys in `maintenanceActions()`, `enterLabel()`, `measure()`, `remove()`, the `data:clean` row opening `CommandForm` for `clean` |
| `src/cli/menu/data-folder.ts` | the "Data folder" row and `DataFolderFlow`: **owned by area 5 (storage)**, leave it alone here |
| `src/selftest/menu-screens.ts` | builds a `MaintenanceModel` with `data: { entries, disks, total }` for the screen snapshots |

## CLI surface to keep

### `sandbox data [show|clean] [targets...]`

- `sandbox data`, `sandbox data show`, `sandbox data info`, `sandbox data list`: measure and print. `--json` prints
  exactly `{ dataPath, storageRoot, totalBytes, entries: [{ area, name, path, bytes }], disks: [{ drive, totalBytes,
  freeBytes, usedBytes, holdsStorage }] }` (key order as written; `src/cli/commands/data/index.ts`).
- Spinner text while measuring (not with `--json`): `Measuring the saved data (big folders take a moment)`.
- Text lines to keep (layout may change, the sentences may not): `Disks`, the table header `DRIVE USED FREE SIZE`,
  `<- sandbox storage (<size> of it)` on the drive that holds storage, `Persistent data for the sandbox: <dataPath>
  (C:\AgentData inside)`, `Nothing stored yet. Toolchains, databases and agent logins appear here after the first
  start.`, the group labels `Toolchains`, `Databases`, `Agent state`, `Logs`, `Other`, `On this PC`, the `Total` row,
  and `Free space with: sandbox data clean <target...>  (e.g. tools/go, databases/postgres-18, logs, launches)`.
- `sandbox data clean <targets...>` and `sandbox data remove <targets...>`; `--yes` deletes without asking.
  - No target and no terminal: fails `Which data should be cleaned?` / `Name them: sandbox data clean logs tools/go
    (what exists: sandbox data)`.
  - No target on a terminal: a checkbox list `What do you want to delete? (space ticks, enter confirms)` with rows
    `<target padded to 28><size>`. Nothing ticked: prints `Nothing chosen, nothing removed.`, exit 0.
  - Target errors come from `resolveCleanTargets` (keep every text; the `data` suite checks which inputs fail).
  - None of them exists: `Nothing to remove: <targets> do(es) not exist.`, exit 0.
  - Otherwise prints a table `  <target>  <size>  <path>`, then `Warning: <target> <warning>.` per warning, then asks
    `Delete <targets> (<size>)? This cannot be undone.` (no terminal: `Cannot ask here (no terminal).` / `Add --yes to
    delete without asking.`). For `all` it asks to type `all` instead: `This cannot be undone; the next sandbox starts
    from scratch and reinstalls everything. Type "all" to confirm:`.
  - A "no": prints `Nothing removed.`, **exit 1**.
  - Partial failure: fails `Could not remove everything: <list>` / `Close programs using those folders and run the
    same command again.`
  - Success: `Removed <targets> and freed <size>; the next sandbox reinstalls what it needs.` (or ending in `.` when
    no data-folder target was touched), then the dimmed `Next: sandbox data   (see what is left)`.
  - A running sandbox: `A Windows Sandbox is running, and it uses these folders.` / `Close it first (sandbox stop),
    then run this again.` (from `DataService.plan`).
  - Unknown action: today `data()` fails `Unknown data action "<x>".`; the parser already refuses it first
    (`Allowed choices are show, clean`, see tests).

### `sandbox clean [--days <n>] [--yes]`

- Nothing found: `Nothing to clean.`, exit 0.
- Else `Can be removed: <describePrune without " removed">.`, asks `Delete them?` (no terminal: `Cannot ask here (no
  terminal).` / `Add --yes to delete without asking.`); "no": `Nothing removed.`, exit 1; yes: `Removed <...>.` then
  `Next: sandbox data   (see what else is saved, and clean it)`.
- The running launch (`RunDir(ctx.dataPath).readSandboxStatus()?.launchId`) is always kept.

### Tests that pin the CLI

- `src/selftest/cli.test.ts:54-70` "`start` is launch without an agent; positionals, repeated lists and arguments
  after -- parse": `parseCli(['data', 'clean', 'tools/go', 'logs', '--yes'])` gives command `data`, positionals
  `['clean', 'tools/go', 'logs']`, `yes` true.
- `src/selftest/cli.test.ts:305-308` "a typo in an action lists the valid ones": `parseCli(['data', 'bogus'])` throws
  `Allowed choices are show, clean`. **So the first argument's choices must stay exactly `show, clean`** (in this
  order; `withActions` dedups, so adding the actions `show` and `clean` keeps it).
- `src/selftest/cli.test.ts:309-312` "an old spelling that is not listed is still accepted": `parseCli(['data',
  'info']).positionals[0] === 'info'`.
- `src/selftest/host-sim.test.ts:59` runs `sandbox clean` in a fresh storage folder: it must succeed or fail with a
  friendly `Error:` (it prints `Nothing to clean.`).
- `src/selftest/data.test.ts` (suite `data`): "targets resolve inside the data folder ...", "cleaning state warns
  about the login; cleaning everything carries a warning", "rejected: .., absolute paths, drive letters, UNC,
  wildcards, streams, too deep, unknown areas", "rejected: no target at all (that is not \"everything\")", "sizes count
  real files only ...", "repair finds a junction planted in the data folder", "a folder is removed, but never what a
  link inside points to", "cleanup: launch folders older than 7 days go; ...", "cleanup: logs older than 14 days and
  interrupted downloads go; ...". It imports `resolveCleanTargets` from `../cli/commands/data/clean.js` and
  `removeTree` from `../cli/commands/data/remove.js`: when those files move, change only the import paths.

## Menu surface to keep

Maintenance page, category `data`, label `Data & storage`, description `Where the sandbox keeps its data, what is
stored, and deleting parts of it.` Rows (from `dataItems()`):

| Row (value) | Section | Label / hint | Enter label | Keys |
| --- | --- | --- | --- | --- |
| `data:folder` | Data folder | `Data folder` / the storage folder | `change` | (area 5) |
| `data:measure` (before measuring) | Stored data | `Measure what is stored` | `measure` | |
| `disk:<drive>` | Disks | drive / `<used> used · <free> free of <total>`; description `The sandbox keeps its files on this drive.` on the storage drive | | |
| `entry:<i>` | the area label | entry name / size; description `x deletes it.` or `Kept on this PC on purpose; it is not deleted here.`; details `Folder  <path>` | | `x delete` (only removable) |
| `data:clean` | Clean up | `Clean up…`, description `Delete caches, old sandboxes and other leftovers (the clean command, with its options).` | `choose what` | |

Category keys: `m` `measure again`, `x` `delete` (applies only to removable entries). Measuring happens only on
`m` or Enter on `Measure what is stored` (busy text `Measuring what is stored… this can take a minute or more`), then
the notice `✓ Total stored: <size>.` The `x` dialog: title `Delete <target>?`, lines `<size> in <path>.`, each
warning, `This cannot be undone.`, yes button `Delete`, dangerous. Success notice `✓ Freed <size>.`; the entry
disappears without measuring again. `data:clean` opens the command form of `clean` and runs it on the normal screen.

## Prerequisites this area adds to the kernel and the CLI adapter

Do these first, in their own commit, with their tests (they are small and later areas use them):

1. **`noTerminal` on every question kind.** Add `noTerminal: z.strictObject({ message: z.string(), fix: z.string()
   }).optional()` to `ChooseQuestionSchema`, `TextQuestionSchema`, `PathQuestionSchema` and
   `ChecklistQuestionSchema` in `src/app/kernel/io.ts`. In `src/cli/operations/io-cli.ts` `ask()`, before the switch
   cases other than `confirm`: `if (!interactive() && 'noTerminal' in q && q.noTerminal) fail(q.noTerminal.message,
   q.noTerminal.fix);`. Needed for `Which data should be cleaned?` here and `Use: sandbox storage move <folder>` in area 5.
2. **A list positional takes the rest of the line.** In `src/cli/operations/input.ts` `cliInput()`: when the positional's
   field (`inputField(def, name)`) has `kind === 'list'`, set `input[name] = positionals.slice(i)` (only allowed for the
   last positional; throw `new Error(def.id + ': only the last positional may be a list')` otherwise). In
   `src/cli/operations/spec.ts` `argSpec()`: add `variadic: true` for a list field.
3. **`next(output)`**: the dimmed `Next: ...` line. Add `next?(output: z.output<O>): string | undefined;` to
   `Definition` in `src/app/kernel/define.ts` ("the next step to suggest, CLI only"). In
   `src/cli/operations/handler.ts` `printOutput()`, after printing `text`, print `nextStep(n)` (from `../output/index.js`)
   when `def.next?.(output)` returns a text. Menu and web ignore it.
4. **Web navigation: Maintenance gets children.** Area 2 added `NavSection.children` and `navViews()` (see
   [02-projects.md](02-projects.md)). Change the Maintenance entry of `NAV` to:
   ```ts
   {
     label: 'Maintenance',
     children: [
       { label: 'Data', view: 'data' },
       { label: 'More', elsewhere: 'Storage, doctor, repair, updates and logs are in the menu (sandbox > Maintenance).' },
     ],
   },
   ```
   A child without a view is drawn by `Shell.tsx` as a disabled link with its `elsewhere` tooltip, and the parity
   check ("every view is shown somewhere, and a web section without a view says where the area is") must accept it
   because it has `elsewhere`. Each later Maintenance area adds its child and shortens the `More` text; the last one
   removes `More`.

## Definitions to write (`src/app/features/data/data.def.ts`)

The def cannot import `core/disk` (`humanBytes`), so the run sends sizes both as bytes and as text.

```ts
import { z } from 'zod';
import { action, defineOperation, defineQuery, defineView, fieldOf, SchemaNode, type Item, type Page, type Section } from '../../kernel/index.js';

export const DATA_AREAS = ['tools', 'databases', 'state', 'logs', 'data', 'host'] as const;
export const AREA_LABEL: Readonly<Record<(typeof DATA_AREAS)[number], string>> = {
  tools: 'Toolchains', databases: 'Databases', state: 'Agent state', logs: 'Logs', data: 'Other', host: 'On this PC',
};

const DataEntrySchema = z.object({
  area: z.enum(DATA_AREAS).describe('Which kind of data it is'),
  name: z.string().describe('The folder as listed (tools: its name; others: area/name)'),
  path: z.string().describe('Its full path on this PC'),
  bytes: z.number().describe('Its size in bytes (links count 0)'),
  size: z.string().describe('Its size in words, e.g. 1.5 KB'),
  target: z.string().nullable().describe('What sandbox data clean calls it; null when it is kept on purpose'),
});
const DiskSchema = z.object({
  drive: z.string().describe('The drive, e.g. C:\\'),
  totalBytes: z.number().describe('Its size in bytes'),
  freeBytes: z.number().describe('Free bytes'),
  usedBytes: z.number().describe('Used bytes'),
  holdsStorage: z.boolean().describe('The sandbox keeps its files on this drive'),
  used: z.string().describe('Used, in words'),
  usedPercent: z.number().describe('Used, in percent of the size (rounded)'),
  free: z.string().describe('Free, in words'),
  total: z.string().describe('Size, in words'),
});
export const DataShowSchema = z.object({
  dataPath: z.string().describe('The data folder (C:\\AgentData inside the sandbox)'),
  storageRoot: z.string().describe('The storage folder that holds it'),
  totalBytes: z.number().describe('Everything listed, in bytes'),
  total: z.string().describe('Everything listed, in words'),
  storageShare: z.string().describe('"<- sandbox storage (<total> of it)": the note on the storage drive'),
  entries: z.array(DataEntrySchema).describe('What is stored, by area, biggest first'),
  disks: z.array(DiskSchema).describe("This PC's drives"),
});
export type DataShow = z.output<typeof DataShowSchema>;

export const showData = defineQuery({
  id: 'data.show',
  title: 'Stored data',
  summary: 'show what is kept between sandboxes (tools, databases, logins, logs), or delete some of it',
  input: z.object({}),
  output: DataShowSchema,
  cli: {
    name: 'data',
    action: 'show',
    json: true,
    // The --json shape `sandbox data` has always printed.
    shapeJson: (o) => ({
      dataPath: o.dataPath,
      storageRoot: o.storageRoot,
      totalBytes: o.totalBytes,
      entries: o.entries.map(({ area, name, path, bytes }) => ({ area, name, path, bytes })),
      disks: o.disks.map(({ drive, totalBytes, freeBytes, usedBytes, holdsStorage }) => ({ drive, totalBytes, freeBytes, usedBytes, holdsStorage })),
    }),
  },
});

const MessageSchema = z.object({ message: z.string().describe('What happened') });

export const cleanData = defineOperation({
  id: 'data.clean',
  title: 'Delete stored data…',
  summary: 'delete chosen parts of what is kept between sandboxes',
  input: z.object({
    targets: z.array(z.string()).default([]).describe('what to clean, e.g. tools/go databases logs'),
  }),
  output: MessageSchema.extend({ freedBytes: z.number().describe('Bytes freed (0 when nothing was removed)') }),
  danger: true,
  text: (o) => o.message,
  next: (o) => (o.freedBytes > 0 ? 'sandbox data   (see what is left)' : undefined),
  cli: { name: 'data', action: 'clean', positional: ['targets'] },
});

const PruneInputSchema = z.object({
  days: z.number().int().min(1).default(7).describe('launch folders older than this many days'),
});

export const pruneStorage = defineOperation({
  id: 'data.prune',
  title: 'Clean up…',
  summary: 'delete old launch folders, logs and leftovers',
  input: PruneInputSchema,
  output: MessageSchema.extend({ removed: z.boolean().describe('Something was deleted') }),
  text: (o) => o.message,
  next: (o) => (o.removed ? 'sandbox data   (see what else is saved, and clean it)' : undefined),
  cli: {
    name: 'clean',
    group: 'Data',
    flags: { days: { flag: '--days', value: 'n' } },
    yes: 'do not ask before deleting',
  },
});
```

Check with `npm test -- app` that `commandSpec('clean')` keeps `--days <n>` (number, default 7, `launch folders
older than this many days`) and `--yes/-y` (`do not ask before deleting`, noMenu); add both to the "with the flags
and help they had" check. `.min(1)` is new validation: if you are unsure, leave it out and say so.

The page builder (pure, exported for the menu and tests):

```ts
const DAYS_FIELD = fieldOf(new SchemaNode(PruneInputSchema).child('days')!, ['days']);

/** The data page: disks, then one section per area, the total, and clean-up. */
export function dataPage(o: DataShow): Page {
  const disks: Section = {
    id: 'disks',
    title: 'Disks',
    columns: [{ key: 'drive', label: 'DRIVE' }, { key: 'used', label: 'USED' }, { key: 'free', label: 'FREE' }, { key: 'size', label: 'SIZE' }, { key: 'note', label: '' }],
    items: o.disks.map((d): Item => ({
      id: 'disk:' + d.drive,
      label: d.drive,
      hint: d.used + ' used · ' + d.free + ' free of ' + d.total, // the menu's wording
      ...(d.holdsStorage ? { description: 'The sandbox keeps its files on this drive.' } : {}),
      cells: { drive: d.drive, used: d.used + ' (' + d.usedPercent + '%)', free: d.free, size: d.total, note: d.holdsStorage ? o.storageShare : '' },
    })),
    notes: [{ text: 'Persistent data for the sandbox: ' + o.dataPath + ' (C:\\AgentData inside)' }],
  };
  const areas: Section[] = DATA_AREAS.flatMap((area) => {
    const rows = o.entries.filter((e) => e.area === area);
    if (!rows.length) return [];
    return [{
      id: 'area:' + area,
      title: AREA_LABEL[area],
      summary: /* the run sends per-area totals in words: add `areaTotals: Record<area, string>` to DataShowSchema */ '',
      columns: [{ key: 'name', label: '' }, { key: 'size', label: '' }, { key: 'path', label: '' }],
      columnsOn: 'cli' as const,
      items: rows.map((e): Item => ({
        id: 'entry:' + e.name,
        label: e.name,
        hint: e.size,
        description: e.target ? 'x deletes it.' : 'Kept on this PC on purpose; it is not deleted here.',
        details: ['Folder  ' + e.path],
        cells: { name: '  ' + e.name, size: e.size, path: e.path },
        actions: e.target ? [action(cleanData, { targets: [e.target] }, { label: 'Delete', key: 'x', verb: 'delete' })] : [],
      })),
    }];
  });
  const total: Section = {
    id: 'total',
    facts: [{ id: 'total', label: 'Total', value: o.total }],
    notes: [
      ...(o.entries.length ? [] : [{ text: 'Nothing stored yet. Toolchains, databases and agent logins appear here after the first start.' }]),
      { text: 'Free space with: sandbox data clean <target...>  (e.g. tools/go, databases/postgres-18, logs, launches)', tone: 'muted' as const, only: 'cli' as const },
    ],
  };
  const clean: Section = {
    id: 'clean',
    title: 'Clean up',
    actions: [action(pruneStorage, {}, {
      label: 'Clean up…',
      verb: 'choose what',
      description: 'Delete caches, old sandboxes and other leftovers (the clean command, with its options).',
      fields: [DAYS_FIELD],
    })],
  };
  return { title: 'Data', sections: [disks, ...areas, total, clean] };
}

export const dataView = defineView({
  id: 'data',
  title: 'Data',
  summary: 'What the sandbox keeps between runs, and deleting parts of it.',
  queries: { data: showData },
  operations: [cleanData, pruneStorage],
  build: ({ data }) => dataPage(data),
});
```

Fill in the `summary` comment: add `areaTotals: z.record(z.string(), z.string()).describe('Each area's total in
words')` to `DataShowSchema` and use `o.areaTotals[area] ?? ''`. `fieldOf`/`SchemaNode` are kernel exports; verify
`new SchemaNode(schema).child(name)` exists (it is used in `src/cli/operations/spec.ts` `inputField`).

## Run functions (`src/app/features/data/data.run.ts`)

Imports: `humanBytes` from `../../../core/disk.js`, `DataService`, `resolveCleanTargets` from
`../../../cli/services/index.js`, `cleanTargetOf` (moved, see below), `pruneStorage as prune`, `describePrune` from
`../../../host/storage/index.js`, `isSandboxRunning` from `../../../host/sandbox/index.js`, `RunDir` from
`../../../shared/channel/index.js`, `implement` from `../../context.js`, `cancelled` from `../../kernel/index.js`,
`fail` from `../../../core/util/index.js`.

- **`showDataRun`** (query, no questions): `io.progress('Measuring the saved data (big folders take a moment)')`;
  `const report = new DataService(ctx).report()`; map entries (`size: humanBytes(e.bytes)`, `target: cleanTargetOf(e)`),
  disks (`used: humanBytes(d.usedBytes)`, `usedPercent: Math.round((d.usedBytes / d.totalBytes) * 100)`,
  `free: humanBytes(d.freeBytes)`, `total: humanBytes(d.totalBytes)`), `total: humanBytes(report.totalBytes)`, `storageShare: '<- sandbox storage (' + humanBytes(total) + ' of
  it)'`, `areaTotals` (sum per area). Measuring is synchronous (`sizeOf`), so there is nothing to stream: the CLI
  shows the spinner, the web a loader, the menu its busy line. **Decision: no streamed measuring** (the CLI never
  streamed either; streaming would need an async measurer in `core/disk.ts`, out of scope).
- **`cleanDataRun`**:
  1. `let inputs = input.targets`. When empty: measure (`io.progress(...)` as above), build choices from
     `service.entries()` with `cleanTargetOf` (`label: target.padEnd(28) + humanBytes(bytes)`, `value: target`); no
     choices -> return `{ message: 'Nothing chosen, nothing removed.', freedBytes: 0 }`; else
     `io.checklist({ title: 'What do you want to delete? (space ticks, enter confirms)', choices, noTerminal: {
     message: 'Which data should be cleaned?', fix: 'Name them: sandbox data clean logs tools/go   (what exists:
     sandbox data)' } })`. Undefined or empty -> `{ message: 'Nothing chosen, nothing removed.', freedBytes: 0 }`.
     (The `noTerminal` check must fire before measuring on the CLI; measuring first is acceptable but slower: note it.)
  2. `const plan = service.plan(inputs)` (keeps the running-sandbox and link refusals).
  3. Nothing present -> `{ message: 'Nothing to remove: ' + plan.targets.map((t) => t.target).join(', ') + ' do(es)
     not exist.', freedBytes: 0 }`.
  4. `io.log` one line per present target, aligned like `table()` did (pad each column to its widest + 2; write the
     small helper in the run, `cli/output` is off limits), then `io.log('Warning: ' + t.target + ' ' + t.warning +
     '.', 'warn')` per warning.
  5. Ask. With `all`: `io.confirm({ title: 'This cannot be undone; the next sandbox starts from scratch and reinstalls
     everything.', typed: 'all', danger: true, noTerminal: { message: 'Nothing removed.', fix: 'Add --yes to delete
     without asking.' } })`. Otherwise: `io.confirm({ title: 'Delete ' + names + ' (' + humanBytes(total) + ')? This
     cannot be undone.', yes: 'Delete', danger: true, noTerminal: { message: 'Cannot ask here (no terminal).', fix:
     'Add --yes to delete without asking.' } })`. Not `implied` (the command always asked). No ->
     `cancelled('Nothing removed.')` (prints it, exit 1, as before).
     Behaviour note for the report: `askTyped` returned "no" without a terminal (exit 1, "Nothing removed."); the
     typed confirm now fails with an error (exit 1, `Error: Nothing removed.`). Say so in your report.
  6. `const outcome = service.clean(plan)`; failures -> `fail('Could not remove everything: ' +
     outcome.failed.join('; '), 'Close programs using those folders and run the same command again.')`.
  7. Return `{ message: 'Removed ' + names + ' and freed ' + humanBytes(outcome.freedBytes) + (outcome.touchedData ?
     '; the next sandbox reinstalls what it needs.' : '.'), freedBytes: outcome.freedBytes }`.
  The menu's `x` now shows the CLI's question and the CLI's success sentence instead of `✓ Freed <size>.`: that is the
  intended unification; update `menu-screens.ts`/menu tests only where they asserted the old words (none found).
- **`pruneStorageRun`**: copy `src/cli/commands/maintenance/clean.ts` line by line: `running` launch id, `found =
  prune(ctx.storageRoot, { launchDays: input.days, keep, dryRun: true })`; nothing -> `{ message: 'Nothing to
  clean.', removed: false }`; `io.log('Can be removed: ' + describePrune(found).replace(' removed', '') + '.')`;
  `io.confirm({ title: 'Delete them?', yes: 'Delete', danger: true, noTerminal: { message: 'Cannot ask here (no
  terminal).', fix: 'Add --yes to delete without asking.' } })`; no -> `cancelled('Nothing removed.')`; then
  `{ message: 'Removed ' + describePrune(prune(ctx.storageRoot, { launchDays: input.days, keep })).replace(' removed',
  '') + '.', removed: true }`.

## Registration and wiring

- `src/app/features/data/index.ts`: `export * from './data.def.js'; export * from './data.run.js';`
- `defs.ts`: import from `./data/data.def.js`; add `cleanData, pruneStorage` to `OPERATIONS`, `showData` to
  `QUERIES`, `dataView` to `VIEWS`; NAV as in prerequisite 4.
- `registry.ts`: `showDataRun, cleanDataRun, pruneStorageRun`.
- `src/cli/menu/views.ts`: `{ view: dataView, section: 'Maintenance' }`.
- **CLI `data` stays a hand-written manifest entry** (it has aliases, a default action and the variadic arg the menu's
  command form reads). The hints add the actions `show` and `clean`, so `sandbox data show|clean ...` run through
  `operationHandler`. Replace `HANDLERS.data` (`src/cli/commands/registry.ts`) with a small forwarder for what the
  hints cannot spell: no action, `info`, `list` -> `definitionHandler(showData)`; `remove` -> `definitionHandler(cleanData)`
  (import `definitionHandler` from `../operations/index.js`, the defs from the feature's def file). `cliInput` strips
  the first positional for an action hint, so `data remove logs` gives `targets: ['logs']`. Anything else stays the
  parser's error.
- **CLI `clean`**: remove its manifest entry and `HANDLERS.clean`; the hint makes it.
- **Menu**: in `maintenance-page.ts` keep the page and its other categories. For `data`:
  - keep `data:folder` (area 5 moves it) and the `data:measure` row before measuring (page-own rows);
  - after measuring, the rows are `menuView(dataPage(model), { category: 'data', prefix: 'data:', refresh: false })`
    items; the key list for the category is that view's `actions` plus the page's own `{ key: 'm', label: 'measure
    again' }`;
  - `measure()` becomes `this.busy(...)` + `this.data = await readQuery(showData, this.ctx)` + the same notice
    (`Total stored: <data.total>.`);
  - `act()`: for category `data`, first `dataMenuView(model).resolve(result)` (only when `this.category === 'data'`,
    see the warning in 00), and run a found action with `this.operations.perform(action, [this.label], busy)` (add a
    `MenuOperations` like `SessionsPage`); then the page-own `m`, `data:measure`, `data:folder`;
  - delete `dataItems()`, `remove()`, `AREA_LABEL`, the `data:clean` `CommandForm` branch and the `x` branch;
  - `MaintenanceModel.data` becomes `DataShow | null`; update the fixture in `src/selftest/menu-screens.ts` to the new
    shape (same values, sizes as text).

## Web page

Maintenance > Data: the Disks table, one card per area with its entries (name, size, path; a **Delete** button on
removable ones: it asks the CLI's question in a modal), the Total, and a **Clean up…** button that asks `days`
(number input, default 7) then the `Delete them?` confirmation. Opening the page measures (a loader; large folders take
a minute). Nothing new in `web/`.

## Delete or shrink afterwards

- Delete `src/cli/commands/data/index.ts`, `src/cli/commands/data/clean.ts`, `src/cli/commands/maintenance/clean.ts`.
- Move `src/cli/commands/data/collect.ts` -> `src/cli/services/data-collect.ts` and `remove.ts` ->
  `src/cli/services/data-remove.ts` (export `collectDataEntries`, `cleanTargetOf`, `DataEntry`, `DataArea`,
  `removeTree` from `src/cli/services/index.ts`); fix imports in `data-service.ts`, `maintenance-page.ts`,
  `src/selftest/data.test.ts` and anything `grep -rn "commands/data/" src` finds. Remove `src/cli/commands/data/`.
- Remove the `clean` export from `src/cli/commands/maintenance/index.ts` and the manifest entry `clean`.
- docs/commands.md: nothing changes for users; check the `data` and `clean` rows still read true.

## Tests

Keep passing: suites `data`, `cli`, `menu` ("every screen ..."), `host-sim`, `app`, `layout`.

Add to `src/selftest/app.test.ts`, `t.section('data')`:

1. "data: disks, one section per area, x deletes only what may be deleted" — `dataPage(sample)` with a sample like
   the one in `menu-screens.ts` (tools/rust, state/claude, host/accounts with `target: null`): the `area:tools` and
   `area:state` sections exist, `pageActions` holds `data.clean` with `targets: ['tools/rust']`, the accounts item has
   no actions, `data.prune` is offered.
2. "data show --json keeps its old shape" — `showData.cli!.shapeJson!(sample)` has exactly the keys `dataPath,
   storageRoot, totalBytes, entries, disks`, entries without `size`/`target`.
3. "data on the command line" — `pageLines(dataPage(sample))` includes a line starting with `Disks`, a line matching
   `/^DRIVE\s+USED\s+FREE\s+SIZE/`, `Persistent data for the sandbox: `, and the `Free space with:` line.
4. "data clean and remove are actions; the targets are the rest of the line" — `definitionFor('data', ['clean'])?.id
   === 'data.clean'`, `definitionFor('data', ['show'])?.id === 'data.show'`, `cliInput(definitionFor('data',
   ['clean'])!, parseCli(['data', 'clean', 'tools/go', 'logs']))` equals `{ targets: ['tools/go', 'logs'] }`, and
   `commandSpec('data')?.args[0].choices` equals `['show', 'clean']`.
5. "data clean refuses while a sandbox runs, asks, and a no changes nothing" — temp `storageRoot`/`dataPath` with a
   `logs` folder; ctx `{ dataPath, storageRoot } as unknown as AppContext`. If `isSandboxRunning()` (always true inside
   a Windows Sandbox): `t.throws(() => runDefinition('data.clean', ctx, { targets: ['logs'] }, fakeIO([]).io), 'A
   Windows Sandbox is running')`. Else: `fakeIO([false])` throws `Nothing removed.` and the folder is still there;
   `fakeIO([true])` returns a message starting `Removed logs and freed` and the folder is gone.
6. "clean on an empty storage folder says so" — `runDefinition('data.prune', { storageRoot: t.dir(...), dataPath:
   t.dir(...) } as unknown as AppContext, {}, fakeIO([]).io)` returns `{ message: 'Nothing to clean.', removed:
   false }`.
7. "a question without a terminal fails with its own words" — `cliIO(parseCli(['data'])).io.checklist({ title: 'x',
   choices: [], noTerminal: { message: 'Which data should be cleaned?', fix: 'f' } })` rejects with `Which data should
   be cleaned?` (the self-test runs without a TTY on stdin; if it does have one, `t.skip`).

## Pitfalls

- **Inside the sandbox** `isSandboxRunning()` is true, so `plan()` always refuses there: never make a test that needs
  deleting depend on it (see test 5).
- Everything under the data folder is sandbox-writable: keep using `DataService` (`assertNoLinks`, `removeTree`);
  never write your own delete or size walk.
- `cancelled('Nothing removed.')`, not `cancelled()`: the CLI prints the message, and the old word is "removed".
- The parser's first-argument choices must stay `show, clean` (cli test). Do not add `info`/`list`/`remove` to them.
- The menu measures only when asked; do not call `readQuery(showData)` in `load()` (a big folder takes minutes).
- `x` must stay limited to removable entries (only items with a `target` get the action).
- Do not touch the Data folder row (area 5) or the other Maintenance categories (areas 7, 8, 9).

## Checklist

1. Worktree and branch: `git worktree add ../ws-data -b web-ui/data master`.
2. Prerequisites 1-4 with their tests; commit.
3. `src/app/features/data/` (def, run, index); registration; menu; CLI forwarder; deletions and moves.
4. Run, in order (see [Commands to run](00-worked-example.md#commands-to-run)):
   `npm run build`, `npm run lint`, `npm run format:check`, `npm test -- app,data,cli,menu,host-sim,layout`, then
   `npm test` until it prints `ALL TESTS PASSED`.
5. Check by hand (inside the sandbox): `node dist/bin/agent-sandbox.js data --json`, `... data`, `... data clean
   bogus/x` (refused with the usage text), `... clean --help`.
6. Re-read [Common mistakes](00-worked-example.md#common-mistakes) against your diff.

## Report template

```
Area 4 (data) — branch web-ui/data
Prerequisites: noTerminal on questions [done/not], list positional [..], next() [..], Maintenance NAV children [..]
Definitions: data.show, data.clean, data.prune; view data (menu: Maintenance > Data & storage; web: Maintenance > Data)
Deleted: ...   Moved: ...
CLI differences (exact old -> new text, if any): ...
Menu differences: ...
Tests added: ...   Tests changed (why): ...
npm run build / lint / format:check: ...   npm test: ALL TESTS PASSED (yes/no, runs: n)
Unsure / left undone: ...
```
