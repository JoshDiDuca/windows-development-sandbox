# 02 · Projects

Read [00-worked-example.md](00-worked-example.md) first. Do area 01 (agents) before this one. This area also adds
**nested web navigation** (decision D1), which later areas (Maintenance children) reuse.

## What it does today

`sandbox projects` lists the projects a sandbox can open without a restart and changes them: remember/forget a
project, include/exclude it, map all projects at every start, and project roots. The menu shows the same as the
**Projects** category of the Sandbox section (add root, remove root, forget project).

## Files today

| Path | What it does |
| --- | --- |
| `src/cli/commands/projects/projects.ts` | The command: `list` (text or `--json`), `choose` (an `@inquirer/prompts` checkbox), `add`, `remove`, `include`, `exclude`, `all`, `roots`; `folderOf()` asks "Which folder?" when the folder was left out; `runningNote()`; constant `NEXT_START`. |
| `src/cli/services/projects-service.ts` | `ProjectsService`: `settings()`, `rows()`, `list()`, `add`, `forget`, `exclude`, `include`, `setAll`, `addRoot`, `removeRoot`, `choose(rows, picked)`, private `checkFolder` (fails for a missing folder, a drive, unsafe folders). Types `ProjectRow`, `ProjectSettings`, `ProjectsListing`. Keep it; the feature calls it. |
| `src/cli/validate.ts` | `validateProjectsArgs(args, canAsk)` (unknown action, `Which folder?` without a terminal, `all` on/off, `roots` list/add/remove). Runs before every handler from `validateOptions`. **Keep it** (it is command-line parsing). |
| `src/cli/manifest.ts` | The `projects` entry (below). |
| `src/cli/commands/registry.ts` | `HANDLERS.projects`. |
| `src/cli/menu/pages/sandbox-page.ts` | Category `projects` of the Sandbox page: rows `@add-root`, `root:<folder>`, `project:<folder>`; keys `a`/`f`; `addRoot()` (the path picker), `forget()` (confirm, then `removeRoot` or `forget`). |
| `src/cli/menu/command-fields.ts`, `src/cli/menu/command-form.ts` | The menu's command form treats the `projects` `value` argument as a folder for add/remove/include/exclude (`argPathKind`). Unchanged: the manifest entry stays. |
| `src/cli/commands/projects/here.ts` | `hereDir(ctx)` = `path.resolve(ctx.options.workspace ?? process.cwd())`. Not part of this area; used by it. |
| `web/src/shell/Shell.tsx`, `src/app/features/defs.ts` (`NAV`, `NavSection`) | The web navigation (flat today). |

## CLI surface to keep

The manifest entry stays **hand-written** (it keeps `args`, `examples`, `json` and the `--yes` option); every action
becomes an `action` of it, so `withActions()` adds them to the first argument's choices. Today's entry:

- `name: 'projects'`, `summary: 'the projects a sandbox can open without a restart: list, choose, roots, all/exclude'`,
  `group: 'Projects & accounts'`, `json`.
- args: `action` (choices `list, choose, add, remove, include, exclude, all, roots`), `value` (`when: ['add', 'remove',
  'include', 'exclude', 'all', 'roots']`), `folder` (`when: 'roots'`).
- options: `--yes` / `-y`, `'do not ask before removing'`, `when: 'remove'`, `noMenu`.
- examples: `sandbox projects`, `sandbox projects add .`, `sandbox projects roots add C:\code`.

**Important:** `withActions()` does **not** add an action definition's `flags` or `yes` to the manifest; it only adds
the action to the choices and `json`. So the `--yes` option must stay in the hand-written entry. `cliIO` reads
`options.yes` for every confirmation, so it still works.

Outputs (exact, keep them in `text()` / `io.log`):

| Command | Prints |
| --- | --- |
| `projects` / `projects list` | `All projects: on (every project below is mapped at every start, except excluded ones)` or `off`, dim `   sandbox projects all on|off`; `Roots: <a, b>` or `none (sandbox projects roots add <folder>)`; with no rows `No projects yet: start one with sandbox claude in its folder.`; else a table `'', FOLDER, AT START, RUNNING SANDBOX` (AT START = `root` / `excluded` / `mapped` / `-`), then `* = this folder.  Choose with: sandbox projects choose` |
| `projects list --json` | `{ all, roots, exclude, projects: ProjectRow[] }` (`folder, here, known, root, excluded, mappedAtStart, running`) |
| `projects choose` | no rows: `No projects to choose from yet (projects in a root are always mapped with it). Start one with sandbox claude in its folder.`; no terminal: fail `sandbox projects choose needs an interactive terminal.` / `Use sandbox projects include|exclude <folder> instead.`; done: `<n> project(s) mapped at every start, <m> excluded. ` + NEXT_START + runningNote |
| `projects add <f>` | `Added <dir> to your projects.` (+ ` ` + NEXT_START when all is on); when all is off, `Next: sandbox projects all on   (map every project at every start)` (`nextStep`) |
| `projects remove <f>` | `Removed <dir> from your projects (nothing in the folder was touched).` or `<dir> was not in your projects.` |
| `projects include|exclude <f>` | `Included <dir>. ` / `Excluded <dir>. ` + NEXT_START, or `Nothing changed.`; include with all off adds ` Mapping all projects is off: sandbox projects all on maps your projects at every start.`; + runningNote when changed |
| `projects all` | `Mapping all projects at every start is on.` / `off.` |
| `projects all on|off` | `Mapping all projects at every start is <v>. ` + NEXT_START + (on: ` Every agent in the sandbox can then see all of those projects.`) + runningNote |
| `projects roots [list]` | one root per line, or `No project roots. Add one: sandbox projects roots add <folder>` |
| `projects roots add <f>` | `Added the project root <dir>: every project in it (also new ones) opens without a restart. Every agent in the sandbox can see all of them. ` + NEXT_START + runningNote, or `<dir> is a root already.` |
| `projects roots remove <f>` | `Removed the project root <dir>. ` + NEXT_START, or `<dir> was not a root.` |

`NEXT_START` = `This changes what is mapped from the next start.`; runningNote (only while a sandbox runs) =
` The running sandbox keeps what it has; start a project in it (sandbox claude there) and it joins without a restart when it can, or you are offered one.`
Service failures (keep, they come from `ProjectsService.checkFolder`): `The folder <dir> does not exist.` / `Check the
path.`; `A whole drive cannot be <what>: <dir>` / `Use the folder that holds your projects, e.g. F:\Code.`.
Unknown action (handler): `Unknown projects action "<a>".` / `Use: sandbox projects list | choose | add | remove | include | exclude | all | roots`.
Exit code 0 for everything above, 1 for a fail or a declined question (`Nothing changed.`).

Tests that assert this today: `src/selftest/projects.test.ts:560` "`sandbox projects` rejects an unknown action,
and `add` needs a folder" (`validateProjectsArgs`: `'projects action'`, `'Which folder'`) — unchanged, because
`validate.ts` stays. `src/selftest/menu.test.ts:738` "choices and paths are told apart: on/off for projects all,
folders and files for the rest" (uses `commandSpec('projects')`, which stays). No test asserts the list's text.

**Decided text changes** (allowed, like `status` in shared-core.md "As built"): `projects list` prints its page
through `printPage`, so `All projects: on (...)` becomes the aligned fact row `All projects  on (...)` and `Roots:`
likewise; the folder column is no longer shortened to the terminal width. `projects choose` without a terminal fails
with the checklist's generic `Cannot ask here (no terminal).` / `Run it in a terminal, or give the value on the
command line.` (a `ChecklistQuestion` has no `noTerminal`). Everything else word for word.

## Menu surface to keep

Sandbox section, category **Projects** (`CATEGORIES` in `sandbox-page.ts`, description `Project roots (folders of
projects, opened without a restart) and the projects started before.`):

- `@add-root` "+ Add a project root…", section `Project roots`, Enter label `choose folder`, opens the path picker
  "Choose the folder that holds your projects" (about: `Every project inside it (also new ones) opens without a
  restart. Every agent in the sandbox can see them.`, check `That folder does not exist.`).
- `root:<folder>` (label shortened in the middle to 60, hint `root`, section `Project roots`, description `Every
  project in this folder (also new ones) opens without a restart. f removes the root.`).
- `project:<folder>` (section `Projects`, hint = running / `in a root` / `excluded` / `mapped` / `-`, details `At
  start   ...` and `In sandbox ...`, description `This is the folder you started the menu in.` for this folder).
- Keys (`sandboxActions('projects')`): `a` "add root", `f` "remove root" (on `root:`), `f` "forget project" (on
  `project:`), `l` "refresh"; all importance 1 except refresh 3.
- `f` asks: `Remove the root <name>?` / `Forget <name>?`, lines `Its projects are no longer opened without a
  restart.` or `The project is dropped from your list of projects.`, then `Nothing in <folder> is touched.`, buttons
  `Remove` / `Forget`, danger.

Row values (`@add-root`, `root:`, `project:`) must stay: `menu.test.ts:827` checks `@add-root` in the stopped sandbox.
The menu's notices become the operations' `text()` (the CLI sentences above): a decided change, no test asserts them.

## Definitions to write (`projects.def.ts`)

Input field names end in `Folder` on purpose: `pathKindOf()` (`src/app/kernel/fields.ts`) makes a key ending in
`Folder` a folder Field, so the menu's editor is the path picker and the web's input a path field, with no new code.

```ts
// src/app/features/projects/projects.def.ts
import { z } from 'zod';
import { action, defineOperation, defineQuery, defineView, fieldsOf, type Field, type Item, type Page } from '../../kernel/index.js';

export const ProjectRowSchema = z.object({
  folder: z.string().describe('The project folder on this PC'),
  here: z.boolean().describe('The folder you are in is inside it'),
  known: z.boolean().describe('Started with this tool before'),
  root: z.string().nullable().describe('The project root it is in, if any'),
  excluded: z.boolean().describe('Excluded from the projects mapped at every start'),
  mappedAtStart: z.boolean().describe('Mapped at every start'),
  running: z.string().nullable().describe('Its name and how it got into the running sandbox, if it is there'),
});
export const ProjectsListSchema = z.object({
  all: z.boolean().describe('Every project is mapped at every start (except excluded ones)'),
  roots: z.array(z.string()).describe('Folders of projects, each opened without a restart'),
  exclude: z.array(z.string()).describe('Folders left out of the projects mapped at every start'),
  projects: z.array(ProjectRowSchema).describe('Every project worth listing'),
});
export type ProjectsList = z.output<typeof ProjectsListSchema>;
const Message = z.object({ message: z.string().describe('What happened') });
const FolderText = (what: string) => z.string().optional().describe(what + ' (. = this folder; asked when left out)');

export const listProjects = defineQuery({
  id: 'projects.list',
  title: 'Projects',
  summary: 'list your projects, roots and the all-projects setting',
  input: z.object({}),
  output: ProjectsListSchema,
  cli: { name: 'projects', action: 'list', json: true }, // --json prints the output as is: the old shape
});
export const chooseProjects = defineOperation({
  id: 'projects.choose', title: 'Choose the projects mapped at every start…',
  summary: 'tick the projects mapped at every start; the rest are excluded',
  input: z.object({}), output: Message, text: (o) => o.message,
  cli: { name: 'projects', action: 'choose' },
});
export const addProject = defineOperation({
  id: 'projects.add', title: 'Add a project…', summary: 'remember a project folder',
  input: z.object({ projectFolder: FolderText('The project folder') }), output: Message, text: (o) => o.message,
  cli: { name: 'projects', action: 'add', positional: ['projectFolder'] },
});
export const removeProject = defineOperation({
  id: 'projects.remove', title: 'Forget project', summary: 'forget a project (nothing in the folder is touched)',
  input: z.object({ projectFolder: FolderText('The project folder') }), output: Message, danger: true,
  text: (o) => o.message, cli: { name: 'projects', action: 'remove', positional: ['projectFolder'] },
});
export const includeProject = defineOperation({ id: 'projects.include', title: 'Include', summary: 'map a project at every start again',
  input: z.object({ projectFolder: FolderText('The project folder') }), output: Message, text: (o) => o.message,
  cli: { name: 'projects', action: 'include', positional: ['projectFolder'] } });
export const excludeProject = defineOperation({ id: 'projects.exclude', title: 'Exclude', summary: 'leave a project out of the projects mapped at every start',
  input: z.object({ projectFolder: FolderText('The project folder') }), output: Message, text: (o) => o.message,
  cli: { name: 'projects', action: 'exclude', positional: ['projectFolder'] } });
export const allProjects = defineOperation({
  id: 'projects.all', title: 'Map all projects at every start', summary: 'map every project at every start, or not',
  input: z.object({ state: z.enum(['on', 'off']).optional().describe('on or off (left out: say which it is)') }),
  output: Message, text: (o) => o.message, cli: { name: 'projects', action: 'all', positional: ['state'] },
});
export const projectRoots = defineOperation({
  id: 'projects.roots', title: 'Project roots', summary: 'list, add or remove project roots',
  input: z.object({
    change: z.enum(['list', 'add', 'remove']).default('list').describe('list, add or remove'),
    rootFolder: z.string().optional().describe('(add, remove) the folder that holds your projects'),
  }),
  output: Message, text: (o) => o.message,
  cli: { name: 'projects', action: 'roots', positional: ['change', 'rootFolder'] },
});
```

Notes:

- `roots` stays **one** operation because the command line has `projects roots add <folder>` and `definitionFor()`
  (`src/cli/operations/input.ts`) matches only the first positional against `action`. Do not change that function.
- Folder fields for actions (pure): `const rootField = fieldsOf(projectRoots.input).find((f) => f.name === 'rootFolder')!`
  and the same for `projectFolder` (check `rootField.kind === 'path'` in a test).
- The view (`projectsPage(o: ProjectsList): Page`), item ids exactly as the menu's today:
  - section `settings` (title `Projects`): fact `all` "All projects" = `on (every project below is mapped at every start, except excluded ones)` / `off`; fact `roots` "Roots" = joined roots or `none (sandbox projects roots add <folder>)`; section action `action(allProjects, { state: o.all ? 'off' : 'on' }, { label: o.all ? 'Stop mapping all projects' : 'Map all projects at every start' })`; note `sandbox projects all on|off` with `only: 'cli'`.
  - section `roots` (title `Project roots`): first item `{ id: '@add-root', label: '+ Add a project root…', description: <the menu's>, primary: action(projectRoots, { change: 'add' }, { verb: 'choose folder', fields: [rootField] }) }`, then per root `{ id: 'root:' + r, label: r, hint: 'root', description: <the menu's>, actions: [action(projectRoots, { change: 'remove', rootFolder: r }, { key: 'f', verb: 'remove root', importance: 1 })] }`; page action `action(projectRoots, { change: 'add' }, { key: 'a', verb: 'add root', importance: 1, fields: [rootField] })`.
  - section `projects` (title `Projects`, `columns`: `here ''`, `folder FOLDER`, `atStart AT START`, `running RUNNING SANDBOX`, `columnsOn: 'all'`): per row `{ id: 'project:' + p.folder, label: p.folder, marked: p.here, hint: <the menu's hint>, details: ['At start   ' + atStart, 'In sandbox ' + (p.running ?? '-')], cells: {...}, actions: [action(removeProject, { projectFolder: p.folder }, { key: 'f', verb: 'forget project', importance: 1 }), p.excluded ? action(includeProject, { projectFolder: p.folder }) : action(excludeProject, { projectFolder: p.folder })] }`; notes `* = this folder.  Choose with: sandbox projects choose` (`only: 'cli'`) and, with no rows, `No projects yet: start one with sandbox claude in its folder.`.
  - page actions also: `action(chooseProjects, {}, { label: 'Choose…' })` (no key), `action(addProject, {}, { fields: [projectField] })` (no key).
- `projectsView = defineView({ id: 'projects', title: 'Projects', summary: 'The projects a sandbox opens without a restart: roots, your projects, all or chosen.', queries: { projects: listProjects }, operations: [chooseProjects, addProject, removeProject, includeProject, excludeProject, allProjects, projectRoots], build: ({ projects }) => projectsPage(projects) })`.
  Because the view shows only `listProjects`, `sandbox projects list` prints this page (see `printOutput`).

## Run functions (`projects.run.ts`)

All over `new ProjectsService(ctx)`. Keep `NEXT_START` and `runningNote()` (moved here from `projects.ts`).

- `listProjectsRun` -> `service.list()`. No questions.
- `chooseProjectsRun`: `rows = service.rows().filter((r) => !r.root)`; none -> return the "No projects to choose
  from yet ..." message; else `io.checklist({ title: 'Projects mapped at every start, so they open without a restart (every agent in the sandbox can see them):', choices: rows.map((r) => ({ value: r.folder, label: r.folder + (r.here ? '  (this folder)' : '') })), checked: rows.filter((r) => all && !r.excluded).map((r) => r.folder) })`;
  undefined -> `cancelled()`; `service.choose(rows, picked)`; the old message.
- A shared helper `folderOf(ctx, io, given)` (replaces the command's): given -> `path.resolve(given)`; missing ->
  `io.choose({ title: 'Which folder?', choices: [{ value: hereDir(ctx), label: 'This folder (' + hereDir(ctx) + ')' }, ...service.rows().filter((r) => !r.here).map((r) => ({ value: r.folder, label: r.folder }))] })`;
  undefined -> `cancelled()`. (On the CLI without a terminal `validateProjectsArgs` has already failed with
  `Which folder?`.) Choices are absolute paths, never `.`.
- `addProjectRun`: `dir = service.add(folder)`; message `Added <dir> to your projects.` (+ NEXT_START when all is on);
  when all is off `io.log('Next: sandbox projects all on   (map every project at every start)', 'muted')` before
  returning (that is what `nextStep` printed).
- `removeProjectRun`: `io.confirm({ title: 'Forget ' + basename + '?', lines: ['The project is dropped from your list of projects.', 'Nothing in ' + dir + ' is touched.'], yes: 'Forget', danger: true, implied: true })`
  (the CLI never asked; the menu did); no -> `cancelled()`; `service.forget(dir)`; the old messages.
- `includeProjectRun` / `excludeProjectRun`: the `includeOrExclude` texts exactly.
- `allProjectsRun`: no state -> the "is on/off." message; else `service.setAll(state === 'on')` and the long message.
- `projectRootsRun`: `list` -> roots joined with `\n`, or the "No project roots" line; `add`/`remove` without
  `rootFolder` -> `fail('Which folder?', 'Usage: sandbox projects roots ' + change + ' <folder>')` (the text of
  `validateProjectsArgs`); `add` -> `service.addRoot(rootFolder)` and its message; `remove` ->
  `io.confirm({ title: 'Remove the root ' + basename + '?', lines: ['Its projects are no longer opened without a restart.', 'Nothing in ' + dir + ' is touched.'], yes: 'Remove', danger: true, implied: true })`,
  no -> `cancelled()`, then `service.removeRoot` and its message.

None of these need a running sandbox or `useSharedSandbox`: they change your own settings and project list. (`forget`
also unregisters a project from your running sandbox; it never acts on another user's.)

## Registration and wiring

1. Barrel `src/app/features/projects/index.ts`; `defs.ts` (`./projects/projects.def.js`): the seven operations in
   `OPERATIONS`, `listProjects` in `QUERIES`, `projectsView` in `VIEWS`; `registry.ts`: the eight runs.
2. `MENU_VIEWS`: `{ view: projectsView, section: 'Sandbox' }`.
3. CLI: `HANDLERS.projects` shrinks to the no-action case:
   `projects: (ctx) => definitionHandler(listProjects)(ctx)` (import `definitionHandler` from `../operations/index.js`
   and `listProjects` from the feature barrel; `registry.ts` already imports the core). `projects <action>` is
   dispatched by `operationHandler` before `HANDLERS`. An unknown action never reaches here (`validateProjectsArgs`).
   Delete `src/cli/commands/projects/projects.ts` and its export from `src/cli/commands/projects/index.ts`.
4. Menu `sandbox-page.ts`: `SandboxModel.projects` becomes the `projects.list` output (`readQuery(listProjects, ctx)`
   in `load()`); the Projects rows come from
   `menuView(projectsPage(m.projects), { category: 'projects', refresh: false })` (no prefix: the row values stay
   `@add-root`, `root:...`, `project:...`; the status rows are prefixed `status:` so nothing clashes). The key bar for
   `projects` = that view's `actions` + `REFRESH`. In `act()`: `const view = this.category === 'projects' ?
   projectsView(model) : this.category === 'status' || this.category === undefined ? statusView(model) : undefined`,
   then `view?.resolve(result)` -> `perform`. Delete `addRoot()`, `forget()`, `ADD_ROOT`, the projects part of
   `sandboxActions` and `enterLabel`, and `this.projects` (ProjectsService).
5. Web navigation (D1), below.

### D1: nested navigation (exact changes)

`src/app/features/defs.ts`:

```ts
export interface NavSection {
  readonly label: string;
  /** The view this entry opens (an entry has a view, or children, or says where the area is). */
  readonly view?: ViewId;
  /** Where the area is today when it has no view yet. */
  readonly elsewhere?: string;
  /** Entries under this one (Sandbox: Status, Projects). */
  readonly children?: readonly NavSection[];
}

/** Every entry of the navigation, children included, in order. */
export function navSections(nav: readonly NavSection[]): NavSection[] {
  return nav.flatMap((n) => [n, ...navSections(n.children ?? [])]);
}

/** Every view the web's navigation opens. */
export function navViews(nav: readonly NavSection[]): ViewId[] {
  return navSections(nav).flatMap((n) => (n.view ? [n.view] : []));
}
```

and in `NAV`: `{ label: 'Sandbox', children: [{ label: 'Status', view: 'sandbox' }, { label: 'Projects', view: 'projects' }] }`.

`src/selftest/app.test.ts` (import `navSections`, `navViews` from `../app/features/defs.js`):

```ts
const webViews = navViews(NAV).map((id) => viewById(id)!);
...
navSections(NAV).every((n) => n.view !== undefined || (n.children?.length ?? 0) > 0 || Boolean(n.elsewhere)),
```

(replacing `NAV.flatMap((n) => (n.view ? [viewById(n.view)!] : []))` and `NAV.every((n) => n.view !== undefined ||
Boolean(n.elsewhere))`; the check names stay the same).

`web/src/shell/Shell.tsx`: move the body of the `NAV.map(...)` callback into a function
`renderSection(section: NavSection): ReactNode` (import the type from defs). When `section.children?.length`, return
`<NavLink key={section.label} label={section.label} leftSection={<SectionIcon size={18} stroke={1.6} />}
childrenOffset={28} defaultOpened={navViews(section.children).includes(active as never)}>{section.children.map(renderSection)}</NavLink>`;
otherwise the existing link/tooltip code. Children get no icon (`leftSection` only when `ICONS[section.label]` exists,
or keep `IconBox`: either is fine; say which). Check at 360 px: the burger menu shows the nested entries.

## Web page

Sandbox > Projects (`/v/projects`): a card "Projects" with the two facts and a "Map all projects at every start" /
"Stop mapping all projects" button; a card "Project roots" with "+ Add a project root…" (a form with the folder field)
and a "Remove root" button per root (confirmation modal); a table of projects (FOLDER, AT START, RUNNING SANDBOX) with
"Forget project" and "Include"/"Exclude" per row; header buttons "Choose…" (checklist modal) and "Add a project…".

The folder field is a plain text field on the web until area 5 (storage) adds the folder browser (D2): no reordering
is needed, because `io.path` and path Fields already work as text. Tell users in the help text to type a full path:
`ProjectsService` resolves a relative path against the server's working folder, which is not the browser user's.

## Delete or shrink afterwards

- `src/cli/commands/projects/projects.ts` (and its line in `src/cli/commands/projects/index.ts`).
- In `sandbox-page.ts`: `addRoot`, `forget`, `ADD_ROOT`, the projects rows, the projects keys; `ProjectsListing` import.
- Keep: `ProjectsService`, `validateProjectsArgs`, the manifest `projects` entry, `command-fields.ts`.

## Tests

Keep passing: the `projects` suite (all of it; it tests the host side, `validateProjectsArgs` and `describeSessions`),
`menu` ("with no sandbox running, Sandbox offers to start one (Status and Databases) instead of dead rows" at
`menu.test.ts:829`, which needs `@add-root`; "choices and paths are told apart ..."), `menu-perf` and the "every
screen" overflow checks (`menu-screens.ts:309` draws the `projects` category: update its fixture at
`menu-screens.ts:157` to the `projects.list` output shape), `app`, `web`, `live-projects`.

Add (in `app.test.ts`, `t.section('projects')`):

- "projects: the menu's row values and keys stay (@add-root, root:, project:; a, f, f)" — `menuView(projectsPage(sample), { category: 'projects', refresh: false })`: values and `actions` keys `a`, `f`, `f` with the right `applies`.
- "projects: the folder fields are folder pickers" — `rootField.kind === 'path' && rootField.pathKind === 'dir'`.
- "projects list prints the facts, the table and the cli notes" — `pageLines(projectsPage(sample))` contains `FOLDER`, `AT START`, `* = this folder.  Choose with: sandbox projects choose`.
- "projects roots add and remove change your settings" — temp config file and storage folder (`t.dir`), ctx like the settings checks plus `storageRoot`, `loaded.config.projects`, `loaded.base` (read `ProjectsService` for what it needs); `runDefinition('projects.roots', ctx, { change: 'add', rootFolder: t.dir('roots', 'code') }, quiet)` -> message starts with `Added the project root`; a second add -> `is a root already.`; remove with `fakeIO([true])` -> `Removed the project root`; remove with `fakeIO([false])` -> `Nothing changed.` (`ProjectsService` writes through `src/cli/commands/user-config.ts`, whose `configFile(ctx)` is `ctx.loaded.configPath ?? userConfigPath()`: **always set `loaded.configPath` to a temp file**, or the test writes the real settings file. `checkFolder` also reads `ctx.packageRoot` and `ctx.storageRoot`; set both to temp folders).
- "projects: a drive cannot be a root" — `'A whole drive cannot be'`.
- "the commands keep their names": `commandSpec('projects')!.args[0].choices` still lists the eight actions, and
  `definitionFor('projects', ['roots'])?.id === 'projects.roots'`, `definitionFor('projects', [])` is undefined.
- Parity: no gaps; "every view is shown somewhere, ..." passes with the nested `NAV`.

## Pitfalls

- `withActions()` ignores action hints' `flags` and `yes`; keep `--yes` in the manifest entry (see above).
- Do not add a `projects` command of its own (a hint without `action`): it would clash with the hand-written entry.
- `validateProjectsArgs` runs before your operation on the CLI. Its texts win there; your run's texts matter for the
  menu and web.
- Row values without a prefix only work because the status rows carry `status:`. Do not prefix the projects rows.
- Call `resolve()` only for the open category (00-worked-example.md, section 5).
- The sandbox view's own "Projects" section (inside Status) is the running sandbox's projects; it stays as it is.
- Your own settings only: no `useSharedSandbox`, no `requireRunning`.

## Checklist

1. `git worktree add <folder> -b web-ui/projects master` (after agents is merged).
2. Write `projects.def.ts`, `projects.run.ts`, `index.ts`; register; `MENU_VIEWS`.
3. D1: `NavSection.children`, `navSections`, `navViews`, `NAV`, `Shell.tsx`, the two lines of `app.test.ts`.
4. Shrink `HANDLERS.projects`; delete `projects.ts`; rewire `sandbox-page.ts`; update `menu-screens.ts` fixture.
5. Add the tests above; update docs/commands.md only if a line users read changed (the list's `All projects:` row).
6. `npm run build`
7. `npm run lint`
8. `npm run format:check`
9. `npm test -- app,projects,menu,menu-perf,web`
10. `npm test` -> `ALL TESTS PASSED`.
11. Commit, stop, report.

See [Commands to run](00-worked-example.md#commands-to-run), [Writing a run test](00-worked-example.md#writing-a-run-test)
and [Common mistakes](00-worked-example.md#common-mistakes).

## Report template

```
Area: 02 projects       Branch: web-ui/projects       Commit: <hash>
Build / lint / format: pass | fail (<why>)
npm test: ALL TESTS PASSED (runs: <n>)   Parity gaps for projects.*: none
Navigation: NavSection.children added; Sandbox = Status + Projects; Shell renders children (icon choice: <...>)
Moved / deleted: <files>
Text changes (decided): list facts aligned; choose without a terminal; menu notices = CLI sentences
Tests changed (moved, same words): <list>      New tests: <names>
Unsure / left undone: <list>
```
