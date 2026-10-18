# 13 · Settings export and import

Read [00-worked-example.md](00-worked-example.md) first. This area adds two operations to the **existing** settings
feature (`src/app/features/settings`); it does not make a new feature folder.

## What it does today

`sandbox config export [file]` writes the settings that differ from the defaults to a shareable `.json` (no secrets,
no data folder, no paths of this PC unless `--with-paths`); `sandbox config import <file>` shows each change as
`setting: old -> new`, asks once and writes through your settings file. The menu offers the same as two rows in
Settings > General.

## Files today

| File | What it does |
| --- | --- |
| `src/cli/commands/maintenance/config-share.ts` | `DEFAULT_EXPORT = 'sandbox-settings.json'`, `MAX_BYTES` (1 MB), `writeExport(ctx, file, withPaths, overwrite)`, `readImport(ctx, file)`, `applyImport(ctx, plan)`, and the printing commands `exportCommand`, `importCommand` |
| `src/cli/commands/maintenance/config.ts` lines ~188-191 | the hand-written `config` command dispatches `export` and `import` to them |
| `src/cli/menu/settings/share.ts` | the pure-ish rules (lodash, `core/schema`): `exportSettings(config, withPaths)` -> `{ data, skipped }`, `planImport(text, current)` -> `{ changes, lines, skipped, problems }`, `diffText(lines)`, `skippedLine(s)`, `Skipped`, `DiffLine`, `ImportPlan`; re-exported by `src/cli/menu/settings/index.ts` |
| `src/cli/menu/share-settings.ts` | the menu rows (`EXPORT_SETTINGS = '@export-settings'`, `IMPORT_SETTINGS = '@import-settings'`, `shareSettingsRows()`) and `ShareSettingsFlow` (`export()`, `import()`: path picker, replace question, diff dialog, notices) |
| `src/cli/menu/pages/settings-page.ts` lines 31, 138, 178, 207-211 | adds the two rows to category `general` (own scope only, `extra` rows), Enter label `open`, runs `ShareSettingsFlow` |
| `src/app/features/settings/settings.def.ts`, `settings.run.ts`, `settings-file.ts` | the settings feature this area extends; `ConfigFile.user(path).setMany(changes)` writes with comments kept |

## CLI surface to keep

From the `config` manifest entry (`src/cli/manifest.ts`, around line 530; it **stays**, hand-written):

- action choices include `export`, `import`; positional `key`: `'(get, set, reset) the setting, e.g. sandbox.memoryMb;
  (export, import) the .json file'`, asked in the menu form `when: ['get', 'set', 'export', 'import']`.
- `bool('--with-paths', '(export) keep folders and files of this PC in the file', { when: 'export' })`
- `bool('--yes', '(import) do not ask before changing your settings', { short: '-y', when: 'import', noMenu: true })`

`sandbox config export [file] [--with-paths]` (from `exportCommand` / `writeExport`):

- file defaults to `sandbox-settings.json` (resolved against the current folder); an existing file fails:
  `<absolute path> exists already.` / `Pick another name, or delete it first.`
- prints `Wrote <absolute path> (only what differs from the defaults).`, then when something was left out `Left out:`
  and one `  <key> (<why>)` line each (`a secret, never shared`, `a folder or file of this PC`, `this PC only`), then
  without `--with-paths`, when a path was left out: `Keep this PC's folders and files in the file with --with-paths.`
  Exit 0.

`sandbox config import <file> [-y]` (from `importCommand` / `readImport`):

- no file: `Which file?` / `Usage: sandbox config import <file>`; missing file: `There is no file <abs>.` / `Give the
  path of a file made by sandbox config export.`; over 1 MB: `<abs> is too big to be a settings file.`; invalid:
  `<abs> is not valid settings:\n  <problem>...` / `Nothing was changed. Fix the file, or export a new one with:
  sandbox config export`.
- prints `Not imported (never taken from a file):` + `  <key> (<why>)` lines when something was skipped.
- nothing to change: `Nothing to change: your settings already match the file.`, exit 0.
- else `This would change N setting[s]:` and `  <key>: <old> -> <new>` lines, then asks `Change your settings like
  this?` unless `--yes` (no terminal: `Cannot ask here (no terminal).` / `Add --yes to change them without asking.`);
  no -> `Nothing was changed.`, exit 0; yes -> `Imported N setting[s]. New sandboxes use them.` (first sentence green).
- a write problem: `Could not import: <problems>` / `Nothing was written. Your settings are unchanged.`

Tests (`src/selftest/config.test.ts`, section around lines 60-160; suite `config`):

- pure rules (lines ~72-118): "an export has no secret, no storage folder and no folder of this PC", "an export keeps
  only what differs from the defaults", "an export says what it left out (the data folder, a folder of this PC, a
  secret)", "--with-paths keeps folders of this PC (secrets and the data folder stay out)", "an import shows old -> new
  for each changed setting and nothing for the unchanged ones" (asserts `diffText(plan.lines)` equals
  `['sandbox.memoryMb: 4096 -> 2048', 'sandbox.headless: true -> false']`), "an import skips secrets, the data folder
  and paths even when the file has them", "an import refuses a file that is not valid settings". These import
  `diffText, exportSettings, planImport` from `../cli/menu/settings/index.js` (line 6).
- the real binary (lines ~131-160): "sandbox config export writes the file without the data folder" (exit 0),
  "export does not overwrite a file that is there" (exit not 0), "import without --yes and without a terminal changes
  nothing" (exit not 0, file unchanged), "sandbox config import --yes applies the settings and never the data folder
  or paths" (exit 0, output includes `sandbox.memoryMb: 4096 -> 2048`).

## Menu surface to keep

Settings page (its own page; see shared-core.md "Deviations"), tab **All projects** only, category `general`:

- rows `Export settings…` (hint `.json`, description `Write the settings you changed to a .json file you can share
  with a team. Secrets, the data folder and folders or files of this PC are left out.`) and `Import settings…` (hint
  `.json`, description `Read a settings file someone shared, see what it would change, and apply it once you say yes.
  Secrets, the data folder and paths in it are never taken.`); Enter label `open`; only Enter (not keys) runs them.
- Export today: path picker (file) `Where to write the settings file`, about `Only what differs from the defaults is
  written; secrets and paths of this PC are left out.`, initial `<cwd>\sandbox-settings.json`, must end in `.json`
  (`The file name should end in .json.`); existing file: `<abs> exists. Replace it?` (default no); notice `✓ Wrote
  <abs>.` + ` Left out: <lines>.`
- Import today: path picker `Which settings file` (about `A file made by Export settings (or sandbox config
  export).`); the diff dialog (`N settings would change:`, blank, diff lines, then `Not imported (never taken from a
  file):` lines), question `Change your settings like this?` (default no); nothing to change: a message dialog, notice
  `Nothing changed.`; notice `✓ Imported N setting[s].`
- Both read your settings **from disk** at that moment (`ShareSettingsFlow.fresh()` reloads with `loadConfig`), not the
  menu's unsaved draft.

## Definitions to write (in `settings.def.ts`)

Add to `src/app/features/settings/settings.def.ts` (pure). The input field names end in `File`, so `fieldOf` makes them
`path` Fields with `pathKind: 'file'` (`pathKindOf` in `src/app/kernel/fields.ts` matches `/File$/`); the menu then
uses its path picker and the web its path input.

```ts
const JsonFileSchema = z.string().max(2000).regex(/\.json$/i, 'The file name should end in .json.');

export const exportConfig = defineOperation({
  id: 'settings.export',
  title: 'Export settings…',
  summary: 'write the settings you changed to a .json file to share (no secrets, no data folder, no paths of this PC)',
  input: z.object({
    settingsFile: JsonFileSchema.optional()
      .describe('(export, import) the .json file; default sandbox-settings.json in the current folder'),
    withPaths: z.boolean().default(false).describe('(export) keep folders and files of this PC in the file'),
  }),
  output: z.object({
    file: z.string().describe('The file written (full path)'),
    leftOut: z.array(z.string()).describe('What was left out, one "<key> (<why>)" each'),
    pathsLeftOut: z.boolean().describe('A folder or file of this PC was left out (and --with-paths was not given)'),
  }),
  text: (o) =>
    [
      'Wrote ' + o.file + ' (only what differs from the defaults).',
      ...(o.leftOut.length ? ['Left out:', ...o.leftOut.map((l) => '  ' + l)] : []),
      ...(o.pathsLeftOut ? ["Keep this PC's folders and files in the file with --with-paths."] : []),
    ].join('\n'),
  cli: { name: 'config', action: 'export', positional: ['settingsFile'], flags: { withPaths: { flag: '--with-paths' } } },
});

export const importConfig = defineOperation({
  id: 'settings.import',
  title: 'Import settings…',
  summary: 'read a shared settings file, show what it would change, and apply it after one yes',
  input: z.object({
    settingsFile: JsonFileSchema.optional().describe('(export, import) the .json file'),
  }),
  output: z.object({
    changed: z.number().describe('How many settings changed'),
    message: z.string().describe('What happened'),
  }),
  text: (o) => o.message,
  cli: { name: 'config', action: 'import', positional: ['settingsFile'] },
});
```

- Both are **actions of the hand-written `config` command** (like `config get/set/reset/list`). The manifest entry
  keeps its `--with-paths` and `--yes` options (`withActions()` does not add options; `cliInput()` reads
  `raw.withPaths`, and `io-cli` reads `--yes` for confirmations).
- Add both to `settingsView.operations`.
- `SettingsListSchema` gets `exportFile: z.string().optional().describe('Where an export goes by default (full path;
  your own settings only)')`, filled by `listSettingsRun` for `scope: 'user'` with `path.resolve(DEFAULT_EXPORT)`.
- `settingsPage(o)` gets page actions, only when `o.scope === 'user'`:
  ```ts
  const fileField = (def: typeof exportConfig | typeof importConfig, label: string): Field => ({
    ...fieldOf(new SchemaNode(def.input).child('settingsFile')!, ['settingsFile']),
    label,
    optional: false,
  });
  actions: o.scope === 'user'
    ? [
        action(exportConfig, {}, { verb: 'export', fields: [fileField(exportConfig, 'Where to write the settings file')],
          initial: { settingsFile: o.exportFile }, description: 'Write the settings you changed to a .json file you can share with a team. Secrets, the data folder and folders or files of this PC are left out.' }),
        action(importConfig, {}, { verb: 'import', fields: [fileField(importConfig, 'Which settings file')],
          description: 'Read a settings file someone shared, see what it would change, and apply it once you say yes. Secrets, the data folder and paths in it are never taken.' }),
      ]
    : [],
  ```
  (`fieldOf` and `SchemaNode` come from the kernel, so this stays pure.) No `key` letters: the menu does not draw this
  page through `menuView`, and on the web they are header buttons.

## Run functions (in `settings.run.ts`)

Move the rules first: `src/cli/menu/settings/share.ts` -> `src/app/features/settings/settings-share.ts` (Node helper:
it uses lodash, `jsonc-parser` and `core/schema`; only `*.run.ts` and the menu import it). Keep its exports and names;
re-export from `src/cli/menu/settings/index.ts` is no longer needed (update `config.test.ts:6` to import from
`../app/features/settings/settings-share.js`). Move `DEFAULT_EXPORT`, `MAX_BYTES` and the bodies of `writeExport`,
`readImport`, `applyImport` from `config-share.ts` into the run file (or into `settings-share.ts`), unchanged.

Both runs read your settings **fresh from disk**: `const config = loadConfig(ctx.loaded.configPath ?? undefined).config`
(`loadConfig` from `core/config`), as `ShareSettingsFlow.fresh()` did.

`exportConfigRun(ctx, { settingsFile, withPaths }, io)`:

1. `const target = path.resolve(settingsFile ?? DEFAULT_EXPORT)` (the CLI never asks for the file; the menu and web
   always send one through the action's field).
2. If it exists: `io.confirm({ title: target + ' exists. Replace it?', yes: 'Replace', noTerminal: { message: target + '
   exists already.', fix: 'Pick another name, or delete it first.' } })`; no -> `cancelled()`. On the CLI this keeps
   the old failure without a terminal (the binary test "export does not overwrite a file that is there" runs without
   one), asks on a terminal, and `--yes` replaces (new; harmless).
3. `exportSettings(config, withPaths)`, `fs.mkdirSync(dirname)`, `writeJson(target, data)` (as `writeExport`).
4. Return `{ file: target, leftOut: skipped.map(skippedLine), pathsLeftOut: !withPaths && skipped.some((s) => s.why
   === 'path') }`.

`importConfigRun(ctx, { settingsFile }, io)`:

1. `const file = settingsFile ?? (await io.path({ title: 'Which settings file', lines: ['A file made by Export settings
   (or sandbox config export).'], pathKind: 'file' }))`; undefined -> `cancelled()`.
2. `readImport` checks unchanged (no file, too big, invalid: same `fail` texts). Pass the fresh config.
3. When `plan.skipped.length`: `io.log('Not imported (never taken from a file):')` and `io.log('  ' +
   safeText(skippedLine(s)))` each.
4. No changes: return `{ changed: 0, message: 'Nothing to change: your settings already match the file.' }` (no
   question).
5. `io.log('This would change ' + n + ' setting' + (n === 1 ? '' : 's') + ':')` and `io.log('  ' + safeText(line))` for
   each `diffText(plan.lines)`. These go **through `io.log`, not the confirm's `lines`**: with `--yes` the CLI does not
   ask, and the binary test still expects `sandbox.memoryMb: 4096 -> 2048` in the output; the menu and the web show
   logged lines above the next question, so the diff is in the dialog there.
6. `io.confirm({ title: 'Change your settings like this?', yes: 'Change', noTerminal: { message: 'Cannot ask here (no
   terminal).', fix: 'Add --yes to change them without asking.' } })`; no -> `cancelled('Nothing was changed.')`.
7. `applyImport` (same `fail` texts); return `{ changed: n, message: 'Imported ' + n + ' setting' + (n === 1 ? '' :
   's') + '. New sandboxes use them.' }`.

Text from the file (keys, values in the diff, problems) goes through `safeText` before `io.log`/`fail`, as today.

## Registration and wiring

- `defs.ts`: add `exportConfig`, `importConfig` to `OPERATIONS` (import from `./settings/settings.def.js`).
  `registry.ts`: `exportConfigRun`, `importConfigRun`. `NAV` and `MENU_VIEWS` already show `settingsView`.
- `src/cli/commands/maintenance/config.ts`: delete the `case 'export'` and `case 'import'` branches and the
  `config-share.js` import (the operations run first: `operationHandler` is tried before `HANDLERS`). Keep `export` and
  `import` in the manifest's action choices (harmless, `withActions` dedupes) and keep the `key` arg description.
- Menu `settings-page.ts`: keep the two rows (`shareSettingsRows()`, ids, Enter label `open`). On Enter, build the
  page's action and run it:
  ```ts
  const page = settingsPage(await readQuery(listSettings, this.ctx, { scope: 'user' }));
  const wanted = result.value === EXPORT_SETTINGS ? 'settings.export' : 'settings.import';
  const act = page.actions?.find((a) => a.kind === 'operation' && a.op === wanted);
  if (act) return await this.operations.perform(act, ['Settings', result.value === EXPORT_SETTINGS ? 'Export settings' : 'Import settings']);
  ```
  (`this.operations = new MenuOperations(app, ctx)`, as in `sessions-page.ts`.) `perform` asks the field with the
  path editor (initial = `exportFile`), runs the operation with dialogs, and returns `{ reload, notice }`.
- Keep `EXPORT_SETTINGS`, `IMPORT_SETTINGS`, `shareSettingsRows()` (move them into `settings-page.ts` if
  `share-settings.ts` is otherwise empty), delete `ShareSettingsFlow`.
- Multi-line `text` in the menu notice: area 3 (accounts) makes `MenuOperations.run` join lines with spaces
  (`text.replace(/\n+/g, ' ')`); if area 3 has not landed, make that one-line change here.

## Web page

The Settings page, tab "All projects", gets two header buttons, **Export settings…** and **Import settings…**. Export
opens a form with the file path (prefilled with `exportFile`, checked by the input schema: must end in `.json`), then a
replace question if it exists, then a green notification with what was written and left out. Import opens a form for
the path, then a question modal showing the logged lines (skipped settings and `key: old -> new`) above `Change your
settings like this?`, then the result. The path is a text field until area 5 adds the folder browser (a file path
field may stay text; the browser is for folders). The file is read and written **on this PC** by the server: the web
never uploads or downloads it (do not add that; it would be a new channel for files).

## Delete or shrink afterwards

- `src/cli/commands/maintenance/config-share.ts`: delete (its helpers moved).
- `src/cli/menu/share-settings.ts`: delete `ShareSettingsFlow`; keep/move the row helpers.
- `src/cli/menu/settings/share.ts`: moved to `src/app/features/settings/settings-share.ts`; remove its re-exports from
  `src/cli/menu/settings/index.ts` (grep for other users first; only `config.test.ts` and `config-share.ts` today).

## Tests

Keep passing: suite `config` (all the checks above; the binary checks must pass unchanged), `app`, `menu`
("settings categories", "every screen"), `layout`.

Add to `src/selftest/app.test.ts`, in the "settings, run against a config file" section (reuse its `ctx`; its
`loaded.configPath` is the temp config):

1. "settings.export writes only what differs and says what it left out": `runDefinition('settings.export', ctx, {
   settingsFile: t.at('app-settings', 'out.json') }, fakeIO().io)`; the file exists, has no `storage`, output
   `leftOut` lists the planted secret (`harnesses.planted...`, why `a secret, never shared`).
2. "settings.export asks before replacing a file": run again with `fakeIO([false]).io` -> throws `Nothing changed.`;
   with `[true]` it writes.
3. "settings.import logs the diff, asks once, and applies": write a shared file with `sandbox.memoryMb: 2048`; with
   `fakeIO([true])` the result message starts `Imported 1 setting`, `seen.logs` include `  sandbox.memoryMb: ... ->
   2048`, `seen.questions[0].title === 'Change your settings like this?'`, and `settings.get` reads 2048; with
   `fakeIO([false])` it throws `Nothing was changed.` and the file is unchanged.
4. "the settings page offers export and import only for your own settings": `settingsPage({ ...listed, scope:
   'project' })` has no `settings.export` action; the user-scope page has both, each with one `path` field of
   `pathKind: 'file'`.

## Pitfalls

- **Secrets never travel**: keep `exportSettings`/`planImport` exactly (they prune secrets, `storage.root` and paths).
  Do not "simplify" them while moving; the `config` suite checks them.
- **Fresh config**: never export `ctx.loaded.config` without reloading; the menu may have saved changes since it
  started.
- **Exit code change**: a declined import used to print `Nothing was changed.` and exit **0**; through `cancelled()` it
  exits **1** like every other declined question. No test covers it; say so in the report.
- **Text changes**: `Imported ...` loses its green; a missing import file on a terminal is now asked for instead of
  failing with `Which file?` (no terminal: `Run it in a terminal, or give the value on the command line.`). Report both.
- **The diff goes through `io.log`**, not `confirm.lines` (see step 5), or `--yes` loses the diff output.
- **Project scope**: export/import are for your own settings only; never offer them on the project tab, and the runs
  always use `ConfigFile.user(ctx.loaded.configPath)`.
- **No upload/download over the web.**

## Checklist

1. Move `share.ts` -> `settings-share.ts`; add `exportConfig`/`importConfig` to `settings.def.ts`, `exportFile` to the
   list output, the page actions; runs in `settings.run.ts`; register in `defs.ts`/`registry.ts`.
2. Remove the `config` command's export/import branches; delete `config-share.ts`; menu rows call
   `MenuOperations.perform`; delete `ShareSettingsFlow`; fix `config.test.ts` import.
3. docs/commands.md line 165 and docs/configuration.md lines 15-16: still true; mention `--yes` replacing an existing
   export only if you keep that behaviour.
4. Run ([commands](00-worked-example.md#commands-to-run)):
   ```
   npm run build
   npm run lint
   npm run format:check
   npm test -- app,config,menu,layout
   npm test
   ```
   Gate on `ALL TESTS PASSED`; check [common mistakes](00-worked-example.md#common-mistakes); tests as in
   [writing a run test](00-worked-example.md#writing-a-run-test).

## Report template

```
Area 13 (settings export/import) — branch web-ui/settings-share
Moved: menu/settings/share.ts -> app/features/settings/settings-share.ts; config-share.ts helpers -> settings.run.ts
Deleted: config-share.ts, ShareSettingsFlow, config.ts export/import branches
CLI: unchanged except: <declined import exits 1; Imported... not green; missing file asked on a terminal; export --yes replaces>
Menu: rows unchanged; dialogs now from the operation: <differences>
Web: Export/Import buttons on Settings (All projects)
Tests added: <names>; tests changed (imports moved): <names>
npm test: ALL TESTS PASSED <yes/no>; parity gaps: <none/list>
Unsure / left undone: <...>
```
