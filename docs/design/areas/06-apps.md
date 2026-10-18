# 06 · Apps

Read [00-worked-example.md](00-worked-example.md) first. This file says only what is special about apps.

## What it does today

The apps catalogue in the menu (section 4): tick the apps every sandbox (or this project) should have, edit "your own
programs" (`apps.custom`), and open a prefilled GitHub "request an app" page. Ticks are **staged** in the menu's
`Draft` and written with Ctrl+S, like Settings; there is **no CLI command** (people use `sandbox config set
apps.install ...`).

## Files today

| File | What it does |
| --- | --- |
| `src/cli/menu/pages/apps-page.ts` | `AppsPage` (section 4) and pure `appsOptions(model, file, draft, scope)`: intro, scope tabs, multi-select list, keys `c` and `r`; stages ticks on every key (`afterKey`), edits `apps.custom` with `ValueEditor`, opens the request page with `openIssuePage` |
| `src/cli/menu/apps.ts` | `APP_GROUPS` (5 groups over the catalogue categories), `groupOf`, `REQUEST_APP` (`'@request-app'`), `ISSUES_URL`, `requestAppUrl()`, `CUSTOM` (`'@custom:'`), `AppsModel` (`entries`, `categories`, `items(draft)`, `isOn`, `custom(draft)`, `stageTicks(draft, ticked)`), `appsSummary`, `appLabel` |
| `src/cli/menu/pages/scopes.ts` | `SCOPES` (`user` = "All projects" / YOURS, `project` = "This project" / PROJECT) and `scopeStatus(file)`; shared with the Settings page |
| `src/shared/apps/catalogue.ts` | `APPS` (`AppEntry`: `id`, `name`, `category`, `about`, `size`, `cli?`, `needs?`, `setting?`, `fullGitOnly?`, ...), `APP_CATEGORIES` |
| `src/core/schema/apps.ts` | `AppsSchema`: `install` (catalogue ids), `custom` (record of your own programs) |
| `src/host/web/browser.ts` | `openIssuePage(url)`: only GitHub new-issue addresses, refuses in the self-test |
| `src/cli/menu/menu.ts` line ~103 | `new AppsPage(app, files, draft, ctx.dataPath)` (the same `files` and `draft` as Settings) |
| `src/app/features/settings/settings-file.ts` | `ConfigFile` (`user(path)`, `project(dir)`, `isProject`, `userConfig()`, `valueInFile(key)`, `set(key, value)`) |
| `src/selftest/menu-screens.ts` lines ~254, ~320 | draws `appsOptions(apps, user, appsDraft, 'user')` |

## CLI surface to keep

None: no command lists or changes apps. `sandbox config set apps.install ...` / `config get apps.custom` (settings
feature) keep working and are not part of this area. **Decision:** the apps definitions declare
`surfaces: { except: { cli: 'apps are settings: sandbox config set apps.install / apps.custom' } }`; do not invent a
new `sandbox apps` command (if the owner wants one later, it is a hint away).

## Menu surface to keep

From `appsOptions` and `AppsModel`:

- Status line under the tabs: `scopeStatus(file)` (`● Editing <file>` ...). Intro: `Tick the apps every sandbox should
  have (space). Each downloads once and is kept. Ctrl+S saves.`
- Tabs: `All projects` / `This project` (`SCOPES`); a tab switch keeps staged ticks.
- `multi: true`, `enterTicks: true` (Enter ticks like space). The page `stages = true` (the shell's unsaved count and
  leave dialog cover it, shared with Settings).
- Categories: the 5 `APP_GROUPS` (`Editors & docs`, `DB & API clients`, `Git & utilities`, `Command-line & cloud`,
  `Browsers & games`) plus, in your own scope only, `Your own programs` (`Programs you added yourself (c to add or change
  them).`).
- App row: value = app id, label = name, description = `about`, keywords = id, hint `installed ` (ok, when downloaded
  into the data folder) + size (muted), checked = on after staged changes, details: `Download  ~<size> once, kept in
  C:\AgentData\tools\[apps\]<id>`, `Starts    from a terminal (on PATH)` or `from the desktop or Start > Sandbox apps`,
  `Graphics  OpenGL on the CPU (Mesa) is added for it` (needs mesa), the warning `Needs full git access (Settings >
  Projects & setup > Git): it pushes with its own git.` (`fullGitOnly`), `Setting   <setting>` (setting-backed entries).
- A project scope cannot change entries with a `setting` (`entries()` leaves them out).
- Own scope only: the disabled row `Request an app…` (value `@request-app`, hint `press r`, description `Not in the
  list? Press r: your browser opens a prefilled request on GitHub (<ISSUES_URL>).`) and one disabled, checked row per own
  program (value `@custom:<id>`, hint `command line` / `desktop`, description `From the latest <github> release.` or
  `From <url>`, disabled `Your own programs are always installed; c to change or remove them.`).
- Keys: `c` your own programs (own scope only; opens the `ValueEditor` on `apps.custom`, path `Apps > Your own
  programs`, staged), `r` request an app (notice `✓ Opened the request form in your browser: <url>` or `✘ <error>  Open
  it yourself: <url>`).

Menu tests to keep: `src/selftest/menu.test.ts:253-262` "the request-an-app address is a GitHub new-issue page with a
title and a body template" (`requestAppUrl()`); `menu.test.ts:838-851` "the apps are in at most 6 groups; every
catalogue category belongs to one and every app is listed" (`AppsModel.categories()`, `items(new Draft())`,
`entries()`, `APP_GROUPS`, `REQUEST_APP`); "every screen" (`menu.test.ts:1003`, draws `appsOptions`).

## Definitions to write (`apps.def.ts`)

`src/app/features/apps/apps.def.ts`. Pure: it cannot import `src/shared/apps` (lint: `shared/` is forbidden in a def,
also for types), so the run sends what the page needs. Move the pure parts of `src/cli/menu/apps.ts` here:
`APP_GROUPS` (with `members` typed as `readonly string[]` instead of `AppCategory`), `groupOf(category: string)`,
`REQUEST_APP`, `ISSUES_URL`, `requestAppUrl()` (pure string building).

```ts
export const AppsScopeSchema = z.enum(['user', 'project'])
  .describe("Your own settings (all projects) or this folder's .sandbox-config.json (this project)");

export const AppRowSchema = z.object({
  id: z.string().describe('The app'),
  name: z.string().describe('Its name'),
  about: z.string().describe('What it is for'),
  group: z.string().describe('The group it is listed under (APP_GROUPS id)'),
  size: z.string().describe('Its download size'),
  cli: z.boolean().describe('A command-line tool (on PATH), not a desktop app'),
  mesa: z.boolean().describe('Needs OpenGL on the CPU (Mesa)'),
  fullGitOnly: z.boolean().describe('Only with full git access'),
  setting: z.string().optional().describe('The setting it stands for (VS Code, Windows Terminal)'),
  installed: z.boolean().describe('Downloaded already into the data folder'),
  on: z.boolean().describe('Installed in every sandbox of this scope'),
});
export const CustomAppRowSchema = z.object({
  id: z.string().describe('Its key in apps.custom'),
  name: z.string().describe('Its name'),
  from: z.string().describe('"From the latest <repo> release." or "From <url>"'),
  cli: z.boolean().describe('A command-line tool'),
});
export const AppsListSchema = z.object({
  scope: AppsScopeSchema,
  file: z.string().describe('The file this scope edits'),
  exists: z.boolean().describe('The file exists already'),
  apps: z.array(AppRowSchema).describe('The catalogue entries this scope can change'),
  custom: z.array(CustomAppRowSchema).describe('Your own programs (your own scope only)'),
  customValue: z.unknown().describe('apps.custom as saved, to edit (your own scope only)'),
  customField: FieldSchema.optional().describe('The Field of apps.custom (your own scope only)'),
});
export type AppsList = z.output<typeof AppsListSchema>;

export const listApps = defineQuery({
  id: 'apps.list', title: 'Apps', summary: 'the apps catalogue: what every sandbox installs',
  input: z.object({ scope: AppsScopeSchema.default('user') }),
  output: AppsListSchema,
  surfaces: { except: { cli: 'apps are settings: sandbox config set apps.install / apps.custom' } },
});

export const toggleApp = defineOperation({
  id: 'apps.toggle', title: 'Install in every sandbox',
  summary: 'turn an app of the catalogue on or off for this scope',
  input: z.object({
    scope: AppsScopeSchema.default('user'),
    id: z.string().max(100).describe('The app'),
    on: z.boolean().describe('Install it (true) or not (false)'),
  }),
  output: z.object({ message: z.string().describe('What changed') }),
  text: (o) => o.message,
  surfaces: { except: { cli: 'apps are settings: sandbox config set apps.install / apps.custom' } },
});

export const setCustomApps = defineOperation({
  id: 'apps.setCustom', title: 'Your own programs',
  summary: 'change your own programs (apps.custom)',
  input: z.object({ value: z.unknown().describe('Programs of your own: a GitHub release or a download link, and the program to start.') }),
  output: z.object({ message: z.string().describe('What changed') }),
  text: (o) => o.message,
  surfaces: { except: { cli: 'apps are settings: sandbox config set apps.custom' } },
});

export const requestApp = defineOperation({
  id: 'apps.request', title: 'Request an app…',
  summary: 'open a prefilled GitHub request for an app that is not in the list',
  input: z.object({}),
  output: z.object({ url: z.string().describe('The request page') }),
  text: (o) => 'Opened the request form in your browser: ' + o.url,
  surfaces: { except: { cli: 'a request is filed on GitHub; the address is in docs' } },
});
```

The view uses **tabs like Settings** (decision: the scope is the same two-file choice, and `ViewTabs` supports it):

```ts
export function appsPage(o: AppsList): Page {
  // notice: 'Editing <file>' (+ ' (created when you save)' + the project sentence), as settingsPage does
  // one section per APP_GROUPS entry that has apps: id = group id, title = label, description = group description;
  //   items: one per app: id = app id, label = name, description = about, keywords = id,
  //   hint = (installed ? 'installed ' : '') + size, badges [{ text: 'on', tone: 'ok' }] when on,
  //   details = the Download / Starts / Graphics / full-git / Setting lines (same words as AppsModel.item),
  //   primary = action(toggleApp, { scope: o.scope, id, on: !app.on }, { label: app.on ? 'Turn off' : 'Turn on', verb: 'tick' })
  // own scope: section 'custom' titled 'Your own programs' (description as today) with the custom rows
  //   (disabled 'Your own programs are always installed; c to change or remove them.'), the section action
  //   action(setCustomApps, {}, { key: 'c', verb: 'your own programs', fields: [{ ...o.customField, name: 'value', label: 'Your own programs' }], initial: { value: o.customValue } }),
  //   and page action action(requestApp, {}, { key: 'r', verb: 'request an app' })
}

export const appsView = defineView({
  id: 'apps', title: 'Apps',
  summary: 'Tick the apps every sandbox should have. Each downloads once and is kept.',
  queries: { apps: listApps },
  operations: [toggleApp, setCustomApps, requestApp],
  tabs: { param: 'scope', choices: [{ value: 'user', label: 'All projects' }, { value: 'project', label: 'This project' }] },
  inputs: (params: { scope: 'user' | 'project' }) => ({ apps: { scope: params.scope } }),
  build: ({ apps }) => appsPage(apps),
});
```

## Run functions (`apps.run.ts`)

Node helper `src/app/features/apps/apps-rows.ts` (like `settings-rows.ts`): the row building of `AppsModel` moved out
of the menu, over an `AppsSource` that is either the saved files or the menu's draft:

```ts
export interface AppsSource {
  /** apps.install as this scope will have it (undefined: not set). */
  install(file: ConfigFile): string[] | undefined;
  /** A setting-backed entry's value (VS Code: vscode.enabled ...). */
  setting(file: ConfigFile, key: string[]): unknown;
  custom(file: ConfigFile): Record<string, { name: string; github?: string; url?: string; cli?: boolean }>;
}
export const SAVED: AppsSource = { /* reads file.valueInFile / file.userConfig() like AppsModel.savedOn */ };
export function appRows(file: ConfigFile, dataPath: string, source: AppsSource): AppRow[];   // entries(), installed(), isOn()
export function customRows(file: ConfigFile, source: AppsSource): CustomAppRow[];
```

`installed()` reads `<dataPath>\tools\vscode\Code.exe`, `<dataPath>\tools\terminal\WindowsTerminal.exe`, or
`<dataPath>\tools\apps\<id>\.agent-sandbox-app` exactly as `AppsModel.installed` does today.

- `listAppsRun(ctx, { scope })`: `const file = settingsFiles(ctx)[scope]` (from `../settings/settings.run.js`, or move
  `settingsFiles` to `settings-file.ts` and import it from both); return `scope`, `file.file`, `file.exists`,
  `appRows(file, ctx.dataPath, SAVED)`, `customRows`, and for `user` the current `apps.custom` and
  `fieldOf(file.schema.child('apps')!.child('custom')!, ['apps', 'custom'], 'Your own programs')`.
- `toggleAppRun(ctx, { scope, id, on })`: find the entry in `APPS`; unknown id or (project scope and entry has a
  `setting`) -> `fail('"' + id + '" is not an app this scope can change.', 'See the list in the menu: sandbox > Apps.')`.
  Setting-backed: `file.set(entry.setting.split('.'), on)`. Otherwise compute the new `apps.install` list (add/remove
  the id, keep order) and `file.set(['apps', 'install'], list)`; for your own file an empty list is written as
  `undefined` (back to the default), for a project the list is written even when empty (same rule as `stageTicks`).
  A `{ problems }` outcome -> `fail('Could not change apps.install: ' + problems.join('; '), 'Nothing was written.')`.
  Message: `<name> is installed in every sandbox.` / `<name> is no longer installed.` (+ ` (it was already)` when the
  outcome is `'unchanged'`). New texts: no test asserts them.
- `setCustomAppsRun(ctx, { value })`: like `setSettingRun` for key `apps.custom` in your own file: `node.check(value)`
  -> on a problem `fail('That does not work for apps.custom: ' + problem, allowedText(node))`; `file.set`. Message
  `Your own programs are saved.` A project scope never reaches it (the action is only on the user tab).
- `requestAppRun()`: `const url = requestAppUrl(); openIssuePage(url)` (from `src/host/web/index.js`); on a throw
  `fail(errMsg(e), 'Open it yourself: ' + url)`. It opens the browser **on this PC**; the web server is loopback-only,
  so that is the browser the person is using.

No questions are asked; toggling is not dangerous.

## Registration and wiring

- `index.ts` barrel; `defs.ts`: import from `./apps/apps.def.js`; `toggleApp`, `setCustomApps`, `requestApp` in
  `OPERATIONS`, `listApps` in `QUERIES`, `appsView` in `VIEWS`; `NAV`: `{ label: 'Apps', view: 'apps' }` (top level;
  replaces the `elsewhere`). `registry.ts`: the four runs. `menu/views.ts`: `{ view: appsView, section: 'Apps' }`.
- **The menu keeps staging** (the same deviation as Settings, see shared-core.md "Deviations"): `AppsPage` keeps its
  tabs, `multi`/`enterTicks`, `afterKey` staging, the shared `Draft` and Ctrl+S. What changes: it gets its rows from
  the feature: `appRows(file, dataPath, draftSource(draft))` and `customRows(...)`, where `draftSource` is the
  draft-aware `AppsSource` (staged value when `draft.has(file, key)`, else saved; as `AppsModel.isOn` does), and
  turns them into `ListItem`s (same values, labels, hints with `Theme`, details, `checked: row.on`, categories from
  `APP_GROUPS`). `stageTicks` moves to `apps-rows.ts` unchanged (it is Node-side and staging-specific). Key `c` runs
  `MenuOperations.perform` of the page's `setCustomApps` action? **No**: in the menu `c` must stage (Ctrl+S saves),
  so keep the `ValueEditor` + `draft.stage` code; key `r` runs `this.operations.perform(action(requestApp, {}), ['Apps'])`
  (the notice then comes from `text()` / the fail fix: `✓ Opened the request form in your browser: <url>`).
- So the parity is reached by `MENU_VIEWS` listing `appsView` (its `operations` include all three), while the menu's
  toggling stays the draft's job. Say this in the file header comment of `apps-page.ts`.

## Web page

`/v/apps` with the two tabs. One card per group, each app a row with its size, an `on` badge and a click that turns it
on or off (writes at once through `apps.toggle`; the list reloads after each action). "Your own programs" card (own
scope) with its rows and a "Your own programs" button opening the `apps.custom` Field: a `map` Field, which
`FieldInput` shows as JSON today (no map editor on the web yet; that is acceptable here, do not write a one-off form).
"Request an app…" header button. Works at 360 px (cards stack).

## Delete or shrink afterwards

- `src/cli/menu/apps.ts`: move `APP_GROUPS`, `groupOf`, `REQUEST_APP`, `ISSUES_URL`, `requestAppUrl` to `apps.def.ts`
  and `AppsModel`'s row logic + `stageTicks` to `apps-rows.ts`; delete the file when nothing is left (`appsSummary`,
  `appLabel`: grep for users; none outside the file today, delete them if still unused).
- `apps-page.ts`: delete `request()` and the `openIssuePage` import.
- Update imports in `src/selftest/menu.test.ts:16` and `src/selftest/menu-screens.ts:7,9` to the new places (output
  moved, not changed); keep the checks' meaning. If `AppsModel` is gone, rewrite "the apps are in at most 6 groups"
  over `appRows`/`APP_GROUPS` with the same assertions and the same check name.

## Tests

Keep passing: `menu` (the three checks above), `app`, `layout`, `config` (apps settings validation).

Add to `src/selftest/app.test.ts`, `t.section('apps')`, with a temp context (`loaded: { configPath: <temp
config.json> }`, `options: { workspace: t.dir('app-apps', 'project') }`, `dataPath: t.dir('app-apps', 'data')`):

1. "apps: turning an app on writes apps.install, off removes it": `runDefinition('apps.toggle', ctx, { id: <a
   catalogue id without setting>, on: true }, fakeIO().io)` -> the config file contains the id; `on: false` -> not.
2. "apps: a project cannot change VS Code": `t.throws(() => runDefinition('apps.toggle', ctx, { scope: 'project', id:
   'vscode', on: false }, ...), 'is not an app this scope can change', ...)`.
3. "apps: the list marks downloaded apps installed": write `<data>\tools\apps\<id>\.agent-sandbox-app`, then
   `readQuery(listApps, ctx, { scope: 'user' })` has `installed: true` for it and every row's `group` is an
   `APP_GROUPS` id.
4. "apps: the page has a card per group and the own-programs actions only in your own scope": `appsPage(...)` with a
   hand-made `AppsList`; `pageActions` contain `apps.setCustom` and `apps.request` for `user`, not for `project`.

Never call `apps.request` in a test (it opens a browser; `openIssuePage` refuses in the self-test anyway).

## Pitfalls

- **Two writers of the same files.** The menu stages into the shared `Draft`; the web writes at once. Do not make the
  menu write immediately (users expect Ctrl+S) and do not make the web stage.
- **A project file may list only catalogue apps** and cannot change setting-backed entries (`NEVER_LOOSER`, CLAUDE.md:
  a repo's `.sandbox-config.json` may only tighten). `setCustomApps` must refuse the project scope
  (`fail('Your own programs are set in your own settings only.', 'Switch to All projects.')`) even though the page
  never offers it there.
- **No imports of `src/shared/apps` in the def** (types included).
- **`openIssuePage` only accepts GitHub new-issue addresses**; do not pass anything else.
- Keys `c` and `r` stay; `l` is refresh.

## Checklist

1. `apps.def.ts` (+ the moved pure helpers), `apps-rows.ts`, `apps.run.ts`, `index.ts`; register in `defs.ts`,
   `registry.ts`, `menu/views.ts`, `NAV`.
2. `apps-page.ts` reads rows from `apps-rows.ts`, `r` through `MenuOperations`; move/delete `menu/apps.ts`; fix test
   imports.
3. Run ([commands](00-worked-example.md#commands-to-run)):
   ```
   npm run build
   npm run lint
   npm run format:check
   npm test -- app,menu,config,layout
   npm test
   ```
   Gate on `ALL TESTS PASSED`; check [common mistakes](00-worked-example.md#common-mistakes) and write the run tests as
   in [writing a run test](00-worked-example.md#writing-a-run-test).

## Report template

```
Area 6 (apps) — branch web-ui/apps
Moved: menu/apps.ts -> app/features/apps/{apps.def.ts, apps-rows.ts}; <...>
Deleted: <...>
CLI: none (exempt: apps are settings)
Menu: rows/keys/staging unchanged: <yes/no; list differences>
Web: /v/apps with tabs; own programs edited as JSON (map Field)
Tests added: <names>; tests changed (imports moved): <names>
npm test: ALL TESTS PASSED <yes/no>; parity gaps: <none/list>
Unsure / left undone: <...>
```
