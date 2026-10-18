# 09 · Logs

Read [00-worked-example.md](00-worked-example.md) first. This file only says what is special about the logs area.

## What it does today

`sandbox logs` prints the end of the newest sandbox log (`guest-*.log`, `daemon-*.log`, `bootstrap-*.log` in the data
folder's `logs`), `-f` keeps printing new lines, and `--crash` prints the newest crash report. The menu lists the log
files under Maintenance > Logs; Enter shows the end of one, `f` follows the newest in the terminal.

## Files today

**Another agent is changing some of these files right now** (memory / heavy-load work: `git status` shows
`src/cli/commands/maintenance/logs.ts`, `src/cli/manifest.ts` and `src/host/life/crash-report.ts` modified). The
`--crash` flag and `newestCrashReport()` are new in that work. Before you start, rebase on the latest `master` and
read these files again; if they differ from what is written here, follow the code and say so in your report.

| File | What it does |
| --- | --- |
| `src/cli/services/logs-service.ts` | `LogsService`: `files()` (log files, newest first, never through links: `assertNoLinks`), `newest()` (path, or `fail('No sandbox logs yet in <folder>.', 'Logs appear after the first start (sandbox claude).')`), `read(file, from)` (text since an offset, `from = 0` = the last 64 KB, at most 4 MB per read, made safe with `safeText`). `LOG_NAME = /^(guest\|daemon\|bootstrap)-.*\.log$/`. |
| `src/cli/commands/maintenance/logs.ts` | the `logs` handler: `--crash` prints `== <file> ==` and the report (or `No crash report yet: no sandbox has ended in a crash since this was installed.`); otherwise `== <file> ==`, the last 120 lines, and with `--follow` `(following; Ctrl+C to stop)` on stderr and a new read every second, forever. |
| `src/host/life/crash-report.ts` | `newestCrashReport(storageRoot): { file: string; text: string } \| null` (mid-change, see above). |
| `src/cli/manifest.ts` (entry `name: 'logs'`) | `summary: 'print the newest sandbox log'`, `group: 'Health'`, no args, options `bool('--follow', 'keep printing new lines', { short: '-f' })` and `bool('--crash', 'print the report of the last crash (what Windows logged, this PC and the sandbox memory)')`. |
| `src/cli/commands/registry.ts` | `logs: logs` in `HANDLERS`. |
| `src/cli/menu/pages/maintenance-page.ts` | category `{ id: 'logs', label: 'Logs', description: "The sandbox's own logs." }`; rows built in `maintenanceOptions()`; key `f` in `maintenanceActions()`; `act()` handles `f` and `log:` rows; `load()` reads `new LogsService(this.ctx).files()`. |
| `src/cli/menu/menu.ts` | `view(file)`: the `{ kind: 'view', file }` exit: clears the screen, prints `== <file> ==`, the last 120 lines (or `(empty)`), waits for `Press any key for the menu…`. |
| `src/cli/menu/shell.ts` | `ShellExit` has `{ kind: 'view'; file: string }` ("Show the end of a log file on the normal screen"). |
| `src/selftest/menu-screens.ts` | the Maintenance fixture has `logs: [{ name: 'guest-2026-10-14.log', ... }, { name: 'daemon-2026-10-14.log', ... }]` and draws category `logs`. |

## CLI surface to keep

| Command | Prints | Exit |
| --- | --- | --- |
| `sandbox logs` | `== <full path of newest log> ==`, then the last 120 lines of its last 64 KB | 0; no logs: the `fail` above (exit 1, message + fix) |
| `sandbox logs -f` / `--follow` | same, then `(following; Ctrl+C to stop)` on **stderr**, then new text every second until Ctrl+C | runs until stopped |
| `sandbox logs --crash` | `== <report file> ==` and the report text, or `No crash report yet: no sandbox has ended in a crash since this was installed.` | 0 |

No `--json`. No positional arguments. The `--follow` and `--crash` descriptions must stay word for word (they come
from `.describe()` once moved).

Self-tests that assert logs output: none found (`grep -rn "No sandbox logs\|No crash report\|LogsService" src/selftest`
finds nothing). The menu's "every screen" check (`src/selftest/menu.test.ts:1003`, check name "every screen is
exactly as tall as the terminal and never wider, at 200x60, 100x30, 80x24 and 60x20") draws
`7 Maintenance · logs` from `maintenanceOptions(maintenance)` (`src/selftest/menu-screens.ts:373`). The crash report
itself is tested in `src/selftest/heavy-load.test.ts` section `'the crash report'` (owned by the other agent; do not
touch it).

## Menu surface to keep

Maintenance (section 7) > category **Logs**:

- One row per log file: value `log:<name>`, label = file name, hint = `humanBytes(bytes) + '  ' + ago(modified)`,
  description `Enter shows the end of this log in the terminal.`, Enter label `show`.
- Enter on a row: leaves the menu and shows the end of that file (`{ exit: { kind: 'view', file: <path> } }`).
- Key `f`, label `follow in the terminal`: leaves the menu and runs `logs --follow`.
- No refresh key in this category today (the page has no `l` here; `l` is Health's "check"). Keep it that way: pass
  `refresh: false` to `menuView`.
- No logs: the category shows the page's `empty: 'Nothing here yet.'`.

New (comes for free from the view, keep it): a "Last crash report" row; Enter runs `logs --crash` on the normal
screen.

## Decisions for this area

1. **`sandbox logs` stays a hand-written command**, because `--follow` writes new text until Ctrl+C, which a one-shot
   definition handler (`definitionHandler` prints once and returns) cannot do. Its handler becomes a thin renderer:
   it reads everything through the feature's queries with `readQuery` and only loops and prints. The queries
   therefore declare `surfaces: { except: { cli: ... } }` with the reason below. This is the one sanctioned
   exception in this area; do not invent more.
2. **Following is a live query** (`logs.tail`, `live: { everyMs: 1000 }`). The web subscribes to it (the RPC session
   only sends data when the text changed, see `sub.last` in `src/host/web/rpc.ts`); the CLI's `--follow` calls it
   with the `next` offset it got last time.
3. **Which log is shown is a view parameter** (`name`), and **the log text is a new Page part** (`Section.text`).
   Both are small kernel changes, spelled out below. The crash report is shown in the same place under the reserved
   name `@crash` (it can never be a log file name: `LOG_NAME` needs a `guest-`, `daemon-` or `bootstrap-` prefix).
4. **Sizes**: a `*.def.ts` cannot import `core/disk.ts`, so add a pure `bytesText(n)` to `src/app/kernel/text.ts`
   with exactly the output of `humanBytes` in `src/core/disk.ts` (copy the function; if area 4 already added one,
   use it). Export it from the kernel barrel (it is `export *`).

## Kernel changes (do these first, in one commit)

1. `src/app/kernel/view.ts`:
   - `Section` gets `readonly text?: readonly string[];` with the comment `/** Preformatted lines (a log): monospace,
     shown as they are. */`.
   - `pageHasContent()` also counts `(s.text?.length ?? 0) > 0`.
   - `Target`'s view member becomes `{ readonly kind: 'view'; readonly view: string; readonly params?:
     Readonly<Record<string, string>> }`.
2. `src/app/kernel/define.ts`: `ViewDef` gets `readonly params?: readonly (keyof P & string)[];` with the comment
   `/** Parameters taken from the address as they are (the log shown), besides the tabs' one. */`.
3. `web/src/pages/ViewPage.tsx` `paramsOf()`: also copy every name in `view.params` from `given` when present (strings
   only, at most 200 characters; drop anything longer).
4. `web/src/render/actions.tsx` `useAct()`: `navigate(viewPath(target.view, target.params))`.
5. `web/src/render/PageView.tsx` `SectionCard`: when `section.text` is set, render Mantine `<ScrollArea h={400}>`
   holding `<Code block>{section.text.join('\n')}</Code>`, scrolled to the bottom whenever the text changes (a `ref`
   on the viewport and `useEffect`). Nothing else changes.
6. `src/cli/output/render-view.ts` `sectionLines()`: after the facts, push `...section.text` unchanged (no colour).
7. `src/cli/menu/render-view.ts`: ignores `text` (the menu shows a log on the normal screen). Write that in a
   one-line comment there.
8. Tests in `src/selftest/app.test.ts` (section `'the kernel's text blocks and view parameters'`): `pageLines` of a
   page with `text: ['a', 'b']` contains `a` and `b` in order; `pageHasContent` is true for a text-only section;
   `bytesText(1536) === '1.5 KB'` and `bytesText(0) === '0 B'`.

## Definitions to write (`src/app/features/logs/logs.def.ts`)

```ts
// The sandbox's own logs: the files (newest first), the end of one (live, so it follows), and the last crash report.
// Pure: schemas, labels and the view; logs.run.ts reads them through LogsService.
import { z } from 'zod';
import { ago, bytesText, defineQuery, defineView, link, type Item, type Page, type Section } from '../../kernel/index.js';

/** The name that shows the newest crash report instead of a log (never a log file name). */
export const CRASH = '@crash';

const CLI_EXEMPT =
  'sandbox logs is hand-written: --follow prints new lines until Ctrl+C; it reads this same query (readQuery)';

export const LogFileSchema = z.object({
  name: z.string().describe('The log file'),
  path: z.string().describe('Where it is on this PC'),
  bytes: z.number().describe('Its size in bytes'),
  modified: z.number().describe('When it was last written (ms)'),
});
export type LogFileRow = z.output<typeof LogFileSchema>;

export const LogFilesSchema = z.object({
  folder: z.string().describe('The folder the logs are in'),
  files: z.array(LogFileSchema).describe('The log files, newest first'),
  crash: z.boolean().describe('A crash report exists'),
});
export type LogFiles = z.output<typeof LogFilesSchema>;

export const LogTailSchema = z.object({
  name: z.string().describe('The log shown, or @crash for the last crash report'),
  file: z.string().describe('Its full path (the CLI prints it as == <file> ==)'),
  text: z.string().describe('The text read, made safe for a terminal'),
  next: z.number().describe('Where to read on from next time (bytes)'),
});
export type LogTail = z.output<typeof LogTailSchema>;

export const listLogs = defineQuery({
  id: 'logs.list',
  title: 'Logs',
  summary: "list the sandbox's own logs",
  input: z.object({}),
  output: LogFilesSchema,
  surfaces: { except: { cli: CLI_EXEMPT } },
});

export const tailLog = defineQuery({
  id: 'logs.tail',
  title: 'Log',
  summary: 'the end of one log, followed as it grows',
  input: z.object({
    name: z.string().max(200).optional().describe('The log to show (default: the newest), or @crash'),
    from: z.number().int().min(0).default(0).describe('Read on from this byte (0: the end of the log)'),
    lines: z.number().int().min(1).max(1000).default(120).describe('How many lines of the end to show'),
  }),
  output: LogTailSchema,
  live: { everyMs: 1000 },
  surfaces: { except: { cli: CLI_EXEMPT } },
});

export function logsPage(files: LogFiles, tail?: LogTail): Page { ... }

export const logsView = defineView<'logs', { files: typeof listLogs; tail: typeof tailLog }, { name?: string }>({
  id: 'logs',
  title: 'Logs',
  summary: "The sandbox's own logs: pick one to see its end as it grows.",
  queries: { files: listLogs, tail: tailLog },
  operations: [],
  params: ['name'],
  inputs: (p) => ({ tail: p.name ? { name: p.name } : {} }),
  build: ({ files, tail }) => logsPage(files, tail),
});
```

(If `defineView`'s generic order makes the explicit type arguments awkward, write `inputs: (p: { name?: string }) =>`
and let it infer. Compile errors here are a sign to stop and ask, not to cast to `never`.)

`logsPage(files, tail?)`, pure:

- Section `id: 'files'`, no title: one item per file: `id: 'log:' + f.name` (keep the menu's row values), `label:
  f.name`, `hint: bytesText(f.bytes) + '  ' + ago(f.modified)`, `description: 'Enter shows the end of this log in the
  terminal.'`, `primary: link({ kind: 'view', view: 'logs', params: { name: f.name } }, 'Show', { verb: 'show' })`.
  `marked: true` on the one shown (`tail?.name === f.name`).
- When `files.crash`: one more item `id: 'log:' + CRASH`, `label: 'Last crash report'`, `description: 'What Windows
  logged, this PC and the sandbox memory when the sandbox last ended in a crash.'`, primary link with
  `params: { name: CRASH }`, verb `show`.
- When `tail` is given: Section `id: 'tail'`, `title: tail.name === CRASH ? 'Last crash report' : tail.name`,
  `summary: tail.file`, `text: tail.text.split('\n').slice(-120)` (never more than 1000 lines).
- Page actions: `link({ kind: 'command', argv: ['logs', '--follow'] }, 'Follow the newest log', { key: 'f', verb:
  'follow in the terminal', importance: 2 })`. The web hides `command` links (it follows live instead); this link
  stays because `logs` stays a hand-written command (decision 1). Say so in a comment.
- `empty: { title: 'No logs yet', text: 'Logs appear after the first start.', cliText: 'No sandbox logs yet.' }`.

## Run functions (`src/app/features/logs/logs.run.ts`)

```ts
export const listLogsRun = implement(listLogs, (ctx) => {
  const service = new LogsService(ctx);
  return {
    folder: service.folder(),
    files: service.files().map((f) => ({ name: f.name, path: f.path, bytes: f.bytes, modified: f.modified })),
    crash: newestCrashReport(ctx.storageRoot) !== null,
  };
});
```

- `tailLogRun(ctx, input)`:
  - `input.name === CRASH`: `const report = newestCrashReport(ctx.storageRoot)`; none:
    `fail('No crash report yet: no sandbox has ended in a crash since this was installed.')` (the same words the CLI
    prints today); else `{ name: CRASH, file: report.file, text: safeText(report.text), next: 0 }`. Check whether
    `newestCrashReport` already makes its text safe; `safeText` twice is harmless.
  - otherwise: `const file = input.name ? service.byName(input.name) : service.newest();` then
    `const chunk = service.read(file, input.from)`. No chunk: `{ name, file, text: '', next: input.from }`. With
    `from === 0` keep only the last `input.lines` lines of `chunk.text`; with `from > 0` return all of it.
- New `LogsService` methods (add them to `src/cli/services/logs-service.ts`; services may grow):
  - `folder(): string` = `hostDataFolder(this.ctx.dataPath, 'logs')`.
  - `byName(name: string): string`: refuses anything that is not exactly one of `files()`' names:
    `fail('There is no log called ' + safeText(name) + '.', 'Pick one from: sandbox logs, or the Logs page.')`. This is
    the security check: a name from the browser must never become a path of its own (no `..`, no `\`, no drive).
- Queries ask nothing (`NO_QUESTIONS`). No `requireOnPc`: logs work inside the sandbox too (the `requireOnPc`
  message lists `logs` among the commands that work there).

The hand-written handler (`src/cli/commands/maintenance/logs.ts`) becomes:

```ts
export async function logs(ctx: Context): Promise<number> {
  const name = ctx.options.crash ? CRASH : undefined;
  let tail = await readQuery(tailLog, ctx, { name });
  console.log('== ' + tail.file + ' ==');
  process.stdout.write(tail.text);
  if (!ctx.options.follow || name) return 0;
  console.error('(following; Ctrl+C to stop)');
  for (;;) {
    await sleep(1000);
    tail = await readQuery(tailLog, ctx, { name: tail.name, from: tail.next });
    process.stdout.write(tail.text);
  }
}
```

Keep the old behaviour exactly: for `--crash` with no report, today it prints the line and exits **0**; the query
fails instead. So the handler catches that case: `if (ctx.options.crash && !(await readQuery(listLogs, ctx)).crash)
{ console.log('No crash report yet: ...'); return 0; }` before reading. The first read must print the last 120 lines
(the query's default `lines`). `--follow` with `--crash` does not follow (today `--crash` returns before following).

## Registration and wiring

- `src/app/features/logs/index.ts` barrel; `defs.ts`: `listLogs`, `tailLog` in `QUERIES`, `logsView` in `VIEWS`
  (import from `./logs/logs.def.js`); `registry.ts`: `listLogsRun`, `tailLogRun`.
- `NAV`: under Maintenance's `children` (added in area 4, see [04-data.md](04-data.md)): `{ label: 'Logs', view: 'logs'
  }`. Update Maintenance's `elsewhere`/children text so it no longer says logs are menu-only.
- `MENU_VIEWS`: `{ view: logsView, section: 'Maintenance' }`.
- Menu (`maintenance-page.ts`): `load()` reads `this.logs = await readQuery(listLogs, this.ctx)` (keep the
  try/catch that falls back to no files). The logs rows come from
  `menuView(logsPage(files), { category: 'logs', prefix: '', refresh: false })` (no prefix needed: the row values are
  already `log:<name>`). In `act()`, **only when `this.category === 'logs'`**, ask that view's `resolve(result)`;
  map what it returns (rendering a target, not feature logic):
  - a `view` link with `params.name === CRASH` -> `{ exit: { kind: 'run', argv: ['logs', '--crash'] } }`;
  - a `view` link with another name -> `{ exit: { kind: 'view', file: <path of that file from the model> } }`;
  - a `command` link -> `this.operations.perform(action, ...)` (it returns the run exit).
  Remove the old `key === 'f' && this.category === 'logs'` and `id?.startsWith('log:')` branches and the `logs` part
  of `maintenanceActions()`; the key bar for `logs` becomes the view's `actions`.
- `MaintenanceModel.logs` changes type to `LogFiles` (the query's output); update `src/selftest/menu-screens.ts`'s
  fixture to `{ folder: 'C:\\AgentData\\logs', files: [...the two files...], crash: true }`. That is "output moved",
  allowed.
- `menu.ts` `view(file)` stays (it is the menu's way to show a file).

## Web page

Maintenance > Logs (`/v/logs`, `/v/logs?name=daemon-2026-10-14.log`, `/v/logs?name=@crash`): a card listing the log
files (size and age as hint, the shown one marked) with "Last crash report" last when there is one; clicking one
opens it; under it a card titled with the log's name, its path as summary, and the end of the log in a monospace
scroll box that grows every second and stays scrolled to the bottom. The "Follow the newest log" key action is not
shown (command link). Works at 360 px: the scroll box is full width, lines wrap off (horizontal scroll inside the box
only).

## Delete or shrink afterwards

- `src/cli/commands/maintenance/logs.ts`: shrinks to the renderer above (no `LogsService`, no `newestCrashReport`
  import).
- `maintenance-page.ts`: the hand-built log rows, the `logs` case of `maintenanceActions()`, the two `act()`
  branches.
- The manifest entry and `HANDLERS` line **stay** (decision 1).
- docs/commands.md: line `| \`sandbox logs [-f]\` | the sandbox log |` may say `[-f] [--crash]` (only if the other
  agent did not already).

## Tests

Must keep passing: `app`, `menu` (especially "every screen ..."), `heavy-load` (not yours: run it, do not edit it),
`links`, `layout`.

Add to `src/selftest/app.test.ts`, section `'logs'` (temp folders only):

- "logs.list lists only log files, newest first": a context with `dataPath` = `t.dir('app-logs', 'data')` and
  `storageRoot` = `t.dir('app-logs', 'storage')`; write `logs/guest-a.log`, `logs/daemon-b.log` (touch one newer),
  `logs/notes.txt`; `runDefinition('logs.list', ...)` returns the two logs in order and not `notes.txt`. (Check how
  `hostDataFolder(dataPath, 'logs')` builds the folder before writing the files.)
- "logs.tail shows the last lines and reads on from next": a file with 300 lines; default input gives 120 lines
  ending with line 300; append a line, read with `from: next` gives only the new line.
- "a log name from outside cannot become a path": `name: '..\\config.json'` and `name: 'C:\\Windows\\win.ini'`
  throw `There is no log called`.
- "no crash report: the reserved name fails with the CLI's words": `name: '@crash'` throws `No crash report yet`.
- "the logs page": `logsPage(files, tail)` has one item per file with ids `log:<name>`, the shown one `marked`, a
  `text` section with the tail; `menuView(logsPage(files), { category: 'logs', refresh: false }).actions` keys are
  exactly `['f']`; `enterLabel('logs', 'log:guest-a.log') === 'show'`.
- Parity: `logs.list`/`logs.tail` show no gap (cli exempt with a reason; menu and web through `logsView`).

## Pitfalls

- **The log is written inside the sandbox: it is hostile text.** Every byte that leaves `LogsService.read` is
  already `safeText`; do not add a path that skips it (the crash report too).
- **Never turn a browser-supplied name into a path** except through `byName()`'s exact match.
- **Bounded**: the web gets at most `lines` (max 1000) lines of the last 64 KB per read; never send a whole file.
- **Do not make `logs` an operation command.** `definitionHandler` returns after one print; `--follow` would break.
- **Mid-change files**: `logs.ts`, `manifest.ts`, `crash-report.ts` are being edited by another agent. Rebase first;
  do not reformat their code; keep `--crash`.
- Keys: `f` exists in Health too (`check and fix`); that is why `resolve()` must only run for the open category.

## Checklist

1. Rebase on `master`; re-read the "Files today" files.
2. Kernel changes + their tests; `npm run build`, `npm run lint`.
3. `logs.def.ts`, `logs.run.ts`, `index.ts`, the two `LogsService` methods.
4. `defs.ts`, `registry.ts`, `NAV` child, `MENU_VIEWS`.
5. The `logs` handler as above; the Maintenance page wiring; the screens fixture.
6. New tests.
7. Run:
   ```
   npm run build
   npm run lint
   npm run format:check
   npm test -- app,menu,links,layout,heavy-load
   npm test
   ```
   Gate on `ALL TESTS PASSED` ([commands to run](00-worked-example.md#commands-to-run)). Read
   [common mistakes](00-worked-example.md#common-mistakes) once more.
8. By hand (inside the sandbox is fine): `node dist/bin/agent-sandbox.js logs --help` shows `-f, --follow` and
   `--crash` with the same words as before.

## Report template

```
Area 9 (logs) — branch web-ui/logs
Kernel: Section.text, ViewDef.params, Target view params, bytesText: <done / notes>
Moved: logs.list, logs.tail (cli exempt: <reason as written>), logsView (menu: Maintenance > Logs; web: Maintenance > Logs)
CLI: sandbox logs [-f] [--crash] output unchanged? <yes/no + diff>
Menu: rows/keys unchanged? <yes/no>; new "Last crash report" row
Deleted/shrunk: <files>
Tests added: <names>; npm test: ALL TESTS PASSED <yes/no>
Unsure / left undone: <...>
```
