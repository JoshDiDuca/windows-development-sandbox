# Commands

`sandbox` (also `windows-development-sandbox`) is the command. `sandbox <agent>` starts any configured agent;
`claude-sandbox`, `codex-sandbox` and `gemini-sandbox` are shortcuts. The old names `agent-sandbox`, `claude-sbx`,
`codex-sbx` and `gemini-sbx` still work for now.

`sandbox --help` lists the commands in groups: Agents, Sessions, Projects & accounts, Data, Web, Health and Advanced.
`sandbox <command> --help` shows that command's options (launch groups them: Session, Folder, Versions & services,
Trust) and some examples. A mistyped command says what you probably meant (`Did you mean: sandbox status?`), and a
mistyped action (`sandbox data clen`) lists the valid ones. Questions that need an answer ask on a terminal; in a
script they fail and say which flag answers them (`-y` / `--yes`).

## The menu

`sandbox` with no arguments opens the menu, a full-screen app. The sections are on the left (`1`-`7` jump to
one); the open section shows its categories underneath, and a mark (`✎`) shows where something is unsaved. The keyboard
is either in the list or in that navigation: `←` or `Esc` in the list moves to the navigation, where `↑` `↓` walk the
sections and their categories (each opens as you pass it), `→` or `Enter` go back into the list, and `Esc` leaves.
`/` searches all categories of a section, `Enter` opens, `Ctrl+C` leaves at once. On a narrow terminal (under 80
columns) the navigation shrinks to the numbers.

- **Agents**: *Start* lists the agents you can start here (Enter starts one; the default first, `ready` or `installs
  on first start`) after "Repeat last", and ends with **Add an agent…** (an npm or Python package, or a program on
  this PC; it is saved in your settings and appears in the list). *Options*: attach this terminal, the sandbox window,
  the folder, more start options, **several agents at once** (projects, then agents for each, then which one this
  terminal attaches to; it builds a `--session` command line) and a sandbox without an agent. *On this PC*: the
  not-sandboxed agents, while agent commands are on.
- **Sessions**: the sessions running now (Enter attaches), restart, reopen the last ones.
- **Sandbox**: status (window, stop), projects and roots, databases.
- **Apps**: the [apps catalogue](toolchains.md#apps-and-tools), for all projects or just this one.
- **Settings**: every setting, in eight categories (General, Sandbox machine, Languages & tools, Databases, Agents &
  sessions, Network, Security & privacy, Projects & setup), on two tabs: **All projects** (your own file, blue) and
  **This project** (this folder's `.sandbox-config.json`, purple; only what a project may set). `Tab` switches between
  them and keeps your place. Each setting shows its value in both, its default and its description; `Enter` edits it
  (on/off flips at once, choices are a list, text and numbers are checked as you type, lists, maps, mapped folders and
  agents get their own editors), `r` resets it. Comments and formatting in the file are kept, and nothing invalid is
  ever saved. Saving a project file does not approve it: the next launch shows what it applies and asks you to approve
  the changed file.
- **Accounts**: the saved logins of every agent.
- **Maintenance**: *Updates* (the program, and your saved settings), *Data & storage* (the data folder, what is
  stored, clean-up), *Health* (doctor, repair and setting up this PC), the logs, and the less common commands.

A command opens as a form: its arguments and options with their values, changed in place, and the exact command line
it will run at the top. **Run** runs it; the output stays until you press a key. Commands that take over the terminal
(starting an agent with `-t`, `attach`) end the menu.

## Starting

| | |
|---|---|
| `sandbox claude` | start Claude in a sandbox for this folder, in Windows Terminal inside it (also `claude-sandbox`) |
| `sandbox start` | the sandbox without an agent |
| `sandbox launch` | the same, with any `--agent` (`--harness` still works) |

Options:

| Option | |
|---|---|
| `-t, --terminal` | run in this terminal. In a running sandbox it reattaches to this folder's session if no terminal is attached to it |
| `--new` | always start a new session |
| `--headless` / `--window` | hide the sandbox window / show it even if config says headless |
| `--agent <agent>`, `--account <name>` | which agent (`--harness` is the old spelling), which Claude account |
| `--node <v>`, `--python <v>` | override the versions |
| `--workspace <dir>` | another folder instead of the current one |
| `--database <name>` | also start this database, e.g. `--database postgres,redis` (repeatable) |
| `--script <file>` | run a `.ps1`/`.mjs`/`.cmd` inside before the agent (repeatable) |
| `--no-agent`, `--trust-config`, `--no-local-config` | no agent, approve the project file, ignore the project file |
| `--session <agent>@<folder>` | several sessions at once (repeatable), e.g. `--session claude@C:\code\api --session codex@C:\code\api --session claude@C:\code\web`; one sandbox maps every folder, each session gets its own tab inside, `-t` attaches the first. Arguments after `--` go to every session; `"codex@C:codeweb|--model o3"` gives one session its own (`|` can't be in a Windows path) |
| `--yes` | restart the sandbox without asking if this folder needs it |

Anything else goes to the agent: `sandbox claude --continue`. If an agent has a flag with the same name as ours, use
`--sbx-<flag>` for ours or put the agent's flags after `--`.

## A running sandbox

| | |
|---|---|
| `sandbox attach [id]` | show a session in this terminal (`Ctrl+]` detaches); without an id it offers the sessions, this folder's project first |
| `sandbox sessions` | sessions (agents and shells), their project and who is attached (`*` = this folder's project) |
| `sandbox shell [project] [--shell pwsh\|powershell\|cmd]` | open a plain shell in this folder's project (or the one named) as a session and attach this terminal; PowerShell 7 when the sandbox has it, else Windows PowerShell. It has the project's tools and environment, not the agent's keys ([web-ui.md](web-ui.md#shells-and-closing-sessions)) |
| `sandbox close <id>` | end a session (agent or shell) and every program it started |
| `sandbox status` | the whole sandbox: the machine, then every project (its folders, setup, databases, sessions, repo-guard findings), this folder's marked |
| `sandbox db [start\|stop <name>]` | list, start or stop this folder's project's databases (`sbx-db` inside) |
| `sandbox exec -- <cmd>` | run a command in this folder inside the sandbox, with its project's tools (`--timeout`, `--workspace`) |
| `sandbox restart` | restart this folder's project's agents in place; they resume their conversation (`--all`: every project's) |
| `sandbox resume` | reopen the sessions from the last sandbox, each continuing its own conversation; starts the sandbox the way it was started if none runs. A launch does the same by itself or asks, as `resume.sessions` says. Terminal tabs you opened yourself inside the sandbox are not reopened |
| `sandbox stop` | shut down (history syncs back); asks first when other projects' sessions would end (`--yes` skips) |
| `sandbox web [start\|stop\|status\|open]` | **(Beta)** your sessions in a browser on this PC ([web-ui.md](web-ui.md)): `start` runs the server in the background (works even with `web.enabled` off, for this run), `open` starts it if needed and opens your browser already signed in, `status` (also the address on your network when LAN mode is on), `stop`. Loopback only, behind a token |
| `sandbox web lan-on\|lan-off` | **(Beta)** let devices you allow use the web UI on your own network ([remote access](web-ui.md#remote-access)): `lan-on` checks the network is Private and adds the firewall rule (Windows asks once); `lan-off` removes it and signs out every device |
| `sandbox web allow-device [--role view\|control]` | a one-time code (5 minutes) for a phone or tablet that opened the address on your network |
| `sandbox web devices [--json]`, `revoke <id>`, `revoke-all` | who may use your web UI (devices and Windows sign-ins), and signing one or everyone out |
| `sandbox remote [user] [--browser]` | **(Beta)** another Windows user's web UI from your account: the menu over their program, or `--browser`; signed in by Windows, with the role they gave you |
| `sandbox show` / `hide` | show or hide the window (`sbx-show`, `sbx-hide`); hidden, it keeps running |

Sessions can be shown in the sandbox and in your terminal at the same time, by any number of terminals. Closing a tab
or a terminal never stops a session; only the agent (or shell) exiting does, or `sandbox close`.

## Several projects

Every command above works from any project's folder and acts on that project. How a second project joins a running
sandbox, where it appears inside, and the consent prompts are explained in [projects](projects.md).

| `sandbox projects ...` | |
|---|---|
| (nothing) / `list` | the projects you have started, whether they are mapped at the start, and which are in the running sandbox |
| `choose` | tick the projects mapped at every start (turns "all projects" on; the rest are excluded) |
| `all on\|off` | map every known project at every start |
| `exclude <folder>` / `include <folder>` | leave one out of `all` / take it back |
| `add [folder]` / `remove [folder]` | add a folder to your projects / forget it (its files are never touched). Without a folder on a terminal you pick one from your known projects or this folder |
| `roots [list\|add\|remove <folder>]` | folders whose subfolders are projects, mapped at every start |

Changes to what is mapped apply from the next start.

## Updates and settings

| | |
|---|---|
| `sandbox update` | install the newest version, also while a sandbox runs (it keeps the version it started with until it restarts); `--check` only looks, `--rollback` goes back one version (names both versions and asks; `-y` skips) |
| `sandbox update --auto on\|off` | install new versions by themselves; for everyone on the PC this needs an admin terminal |
| `sandbox migrate` | bring your saved settings up to date after an upgrade (a backup is kept); `--dry-run` lists changes, `--restore <backup>` puts one back (asks first; `-y` skips) |

An npm install is updated with `npm install -g windows-development-sandbox`; `sandbox update` says so. A failed update, or one that waits for a running sandbox, prints `Error: ...` on stderr and exits 1.

With an all-users install, a sandbox another user started shows in `status` and `sessions` as "started by <name>". When
they share it, `attach`, `exec`, `db` and `stop` work (stop asks you to type their name; `--yes` in scripts); otherwise
and for `restart`, `show`, `hide` and starting your own, you are told whose it is.

## Data and maintenance

| | |
|---|---|
| `sandbox data` | what is kept between sandboxes and how big it is, and disk usage per drive |
| `sandbox data clean [targets]` | delete parts: `tools/go`, `tools`, `databases/postgres-18`, `databases`, `logs`, `launches`, `state/claude`, `all`. Without targets on a terminal you tick them from a list with sizes. Asks first; `-y` skips |
| `sandbox storage` | where your saved data is, how big, the default folder, and any other folder that holds data |
| `sandbox storage move [folder] [-y] [--keep-old]` | move your data to another folder or drive (shows size, time and a warning first); `--keep-old` copies and leaves the old folder |
| `sandbox storage use [folder] [-y]` | switch to a folder without moving anything (the new folder is used as it is). Without a folder on a terminal you pick one (or type a path) |
| `sandbox storage contained [status, on or off] [-y]` | **(Beta, not yet tried on a real PC)** keep the sandbox's tools, state and logs in one disk image (`storage.contained`). `status` (the default) shows the setting, the image and whether it is mounted. `on` makes the image (shows the size limit, asks), offers to move what you have into it (size and time first) and turns the setting on. `off` moves everything back to plain folders (size and time first), dismounts, writes the setting, and then asks before deleting the image file. Windows asks for permission to mount and to dismount (no prompt when an all-users install added the storage helper). Not inside a sandbox. See [Contained storage](configuration.md#contained-storage-beta) |
| `sandbox engine check [hcs|windows-sandbox]` | **(Alpha)** what this PC lacks for an engine (default `hcs`), in plain words with the exact commands that would fix each thing (Windows features, group membership, a base image). It only looks; it never runs them. Exit code 1 when the engine cannot be used |
| `sandbox engine leftovers [--json]` | **(Alpha)** HCS compute systems of yours that are still running after a command stopped early. Only systems this tool made for your Windows user are listed; it never builds the HCS helper to look |
| `sandbox engine clean [--yes]` | **(Alpha)** stops those HCS systems after asking, naming each one. It deletes no files and never touches Windows Sandbox, Docker, other programs or other Windows users' sandboxes. Nothing happens on a PC without HCS. Doctor shows a warning row when there is something to clean |
| `sandbox engine [--json]` | **(Alpha)** the engine that runs your sandboxes (`sandbox.engine`), and for each engine what it can do (desktop, GPU, clipboard, audio, video, printers, adding folders while it runs, attached disks, several at once, Hyper-V sockets) and whether it can be used on this PC. The `hcs` engine can be checked but not started yet |
| `sandbox clean [--days n] [-y]` | delete old launch folders, logs and leftovers (shows what and how much first, then asks) |
| `sandbox sync` | copy history back to this PC now |
| `sandbox sessions [--wide]` | the sessions; `--wide` adds each one's folder |
| `sandbox logs [-f] [--crash]` | the newest sandbox log (`-f` keeps printing new lines). `--crash` prints the report of the last crash instead: the freeze gap, blue-screen codes, hardware and memory events, crash dumps, this PC's memory log and whether vGPU was on (see [troubleshooting](troubleshooting.md)) |

## Diagnostics

`sandbox audit [--days n] [--kind proc|file|commit|session|guard] [--session id] [--agent name] [--project name] [--grep text] [--limit n] [--json]` shows the [audit log](configuration.md#audit-log): what your agents ran, changed and committed in the last `n` × 24 hours (default 1), with totals, a table of sessions and the newest events. `--session` takes a session id or its start (`none`: what no session can be linked to). The web UI shows the same on its Activity page.


| | |
|---|---|
| `sandbox setup` | check this PC (edition, virtualization, Windows Sandbox, RAM, disk, Node) and offer fixes; after turning Windows Sandbox on it offers to restart Windows (`shutdown /a` cancels). Starting a sandbox on a PC where it is off offers the same |
| `sandbox doctor [--fix] [--json]` | checks this PC, the install, your data folder, settings, the sandbox, agents and the network, one line each as it runs, and says what to do about each problem. When repair can fix some, it asks (`--fix` fixes without asking). Ends with what will be copied from this PC or downloaded. What it checks: [troubleshooting](troubleshooting.md#what-doctor-checks-and-repair-can-fix) |
| `sandbox repair [--yes] [--json]` | runs the same checks, lists what it would change, asks once (`--yes` skips that), fixes it, looks again, and writes a log of what it found and changed to `<storage>\logs\repair-<time>.log`. `--json` prints the results and changes nothing unless `--yes` is also given |
| `sandbox migrate [--dry-run] [--restore <backup>]` | bring your saved settings up to date with this version (this also runs by itself the first time a new version starts; `--restore` puts back the files saved before an update) |
| `sandbox generate` | dry run: what a launch would do, without starting anything |

## Accounts and config

| | |
|---|---|
| `sandbox account list` | Claude accounts |
| `sandbox account save <name> [--from-host]` | save the sandbox's (or this PC's) login |
| `sandbox account use [name]` / `default [name]` / `remove [name] [-y]` | switch now (Claude restarts and continues) / for new sandboxes / delete (asks first). Without a name on a terminal you pick a saved login |
| `sandbox account rename [name] [--to <new>]` | rename a saved login (asks for what is missing) |
| `sandbox account ... --agent <name>` | the same for another agent that keeps its login in a folder we can point it at (codex, gemini, copilot, crush; see `home` in the agent's settings). Default: claude |
| `sandbox config` | short summary: settings file, default agent, storage |
| `sandbox config show` / `path` / `init` / `schema` | all settings with defaults filled in as JSON / the file / create it (when it exists: open, overwrite or cancel) / editor schemas |
| `sandbox config get <setting>` / `set <setting> <value>` / `reset <setting>` | read, change or put back to its default one setting, e.g. `sandbox config set sandbox.memoryMb 8192`; a wrong value lists what is allowed; secrets show as `***` |
| `sandbox config list [--json]` | every setting with its value, by category (the same rows as the menu's and the web's Settings) |
| `sandbox config export [file] [--with-paths]` / `import <file> [-y]` | write the settings you changed (only what differs from the defaults) to a shareable `.json` (default `sandbox-settings.json`; asks before replacing a file that is there, `-y` replaces it), or read one: it shows each change as `setting: old -> new`, asks once (`-y` skips it) and writes through your settings file, keeping its comments. Secrets (API keys), the data folder (`storage.root`) and folders or files of this PC (unless `--with-paths` on export) are never written to a file and never taken from one; both commands list what they left out. Menu: Settings > General > Export settings… / Import settings… |
| `sandbox config check [--workspace <dir>]` | check a project's `.sandbox-config.json` and list what it changes, without starting anything |
| `sandbox agent-commands [status\|on\|off]` | **(Beta)** typing an agent's own command on this PC (`claude`, `codex` ...) starts it in a hidden sandbox for the folder you are in and attaches that terminal. See [agent commands](configuration.md#agent-commands-beta) |
| `sandbox vpn [status\|login\|logout]` | **(Alpha)** the VPN login (typed hidden, kept encrypted, never printed) and whether the VPN is on. `login` first prints the steps to find NordVPN's service credentials. See [vpn](vpn.md) |
| `sandbox github [status\|login\|logout]` | a GitHub token for sandboxes (typed hidden, kept encrypted, never printed): `login` first prints the steps to make a fine-grained token limited to some repositories and permissions; `status [--json]` says whether one is saved (its kind and date, never the token) and whether sandboxes get it (`github.shareToken`). Menu: Settings > Security & privacy > Set GitHub token…; web: Settings > GitHub. See [GitHub token](configuration.md#github-token) |
| `sandbox host <agent> [-- arguments]` | any agent installed on this PC, run here, **not** sandboxed (`SANDBOX_AGENT_DIRECT=1` is set for it) |
| `sandbox host claude [--personal]` (or `claude-host`) | Claude on this PC, **not** sandboxed, with its own profile (`--personal` uses your normal one). `sandbox host-claude` still works but is no longer listed |

`sandbox --version` (or `-v`) prints the version and where this copy runs from, for example `1.5.1 (all users, C:\Program Files\WindowsDevelopmentSandbox)` or `1.5.1 (npm copy, C:\nvm4w\nodejs\node_modules\windows-development-sandbox)`; `--version --short` prints the number alone (the installer and updater compare it). When you start the menu or a sandbox from a copy that is not the installed one while an install exists, one yellow line says so, once per version (`sandbox doctor` explains). Inside a sandbox, commands that control it from outside (`launch`,
`attach`, `exec`, `stop`, `show`, `hide`, `restart`) say so, list what does work there, and do nothing; `sandbox db` runs `sbx-db` right there. `sandbox resume` with nothing to reopen says `Nothing to resume. Start one: sandbox claude.`

Every command also takes `--config <file>` (before or after the command) to use another settings file. Colours are off
with `NO_COLOR`, `TERM=dumb` or piped output (`FORCE_COLOR=1` forces them). Unknown agents, accounts, databases and
malformed `--node`/`--python` versions are rejected up front with the valid values. The environment variables `AGENT_SANDBOX_CONFIG`
(settings file) and `AGENT_SANDBOX_HOME` (folder for settings and history, default `~/.agent-sandbox`) do the same.
Commands that print data take `--json`.
