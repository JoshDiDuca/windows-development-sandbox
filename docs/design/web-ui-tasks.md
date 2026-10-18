# Parity tasks: one area at a time (spec for contributors)

## Start here (instructions for the agent picking this up)

**Ask an advisor instead of guessing.** Whenever the area file does not settle something, a test fails and you do not
know why, or a change could touch security (the web server, secrets, another user's sandbox), stop and ask an advisor:
start an Agent with `model: "opus"` and a short, self-contained question (the facts, what you tried, the options you
see). Follow its answer and say so in your report. Guessing is the most common reason an area is sent back.

You are finishing the web UI by moving each area of the tool into the shared core, so the command line, the menu and
the web UI all run the same code. Work like this:

1. Work in your own git worktree of this repository, on a branch made from the latest `master`
   (`git worktree add <folder> -b web-ui/<area> master`). Never commit to `master` yourself.
2. Read, in order: `CLAUDE.md` (all of it: the hard rules, the coding standard, the Gotchas), then
   [shared-core.md](shared-core.md) (the contract, then its "As built" and "How to add a feature" sections), then
   **[areas/00-worked-example.md](areas/00-worked-example.md) (mandatory: the sessions feature built file by file, the
   commands to run and the common mistakes)**, then **[web-ui-standard.md](web-ui-standard.md) (how every web page
   must look, the Page hints that give that look, and how to check it with screenshots)**, then the rest of this file.
3. Do the areas in the table at the end of this file **one at a time, in the order of the table**, starting with
   area 1 (agents). Each area has its own spec file in [areas/](areas/): read the whole file before you change
   anything, and follow it. It names every file, flag, text, key and test of the area, the definitions to write, and
   the checklist. Where an area file and this file disagree, the area file wins (it is more specific); where an area
   file and the code disagree, stop and say so in your report.
4. An area is done only when `npm run build`, `npm run lint` and `npm run format:check` pass and `npm test` prints
   `ALL TESTS PASSED` (gate on that text, not the exit code; live tests can flake: run once more before calling a
   failure real). Do not weaken or delete tests to make them pass; if a test is wrong, say so in your report. An area
   file may tell you to replace a named test because of a decision: do exactly that and list it in the report.
5. Commit each area separately, with a clear message saying what moved where. Then **stop** and fill in the area
   file's "Report template". Wait for the review before starting the next area.
6. When something in this spec is unclear or seems wrong, do not guess: stop and say what is unclear in your report.
   Text marked "(unverified)" in an area file was not checked against the code: check it before relying on it.

The environment: you run inside a Windows Sandbox on a mapped folder, so symlinks and npm workspaces do not work,
`sed -i` leaves stray files (use your editor's file tools), and shell heredocs and `node -e` eat backslashes (write
code with file tools). Never run the self-test on a real PC, and never touch the real `~/.agent-sandbox`, the registry,
PATH or the user's profile. Inside the sandbox, `requireOnPc` refuses the commands that control a sandbox from outside
(the area files say which runs therefore cannot be exercised by the self-test and what to test instead).

## Read first

Read first, in this order: CLAUDE.md, [shared-core.md](shared-core.md) (the contract, then its "As built" and "How to
add a feature" sections), [areas/00-worked-example.md](areas/00-worked-example.md), then the three reference features
in `src/app/features/sandbox`, `src/app/features/sessions` and `src/app/features/settings`, and how the surfaces draw
them: `src/cli/menu/pages/sessions-page.ts` (a menu section that is one view), `src/cli/menu/pages/sandbox-page.ts` (a
view as one category of a section), `web/src/pages/ViewPage.tsx`. Every task below is "make this area look like the
reference features". Do one area per change; never two at once.

## Steps for every area (mechanical)

The area file spells each step out for its area; this is the shape they all share.

1. `src/app/features/<area>/<area>.def.ts`: queries, operations and the view (copy `sessions.def.ts`). Every input and
   output field has `.describe()`. Give each operation and query a CLI hint that spells the existing command exactly
   (`name`, `action` for an action of a hand-written command, `positional`, `flags` with `shownAs`/`short`, `yes`,
   `json` and `shapeJson` when the `--json` shape must stay). `text(output)` is the line the CLI prints. A def imports
   only zod, the kernel, other `*.def.ts` and `core/util/errors` (not `core/schema`, not `core/disk`).
2. `<area>.run.ts`: `implement(def, async (ctx, input, io) => ...)` over the existing services; questions through `io`
   (`implied: true` where the CLI never asked, `noTerminal` where it failed with a specific message), `cancelled()` on
   a no. Another user's sandbox: `useSharedSandbox(ctx, action, typedConfirm(io))`.
3. `index.ts` barrel; add the definitions to `src/app/features/defs.ts` (import the `*.def.ts` file, never the barrel)
   and the implementations to `src/app/registry.ts`.
4. Menu: make the area's page render the view: `menuView(page)` gives rows, keys and Enter labels, `resolve()` the
   action, `MenuOperations.perform()` runs it (see `sessions-page.ts`). A view that is one category of a page (the
   Maintenance areas, Sandbox > Projects) copies `sandbox-page.ts` and resolves keys only against the open category's
   view. Add the view to `src/cli/menu/views.ts`.
5. Web: add the view to `NAV` in `src/app/features/defs.ts` (replacing the section's `elsewhere`, or as a child of a
   section once area 2 has added `children`). Nothing else in `web/` unless the area file asks for a new Field kind,
   target or kernel addition. Use the Page hints of [web-ui-standard.md](web-ui-standard.md) (cards for things to pick
   from, facts for status, `inline` for values, `icon`, `verb`), add sample data to the web preview, and check the page
   in light, dark and phone screenshots (`npm run web:preview`, `npm run web:shots`).
6. CLI: a command that is wholly an operation loses its manifest entry and its `HANDLERS` line (the hint makes the
   command). A command with several actions, a default action or flags `withActions()` cannot carry (`data`,
   `storage`, `account`, `projects`, `vpn`, `engine`, `web`, `config`) keeps its hand-written manifest entry, its
   actions become `action` hints, and its `HANDLERS` entry shrinks to a forwarder (`definitionHandler(<def>)`) for the
   bare command. Delete the old command file and the menu code that did the work.
7. Remove `link({ kind: 'command', argv: [...] })` targets that pointed at this area from other views, and use the new
   operation instead. (`resume` belongs to no area: Sessions' "Reopen last sessions" stays a command link, see
   [01-agents.md](areas/01-agents.md). The `start-agent` target stays too: after area 1 the menu still runs `launch`
   for it, and the web runs `agents.start`.)
8. `npm test -- app` must show no parity gap; run the area's existing suites; `npm run lint`, `npm run format:check`.

## Rules (non-negotiable)

- Logic lives in `src/app/features/<area>/` only. The CLI command, the menu page and the web page render the area's
  views and call its operations; they contain no feature logic. If you find logic in `src/cli/commands/...` or
  `src/cli/menu/pages/...`, move it into the feature (or into a service it calls), then delete the old copy.
- `<area>.def.ts` is pure (zod, labels, view builders): no `node:` imports, no services. `<area>.run.ts` does the work
  through the existing services (`src/cli/services`, `src/host/*`) and talks only through `io`.
- No `console.log`, no `@inquirer`, no React or TUI imports in a feature. Errors: `fail(message, fix)`.
- Inputs and outputs are zod schemas with `.describe()` on every field (that text becomes the label/help everywhere).
- Every operation is on every surface, or declares `surfaces: { except: { <surface>: '<reason>' } }`.
- Keep behaviour: the CLI's text and flags, the menu's rows and keys stay as they are unless the area file says
  otherwise (each area file lists its deliberate changes under its decisions; report every one). The existing tests
  for that command/page must keep passing; update them only where output moved, not changed.
- Secrets (logins, tokens, the web UI's URL with its token, VPN credentials) never appear in an output schema, a log
  line or a notice.
- Web: Mantine components only (no hand-written CSS beyond `app.css` tokens); every page works at 360 px wide. A new
  kind of value is a new Field kind in `src/app/kernel/fields.ts` with its input in `web/src/render/FieldInput.tsx` and
  its editor in `src/cli/menu/settings/value-editor.ts`, never a one-off form.
- Done means: `npm run build`, `npm run lint`, `npm run format:check` pass; `npm test` prints ALL TESTS PASSED; the parity
  test shows no gap for the area; docs/commands.md updated if a command changed.

## Areas

Do them in this order. Each line: the spec file, what moves, and what the web page offers.

| # | Area | Spec | What moves | Web page |
| --- | --- | --- | --- | --- |
| 1 | agents | [01-agents.md](areas/01-agents.md) | menu/pages/agents-page.ts, menu/add-agent.ts; `POST /api/sessions` | Agents: a card per agent with Start (`agents.start`, replaces `NewSessionModal.tsx` and the endpoint), add / make default / remove |
| 2 | projects | [02-projects.md](areas/02-projects.md) | commands/projects, services/projects-service.ts, menu Sandbox > Projects | Sandbox > Projects: projects and roots; adds nested web navigation |
| 3 | accounts | [03-accounts.md](areas/03-accounts.md) | commands/accounts.ts, services/accounts-service.ts, menu/pages/accounts-page.ts | Accounts: a card per agent, actions with confirmation |
| 4 | data | [04-data.md](areas/04-data.md) | commands/data, services/data-service.ts, Maintenance > Data & storage (data part) | Maintenance > Data: sizes, clean checklist with confirmation |
| 5 | storage | [05-storage.md](areas/05-storage.md) | commands/storage, the menu's Data folder row | Maintenance > Storage: current folder, move with estimate; adds the folder browser (`files.list`) for every path question |
| 6 | apps | [06-apps.md](areas/06-apps.md) | menu/apps.ts, menu/pages/apps-page.ts (no CLI command: exempt) | Apps: grouped toggles on All projects / This project tabs, your own programs |
| 7 | health | [07-health.md](areas/07-health.md) | commands/repair, commands/setup, doctor, Maintenance > Health | Maintenance > Health: last results, check, fix |
| 8 | updates | [08-updates.md](areas/08-updates.md) | services/update-service.ts, commands/maintenance/update.ts, migrate, Maintenance > Updates | Maintenance > Updates: version, check, update, roll back, automatic on/off |
| 9 | logs | [09-logs.md](areas/09-logs.md) | services/logs-service.ts, commands/maintenance/logs.ts, Maintenance > Logs | Maintenance > Logs: list, viewer with follow (live query) |
| 10 | vpn | [10-vpn.md](areas/10-vpn.md) | commands/vpn.ts, menu/vpn-login.ts | Settings > VPN: status, login (secret questions), logout |
| 11 | engine | [11-engine.md](areas/11-engine.md) | commands/engine.ts | Maintenance > Engine: each engine's check with reasons and fixes |
| 12 | web | [12-web.md](areas/12-web.md) | commands/web.ts | none (`except: { web: 'the page is the web UI' }`); menu Maintenance > Web UI |
| 13 | settings export/import | [13-settings-export-import.md](areas/13-settings-export-import.md) | menu/share-settings.ts, commands/maintenance/config-share.ts | Settings: Export / Import page actions with the changes listed before confirming |

### Order and dependencies

The table's order works; do not reorder. Why each area must come after the ones before it:

- **1 agents first.** Sessions' "Start" and the web's New session depend on it: area 1 adds `agents.start` and deletes
  `NewSessionModal.tsx` and `POST /api/sessions`. `useRunAction` (web) learns to return an operation's output so the
  web can open the new session's terminal.
- **2 projects before every area with a web page under a parent section.** It adds `NavSection.children` and the
  `navSections()` / `navViews()` helpers in `defs.ts`, nested links in `web/src/shell/Shell.tsx`, and the matching
  change to the parity check in `app.test.ts`. Areas 4, 5, 7, 8, 9, 10 and 11 use it. Projects does **not** need the
  folder browser: its path questions are text fields on the web until area 5, then get Browse… without changes.
- **3 accounts** stays a top-level web section (no dependency on 2's nesting, but done after it). It changes
  `src/cli/operations/input.ts` so `--no-<flag>` reaches an input, and `MenuOperations.run` so a multi-line `text()`
  shows as one notice line. Area 13 relies on the second change (or makes it itself if area 3 has not landed).
- **4 data before every Maintenance area.** It turns the web's Maintenance section into a parent (children `Data` and
  a `More` entry whose `elsewhere` text later areas shorten), and adds to the kernel/CLI: `noTerminal` on
  choose/text/path/checklist questions, a list positional that takes the rest of the line, and `next(output)` for the
  CLI's dimmed `Next:` line. Areas 5, 7, 8, 9 and 11 build on these.
- **5 storage after 4.** It needs 4's `noTerminal`; it adds two-word CLI actions (`storage contained on`), `skipWithYes`
  on confirm, the `files.list` query (loopback only, folders only, bounded, links refused) with `WEB_TOOLS` in
  `defs.ts`, `web/src/render/FolderBrowser.tsx`, and `src/host/files/`. It changes `settings.def.ts` (the Data folder
  row becomes `storage.change`), so area 13 comes after it.
- **6 apps** is independent (a top-level section; all definitions are CLI-exempt).
- **7 health and 8 updates** both need a `contextOrDefaults()` helper (the commands run before the context exists when
  the settings file is broken): the first of them to land extracts it, the second reuses it; check before writing it
  twice. Area 8 adds an `onOutput` callback to `MenuOperations`.
- **9 logs** adds view parameters taken from the address, `params` on view links and a Page part for a block of log
  text; later areas may reuse them. It may also add a `bytesText` helper to the kernel (area 4 sends sizes as text
  from the run instead; do not add both).
- **10 vpn** turns the web's Settings section into a parent (Settings, VPN) and touches `settings-page.ts`, like 13.
- **11 engine and 12 web** come after 4, 7, 8 and 9 have reshaped `maintenance-page.ts` into one category view each.
  Area 11 adds `CliHint.exitCode?(output)` (in `define.ts`, used in `src/cli/operations/handler.ts`) for
  `engine check`'s exit 1.
- **13 last.** It needs 3's notice change and 5's `settings.def.ts` change, and edits the settings feature.

Files another agent was changing when these specs were written (memory and crash reporting: `src/cli/manifest.ts`,
`src/cli/commands/maintenance/logs.ts`, `src/host/life/*`, `src/cli/commands/repair/checks/pc.ts` and `sandbox.ts`):
rebase on the latest `master` first, and search for the quoted text instead of trusting line numbers there.

After all areas: remove `cli/manifest.ts` entries that became operation CLI hints, and delete any page or command file
that only forwards to a feature.
