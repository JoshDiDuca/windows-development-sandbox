# 05 · Storage (and the web folder browser)

> **Superseded part (2026-10-16): the folder browser is already built.** The query is `files.browse`
> (`src/app/features/files/`, input `{ path?, files }`, output with `entries`, `parent` and `places`), and the web's
> `web/src/render/FolderPicker.tsx` uses it for every path Field, path list and `io.path` question. Views name it in
> `pickers` (the parity test counts those). Skip everything below about `files.list`, `WEB_TOOLS`, moving
> `path-listing.ts` and the FolderBrowser component, and its tests (checks 6 and the folder-browser lines of the
> report). Do only the storage part of this area.

Read [00-worked-example.md](00-worked-example.md) and [04-data.md](04-data.md) first (this area uses the prerequisites
area 4 added: `noTerminal` on every question, `next()`, the Maintenance children in `NAV`).

## What it does today

`sandbox storage` shows where the saved data lives, `storage move <folder>` moves it (size, time estimate and warning
first), `storage use <folder>` switches folders without moving, and `storage contained on|off|status` (beta) keeps
tools, state and logs in a disk image. The menu offers only the **Data folder** row (Settings > General and
Maintenance > Data & storage), whose flow ends by running `storage move|use <folder> --yes` on the normal screen.

This area also builds the **web folder browser** (decision D2): a query that lists folders on this PC, and a
"Browse…" button on the web's path question and path Field. Every later `io.path` on the web gets it for free.

## Files today

| Path | What it does |
| --- | --- |
| `src/cli/manifest.ts` (entry `name: 'storage'`, ~line 358) | `storage [action] [folder]`: action choices `show, move, use, contained`; arg `folder` (`the folder to move to, or to use; for contained: on, off or status`, `when: ['move', 'use', 'contained']`); `--yes/-y` (`do not ask before moving or switching`, noMenu); `--keep-old` (`copy instead of moving: the old folder stays (needs room for both)`, `when: 'move'`); `--json`; four examples |
| `src/cli/commands/storage/storage.ts` | `storage()` dispatch (`show`/`info`, `move`, `use`, `contained`, else fail), `show`, `move`, `use`, `printPlan`, `folderOf` (the folder picker on the terminal), exported `storageBusy(root)` and `performMove(ctx, to, keepOld)` |
| `src/cli/commands/storage/contained.ts` | `contained()` dispatch (`status` default, `on`, `off`), `status`, `turnOn`, `turnOff` |
| `src/cli/commands/storage/offer.ts` | the start-up offer to move data (before `menu`/`launch`); uses `performMove`. **Not part of this area: it stays** |
| `src/cli/commands/storage/index.ts` | barrel |
| `src/host/storage/*` | `StorageMove` (`validate`, `move`, `pin`), `measureFolder`, `estimate`, `describeSize`, `describeDuration`, `moveWarning`, `moveProblem`, `holdsData`, `sharedDefaultRoot`, `otherDataFolders`, `StorageHistory`, `mountedSets`; contained: `ContainedStorage`, `containedAvailability`, `planTransfer`, `runTransfer`, `assertTargetsFree`, `setStateOf`, `StateFile`, `writeContainedSetting` |
| `src/host/sandbox/index.ts` | `isSandboxRunning`, `realContainedDeps` |
| `src/cli/menu/data-folder.ts` | `dataFolderRow(ctx)` and `DataFolderFlow` (path picker, the move/use/cancel dialog, then `storage move|use <to> --yes`) |
| `src/cli/menu/pages/settings-page.ts` | row `DATA_FOLDER = '@data-folder'` in category `general`, Enter runs `DataFolderFlow` |
| `src/cli/menu/pages/maintenance-page.ts` | row `data:folder` in category `data`, Enter runs `DataFolderFlow`, Enter label `change` |
| `src/app/features/settings/settings.def.ts` | `dataFolderItem()`: item `@data-folder` whose `primary` is `link({ kind: 'command', argv: ['storage'] }, 'Data folder', { verb: 'change' })` |
| `src/cli/menu/command-form.ts` (`pathProblem`, ~line 382) | checks a picked folder for `storage` with `moveProblem(ctx.storageRoot, picked, true)` |
| `src/cli/tui/dialogs/path-listing.ts` | the menu path picker's disk helpers: `listFolder` (never follows links), `listDrives`, `parentOf`, `LIST_CAP` |
| `src/cli/commands/registry.ts` | `HANDLERS.storage` |
| web: `web/src/render/QuestionModal.tsx` (path question = `TextInput`), `web/src/render/FieldInput.tsx` (`case 'path'` = `TextInput`) | today's web path inputs |

## CLI surface to keep

`requireOnPc('storage')` runs first for every action: inside a sandbox every storage command fails `You are inside the
sandbox already, so "sandbox storage" has nothing to control.` / `Run it from a terminal on your PC. Inside the sandbox
these work: ...`.

- `sandbox storage` / `storage show` / `storage info`: spinner `Measuring your saved data (big folders take a moment)`
  (not with `--json`). `--json`: `{ root, exists, bytes, files, partial, defaultRoot, otherFoldersWithData }` (the
  `Measured` fields spread between `exists` and `defaultRoot`). Text:
  `Your saved data is in: <root>`, `  <describeSize>` or `  nothing in it yet`, `The default folder is: <default>[ (in
  use)]`, `Another folder with data: <folder>` per folder, blank line, `Move it with: sandbox storage move <folder>  (or
  switch without moving: sandbox storage use <folder>)`, `What takes the space: sandbox data`.
- `storage move [folder] [--keep-old] [--yes]`:
  - no folder: on a terminal `Which folder?` with the default folder, other folders with data, `<drive>\AgentSandbox`
    of other drives (never the current one) and `Type a path...` (then `Folder:`, empty refused with `Type a folder
    path.`); without a terminal `Cannot ask here (no terminal).` / `Use: sandbox storage move <folder>`.
  - the typed folder is expanded with `expandPath(value, process.cwd())`.
  - `There is nothing to move: <from> does not exist.` / `Use sandbox storage use <to> to switch.`
  - `StorageMove.validate` refusals (`There is no folder to move: ...`, `... is a link.`, `moveProblem` texts, `A
    Windows Sandbox is running.` / `Close it (sandbox stop), then move your data.`, busy text).
  - spinner `Measuring your saved data`, then `Move from: `, `       to: `, `     size: `, `     time: ` (`a few seconds
    (same drive, nothing is copied)` or `<describeDuration> (copied to another drive)`), `Warning: <moveWarning>`;
    `Not enough free space on the target drive.` / `Free some space or pick another drive.`
  - asks `Move your data to <to>?` (default yes; no terminal: `Cannot ask here (no terminal).` / `Add --yes to move
    without asking.`); no: `Nothing was moved.`, **exit 1**.
  - progress `Moving your data`, then `Copying: <n> files, <size>`.
  - `--json` after a move: the `MoveResult` object. Text: `Moved <n> files. Your data is now in <to>[; the old folder
    is still at <from>].`, each note, `Your settings now point to <pinned>, so older versions find the data too.`
- `storage use [folder] [--yes]`: same folder choice (`Use: sandbox storage use <folder>`); same folder: `That folder
  is in use already.` exit 0; busy: `<storageBusy text>` / `Wait a minute, then try again.`; `Warning: your data stays
  in <root>. <to> is used as it is.` or `... <to> starts empty: tools, logins and history are set up again.`; asks `Use
  <to> from now on, without moving your data?` (fix `Add --yes to switch without asking.`); no: `Nothing was
  changed.`, exit 1; yes: `Your data is now looked for in <to>. Move it later with: sandbox storage move <folder>`.
- `storage contained [status]`: `--json` = `{ setting, maxGb, available, reasons, image, imageExists, imageBytes,
  mountFolder, recordedMounted, holders, mountedNow }`; text block starting `Contained storage (beta, untested on a
  real PC)` with `  setting:`, `  this PC:`, `  image:`, `  mount folder:`, `  mounted now:` lines and `Turn it on with:
  sandbox storage contained on   Turn it off with: sandbox storage contained off`.
- `storage contained on [--yes]`: `requireAvailable` (`Contained storage cannot be used: <reasons>` / `<fixes>`),
  `requireNoSandbox` (`A sandbox is running.` / `Close it (sandbox stop) first: the folders in the image are in use.`);
  explains (yellow `Beta, and not yet tested on a real PC. Contained storage keeps ...`, `  image:`, `  limit:`, `
  Windows asks for permission ...`); asks `Turn contained storage on?` (default yes, fix `Add --yes to turn it on
  without asking.`); **no fails** `Nothing was changed.` / `Run sandbox storage contained on when you want it.`;
  progress `Making and mounting the image (Windows asks for permission)`; when folders exist prints `These folders hold
  your tools, state and logs now:` + the plan, asks `Move them into the image?` (default yes; `--yes` = yes); no:
  `They stay where they are and are not used: ...`; always dismounts (`Dismounting the image (Windows asks for
  permission)`; failure prints `The image stays mounted (<note>). sandbox repair dismounts it.`); ends `Contained
  storage is on. sandbox launch mounts the image first.`
- `storage contained off [--yes]`: same checks; no image: `There is no image, so there was nothing to move. Contained
  storage is off.`; asks `Move them back out of the image?` (no **fails** `Nothing was moved.` / `Contained storage is
  still on.`); ends `Contained storage is off: tools, state and logs are plain folders in <dataPath>.`; then asks
  `Delete the image file now (<size>)? Everything in it was moved out.` (default no, fix `Answer no to keep it.`) —
  **with `--yes` this question is skipped and the image is kept**: `The image file is kept: <image> (delete it
  yourself when you are sure).` / yes: `Deleted <image>.`
- Unknown action: `Unknown storage action "<x>".` (the parser refuses it first) and `Unknown action "<x>" for
  contained storage.` / `Use: sandbox storage contained on, off or status`.

Tests that pin it: no test asserts the storage command's printed text (grep `src/selftest` for `Nothing was moved`,
`looked for in`, `settings now point` finds nothing). These do pin the code it uses:
- `src/selftest/storage.test.ts` (suite `storage`): sections `storage move: rename on one drive`, `storage move: copy
  to another drive (forced), progress, keep old`, `storage move: failures leave everything as it was`, `storage move:
  checks before anything happens`, `estimate, warnings and the pinned form`, `the offer to move`, `path picker:
  helpers`, `path picker: the screen` (it imports `listFolder`, `parentOf`, ... from
  `../cli/tui/dialogs/path-listing.js`).
- `src/selftest/contained.test.ts:14` imports `storageBusy` from `../cli/commands/storage/storage.js`; `:375` checks
  `t.includes(storageBusy(staleBase) ?? '', 'is mounted', 'and waits for it')`.
- `src/selftest/menu.test.ts:734` "choices and paths are told apart: ...": `argPathKind({ name: 'folder', ... },
  'storage', 'move') === 'dir'` (the manifest arg must stay named `folder`).

## Menu surface to keep

- Settings > General: row `Data folder`, hint = the storage folder, description `Where your tools, logins, history
  and logs are kept between sandboxes. Press Enter to move them to another folder or drive, or to use a different
  folder.`, Enter = `change` (settings view item `@data-folder`).
- Maintenance > Data & storage: the same row (`data:folder`), Enter label `change`.
- The flow (`DataFolderFlow`): measure for at most 8 s (`MEASURE_MS = 8000` in `data-folder.ts`; the size then reads
  "at least"), status `Measuring your saved data…`; path picker titled `Choose the folder for your saved data`, about
  `Now: <from> (<size>).` and `Pick a new or empty folder to move your data there, or a folder that already holds
  data to use it.`, starting in the parent of the current folder, checked with `moveProblem(from, picked, true)`; then
  a dialog `Move your data to <to>?` (or `Use <to>?`) with `From:`, `To:`, `Size:`, `Time: ...`, `Free space on the
  target drive: ...`, the warning, and `Use without moving: the new folder is used from now on and your old data is
  left behind.`; choices `Move data` (only when there is data to move, the target is empty and it fits), `Switch
  without moving`, `Cancel`.

## Prerequisites this area adds

1. **Two-word actions** (`storage contained on`). In `src/cli/operations/input.ts`: `definitionFor` matches when
   every word of `d.cli.action.split(' ')` equals `positionals[i]`; `cliInput` drops `hint.action.split(' ').length`
   positionals instead of 1. In `src/cli/operations/spec.ts` `withActions`: use the **first word** of each action for
   the first argument's choices and for `when` (`'contained on'` -> `'contained'`, already a choice). Test: see Tests.
2. **`skipWithYes` on confirm.** Add `skipWithYes: z.boolean().optional()` to `ConfirmQuestionSchema`
   (`src/app/kernel/io.ts`), described "On the command line --yes answers no without asking: an extra step a script
   did not ask for (delete the image)". In `io-cli.ts` `ask()`, first line of `case 'confirm'`: `if (q.skipWithYes &&
   options.yes) return false;`. Menu and web ignore it.
3. **The folder listing query and the web folder browser** (below).

## The folder listing query (`src/app/features/files/`)

`files.def.ts` (pure):

```ts
export const FolderListingSchema = z.object({
  folder: z.string().nullable().describe('The folder listed; null: the drives of this PC'),
  parent: z.string().nullable().describe('The folder above it; null at a drive or at the drives'),
  folders: z.array(z.object({
    name: z.string().describe('The folder name'),
    path: z.string().describe('Its full path'),
  })).describe('Its subfolders (never files, never links), sorted by name'),
  drives: z.array(z.object({
    name: z.string().describe('The drive, e.g. D:\\'),
    path: z.string().describe('Its root'),
    detail: z.string().describe('Free space, e.g. 22 GB free of 40 GB'),
  })).describe('The drives, when no folder was given'),
  truncated: z.boolean().describe('More subfolders exist than were listed'),
});

export const listFolders = defineQuery({
  id: 'files.list',
  title: 'Folders',
  summary: 'list the subfolders of a folder on this PC (the web folder browser)',
  input: z.object({
    folder: z.string().max(2000).optional().describe('A full path like D:\\Projects; left out: the drives'),
  }),
  output: FolderListingSchema,
  surfaces: {
    except: {
      cli: 'typing the path is the command line way; nothing to browse',
      menu: 'the menu has its own path picker (askPath, cli/tui/dialogs/path-picker.ts)',
    },
  },
});
```

`files.run.ts`:

1. No `folder`: return `{ folder: null, parent: null, folders: [], drives: listDrives().map(...), truncated: false }`.
2. Refuse, with `fail()`, anything that is not a plain local path:
   - starts with `\\` or `//` (UNC `\\server\share`, `\\?\`, `\\.\` device paths): `fail('Only folders on this PC\'s
     drives can be browsed.', 'Give a path like D:\\Projects.')`;
   - not `^[A-Za-z]:[\\/]` after trimming: same message;
   - contains `:` after the drive (alternate data streams) or a NUL: same message.
   Then `const folder = path.win32.normalize(input)` (resolves `..`; the result must still match the drive pattern).
3. **Never follow a link**: `assertNoLinks(path.win32.parse(folder).root, folder)` from `src/core/util/links.ts`
   (it walks every component from the drive root down and fails `Refusing to touch <target>: <component> is a link
   (possible escape attempt from the sandbox).`). Also refuse when the folder is not a directory (`fail('No such
   folder: ' + folder + '.')`).
4. List one level, no recursion: `fs.readdirSync(folder, { withFileTypes: true })`, keep only `d.isDirectory() &&
   !d.isSymbolicLink()` (on Windows junctions are reported as symbolic links), and also drop any entry for which
   `isLink(full)` is true. **Never return file names, sizes or contents.** Unreadable folder: `fail('That folder cannot
   be opened.', 'Pick another folder.')`.
5. Sort by name (case-insensitive), cap at **500** entries (`MAX_FOLDERS = 500`), `truncated: total > 500`.
6. `parent`: `path.win32.dirname(folder)`, or `null` when that equals `folder` (a drive root).

Reuse instead of copying: move `listFolder`, `listDrives`, `parentOf`, `LIST_CAP`, `PickEntry`, `Listing` out of
`src/cli/tui/dialogs/path-listing.ts` into a new `src/host/files/listing.ts` (barrel `src/host/files/index.ts`; add
`files/` to the `src/host/` row of CLAUDE.md's layout table), keep `path-listing.ts` re-exporting them for the TUI and
`storage.test.ts`, and call `listFolder(folder, false, 500)` + the link checks above from the run (a run may not import
`cli/tui`). Keep `listFolder`'s behaviour for the menu (it lists links as `kind: 'link'`); the run filters them out.

Security, in one place (write it as the file header of `files.run.ts`):
- Served only over the existing RPC socket: the web server listens on `127.0.0.1` only (`src/host/web/server.ts`),
  needs the login cookie, and checks Host/Origin/CSRF; the server runs as the PC user, who can open any of these
  folders in Explorer anyway.
- Folders only, one level, at most 500, no file names or contents, links refused, no UNC or device paths.
- Not live (no subscription), not on the CLI or the menu (exempt).

Registration: `listFolders` in `QUERIES` (defs.ts) and `listFoldersRun` in `IMPLEMENTATIONS`. It is in no view, so the
parity check would report `files.list on web: no web view offers it`. Add to `defs.ts`:

```ts
/** Queries the web's own dialogs call (the folder browser), not a page: reachable on the web without a view. */
export const WEB_TOOLS: readonly QueryDef[] = [listFolders];
```

and in `src/selftest/app.test.ts` add their ids to `reach.web` (`web: new Set([...reached(webViews), ...WEB_TOOLS.map((q) => q.id)])`).
That is a change to the parity test's input, not a weakening: say so in your report.

## The web folder browser

New `web/src/render/FolderBrowser.tsx` exporting `openFolderBrowser(start: string | undefined): Promise<string |
undefined>` (a Mantine modal through `@mantine/modals`, resolved with the chosen path or `undefined` on cancel):

- Loads `files.list` through the RPC client (`useRpc().call('files.list', { folder }, noQuestions)` or a `useQuery`
  keyed by the folder); `start` = the current text when it is a full path, else the drives.
- Shows: a breadcrumb of the path (each part clickable), an **Up** button (disabled when `parent` is null; at a drive
  root it goes to the drives), a scrollable list (`ScrollArea`, max height ~50vh) of subfolders (click opens) or of
  drives with their `detail`, a note "Only the first 500 folders are shown." when `truncated`, errors as an `Alert`
  with the fix.
- Buttons: **Cancel** and **Use this folder** (disabled on the drives level).
- Works at 360 px: one column, full-width buttons wrapping, breadcrumb wraps.
- `QuestionModal.tsx`: for `q.kind === 'path'` and `q.pathKind === 'dir'` add a `Browse…` button
  (`rightSection` or a button under the input) that calls `openFolderBrowser(text)` and puts the answer in the field.
  `pathKind === 'file'` keeps the plain text field (files are never listed).
- `FieldInput.tsx` `case 'path'`: same button when `field.pathKind === 'dir'`.
- Only Mantine components; imports only `src/app/kernel`, `src/app/features/defs`, `src/shared/web` (lint).

Projects (area 2) and every later `io.path` with `pathKind: 'dir'` get the browser without more work.

## Definitions to write (`src/app/features/storage/storage.def.ts`)

```ts
const MeasuredSchema = z.object({
  bytes: z.number().describe('Bytes counted'),
  files: z.number().describe('Files counted'),
  partial: z.boolean().describe('The count stopped at its limit: there is at least this much'),
});

export const StorageShowSchema = z.object({
  root: z.string().describe('The folder your saved data is in'),
  exists: z.boolean().describe('It exists'),
  holdsData: z.boolean().describe('Something is in it'),
  measured: MeasuredSchema.nullable().describe('Its size; null when not measured'),
  size: z.string().describe('Its size in words, or "nothing in it yet"'),
  defaultRoot: z.string().describe('The default folder'),
  defaultInUse: z.boolean().describe('The default folder is the one in use'),
  otherFoldersWithData: z.array(z.string()).describe('Other folders that hold data'),
});

export const showStorage = defineQuery({
  id: 'storage.show',
  title: 'Data folder',
  summary: 'where your saved data lives',
  input: z.object({ measure: z.boolean().default(true).describe('add up its size (big folders take a moment)') }),
  output: StorageShowSchema,
  text: (o) => [ /* the six lines of `show` in storage.ts, word for word */ ].join('\n'),
  cli: {
    name: 'storage',
    action: 'show',
    json: true,
    shapeJson: (o) => ({ root: o.root, exists: o.exists, ...(o.measured ?? { bytes: 0, files: 0, partial: false }), defaultRoot: o.defaultRoot, otherFoldersWithData: o.otherFoldersWithData }),
  },
});
```

A query's `text` is printed only by the CLI (the menu and web draw the page), so a multi-line text is fine here.

```ts
const MoveOutputSchema = z.object({
  from: z.string().describe('The old folder'), to: z.string().describe('The new folder'),
  copied: z.boolean().describe('It was copied (another drive)'), files: z.number().describe('Files moved'),
  bytes: z.number().describe('Bytes moved'), pinned: z.string().describe('What storage.root now says'),
  removedOld: z.boolean().describe('The old folder is gone'), notes: z.array(z.string()).describe('Extra notes'),
  message: z.string().describe('What happened'),
});  // = MoveResult (src/host/storage/move.ts) + message

export const moveStorage = defineOperation({
  id: 'storage.move',
  title: 'Move the data…',
  summary: 'move your saved data to another folder',
  input: z.object({
    folder: z.string().optional().describe('the folder to move to'),
    keepOld: z.boolean().default(false).describe('copy instead of moving: the old folder stays (needs room for both)'),
  }),
  output: MoveOutputSchema,
  text: (o) => o.message,
  cli: { name: 'storage', action: 'move', positional: ['folder'], flags: { keepOld: { flag: '--keep-old' } }, json: true,
    shapeJson: ({ message: _m, ...result }) => result },
});

export const useStorage = defineOperation({
  id: 'storage.use',
  title: 'Use another folder…',
  summary: 'use another folder for your saved data, without moving it',
  input: z.object({ folder: z.string().optional().describe('the folder to use') }),
  output: z.object({ message: z.string().describe('What happened') }),
  text: (o) => o.message,
  cli: { name: 'storage', action: 'use', positional: ['folder'] },
});

export const changeDataFolder = defineOperation({
  id: 'storage.change',
  title: 'Data folder',
  summary: 'pick another folder for your saved data, then move it there or switch to it',
  input: z.object({}),
  output: z.object({ message: z.string().describe('What happened') }),
  text: (o) => o.message,
  surfaces: { except: { cli: 'the command line has storage move <folder> and storage use <folder>' } },
});

export const ContainedStatusSchema = z.object({
  setting: z.string().describe('storage.contained'), maxGb: z.number().describe('storage.containedMaxGb'),
  available: z.boolean().describe('This PC can use it'), reasons: z.array(z.string()).describe('Why not'),
  fixes: z.array(z.string()).describe('What would fix it'),
  image: z.string().describe('The disk image file'), imageExists: z.boolean().describe('It exists'),
  imageBytes: z.number().nullable().describe('Its size on disk'), mountFolder: z.string().describe('Where it is mounted'),
  recordedMounted: z.boolean().describe('The record says it is mounted'), holders: z.number().describe('Sandboxes using it'),
  mountedNow: z.boolean().nullable().describe('It is mounted now (null: not checked)'),
});

export const containedStatus = defineQuery({
  id: 'storage.containedStatus',
  title: 'Contained storage (beta)',
  summary: '(beta) the disk image for tools, state and logs',
  input: z.object({}),
  output: ContainedStatusSchema,
  text: (o) => [ /* the lines of status() in contained.ts; the first one in plain text (no colour) */ ].join('\n'),
  cli: { name: 'storage', action: 'contained status', json: true, shapeJson: ({ fixes: _f, ...rest }) => rest },
});

export const containedOn = defineOperation({
  id: 'storage.containedOn', title: 'Turn contained storage on…',
  summary: '(beta) keep tools, state and logs in a disk image',
  input: z.object({}), output: z.object({ message: z.string().describe('What happened') }),
  text: (o) => o.message, cli: { name: 'storage', action: 'contained on' },
});
export const containedOff = defineOperation({
  id: 'storage.containedOff', title: 'Turn contained storage off…',
  summary: '(beta) move tools, state and logs back into plain folders', danger: true,
  input: z.object({}), output: z.object({ message: z.string().describe('What happened') }),
  text: (o) => o.message, cli: { name: 'storage', action: 'contained off' },
});
```

The view and its page:

```ts
export function storagePage(o: StorageShow, c: ContainedStatus): Page {
  return {
    title: 'Storage',
    sections: [
      { id: 'folder', title: 'Data folder', items: [{
          id: '@data-folder', label: 'Data folder', hint: o.root,
          description: 'Where your tools, logins, history and logs are kept between sandboxes. Press Enter to move them to another folder or drive, or to use a different folder.',
          details: [o.size, 'Default folder: ' + o.defaultRoot + (o.defaultInUse ? ' (in use)' : ''), ...o.otherFoldersWithData.map((f) => 'Another folder with data: ' + f)],
          primary: action(changeDataFolder, {}, { label: 'Data folder', verb: 'change' }),
        }],
        actions: [action(moveStorage, {}), action(useStorage, {})] },
      { id: 'contained', title: 'Contained storage (beta)', facts: [/* setting, this PC, image, mount folder, mounted now */],
        actions: c.setting === 'off' ? [action(containedOn, {})] : [action(containedOff, {})] },
    ],
  };
}

export const storageView = defineView({
  id: 'storage', title: 'Storage', summary: 'Where your saved data lives: move it, switch folders, (beta) a disk image.',
  queries: { storage: showStorage, contained: containedStatus },
  operations: [changeDataFolder, moveStorage, useStorage, containedOn, containedOff],
  tabs: undefined,
  inputs: () => ({ storage: { measure: true } }),
  build: ({ storage, contained }) => storagePage(storage, contained),
});
```

`storage.contained` is `z.enum(['off', 'vhdx'])` (`src/core/schema/config.ts`); the run writes those through
`writeContainedSetting`. Write `setting: z.enum(['off', 'vhdx'])` in `ContainedStatusSchema` instead of `z.string()`.

## Run functions (`src/app/features/storage/storage.run.ts`)

Move `storageBusy`, `mover()` and the move itself out of `src/cli/commands/storage/storage.ts` into a new
`src/cli/services/storage-service.ts` (`StorageService` with `busy()`, `validate(to)`, `move(to, keepOld,
onProgress)` which also remembers both folders in `StorageHistory`, `use(to)`, `knownFolders()` for the choice list);
export it from `src/cli/services/index.ts`. Change the import in `src/selftest/contained.test.ts:14` and in
`offer.ts` (which keeps its own `working()` spinner around `StorageService.move`).

Every run starts with `requireOnPc('storage')`.

- **`showStorageRun`**: `io.progress('Measuring your saved data (big folders take a moment)')` when `input.measure`;
  `measureFolder(ctx.storageRoot)`; `size` = `holdsData(root) ? describeSize(measured) : 'nothing in it yet'`;
  `otherDataFolders(ctx.storageRoot, new StorageHistory(userDir()))`, `sharedDefaultRoot()`.
- **`chooseFolder(io, ctx, what)`** (helper in the run file): `io.choose({ title: 'Which folder?', choices: [...known,
  { value: '@type', label: 'Type a path...' }], noTerminal: { message: 'Cannot ask here (no terminal).', fix: 'Use:
  sandbox storage ' + what + ' <folder>' } })`; `@type` -> `io.path({ title: 'Folder:', pathKind: 'dir', validate: (v)
  => v.trim().length > 0 || 'Type a folder path.', noTerminal: { same } })`; then `expandPath(answer, process.cwd())`.
  Backed out -> `cancelled(what === 'move' ? 'Nothing was moved.' : 'Nothing was changed.')`.
- **`moveStorageRun`**: folder (`input.folder` expanded, or `chooseFolder`); the `does not exist` fail; `validate`;
  `io.progress('Measuring your saved data')`; `io.log` the four plan lines and `Warning: ...` (tone `warn`); the
  free-space fail; `io.confirm({ title: 'Move your data to ' + to + '?', yes: 'Move', noTerminal: { message: 'Cannot
  ask here (no terminal).', fix: 'Add --yes to move without asking.' } })` (not implied: the command always asked);
  no -> `cancelled('Nothing was moved.')`; `io.progress('Moving your data')`, `onProgress` -> `io.progress('Copying: '
  + files.toLocaleString('en-US') + ' files, ' + humanBytes(bytes))`; `io.log` each note and `Your settings now point
  to <pinned>, so older versions find the data too.`; return the result with `message: 'Moved <n> files. Your data is
  now in <to><left>.'`.
  Order change to report: the notes and the "settings now point" line now print **before** the `Moved ...` line (the
  operation's `text` is the last line). No test asserts the order.
- **`useStorageRun`**: as `use()` in storage.ts; confirm `Use <to> from now on, without moving your data?` (yes
  `Use`, fix `Add --yes to switch without asking.`); no -> `cancelled('Nothing was changed.')`.
- **`changeDataFolderRun`** (menu and web; replaces `DataFolderFlow`): measure capped at 8 s (`measureFolder(from,
  8000)`, `io.progress('Measuring your saved data')`); `io.path({ title: 'Choose the folder for your saved data',
  lines: ['Now: ...', 'Pick a new or empty folder ...'], pathKind: 'dir', initial: from.replace(/[\\/][^\\/]*$/, '\\'),
  validate: (picked) => moveProblem(from, picked, true)?.message ?? true })`; undefined or the same folder ->
  `cancelled()`; the lines of `DataFolderFlow.decide`; `io.choose({ title: canMove ? 'Move your data to ' + to + '?' :
  'Use ' + to + '?', lines, choices: [...(canMove ? [{ value: 'move', label: 'Move data' }] : []), { value: 'use',
  label: 'Switch without moving' }, { value: 'cancel', label: 'Cancel' }] })`; `cancel`/undefined -> `cancelled()`;
  `move` -> the move steps without a second question (the old flow ran `--yes`), progress through `io.progress`; `use`
  -> the use steps without a question. The menu now moves inside the menu with a busy line instead of leaving for the
  normal screen: intended.
- **`containedStatusRun`**: the `answer` object of `status()` plus `fixes: check.fixes`.
- **`containedOnRun`** / **`containedOffRun`**: copy `turnOn` / `turnOff` step by step: every `console.log` ->
  `io.log` (yellow -> tone `warn`), every `working(text, fn)` -> `io.progress(text)` then `await fn()`, keep the
  `try/finally` dismount. Questions:
  - `Turn contained storage on?`: `io.confirm({ title, yes: 'Turn on', noTerminal: { message: 'Cannot ask here (no
    terminal).', fix: 'Add --yes to turn it on without asking.' } })`; no -> **`fail('Nothing was changed.', 'Run
    sandbox storage contained on when you want it.')`** (it was a failure, keep it).
  - `Move them into the image?`: same pattern (fix `Add --yes to move without asking.`); no -> the `They stay where
    they are ...` log.
  - `Move them back out of the image?`: no -> `fail('Nothing was moved.', 'Contained storage is still on.')`.
  - `Delete the image file now (<size>)? Everything in it was moved out.`: `io.confirm({ title, yes: 'Delete',
    danger: true, skipWithYes: true, noTerminal: { message: 'Cannot ask here (no terminal).', fix: 'Answer no to keep
    it.' } })`.
  - Return `{ message: 'Contained storage is on. sandbox launch mounts the image first.' }` / the off sentence (the
    image kept/deleted line is logged before it; order change, report it).

## Registration and wiring

- `index.ts` barrels for `storage` and `files`; `defs.ts`: `moveStorage, useStorage, changeDataFolder, containedOn,
  containedOff` in `OPERATIONS`; `showStorage, containedStatus, listFolders` in `QUERIES`; `storageView` in `VIEWS`;
  `WEB_TOOLS`; NAV Maintenance children: add `{ label: 'Storage', view: 'storage' }` after Data and drop "Storage" from
  the `More` text.
- `registry.ts`: the seven runs.
- **CLI**: `storage` stays a hand-written manifest entry (keep it as it is: arg `folder`, `--yes`, `--keep-old`,
  examples). The hints add the actions. Replace `HANDLERS.storage` with a forwarder for what the hints cannot spell:
  no action or `info` -> `definitionHandler(showStorage)`; `contained` with no second word -> `definitionHandler(
  containedStatus)`; anything else falls to the parser's error. Delete `storage.ts`, `contained.ts`; keep `offer.ts`.
- **Settings view**: in `settings.def.ts` `dataFolderItem()` replace the `command` link with
  `action(changeDataFolder, {}, { label: 'Data folder', verb: 'change' })` (import from `../storage/storage.def.js`)
  and add `changeDataFolder` to `settingsView.operations`. Update its description (drop "Move it with the menu
  (Settings > Data folder) or"; keep `sandbox storage move <folder>`).
- **Menu Settings page** (`settings-page.ts`): the `DATA_FOLDER` row runs `this.operations.perform(action(
  changeDataFolder, {}), [this.label, 'Data folder'], busy)` (add a `MenuOperations`); delete the `DataFolderFlow`
  branch.
- **Menu Maintenance page**: draw the storage view in the `data` category above the data rows:
  `menuView(storagePage(storage, contained), { category: 'data', prefix: 'storage:', refresh: false })`, read in
  `load()` with `readQuery(showStorage, ctx, { measure: false })` (fast) and `readQuery(containedStatus, ctx)`; resolve
  it only while `this.category === 'data'`, before the data view. Remove the page-own `data:folder` row.
  `src/cli/menu/views.ts`: `{ view: storageView, section: 'Maintenance' }`.
- `command-form.ts` `pathProblem`: keep (the menu's command list can still build `storage move`).

## Web page

Maintenance > Storage: the Data folder card (path, size, default folder, other folders) with **Data folder**
(change: path question with Browse…, then the Move/Switch/Cancel choice with the estimate in its lines), **Move the
data…** and **Use another folder…** buttons; the Contained storage card (facts, Turn on/off). Windows' permission
prompts for the image appear on this PC's desktop (the web is loopback only, so the user is at this PC).

## Delete or shrink afterwards

`src/cli/commands/storage/storage.ts`, `contained.ts`, `src/cli/menu/data-folder.ts` (`dataFolderRow` is replaced by
the view's item); the `DataFolderFlow` branches in `settings-page.ts` and `maintenance-page.ts`; the `command` link in
`settings.def.ts`. Update the `storage` barrel to export only `offer.ts`'s functions.

## Tests

Keep passing: `storage`, `contained`, `menu` (incl. "every screen ..." and `menu.test.ts:734`), `cli`, `host-sim`,
`app`, `layout`, `web`.

Add (in `app.test.ts`, `t.section('storage')` and `t.section('folder listing')`):

1. "storage contained on and off are two-word actions" — `definitionFor('storage', ['contained', 'on'])?.id ===
   'storage.containedOn'`, `definitionFor('storage', ['contained', 'status'])?.id === 'storage.containedStatus'`,
   `definitionFor('storage', ['move'])?.id === 'storage.move'`, `cliInput(definitionFor('storage', ['move'])!,
   parseCli(['storage', 'move', 'D:\\x', '--keep-old']))` equals `{ folder: 'D:\\x', keepOld: true }`, and
   `commandSpec('storage')?.args[0].choices` equals `['show', 'move', 'use', 'contained']`.
2. "storage show --json keeps its old shape" — `showStorage.cli!.shapeJson!(sample)` has exactly `root, exists, bytes,
   files, partial, defaultRoot, otherFoldersWithData`.
3. "storage refuses inside the sandbox" — when `insideSandbox()` (`src/host/sandbox`), `runDefinition('storage.move',
   ctx, { folder: 'D:\\x' }, fakeIO([]).io)` throws `has nothing to control`.
4. "--yes skips the image deletion" — `cliIO({ ...parseCli(['storage', 'contained', 'off', '--yes']) }).io.confirm({
   title: 'Delete?', skipWithYes: true })` resolves `false`.
5. "the folder listing: folders only, bounded, links refused" — in `t.dir('files')` create 3 folders and 2 files; the
   run returns the 3 folder names only and `truncated: false`; with 501 folders it returns 500 and `truncated: true`;
   a junction (`fs.symlinkSync(target, link, 'junction')`, skip with `t.skip` when it cannot be made) is not listed,
   and listing *through* it throws `is a link`; `\\?\C:\`, `\\server\share`, `C:relative`, `C:\x:stream` throw
   `Only folders on this PC's drives can be browsed.`; no folder returns drives.
6. "files.list is web only" — `exemption(listFolders, 'cli')` and `exemption(listFolders, 'menu')` are non-empty,
   `createRpcHost(ctx).kind('files.list') === 'query'`.
7. Parity still shows no gaps (with `WEB_TOOLS` in `reach.web`).

## Pitfalls

- `requireOnPc('storage')` means none of these runs work inside the sandbox where tests run: test the pure parts, the
  CLI adapters and the refusal.
- Moving takes minutes and copies gigabytes: never call `move` in a test with real data; `storage.test.ts` already
  covers `StorageMove` with temp folders.
- `storageBusy` must keep its words (`is mounted`, contained test).
- The storage folder is not sandbox-writable, but the data folder inside it is: keep using the host helpers
  (`assertTargetsFree`, `planTransfer`), never your own copy.
- `contained on/off` ask Windows for permission (an elevated script mounts the VHDX); the operation waits for it.
  Do not add a timeout. Whether the elevated script writes to the console is unverified: if it does, the menu's
  `enable()` pattern (`this.app.terminal.stop()`) may be needed around it; check on a real PC and say so.
- Never return the folder listing for paths outside local drives; never add files to it, even "just names".
- The web server's working folder is not the user's: relative paths typed on the web must not be accepted silently
  (`moveProblem` refuses non-absolute paths only after `expandPath`; in `chooseFolder` on the web the browser always
  gives a full path; note it in the run's comments).

## Checklist

1. `git worktree add ../ws-storage -b web-ui/storage master` (after area 4 is merged).
2. Prerequisites 1-2 with tests; commit. Then the folder listing (host/files move, `files` feature, `WEB_TOOLS`,
   `FolderBrowser.tsx`, Browse buttons) with tests; commit. Then the storage feature; commit.
3. `npm run build`, `npm run lint`, `npm run format:check`,
   `npm test -- app,storage,contained,menu,cli,web,layout,host-sim`, then `npm test` until `ALL TESTS PASSED`
   ([Commands to run](00-worked-example.md#commands-to-run)).
4. By hand: `node dist/bin/agent-sandbox.js storage --help`; inside the sandbox `storage` must refuse with the
   requireOnPc text; `sandbox web` cannot run inside the sandbox, so check the browser at 360 px on the PC if you can,
   and say if you could not.
5. Re-read [Common mistakes](00-worked-example.md#common-mistakes).

## Report template

```
Area 5 (storage) — branch web-ui/storage
Prerequisites: two-word actions [..], skipWithYes [..]
Folder listing: files.list [..], host/files move [..], WEB_TOOLS + parity input change [..], FolderBrowser [..], tested at 360 px [yes/no]
Definitions: storage.show, storage.move, storage.use, storage.change, storage.containedStatus, storage.containedOn, storage.containedOff; view storage
Deleted / moved: ...
CLI text changes (old -> new, order changes): ...
Menu changes (Data folder flow now runs inside the menu): ...
Tests added / changed (why): ...
npm run build / lint / format:check: ...   npm test: ALL TESTS PASSED (yes/no, runs: n)
Unsure / left undone (contained on a real PC, elevated console output): ...
```
