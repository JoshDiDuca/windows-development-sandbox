# Commands

The command is `sandbox` (also `windows-development-sandbox`). `sandbox <agent>` starts any configured agent, and
`claude-sandbox`, `codex-sandbox` and `gemini-sandbox` are shortcuts. The old names `agent-sandbox`, `claude-sbx`,
`codex-sbx` and `gemini-sbx` still work for now.

- `sandbox --help` lists the commands in groups. `sandbox <command> --help` shows that command's options and examples.
- A mistyped command suggests the right one (`Did you mean: sandbox status?`). A mistyped action lists the valid ones.
- Questions are asked on a terminal. In a script they fail and name the flag that answers them (`-y` / `--yes`).
- Commands that print data take `--json`.

## The menu

`sandbox` with no arguments opens the menu, a full-screen app.

**Keys.** Sections are on the left (`1`-`7` jump to one), with the open section's categories underneath. A `✎` marks
unsaved changes.

- `←` or `Esc` moves from the list to the navigation; `↑` `↓` walk it; `→` or `Enter` go back into the list.
- `/` searches the section, `Enter` opens, `Esc` in the navigation leaves, `Ctrl+C` leaves at once.
- Under 80 columns the navigation shrinks to numbers.
- The menu reopens where you left it (kept in `~/.agent-sandbox/menu-state.json`; delete it to start on Agents).

**Sections.**

- **Agents.** _Start_: the agents you can start here, after "Repeat last". **Add an agent…** adds an npm or Python
  package, or a program on this PC, to your settings. _Options_: attach this terminal, the window, the folder,
  **several agents at once** (builds a `--session` command line), and a sandbox without an agent. _On this PC_: the
  agents that run outside the sandbox, while agent commands are on.
- **Sessions.** The sessions running now (`Enter` attaches), restart, reopen the last ones.
- **Sandbox.** Status (window, stop), projects and roots, databases.
- **Apps.** The [apps catalogue](toolchains.md#apps-and-tools), for all projects or just this one. **Request an app…**
  (`r`) opens a prefilled GitHub issue.
- **Settings.** Every setting, by category, on two tabs: **All projects** (your own file) and **This project** (this
  folder's `.sandbox-config.json`, only what a project may set). `Tab` switches. Each setting shows its value, default
  and description; `Enter` edits it and `r` resets it. Comments in the file are kept, and nothing invalid is saved.
  Saving a project file does not approve it: the next launch asks.
- **Accounts.** The saved logins of every agent.
- **Maintenance.** Updates, data and storage, health (doctor, repair, setup), logs, activity, the web UI and the less
  common commands.

A command opens as a form: its arguments and options, and the exact command line at the top. **Run** runs it, and the
output stays until you press a key. Commands that take over the terminal (`-t`, `attach`) end the menu.

## Starting

|                  |                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `sandbox claude` | start Claude in a sandbox for this folder, in a terminal inside it (also `claude-sandbox`) |
| `sandbox start`  | the sandbox without an agent                                                               |
| `sandbox launch` | the same, with any `--agent`                                                               |

Options:

| Option                                 |                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `-t, --terminal`                       | run in this terminal. In a running sandbox, reattach to this folder's session if nothing is attached to it |
| `--new`                                | always start a new session                                                                                 |
| `--headless` / `--window`              | hide the sandbox window / show it even if your settings say headless                                       |
| `--agent <agent>`                      | which agent (`--harness` is the old spelling)                                                              |
| `--account <name>`                     | which saved login                                                                                          |
| `--node <v>`, `--python <v>`           | override the versions                                                                                      |
| `--workspace <dir>`                    | another folder instead of this one                                                                         |
| `--database <name>`                    | also start this database, e.g. `--database postgres,redis` (repeatable)                                    |
| `--script <file>`                      | run a `.ps1`, `.mjs` or `.cmd` inside before the agent (repeatable)                                        |
| `--no-agent`                           | no agent                                                                                                   |
| `--trust-config` / `--no-local-config` | approve the project's `.sandbox-config.json` / ignore it                                                   |
| `--session <agent>@<folder>`           | several sessions at once (repeatable), see below                                                           |
| `--yes`                                | restart the sandbox without asking if this folder needs it                                                 |

Anything else goes to the agent: `sandbox claude --continue`. If the agent has a flag with the same name as one of
ours, use `--sbx-<flag>` for ours, or put the agent's flags after `--`.

**Several sessions at once:**

```powershell
sandbox launch --session claude@C:\code\api --session codex@C:\code\api --session claude@C:\code\web -t
```

One sandbox maps every folder, each session gets its own tab inside, and `-t` attaches the first. Arguments after `--`
go to every session. To give one session its own, add them after a `|`: `"codex@C:\code\web|--model o3"` (a Windows
path cannot contain `|`).

## A running sandbox

|                                                           |                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sandbox attach [id]`                                     | show a session in this terminal (`Ctrl+]` detaches). Without an id it offers the sessions, this folder's project first                                       |
| `sandbox sessions [--wide]`                               | the sessions (agents and shells), their project and who is attached. `*` marks this folder's project; `--wide` adds each folder                              |
| `sandbox shell [project] [--shell pwsh\|powershell\|cmd]` | open a shell in a project as a session and attach to it. It has the project's tools, not the agent's keys ([details](web-ui.md#shells-and-closing-sessions)) |
| `sandbox close <id>`                                      | end a session and everything it started                                                                                                                      |
| `sandbox status`                                          | the whole sandbox: the machine, then each project (folders, setup, databases, sessions, repo-guard findings)                                                 |
| `sandbox db [start\|stop <name>]`                         | list, start or stop this project's databases (`sbx-db` inside)                                                                                               |
| `sandbox exec -- <cmd>`                                   | run a command inside, in this folder, with its project's tools (`--timeout`, `--workspace`)                                                                  |
| `sandbox restart [--all]`                                 | restart this project's agents in place; they continue their conversations. `--all`: every project's                                                          |
| `sandbox resume`                                          | reopen the sessions from the last sandbox, each in its own conversation. Starts the sandbox if none runs ([settings](configuration.md#reopening-sessions))   |
| `sandbox stop [--yes]`                                    | shut down (history syncs back). Asks first when other projects' sessions would end                                                                           |
| `sandbox show` / `hide`                                   | show or hide the window (also `sbx-show`, `sbx-hide`). Hidden, it keeps running                                                                              |
| `sandbox cleanup [--service] [--yes]` | close the Windows Sandbox programs a dead sandbox left behind (Windows then says the sandbox was signed out, or that one is already running); `--service` also restarts the Windows Sandbox service (administrator permission). Asks first; never touches a working sandbox |

Any number of terminals can show a session, in the sandbox and on your PC at once. Closing a tab or terminal never
stops a session; only the agent (or shell) exiting does, or `sandbox close`.

**Other users' sandboxes.** With an all-users install, a sandbox another user started shows in `status` and
`sessions` as "started by <name>". When they share it, `attach`, `exec`, `db` and `stop` work (`stop` asks you to type
their name). Everything else tells you whose it is.

## Web UI (Beta)

See [web-ui.md](web-ui.md).

|                                                             |                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sandbox web [start\|stop\|status\|open]`                   | `start` runs the server in the background (even with `web.enabled` off); `open` starts it if needed and opens your browser signed in; `status`; `stop` |
| `sandbox web lan-on` / `lan-off`                            | let devices you allow use it on your own network, or stop that and sign out every device ([remote access](web-ui.md#remote-access))                    |
| `sandbox web allow-device [--role view\|control]`           | a one-time code (5 minutes) for a phone or tablet                                                                                                      |
| `sandbox web devices [--json]`, `revoke <id>`, `revoke-all` | who may use your web UI, and signing one or everyone out                                                                                               |
| `sandbox remote [user] [--browser]`                         | another Windows user's web UI from your account: the menu, or `--browser`                                                                              |

## Several projects

Every command above works from any project's folder and acts on that project. How projects join a running sandbox:
[projects](projects.md).

| `sandbox projects ...`                  |                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| (nothing) / `list`                      | the projects you have started, whether they are mapped at every start, and which are running |
| `choose`                                | tick the projects mapped at every start (turns "all projects" on and excludes the rest)      |
| `all on\|off`                           | map every known project at every start                                                       |
| `exclude <folder>` / `include <folder>` | leave one out of `all`, or take it back                                                      |
| `add [folder]` / `remove [folder]`      | add a folder to your projects, or forget it (its files are never touched)                    |
| `roots [list\|add\|remove <folder>]`    | folders whose subfolders are projects, mapped at every start                                 |

Changes to what is mapped apply from the next start.

## Updates

|                                                    |                                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `sandbox update [--check] [--rollback]`            | install the newest version (also while a sandbox runs); `--check` only looks; `--rollback` goes back one version |
| `sandbox update --auto on\|off`                    | install new versions by themselves (for everyone, this needs an admin terminal)                                  |
| `sandbox migrate [--dry-run] [--restore <backup>]` | bring your saved settings up to date (runs by itself after an update; a backup is kept first)                    |
| `sandbox --version` (`-v`)                         | the version and where this copy runs from; `--short` prints the number alone                                     |

An npm install is updated with `npm install -g windows-development-sandbox`. A failed update prints `Error: ...` and
exits with 1. More: [install](install.md#updating).

## Data and maintenance

|                                                    |                                                                                                                                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox data`                                     | what is kept between sandboxes, how big it is, and disk use per drive                                                                                                        |
| `sandbox data clean [targets] [-y]`                | delete parts: `tools/go`, `tools`, `databases/postgres-18`, `databases`, `logs`, `launches`, `views`, `state/claude`, `all`. Without targets you pick from a list with sizes |
| `sandbox clean [--days n] [-y]`                    | delete old launch folders, logs and leftovers (shows what first, then asks)                                                                                                  |
| `sandbox storage [show]`                           | where your data is, how big, and any other folder that holds data                                                                                                            |
| `sandbox storage move [folder] [-y] [--keep-old]`  | move your data to another folder or drive (shows size and time first); `--keep-old` copies and keeps the old folder                                                          |
| `sandbox storage use [folder] [-y]`                | switch to a folder without moving anything                                                                                                                                   |
| `sandbox storage contained [status\|on\|off] [-y]` | **(Beta)** keep tools, state and logs in one disk image ([contained storage](configuration.md#contained-storage-beta))                                                       |
| `sandbox sync`                                     | copy history back to this PC now                                                                                                                                             |
| `sandbox logs [-f] [--crash]`                      | the newest sandbox log (`-f` follows it). `--crash`: the report of the last crash ([troubleshooting](troubleshooting.md#the-pc-froze-or-restarted-during-heavy-builds))      |

## Engines (Alpha)

|                                               |                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox engine [--json]`                     | the engine in use (`sandbox.engine`), and what each engine can do and whether this PC can use it                                                  |
| `sandbox engine check [hcs\|windows-sandbox]` | what this PC lacks for an engine (default `hcs`), with the commands that would fix it. It only looks. Exits with 1 when the engine cannot be used |
| `sandbox engine leftovers [--json]`           | HCS systems of yours still running after a command stopped early                                                                                  |
| `sandbox engine clean [--yes]`                | stop those HCS systems, after asking. Deletes no files and touches nothing else                                                                   |

## Health

|                                   |                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `sandbox setup`                   | check this PC (edition, virtualization, Windows Sandbox, RAM, disk, Node) and offer fixes, then a restart of Windows |
| `sandbox doctor [--fix] [--json]` | check this PC, the install, your data, settings, the sandbox, agents and network, and offer to fix what it can       |
| `sandbox repair [--yes] [--json]` | list what it would fix, ask once, fix it and check again. Writes a log to `<storage>\logs\repair-<time>.log`         |
| `sandbox generate`                | a dry run: what a launch would do, without starting anything                                                         |
| `sandbox audit [options]`         | what your agents ran, changed and committed (see below)                                                              |

What doctor checks and repair fixes: [troubleshooting](troubleshooting.md#what-doctor-checks-and-repair-can-fix).

`sandbox audit` shows the [audit log](configuration.md#audit-log) for the last `--days n` (default 1): totals, a table
of sessions and the newest events. Filters: `--kind proc|file|commit|session|guard`, `--session <id>` (`none` for what
no session is linked to), `--agent <name>`, `--project <name>`, `--grep <text>`, `--limit n`. The web UI shows the
same on its Activity page.

## Accounts and settings

|                                                                      |                                                                                                                                     |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox account list`                                               | saved logins, with their kind (subscription, Console, API key)                                                                      |
| `sandbox account save <name> [--from-host]`                          | save the sandbox's login (or this PC's), whichever kind it is                                                                       |
| `sandbox account save <name> --api-key [--from-host]`                | save an Anthropic API key: typed in (hidden), or this PC's Console key or `ANTHROPIC_API_KEY`                                       |
| `sandbox account use [name]`                                         | switch now (the agent restarts and continues)                                                                                       |
| `sandbox account default [name]`                                     | the login new sandboxes start with                                                                                                  |
| `sandbox account rename [name] [--to <new>]` / `remove [name] [-y]`  | rename or delete a saved login                                                                                                      |
| `sandbox account ... --agent <name>`                                 | the same for another agent (default `claude`); works for agents with a `home` in their settings                                     |
| `sandbox account status [service]`                                   | service sign-ins for sandboxes (Epic, Steam, Unity ...): shared or not, saved or not ([accounts](accounts.md))                     |
| `sandbox account import <service> [--from <path>] [-y]`              | save one from this PC's program or a file (asks first)                                                                              |
| `sandbox account login <service>` / `logout <service> [-y]`          | type a key or token to keep / forget one everywhere                                                                                 |
| `sandbox config`                                                     | a short summary: settings file, default agent, storage                                                                              |
| `sandbox config show` / `path` / `init` / `schema`                   | all settings with defaults as JSON / the file's path / create the file / the editor schema                                          |
| `sandbox config get\|set\|reset <setting> [value]`                   | read, change or reset one setting, e.g. `sandbox config set sandbox.memoryMb 8192`. Secrets show as `***`                           |
| `sandbox config list [--json]`                                       | every setting with its value, by category                                                                                           |
| `sandbox config export [file] [--with-paths]` / `import <file> [-y]` | share your settings ([details](configuration.md#your-settings))                                                                     |
| `sandbox config check [--workspace <dir>]`                           | check a project's `.sandbox-config.json` and list what it changes, without starting anything                                        |
| `sandbox github [status\|login\|logout]`                             | a GitHub token for sandboxes ([GitHub token](configuration.md#github-token))                                                        |
| `sandbox vpn [status\|login\|logout]`                                | **(Alpha)** the VPN login and status ([vpn](vpn.md))                                                                                |
| `sandbox agent-commands [status\|on\|off]`                           | make `claude`, `codex` ... on this PC start in a hidden sandbox ([agent commands](configuration.md#agent-commands)) |
| `sandbox host <agent> [-- arguments]`                                | run an agent installed on this PC, **not** sandboxed (`SANDBOX_AGENT_DIRECT=1` is set for it)                                       |
| `sandbox host claude [--personal]` (or `claude-host`)                | Claude on this PC, **not** sandboxed, with its own profile (`--personal` uses your normal one)                                      |

## Good to know

- Every command takes `--config <file>` to use another settings file. The environment variables
  `AGENT_SANDBOX_CONFIG` (settings file) and `AGENT_SANDBOX_HOME` (settings and history folder, default
  `~/.agent-sandbox`) do the same.
- Colours are off with `NO_COLOR`, `TERM=dumb` or piped output. `FORCE_COLOR=1` forces them.
- Unknown agents, accounts and databases, and malformed `--node` / `--python` versions, are refused up front with the
  valid values.
- If you run a copy that is not the installed one, one yellow line says so (once per version). `sandbox --version`
  shows where the running copy is.
- Inside a sandbox, commands that control it from outside (`launch`, `attach`, `exec`, `stop`, `show`, `hide`,
  `restart`) say so and do nothing. `sandbox db` runs `sbx-db` right there.
