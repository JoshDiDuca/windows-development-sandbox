# Web UI standard

How every page of the web UI looks and behaves, and how to check it. Read it with [shared-core.md](shared-core.md) and
[web-ui-tasks.md](web-ui-tasks.md): those say where the code goes; this says what the result must look like.

## The one rule

**A page of the web UI is a Page from the shared core, drawn by the one renderer** (`web/src/render/PageView.tsx`).
There is no React per area: an area that defines its view in `src/app/features/<area>/<area>.def.ts` and adds it to
`NAV` appears in the web UI, with the same look as every other page. When a page needs something the renderer cannot
show, add a *hint* to the Page model (`src/app/kernel/view.ts`) and teach the renderer, for every page at once. Never
special-case a view id in `web/`.

## Page hints (what to put in a view to get the right look)

| Hint | Use it for | The web shows | Menu and CLI |
| --- | --- | --- | --- |
| `Page.categories` | one long list split into categories (Settings) | the categories down the side, one at a time, a search over all | as before |
| `Section.cards` | things you pick from: sessions, agents, apps, accounts | a grid of cards (icon, name, badges, details, actions) | rows / table |
| `Section.columns` + `columnsOn: 'all'` | data people compare across rows: logs, audit, sizes | a table | a table |
| `Section.facts` | a status: label and value | tiles; a `tone` adds a coloured dot | label: value lines |
| `Fact.meter` | how full something is (memory, disk) | a bar under the value | the value text |
| `Item.icon` | an agent's name (`claude`), or `project`, `folder`, `database`, `session` | an avatar or icon | nothing |
| `Item.keys` | words about the menu's keys ("x deletes it.", "Enter shows ...") | nothing (the web has buttons) | after the description |
| `Item.code` | the name in files and commands (a setting's key) | small monospace under the label | nothing |
| `Item.badges` | short states (`running`, `changed`, `beta`) | pills | the hint says it |
| `Item.marked` | "the one this is about" (this folder's project) | a "this folder" badge | `*` |
| `OperationAction.inline` | an action with ONE field that is a value to change (a setting, an app on or off) | the control in place (rows, cards and category pages), saved at once | its editor |
| `Action.verb` | the first word picks the button's icon (start, stop, restart, open, edit, reset, remove, show, hide, add, new) | an icon | the key bar word |
| `Action.description` | what a button does, when the label is not enough | a tooltip | the details pane |
| `Page.empty` | what the page shows with nothing in it, and the next step | a centred card with a button | text and the command |

A `link({ kind: 'command' })` is not offered on the web (the renderer hides it): if an area's main action is only a
command link, the area is not finished.

## Writing for every surface

- Labels are short and plain ("Stop the sandbox…", not "Initiate shutdown"); `…` when the action asks something first.
- A section's `title` is a noun ("Projects"); its `summary` one short line of state ("2 folders guarded").
- `hint` is the item's state or value, not a sentence. Put explanations in `description`.
- `details` are extra lines (shown monospace); keep them `Label   value` aligned like the CLI.
- One `primary` action per item, at most two `actions` (more go behind "…" on the web: fine, but think first).
- Danger: set `danger` on the operation; the web shows it red and the operation asks through `io.confirm`.
- Notes for one surface only use `only` (`'cli'` for flag hints). The web leaves out `* = …` legends by itself.

## The look (web/src/theme.ts and app.css)

- Colours come only from the theme: Mantine colour names and the `--app-*` tokens. Tones: ok = green, warn = orange,
  danger = red, muted = grey, accent = indigo. No hex values in components.
- Type: Segoe UI Variable (Windows), Cascadia Mono for code and paths. Headings 650 weight.
- Cards: border, `lg` radius, no shadow. Rows inside a card are separated by a border line, not gaps.
- Dark and light both work; check both.
- Phone width (390 px): nothing scrolls sideways, the sidebar folds behind the burger, buttons wrap.

## States

Every page gets these from the renderer; never draw your own: a skeleton while loading (`PageSkeleton`), an error card
with what to do (`ErrorState`, from the operation's `fail(message, fix)`), the empty card (`Page.empty`), progress and
results as notifications, questions as modals (`io.confirm`, `choose`, `text`, `secret`, `path`, `checklist`). A
`path` question or Field gets the folder picker (`files.browse`).

## Check your page (required before a review)

1. `npm run build`, then `npm run web:preview` (runs in the background; the real app with sample data, settings from
   a temp file). Add sample data for your area's queries to `src/selftest/support/web-preview.ts`, made with your
   query's own output schema (`.parse(...)`), so the preview shows your page.
2. `MSYS_NO_PATHCONV=1 npm run web:shots -- <out folder> /v/<view>`, then again with `--dark` and with `--mobile`.
   Look at all three screenshots. Compare with Sessions, Sandbox and Settings: same spacing, same parts.
3. Click through it with playwright-core (`chromium.launch({ channel: 'msedge' })`, like `scripts/web-shots.mjs`):
   every button does what it says, questions appear, the page updates after an operation.
4. Put the three screenshot paths in your report.

## Review checklist (what the reviewer checks)

- No file under `web/` mentions the area (unless the area spec asked for a new hint or Field kind).
- The view uses the hints above where they fit (cards for things to pick, facts for status, `inline` for values).
- Every action works on the web (no command links left for the area's main actions).
- Screenshots: light, dark, phone; nothing cut off, nothing scrolls sideways, empty state looks right.
- `npm test` prints ALL TESTS PASSED, lint and format pass.
