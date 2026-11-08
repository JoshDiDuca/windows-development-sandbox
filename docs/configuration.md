# Configuration

## Your settings

The easiest way is the menu: `sandbox`, then **Settings**. Every setting is listed with its value and what it does.
Pick one to change it or reset it. Changes are saved to your settings file, keeping its comments, and only when the
result is valid.

From the command line:

- `sandbox config set sandbox.memoryMb 8192`, `get`, `reset` and `list` change and show single settings.
- `sandbox config init` creates `~/.agent-sandbox/config.json` with every setting and its default (see
  [config.example.json](../config.example.json)). Keep only what you change. Comments and trailing commas are allowed.
- `sandbox config show` prints your settings with the defaults filled in.
- `sandbox config schema` shows how to get help and autocomplete in VS Code.
- `--config <file>` or `AGENT_SANDBOX_CONFIG` uses another file.

**Sharing settings with a team.** `sandbox config export team.json` writes only what differs from the defaults.
`sandbox config import team.json` shows each change (`sandbox.memoryMb: 8192 -> 4096`), asks once and applies it. Secrets
(API keys), the data folder (`storage.root`) and folders or files of this PC are never exported or imported
(`--with-paths` exports the folders and files). Both commands say what they skipped. The menu has the same under
Settings > General.

## Common settings

| Setting                                        |                                                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultHarness`                               | the agent `sandbox launch` starts (default `claude`)                                                                                                                    |
| `toolchains.<lang>.enabled`                    | `true`, `false` or `"auto"` (only when the project uses it). Every tool works like this, Bun, uv and VS Code too. A project file can set it                             |
| `toolchains.<lang>.version`                    | default versions; the project's version files still win                                                                                                                 |
| `toolchains.environment`                       | extra environment variables, such as registry mirrors (not for secrets)                                                                                                 |
| `databases.<db>.enabled`, `.port`              | `true`, `false` or `"auto"`, and the port inside                                                                                                                        |
| `apps.install`, `apps.custom`                  | apps from the catalogue, and programs of your own ([apps](toolchains.md#apps-and-tools))                                                                                |
| `sandbox.memoryMb`, `.headless`, `.networking` | RAM (`"auto"`, see [CPU, RAM and GPU](#cpu-ram-and-gpu)), no window, internet on or off                                                                                 |
| `sandbox.clipboard`                            | `"text"` (default), `"shared"` or `"off"` ([Copy and paste](#copy-and-paste)). `true` / `false` from older versions mean `"text"` / `"off"` |
| `sandbox.clipboardDirection`                   | `"both"` (default), `"toPc"` or `"toSandbox"`; only for `"text"`                                                                          |
| `sandbox.vGpu`                                 | give the sandbox your GPU (default off). With some graphics drivers, heavy use can freeze the whole PC: leave it off unless a program needs the GPU                     |
| `sandbox.keepAwake`                            | keep this PC from sleeping while a sandbox runs (default on). The screen may still turn off, and closing a laptop lid still sleeps it                                   |
| `attach.auto`                                  | starting an agent attaches this terminal (like `-t`)                                                                                                                    |
| `attach.autoHide`                              | hide the sandbox window whenever a terminal attaches (`sandbox show` brings it back)                                                                                    |
| `attach.confirmCtrlC`                          | (default on) a single Ctrl+C is held back, and only a second one within 1.5 s reaches the agent, so a Ctrl+C meant as "copy" does not stop it. Esc still stops an agent. After you copy (select with the mouse: the sandbox window copies on select) or the agent copies, Ctrl+C is not sent until you press another key or click, also in the web terminal and whatever this setting says; Esc still stops an agent |
| `provisioning.git.access`                      | `full`, `readonly` or `none` ([git access](security.md#git-access))                                                                                                     |
| `secrets.allow`, `secrets.patterns`            | let named variables through, or strip more ([secrets](security.md#secrets))                                                                                             |
| `downloads.requireChecksum`                    | refuse downloads that have no published checksum (default off; downloads that have one are always checked)                                                              |
| `sharing.otherUsers`                           | let other Windows users of this PC use a sandbox you start ([several users](security.md#several-users-on-one-pc)). Default off; your settings only                      |
| `web.enabled`, `web.port`, `web.openOnLaunch`  | **(Beta)** the [web UI](web-ui.md) on `127.0.0.1:47800`. With `web.enabled` on, every sandbox start also starts it; `web.openOnLaunch` also opens your browser          |
| `web.remote.*`                                 | **(Beta)** [remote access](web-ui.md#remote-access) to the web UI. All off by default                                                                                   |
| `agentCommands.enabled`, `.agents`             | [agent commands](#agent-commands); `.agents` is `"auto"` (every agent on this PC) or a list such as `["claude", "codex"]`                               |
| `sandbox.engine`                               | **(Alpha)** `"windows-sandbox"` (default) or `"hcs"` (see [the HCS engine](#the-hcs-engine-alpha))                                                                      |
| `harnesses`                                    | the agents and how they are installed ([agent settings](#agent-settings))                                                                                               |

Settings for one toolchain (MSVC, Unreal, Rust, Mesa, CLI tools, the game and mobile ones) are in
[toolchains](toolchains.md).

Many settings are **yours only**: a project's `.sandbox-config.json` cannot set them. These include storage, sharing,
secrets, the audit log, the web UI, agent commands, agents (`harnesses`), the engine, the CPU and memory limits,
`projects.*`, `resume.*`, `github.*`, `pcInstalls`, most of `network` and the agent add-ons. A project can only turn
off `accounts.*.share` and never accept a licence (`toolchains.*.acceptLicense`). See [project settings](#project-settings).

## Paths

| Setting            | Default                                       |                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage.root`     | `%ProgramData%\AgentSandbox\users\%USERNAME%` | everything kept on your PC between sandboxes ([where your data is kept](#where-your-data-is-kept)). `AgentSandbox` is the old name, kept on purpose                                                                        |
| `storage.dataName` | `default`                                     | the data set (`C:\AgentData` inside). Give an untrusted project its own to keep its tools separate                                                                                                                         |
| `guestWorkspace`   | `"auto"` (`C:\Workspace\<folder>`)            | where the project appears inside. `"mirror"` uses the same path as on your PC (e.g. `F:\Projects\game`; not for `C:\Users\...`). With several projects: [projects](projects.md#where-a-project-appears-inside-the-sandbox) |
| `mappings`         | none                                          | more folders from your PC, read-only or read/write (below)                                                                                                                                                                 |

A mapping looks like `{ "host": "F:\\SteamLibrary\\steamapps\\common\\Game", "readOnly": true }`. `optional: true`
skips a folder that is not on this PC. Where it appears:

- **Without `guest`:** at the same path as on your PC (`C:\SteamGame` stays `C:\SteamGame`). A folder inside the
  project needs no mapping: it comes with the project. (With `workspaceFilter` on, map a git-ignored folder to a `guest`
  path outside the project to bring it in.)
- **With `guest`:** exactly there, on `C:` or any drive from D: to Z:.
- **A folder that cannot appear at its path stops the launch**, with the reason and the fix. That includes relative
  paths, drive roots, `A:`/`B:`, paths already used, and the folders the sandbox keeps for itself (`C:\Windows`,
  `C:\Program Files*`, `C:\ProgramData`, `C:\Users`, `C:\AgentData`, `C:\AgentLaunch`, `C:\HostTools`, `C:\nvm`,
  `C:\Mirror`, `C:\Projects`). `sandbox config check` shows where each folder will appear before you launch.

Windows Sandbox can only map folders onto C:. So a path on F: is mapped to `C:\Mirror\F\...`, and `subst F: C:\Mirror\F`
runs at boot. Tools that resolve real paths may print the `C:\Mirror` form. A drive letter the sandbox already has is
left alone.

Under `storage.root` you find `data\<name>` (tools, databases, logins, logs), `launches\` (one per start, cleaned after 7
days), `accounts\`, `sync\`, `known-projects.json` and `run\projects.json`. The last two are for your PC only: the
sandbox cannot read or change them.

### Where your data is kept

New installs keep everything in `%ProgramData%\AgentSandbox\users\<you>`. Only you, SYSTEM and administrators can read
it. The same folder works for an install for just you and one for everyone, so switching needs no move.

- **Upgrading** from a version that used `%LOCALAPPDATA%\AgentSandbox`: nothing moves. `storage.root` is pinned to the
  old folder in your `config.json`, and the next command asks once whether to move it ("Move now", "Not now" for two
  weeks, "Don't ask again").
- **Moving later:** `sandbox storage` shows where the data is, and `sandbox storage move <folder>` moves it. On the same
  drive it is a rename; to another drive, a checked copy. It warns above 5 GB or 200,000 files, and refuses when the
  target lacks room or a sandbox runs. If a move fails, nothing changes. The menu has the same under Settings > General
  > Data folder.
- **Always pinned:** after a move or `sandbox storage use`, `storage.root` is written to your `config.json`, so an older
  version finds the data too.

### Contained storage (Beta)

**Beta, not yet tried on a real PC.** The code is tested with a fake disk and the scripts in a dry-run mode.

Normally the sandbox's tools, state, logs, databases and caches are loose folders in `<storage>\data\<name>`: many
files that scanners check one by one. With `storage.contained: "vhdx"` they live in one disk image instead.

- **The image** is `<storage>\images\<name>.vhdx`. It grows as it fills, up to `storage.containedMaxGb` (default 64).
  It is mounted on the folder `<storage>\mounts\<name>` (**no drive letter**) while a sandbox runs.
- **The sandbox sees the same folders as before** (`C:\AgentData\tools` ...). `run\` stays a normal folder, because this
  tool reads it.
- **Turning it on and off:** `sandbox storage contained on` makes the image, offers to move your files in and sets the
  setting. `off` moves everything back, dismounts, and then asks before it deletes the image. `status` shows the
  setting, the image and whether it is mounted.
- **Permission prompts:** mounting needs admin rights, so Windows asks when a sandbox starts and when it ends. Declining
  the second leaves the image mounted; `sandbox repair` dismounts it later. With the **storage helper** of an all-users
  install there is no prompt ([install](install.md#just-me-or-everyone)). The helper reads only your usual settings
  file, so a command run with `--config`, `AGENT_SANDBOX_CONFIG` or `AGENT_SANDBOX_HOME` still uses the prompt.
- **Limits:** while the image is mounted, `sandbox storage move` and `use` wait. It needs `diskpart` and does not work
  inside a Windows Sandbox. `sandbox data`, `sandbox clean` and the menu's data screens still look only at the plain
  folders, so they do not show what is in the image.

Security: [security](security.md#contained-storage-beta). Problems: [troubleshooting](troubleshooting.md#contained-storage-beta).

## Machine settings (everyone installs)

An all-users install writes `%ProgramData%\AgentSandbox\config.json` (only admins can change it). Your own file is read
on top of it, so your settings win. The installer writes:

```json
{ "storage": { "root": "%ProgramData%\\AgentSandbox\\users\\%USERNAME%" }, "sharing": { "otherUsers": false } }
```

`%USERNAME%` is filled in for each user, so everyone gets a private folder. Paths in this file must be full paths.
Whether updates install themselves is not a setting: it lives in the install folder's `install.json` and is changed
with `sandbox update --auto on|off`.

## Network

The **Network** category, or `network` in your file:

| Setting              |                                                                                                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blockPrivateRanges` | your LAN (and SMB) cannot be reached from the sandbox; DNS to the gateway still works (default on)                                                                                                                                                          |
| `allowOnly`          | only these hosts can be reached once setup is done (tools still download first). `*.example.com` covers subdomains; `@developer` adds package registries, GitHub/GitLab, toolchain downloads and the AI providers. Refused hosts are in `logs\netproxy.log` |
| `blockHosts`         | names that go nowhere, such as production servers or telemetry (exact names, no wildcards)                                                                                                                                                                  |
| `forwardPorts`       | `{ "pc": 3000, "sandbox": 5173 }`: `http://localhost:3000` on your PC reaches port 5173 inside, even for a server that listens only on localhost there. Only this PC can use it                                                                             |
| `dns`                | DNS servers for the sandbox, e.g. `["1.1.1.1", "9.9.9.9"]`                                                                                                                                                                                                  |
| `proxy`              | your HTTP proxy for everything in the sandbox, e.g. `http://proxy.corp:8080`. No `user:password@`: the agent could read it, so it is refused                                                                                                                |

These rules run inside the sandbox, where the agent is an administrator. They keep a well-behaved agent and its tools
in bounds, but a determined one could undo them. Only `sandbox.networking: false` is hard isolation. A project file may
add `blockHosts` and turn on `blockPrivateRanges`, nothing else here.

## VPN

**(Alpha)** The `vpn` settings send the sandbox's traffic, and only the sandbox's, through a VPN. The settings, setup
steps and what is not tested yet are in [vpn.md](vpn.md). A project file can turn `vpn.killSwitch` on, never off, and
can never choose a VPN, server, profile or login.

## GitHub token

Off by default. To make `gh` and https `git` work inside without logging in
each time, save a token made only for sandboxes:

1. Run `sandbox github login` (or Settings > Security & privacy > Set GitHub token…, or Settings > GitHub in the web
   UI). It prints the steps. In short: at <https://github.com/settings/personal-access-tokens/new> make a
   **fine-grained** token, pick only the repositories the agent should reach, give only the permissions it needs (for
   example Contents and Pull requests read and write, Actions read) and set an expiry. Paste it when asked. It is typed
   hidden, kept encrypted for your Windows user, and never printed. A classic token (`ghp_`) gets a warning. An OAuth
   token (`gho_`, from `gh auth token`) is refused, because it reaches everything your account can.
2. Run `sandbox config set github.shareToken true`.

**Or use the login from your PC.** If `gh` is signed in on this PC, `sandbox config set github.usePcLogin true` hands
that login to sandboxes instead, so nobody runs `gh auth login` in each one. A token saved above wins when both are
on; with no gh login on the PC nothing happens. It is the same OAuth token as on your PC and reaches everything your
account can: a fine-grained token is safer. Only github.com is copied.

The token is given only to sandboxes whose git access is `full`; otherwise the launch says why not. **The agent can read
the token** and use it for everything it allows. `sandbox github logout` deletes it from this PC; revoke it on GitHub
too. How it is kept and handed over: [security](security.md#github-cli).

## Agent settings

`harnesses` lists the agents and how to install them (`npmPackage` / `npmBin`, `uvPackage` / `uvBin` or
`hostExecutable`). Add your own agents there, or with **Add an agent…** in the menu.

- `home` says where an agent keeps its login, so logins can be saved and switched (`sandbox account`). An agent with no
  variable for that lists `profileDirs` (folders in the sandbox's user profile, such as `.qwen`), which are kept in the
  data set so its login survives.
- `home.hostDir` is the agent's own folder on this PC, so `sandbox account save <name> --from-host --agent <agent>`
  can save this PC's login (Codex, Gemini, Copilot, Continue, opencode, Kilo). When the login sits at another place on
  this PC than in the sandbox, `home.hostFiles` maps each login file to its path below `hostDir` (opencode and Kilo:
  `hostDir` `~`, `auth.json` at `.local/share/<agent>/auth.json`). `home.providersFile` names a login file that is a JSON
  object keyed by provider id (opencode's `auth.json`): the accounts list shows those ids (`anthropic, openai`), never a
  token.
- `home.copyPcLogin` (`harnesses.<agent>.home.copyPcLogin`, default `false`; Accounts page: "Copy this PC's login at every
  launch") puts this PC's current login for that agent into the sandbox at every launch, in place of a saved login. It
  is the same safe path a saved login takes (the agent's state folder, never `session.json` or the launch folder), and
  `sandbox launch --account <name>` still wins. Claude has its own, `claudeProfile.copyCredentials`. Only your own
  settings can turn it on: a project's `.sandbox-config.json` cannot change `harnesses`.
- `localState` is for agents that keep SQLite databases (Codex). SQLite cannot run in the shared data folder, so the
  agent runs from a copy on the sandbox's own disk, restored at start and saved after the agent exits.
- Every configured agent is a command in every terminal tab (`claude`, `codex` ...). One that is not installed yet
  installs on first use (`sbx-agent list` shows them). These commands come first on PATH, so they win over a copy
  installed with `npm i -g` in Node's folder.

### Agent environment variables

`harnesses.<agent>.environment` holds variables for one agent, such as an API key. Their values show as `***` in
`sandbox config show`, the settings screen and every `--json` output. They reach the sandbox in a one-shot file that the
sandbox reads and deletes, never in `session.json` or the launch folder. The agent can read its own environment (that is
the point), and so can anything it runs.

**Claude environment.** Agents > Claude > Environment… (menu and web) lists the variables of Claude Code worth
setting, in groups (subagents, models, limits, behaviour, privacy, network, providers) with plain labels. Numbers are
checked, flags are on or off, and an empty value removes the variable. "Subagents at once"
(`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`; Claude's own limit is 20) is also on the Agents page. Secrets are never shown
again once saved; an API key must be one from the Claude Console (any prefix, no spaces, 20 characters or more). "Your own variables" holds
any other name. On the command line: `sandbox config set harnesses.claude.environment.NAME value`.

### Codex settings

The `codex` section (Settings > Agents & sessions > Codex) says how Codex runs inside the sandbox. Windows Sandbox is
already the sandbox, and Codex's own Windows sandbox only slows it down (it sets up users and firewall rules and
re-grants file permissions over your profile at every start), so the default is no inner sandbox.

- `codex.sandboxMode` (`danger-full-access`, `workspace-write`, `read-only`) and `codex.approvalPolicy` (`never`,
  `on-request`, `on-failure`, `untrusted`) become launch flags on every Codex start: a new tab, a restart and the
  `codex` command of a terminal. Flags beat `config.toml` and the permissions a resumed thread saved. Full access with
  `never` uses `--dangerously-bypass-approvals-and-sandbox`, which skips the Windows sandbox setup for certain.
- The same settings are also written at the top of `config.toml` (`sandbox_mode`, `approval_policy`, and `model`,
  `model_reasoning_effort` when set), under a `# Set by the sandbox` comment, so a Codex started without the flags
  (say, one you installed yourself with `npm i -g @openai/codex`) obeys them too. The sandbox replaces those marked
  lines at every boot; a line of your own for the same key (without the comment above it) is kept and wins.
- `codex.model` (empty = Codex's default) and `codex.reasoningEffort` are passed as `-c` overrides.
- `codex.windowsSandbox` (`off`, `unelevated`, `elevated`): `off` removes `[windows] sandbox` from `config.toml`.
- `codex.mcpLoginsInFile` (default on) sets `mcp_oauth_credentials_store = "file"` unless you set it yourself.

Only your own settings change these; a project's `.sandbox-config.json` cannot. Every other line of `config.toml` is
left as it is.

## Audit log

The audit log is **on by default** (`audit.enabled`; menu: Settings > Security & privacy > Audit log). It records what
your agents did, on your PC in `<storage>\audit\<data set>`, where the sandbox cannot reach it. Turn it off with
`sandbox config set audit.enabled false`.

What it records:

- **Programs started** in the sandbox, with their command lines (`audit.processes`). Windows' own background programs
  are left out. **Secrets are hidden** first: tokens and keys by their shape, passwords in URLs, `Authorization:`
  headers, and values after names like `--password`, `--token=` or `API_KEY=` become `***`.
- **Files changed** in the projects while the sandbox runs (`audit.files`), seen from your PC.
- **Git commits** made in the projects (`audit.commits`): id, first line of the message and author, read from each
  project's reflog.
- **Sessions** starting and ending, and what the **repo guard** caught.

**Which agent did it.** A program is linked to the agent session whose terminal started it, directly or further down.
Programs the sandbox runs itself are "not linked to a session". A commit is linked to the session that ran the
`git commit` (or merge, cherry-pick ...). A file change is linked only when exactly one session was running in that
project, and then shown as _likely_ (`?`), since you may have changed it yourself. Nothing else is guessed.

**Size.** One short line per event; repeats within a minute become one line with a count; at most 300 lines a minute.
Finished days are compressed. Days past `audit.days` (default 7, at most 30) or beyond `audit.maxMb` (default 100) are
deleted, oldest first.

See it on the web UI's **Activity** page, in the menu (Maintenance > Activity) or with `sandbox audit`:

```powershell
sandbox audit                            # the last 24 hours
sandbox audit --days 7 --kind commit
sandbox audit --session 4f2c --grep "git push"
sandbox audit --agent codex --project api
sandbox audit --json                     # for scripts
```

**How far to trust it.** File changes, sessions and repo-guard findings are seen from your PC. Program lines come from
the sandbox and are checked, but an agent with admin rights there could leave things out or link them wrongly (it
cannot invent a session). Commits come from the reflog, which the sandbox can also write: a listed commit is a record,
not proof.

## Git-ignored files

`workspaceFilter.enabled: true` keeps what your `.gitignore` lists out of the sandbox: `.env` files, your
`node_modules`, build output, local notes. The sandbox then works on a copy of the project (in
`<storage>\views\<project>`) without those files. The two are kept in step both ways while the sandbox runs (within
about a second, with a full check every minute and at close):

- Your edits reach the sandbox; the agent's edits, new files and deletions reach your project.
- Ignored files the sandbox makes (its own `node_modules`, `target`, `dist` ...) stay in the copy, so they never mix
  with your PC's builds, and are there again next time.
- If a file changes on both sides at once, yours is kept and the sandbox's is saved next to it as
  `<name>.sandbox-conflict-<time><ext>`.
- Git works as usual: the real `.git` is mapped next to the workspace (`C:\Workspace\<name>.git`), so commits and
  branches made inside are in your repository. With git access `none`, no `.git` is mapped.
- The rules are git's own: every `.gitignore`, `!` exceptions and `.git/info/exclude`. `workspaceFilter.exclude` keeps
  more out (`secrets/`, `*.pem`); `workspaceFilter.include` lets in something git ignores (`.env.example`).

It applies to the folder you start from. Projects that join a running sandbox, and a project that is a git worktree, are
mapped as they are. A project file can turn the filter on and add `exclude` patterns, never turn it off.
`sandbox data clean views` removes the copies (your projects are not touched).

## Project settings

A project can carry a `.sandbox-config.json` (see the [example](../.sandbox-config.example.json)) for its agent,
toolchains and versions, databases, git access, extra folders and setup scripts. `sandbox config check` checks one
without starting anything.

A repo can ship this file, so it is **untrusted**:

- **You approve it** the first time and again whenever it changes. The approval prompt flags read/write folders and is
  shown without colours or escape codes, so the file cannot hide lines.
- **It can only make protections stricter:** read-only, git `readonly`/`none`, the LAN block, protected client, and
  narrowing the clipboard (`"shared"` -> `"text"` -> `"off"`, `sandbox.clipboardDirection`) and turning off network,
  microphone, camera, printers, vGPU, login copying, copying tools from this PC
  (`provisioning.copyFromHost`) and history or claude-mem sync, and turning on `downloads.requireChecksum`. A looser
  value is used only if you allow it: an interactive launch asks once ("Allow these for this project?"), and the answer
  is kept on this PC for that exact file. `--trust-config` never allows one. Or set it in your own settings.
- **Folders outside the project** (after `%VARIABLES%` and links are resolved) follow `projects.allowOutsideMappings`
  in your settings: `"ask"` (default) asks at an interactive launch, once per file and folder; `true` allows them;
  `false` refuses them. Without a terminal, `"ask"` stops the launch. Answers are kept in
  `<storage>\allowed-requests.json`, which no repo or sandbox can write. A folder inside the project mapped a second
  time is refused while `workspaceFilter` is on.
- **Its `scripts`** must be files inside the project.
- **Its `toolchains.environment`** cannot set variables that the sandbox sets, that carry logins or that redirect a
  server: `AGENT_*`, `GIT_*`, `GH_*`, `NODE_*`, `PATH`, `BASH_ENV`, proxies (`*_PROXY`), `*_BASE_URL` / `*_ENDPOINT`,
  certificate bundles, `ANTHROPIC_*`, `CLAUDE*`, `OPENAI_*` and other agent and cloud prefixes. Registry mirrors such as
  `NPM_CONFIG_REGISTRY` or `PIP_INDEX_URL` are fine.
- **Apps:** it may add catalogue apps (`apps.install`, added to yours), but never programs of its own (`apps.custom`)
  and never the agent add-ons (`rtk`, `headroom`, `ccusage`, `playwright-mcp`, `context7`, the Perplexity and
  browser MCP servers) or Comet.
- **Never:** storage, agent executables, secrets handling, CPU, memory, the paging file, host folders for tools or
  Claude settings, or any setting marked "yours only" above.

## Several projects in one sandbox

How projects join a running sandbox is in [projects](projects.md). These settings decide which folders are mapped at
every start. They are yours only, because they map folders of your PC.

| Setting                         | Default |                                                                                                                                                                                    |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects.roots`                | none    | folders whose subfolders are your projects (e.g. `F:\Code`), mapped read/write at every start as `C:\Projects\<name>`. Every project inside opens without a restart, also new ones |
| `projects.all`                  | `false` | also map every project you have started before (`sandbox projects choose` / `all on`)                                                                                              |
| `projects.exclude`              | none    | projects left out of `all`                                                                                                                                                         |
| `projects.askToAddRoot`         | `true`  | when you start a project whose parent is not a root, ask once whether to add it                                                                                                    |
| `projects.declinedRoots`        | none    | parents you said no to (not asked again)                                                                                                                                           |
| `projects.allowOutsideMappings` | `"ask"` | may a project file map folders outside its project? `"ask"`, `true` or `false` ([project settings](#project-settings))                                                             |
| `projects.wsbShare`             | `true`  | on Windows 11 24H2+ with the updated Windows Sandbox, add folders live with `wsb share` (untested)                                                                                 |
| `projects.liveFolders`          | `"off"` | **(Alpha, untested on a real PC)** `"hcs"` adds folders live through HCS where `wsb share` is missing ([live folders](projects.md#live-folders-through-hcs-alpha))                 |

## Reopening sessions

Your settings only.

| Setting                    | Default | What it does                                                                                                                                                                                           |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resume.sessions`          | `"ask"` | when a sandbox starts after one that had agent sessions: `"ask"` lists them and asks; `"always"` reopens them; `"afterCrash"` reopens them only after a crash; `"never"` leaves it to `sandbox resume` |
| `resume.restartAfterCrash` | `false` | when Windows Sandbox crashes or runs out of memory, start it again and reopen its sessions. At most 3 times in 6 hours                                                                                 |

Each session reopens in its own folder and continues its own conversation when the agent can open one by id
(`harnesses.<agent>.resumeOneArguments`; Claude: `--resume {id}`), else the agent's last one (`resumeArguments`). Only
sessions this tool started are reopened, not terminal tabs you opened yourself.

## Accounts

```powershell
sandbox account save personal          # save the login now in the sandbox
sandbox account save work --from-host  # or this PC's login
sandbox account save credits --api-key # or an Anthropic API key you paste in (not shown)
sandbox account default personal       # every launch starts on it (the running sandbox switches too)
sandbox account use work               # switch now: Claude restarts and continues the conversation
sandbox claude --account work          # this launch only
```

The same works for every agent that keeps a login (`--agent codex` and so on). `use` lasts until the next launch;
`default` stays. When sessions are running, both offer to restart them under the new login (`--no-restart` skips that).

Service sign-ins (Epic, Steam, Unity, a FiveM server key, Android and app-store keys) are in Accounts too:
`sandbox account status | import | login | logout <service>`, and `accounts.<service>.share` (default off) lets
sandboxes have one. A project file can only turn sharing off. See [accounts](accounts.md).
A Claude account is one of three kinds, and `account list`, the menu and the web UI say which:

- **subscription**: a Claude Pro, Max, Team or Enterprise login (`/login` with your Claude account).
- **Console**: a Claude Console (platform) login. Claude Code makes an API key for it; that key is what is saved.
- **API key**: an Anthropic API key from the Claude Console, for free or paid API credits. Any key from the Console is accepted, whatever its prefix (`sk-ant-api03-...`, `skt-ant-usr-...`).

`save` takes whichever login the sandbox (or, with `--from-host`, this PC) has. `--api-key` saves a key instead: you
paste it in (it is not shown), or with `--from-host` it takes this PC's Console key, else its `ANTHROPIC_API_KEY`. A key
must be one from the Claude Console: text with spaces, or under 20 characters, is refused. Only the key's prefix (`sk-ant-...`) and its last 4 characters are ever shown. Using an API key
account puts the key where Claude Code keeps a Console login's key, already approved, so Claude does not ask "Do you
want to use this API key?". It also takes the subscription out of the sandbox, because Claude prefers a subscription
over a key. Switching back to a subscription takes the key out again. An `ANTHROPIC_API_KEY` you set in the agent's
`environment` comes before any saved account (Claude asks once whether to use it).

Your PC's plugins (`plugins` in `claudeProfile.include`) are copied at launch, with their paths rewritten to the
sandbox's Claude folder. The copy is limited to 250 MB. Leftovers Claude never reads (`temp_*` folders from interrupted
clones, `*.backup` and `*.staging` marketplaces) are always left out; if the rest is still over the limit, git history
(`.git`) is left out, then `node_modules`. Only when it still does not fit is `plugins` skipped, and the launch says so.

Plugins installed in the sandbox stay when you switch accounts, because all accounts of a data set share one Claude
folder. They do not reach another data set. Set `claudeProfile.sharePluginsAcrossAccounts: true` to copy them into a
data set that has none yet (the plugins folder and the plugin entries of `settings.json`; logins are not touched). The
copy is limited to 1 GB / 20,000 files and a project file cannot turn this on. Plugins are code: with this on, a plugin
installed in one sandbox runs in your other sandboxes too.

## Installs on this PC

`pcInstalls` maps games, engines and editors already installed on this PC into sandboxes, read-only under
`C:\PcInstalls` (nothing is copied, nothing lands on the sandbox's disk). All off by default; yours only.

| Setting                    |                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------- |
| `pcInstalls.steamGames`    | `true` (every Steam library) or a list of app IDs, e.g. `[480]`                  |
| `pcInstalls.epicGames`     | `true` or a list of Epic app names                                               |
| `pcInstalls.unrealEngines` | `"auto"` (default: whenever the sandbox is set up for Unreal), `true`, `false`, or a list of versions, e.g. `["5.4"]` |
| `pcInstalls.unrealEngineFolders` | a list of engine folders of this PC, mapped writable (a source build, or a copy of an engine) |
| `pcInstalls.unrealAssets`  | `"auto"` (default), `true` or `false`: the launcher's vault cache (Fab and Marketplace packs), read-only |
| `pcInstalls.unityEditors`  | `"auto"` (default: whenever the sandbox is set up for Unity), `true`, `false`, or a list of versions, e.g. `["6000.0.32f1"]` |
| `pcInstalls.unityAssets`   | `"auto"` (default), `true` or `false`: this PC's Asset Store downloads (`.unitypackage`), read-only |

Unreal is described in [game engines](game-engines.md), Unity in [Unity](unity.md). The agent can read what is mapped.

## Unity

`toolchains.unity` sets Unity up for a project: its editor and modules, the Unity CLI, and the agents' MCP server and
skills. Your licence is accepted with `toolchains.unity.acceptLicense` (a project file cannot accept it for you).
Editors, modules, licence and the Asset Store are in [Unity](unity.md). These four are the agent settings:

| Setting                          | Default              | What it does                                                                                                   |
| -------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `toolchains.unity.mcp`           | `true`               | the Unity CLI's MCP server as `sbx-unity` in Claude Code and Codex (read-only tools; the open editor's tools need the Unity Pipeline package) |
| `toolchains.unity.agentSkills`   | `true`               | Unity's skills for Claude Code and Codex, synced every boot                                                    |
| `toolchains.unity.cliVersion`    | `"1.0.0-beta.16"`    | the Unity CLI version, checked against the SHA-256 Unity publishes: a version, or `"latest"`. It never updates itself |
| `toolchains.unity.assetCache`    | `"persisted"`        | where Asset Store downloads made in the sandbox go: `"persisted"` (`tools\unity\asset-store`, kept), `"pc"` (this PC's downloads, read-only) or `"local"` (lost on close) |

The other keys (`enabled`, `acceptLicense`, `version`, `modules`, `hub`, `keepVersions`) are described in
[Unity](unity.md).

## Hooks

`.ps1`, `.mjs` or `.cmd` files in `~/.agent-sandbox/hooks/pre-provision`, `pre-agent` or `post-agent` run inside the
sandbox at that point, in name order. Use them for real installers (MSI, winget), which must run again every boot.

The hooks keep their contract with the parallel boot: `pre-provision` runs before any developer tool is set up, and
`pre-agent` runs alone, after everything else the boot does before the agent starts (the toolchains, the environment,
Git, the VPN, Claude's settings and the agent's install); the agent starts after it. Visual Studio (and what needs it:
Unreal, Rust with the MSVC host) is the one exception: the first time, unless a VPN or `network.allowOnly` is on, it
installs in the background after the agent has started, so `pre-agent` hooks do not wait for it. The sandbox's log says
when it is done. Later boots put the saved copy back in seconds, before the agent starts.

## Agent commands

Turn them on with the **Agent commands** switch (menu: Agents > On this PC; web: Agents), `sandbox agent-commands on` or `agentCommands.enabled`. They make the agents installed on this PC start in the sandbox.
Type `claude` (or `codex`, `gemini` ...) in any project folder, and it starts in a hidden sandbox for that folder and
attaches your terminal, like `sandbox claude -t --headless`. Arguments go to the agent.

- It writes a small forwarding command for each agent on your PATH into `<storage>\agent-commands`, and puts that folder
  first on **your** PATH (nothing else changes). Open a new terminal afterwards.
- `$env:SANDBOX_AGENT_DIRECT=1` (cmd: `set SANDBOX_AGENT_DIRECT=1`) runs the real agent on this PC instead.
- `sandbox agent-commands off` removes the commands and the PATH entry. `status` shows what is forwarded.
- Agents installed later are picked up at your next launch. An agent on the machine-wide PATH is not overridden.
- The commands call the installed program's own launcher, so they keep working after an update. If the program is
  uninstalled or moved, `claude` simply runs the real agent again; the uninstaller also removes the commands and the PATH
  entry.
- Changing `agentCommands.*` anywhere (menu, web, `sandbox config set`) updates the files and your PATH at once.
- Arguments are passed on as typed. `cmd.exe` expands an unquoted `%` or `^` before the command runs, as it does for any
  `.cmd` file; quote such arguments.

## The HCS engine (Alpha)

`sandbox.engine: "hcs"` runs agents in a headless, Hyper-V isolated Windows Server Core container instead of Windows
Sandbox. **Starting it is not enabled yet in this alpha**: a launch passes the check and stops with that message.

- It needs Windows features you turn on yourself (Containers, and Hyper-V or Virtual Machine Platform), an account in
  Administrators or Hyper-V Administrators, and a Server Core (ltsc2022) image already on this PC (for example pulled by
  Docker Desktop, or a folder named in `AGENT_SANDBOX_HCS_IMAGE`).
- `sandbox engine check hcs` lists what is missing, with the exact commands. It changes nothing.
- It has no desktop, GPU, shared clipboard (text copies through attached terminals), audio, camera or network yet.

How it compares with Windows Sandbox: [security](security.md#the-hcs-engine-alpha-compared-with-windows-sandbox).
Design: [design/engines.md](design/engines.md).

## Copy and paste

`sandbox.clipboard` sets how text moves between your PC and the sandbox. `"off"` means no clipboard at all.

- `"text"` (default): text only, through this tool, and Protected Client stays on. A copy in the sandbox reaches your PC
  only while the sandbox window is in front (or within 2 seconds after you leave it). The text on your PC's clipboard
  goes into the sandbox when you switch to its window, also when it first opens. Copies are text only, at most 1 MB.
- `"shared"`: Windows Sandbox's own clipboard, for text, images and files, all the time. Protected Client blocks it, so
  that sandbox starts with Protected Client off, and the launch says so in one line.

`sandbox.clipboardDirection` (only for `"text"`) can limit copying to `"toPc"` or `"toSandbox"`. A project file can only
narrow these: `"shared"` -> `"text"` -> `"off"`, and `both` -> one way -> `"off"`.

- HCS has no shared clipboard: text copies through attached terminals.
- A headless sandbox has no window to switch to: use `sandbox attach`. The agent's copy reaches your PC there.
- Refused copies are counted, never logged with their text, in the watcher log `host-sync-<data>.log`.

## CPU, RAM and GPU

A project file may ask for `memoryMb` and `vGpu` (a looser value needs your approval). Everything else here is yours
only.

| Setting                         | Default  |                                                                                                                                                                                    |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.cpuLimit`              | `80`     | the most of your PC's CPU the sandbox may use, in percent (`"none"` = all of it)                                                                                                   |
| `sandbox.memoryMb`              | `"auto"` | the sandbox's RAM. `"auto"` = free RAM minus `reserveHostMb`, also within your PC's unused commit (RAM plus paging file), at most `maxMemoryPercent` of your RAM and `maxMemoryMb` |
| `sandbox.reserveHostMb`         | `8192`   | RAM kept for your PC                                                                                                                                                               |
| `sandbox.maxMemoryPercent`      | `80`     | the most of your RAM the sandbox may get                                                                                                                                           |
| `sandbox.maxMemoryMb`           | `32768`  | the most RAM the sandbox may get, in MB                                                                                                                                            |
| `sandbox.pageFileMb`            | `16384`  | the sandbox's paging file, made at full size at start so it never grows under load (`0` = Windows' own ~1 GB, which parallel builds run out of)                                    |
| `sandbox.pressureResponse`      | `true`   | slow the heaviest builds down when memory runs low (the governor), and hold new compilers for a moment when memory grows very fast (the memory gate)                                                                                                                  |
| `sandbox.agentMemoryHeadroomMb` | `"auto"` | the last-resort backstop: how far below the sandbox's commit limit the agents' programs are stopped from taking more (`"auto"` = the larger of 1536 MB and 3 %; `"none"` = off)    |
| `sandbox.vGpu`                  | `false`  | the GPU, on or off                                                                                                                                                                 |

- **CPU.** Windows Sandbox has no CPU setting, so the sandbox caps itself with a Windows job object. Everything this
  tool starts inside inherits the cap (agents, installs, builds, its terminal tabs). Programs started from the sandbox's
  own Start menu are not covered.
- **RAM** is fixed when the sandbox starts.
- **GPU.** Windows Sandbox can only turn it on or off. With vGPU on, the sandbox runs gentler by itself (a lower CPU cap,
  earlier memory steps). Browsers in the sandbox (Edge, Chrome) never use the GPU, because a browser next to a game on
  the vGPU has crashed the whole sandbox; they draw in software, and WebGL still works.

How the sandbox behaves under heavy load: [troubleshooting](troubleshooting.md#the-sandbox-closes-under-heavy-load).
