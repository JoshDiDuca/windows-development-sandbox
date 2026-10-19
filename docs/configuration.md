# Configuration

## Your settings

The easiest way: `sandbox`, then **Settings**. Every setting is listed by section with its current value and what it
does; pick one to change it (on/off and choices as lists) or reset it to the default. Changes are saved to your config
file, keeping its comments, and only when the result is valid.

`sandbox config init` creates `~/.agent-sandbox/config.json` with every setting and its default (see
[config.example.json](../config.example.json)). Keep only what you change. VS Code shows docs and autocomplete from
its JSON Schema (`sandbox config schema` prints the setting that turns it on). `sandbox config show` prints your
settings with the defaults filled in. Comments and trailing commas are allowed in the file. Use another file with
`--config <file>` or `AGENT_SANDBOX_CONFIG`.

Share your settings with a team: `sandbox config export team.json` writes only what differs from the defaults, and
`sandbox config import team.json` shows what it would change (`sandbox.memoryMb: 8192 -> 4096`), asks once and applies
it, keeping your file's comments. Secrets (an agent's API keys), the data folder and folders or files of this PC are
left out of an export (`--with-paths` keeps the folders and files) and are never taken from an import, even if the file
has them; both say what they skipped. The menu has the same under Settings > General.

The menu opens on the section, category and search you left it on, also after you close it (kept in
`~/.agent-sandbox/menu-state.json`; delete the file to start on Agents). In Apps, **Request an app…** (key `r`) opens a
prefilled request form on this project's GitHub issues page.

Commonly changed:

| Setting | |
|---|---|
| `defaultHarness` | the agent `sandbox launch` starts |
| `toolchains.<lang>.enabled` | `true`, `false` or `"auto"` (only when the project uses it). Every tool is like this, Bun, uv and VS Code too, and a project's `.sandbox-config.json` can set it |
| `toolchains.<lang>.version` | default versions; project version files still win |
| `databases.<db>.enabled`, `.port` | `true`, `false` or `"auto"`, and the port inside |
| `sandbox.memoryMb`, `.headless`, `.vGpu`, `.networking` | RAM, no window, GPU, internet. vGPU lets heavy use freeze the whole PC with some graphics drivers: leave it off unless a program needs the GPU; with it on the sandbox runs gentler by itself (lower CPU cap, earlier memory thresholds) |
| `sandbox.engine` | **(Alpha)** what runs the sandbox: `"windows-sandbox"` (default, everything described here) or `"hcs"`: a headless Hyper-V isolated Windows Server Core container for agents. `hcs` needs Windows features turned on by you (Containers and Hyper-V or Virtual Machine Platform), an Administrators or Hyper-V Administrators account, and a Server Core (ltsc2022) image already on this PC (for example pulled by Docker Desktop, or a folder named in `AGENT_SANDBOX_HCS_IMAGE`); `sandbox engine check hcs` lists what is missing with the exact commands, and changes nothing. It has no desktop window, no GPU, no clipboard, no audio or camera, and no network yet. **Starting it is not enabled yet in this alpha** (a launch with `hcs` passes the check and stops with that message). `sandbox engine` shows the engine in use and what each can do. Your setting only: a project's `.sandbox-config.json` cannot set it |
| `sandbox.pageFileMb` | size of the sandbox's paging file, created at full size at start so it never grows under load (default `16384`; `0` = Windows' own ~1 GB, which parallel builds run out of) |
| `sandbox.keepAwake` | keep this PC from sleeping while a sandbox runs (default `true`), so agents left overnight keep working. The screen may still turn off; closing a laptop lid still sleeps it |
| `sharing.otherUsers` | let other Windows users of this PC use a sandbox you start: list its sessions, attach, run commands and stop it (default `false`). They use the agent logins inside it, and history goes to your account. Only your own settings can set it, never a project's `.sandbox-config.json`. A machine file (`%ProgramData%\AgentSandbox\config.json`, all-users installs) is read first; your file wins |
| `sandbox.cpuLimit` | most of your PC's CPU the sandbox may use, in percent (default `80`; `"none"` = all of it). Your setting only: a project file cannot change it |
| `sandbox.maxMemoryPercent`, `.maxMemoryMb`, `.reserveHostMb` | `memoryMb: "auto"` = free RAM minus `reserveHostMb` (8 GB), and also this PC's unused commit (RAM plus paging file) minus `reserveHostMb`, at most `maxMemoryPercent` (80) of your RAM and `maxMemoryMb` |
| `sandbox.agentMemoryHeadroomMb` | the last resort that keeps the sandbox up: how far below the sandbox's commit limit (RAM plus paging file) everything the agents start together is stopped from committing more. Builds are slowed down long before that (`sandbox.pressureResponse`); this only ever matters at the very edge, where Windows inside the sandbox would otherwise start failing, and then a build is refused memory instead of Windows (default `"auto"` = the larger of 1536 MB and 3 % of the commit limit; a number of MB; `"none"` = no backstop). Your setting only |
| `sandbox.pressureResponse` | when the sandbox (or this PC) runs low on memory, slow the heaviest build programs down and, if needed, pause the biggest compiler for a few seconds (default `true`; see troubleshooting "The sandbox closes under heavy load"). Your setting only |
| `attach.auto` | starting an agent attaches this terminal automatically (like `-t`) |
| `agentCommands.enabled` | **(Beta)** typing `claude`, `codex` ... on this PC starts the agent in a hidden sandbox and attaches (default off) |
| `agentCommands.agents` | `"auto"` = every agent installed on this PC, or a list such as `["claude", "codex"]` |
| `web.enabled`, `web.port`, `web.openOnLaunch` | **(Beta)** the web UI ([web-ui.md](web-ui.md)) on `127.0.0.1:<port>` (default `47800`, this PC only); off by default and not settable from a project. With `web.enabled` on, every sandbox start also starts it in the background (it keeps running until `sandbox web stop`); with `web.openOnLaunch` on too, your browser opens it already signed in. `sandbox web start` / `open` work either way. The address alone does not sign you in: open it with `sandbox web open` (or `web.openOnLaunch`) |
| `attach.autoHide` | the sandbox window hides whenever this terminal attaches (`sandbox show` brings it back) |
| `attach.confirmCtrlC` | on (default): a single Ctrl+C in an attached terminal or the sandbox window is held back (the title says so) and only a second one within 1.5 s reaches the agent, so a Ctrl+C meant as "copy" no longer stops it; Esc still stops an agent. In the web terminal, Ctrl+C with text selected copies it |
| `provisioning.git.access` | `full`, `readonly` or `none` |
| `secrets.allow`, `secrets.patterns` | let named variables through, or strip more |
| `downloads.requireChecksum` | `true` refuses toolchain, database and tool downloads that have no published checksum (default `false`; downloads that have one are always verified) |
| `toolchains.environment` | extra environment variables (e.g. registry mirrors) |
| `toolchains.msvc.acceptLicense` | `true` to allow installing MSVC (see [toolchains](toolchains.md#msvc)) |
| `toolchains.rust.host`, `.targetDir`, `.crates` | Rust target (`auto`, msvc or gnu), where builds go, and binaries to install with cargo |
| `toolchains.rust.linker`, `.linkSlots` | GNU host: `"lld"` (default, far less memory than GNU ld) or `"gnu"`, and how many programs may link at once in the whole sandbox (`"auto"` = one per 3 GB after 6 GB of the sandbox's memory, 2 to 8; the memory governor slows links down too when memory runs short) |
| `toolchains.cli.gh`, `.zstd`, `.openssl` | small command-line tools |
| `toolchains.mesa.enabled`, `.vulkan` | software OpenGL / Vulkan when there is no GPU |
| `apps.install`, `apps.custom` | apps from the catalogue and programs of your own ([toolchains](toolchains.md#apps-and-tools)); `"rtk"` adds the rtk agent add-on and its Claude Code hook ([agent add-ons](toolchains.md#agent-add-ons)), your setting only |
| `harnesses` | agents and how to install them; `home` says where an agent keeps its login (variable -> folder in the saved state, the login files, the folder on this PC) so logins can be saved and switched. An agent with no variable for it lists `profileDirs` (folders in the sandbox's user profile, such as `.qwen`): each is linked to `state\<agent>\profile\<folder>`, so its login survives the sandbox, and its `loginFiles` start with `profile/`. `localState` (variable -> folder in the agent's saved state) is for agents that keep SQLite databases (codex): SQLite cannot run in the shared data folder, so the agent runs from a copy on the sandbox's own disk (the variable points to it); the copy is restored at start and saved again after the agent exits. Every configured agent also gets its command (`claude`, `codex` ...) in every terminal tab: when it is not installed yet, the command installs it on first use (`sbx-agent list` shows them) |

## Paths

| Setting | Default | |
|---|---|---|
| `storage.root` | `%ProgramData%\AgentSandbox\users\%USERNAME%` | everything kept on your PC between sandboxes (see [Where your data is kept](#where-your-data-is-kept)). The name `AgentSandbox` is from before the rename and is kept on purpose |
| `storage.dataName` | `default` | the persistent data set (`C:\AgentData` inside); a different one per untrusted project keeps its tools separate |
| `storage.contained`, `storage.containedMaxGb` | **(Beta, not yet tried on a real PC)** `"off"` (default) keeps tools, state and logs in loose folders; `"vhdx"` keeps them in one disk image (`<storage>\images\<dataName>.vhdx`, a dynamic NTFS disk of at most `containedMaxGb` GB, default `64`) that is mounted on a private folder only while a sandbox runs. Turn it on and off with `sandbox storage contained on` / `off` (they ask first, move your files and show size and time); the setting is written for you. Windows asks for permission to mount it each time a sandbox starts. See [Contained storage](#contained-storage-beta). Your setting only: a project's `.sandbox-config.json` cannot set them |
| `guestWorkspace` | `C:\Workspace\<folder>` | where the project appears inside; `"mirror"` = the same path as on your PC (e.g. `F:\Projects\game`; falls back for `C:\Users\...`). Where projects appear with several projects: [projects](projects.md#where-a-project-appears-inside-the-sandbox) |
| `mappings` | none | more folders from your PC, read-only or read/write: `{ "host": "F:\\SteamLibrary\\steamapps\\common\\Game", "readOnly": true }`; `guest` (where it appears) is optional, `optional: true` skips a folder that is not on this PC |

Where a mapped folder appears:

- No `guest`: at the same path as on your PC (`C:\SteamGame` stays `C:\SteamGame`, `F:\SteamLibrary...` stays
  `F:\SteamLibrary...`). A folder inside the project is already in the sandbox with the project, so it needs no
  mapping (with `workspaceFilter` on, give it a `guest` path outside the project to bring a git-ignored folder in).
- `guest` given: exactly there. A full path: any `C:` folder, or any path on D: to Z:.
- A folder that cannot appear at its path stops the launch, and the message names each such folder, why, and the fix:
  a relative path, the folders the sandbox keeps for itself (`C:\Windows`, `C:\Program Files*`, `C:\ProgramData`,
  `C:\Users`, `C:\AgentData`, `C:\AgentLaunch`, `C:\HostTools`, `C:\nvm`, `C:\Mirror`), a path already used by the
  project, `C:\Projects` or another mapping (the same folder or one inside the other), a drive root, `A:`/`B:`, or a
  path Windows cannot have. Folders are never moved somewhere else. `sandbox config check` shows where each folder will
  appear, and any problem, before you launch.

Windows Sandbox can only map onto C:, so a guest path on F: is mapped to `C:\Mirror\F\...` and `subst F: C:\Mirror\F` runs at
boot. Tools that resolve real paths may print the `C:\Mirror` form; history sync understands both. A letter that already
exists in the sandbox is left alone.

Under `storage.root`: `data\<name>` (tools, databases, logins, logs), `launches\` (one per start; cleaned after 7
days), `accounts\`, `sync\`, `known-projects.json` (the folders you started projects in) and `run\projects.json` (the
running sandbox's projects). The last two are host-only: the sandbox cannot read or change them.

### Contained storage (Beta)

**Beta, and not yet tried on a real PC** (the code is tested with a fake disk and the scripts in a dry-run mode; mounting a disk image needs a PC, not a sandbox).

Normally the sandbox's tools, state, logs, databases and caches are loose folders in `<storage>\data\<name>`: many files that scanning programs inspect one by one. With `storage.contained: "vhdx"` they live in one disk image file instead:

- The image is `<storage>\images\<name>.vhdx`, a dynamic NTFS disk (it grows as it fills, up to `storage.containedMaxGb`). It is mounted at `<storage>\mounts\<name>` (a folder, **no drive letter**) when a sandbox starts and dismounted when it ends.
- `run\` (how this tool and the sandbox talk) stays a normal folder on your PC, because this tool reads it. `tools`, `state`, `logs`, `databases` and `cache` come from inside the mounted image and appear in the sandbox at the same places as before (`C:\AgentData\tools` ...). Anything else in the data folder stays a plain folder on your PC and is not shared.
- **One Windows permission prompt** appears when a sandbox starts (to mount) and one when it ends (to dismount); declining the second leaves the image mounted, and `sandbox repair` dismounts it.
- `sandbox storage contained status` shows the setting, the image and whether it is mounted. `sandbox storage contained on` makes the image (asking first, showing the size limit), offers to move your current tools, state and logs into it (with size and time) and writes the setting. `sandbox storage contained off` moves everything back to plain folders (with size and time), dismounts, and only then asks whether to delete the image file (default: keep it). Nothing is ever deleted without that question.
- While an image is mounted, `sandbox storage move` / `use` wait (a move would reach into the image). Contained storage needs Windows with `diskpart`, and does not work inside a Windows Sandbox.
- Some host views (`sandbox data`, `sandbox clean`, the menu's data screens) still look at the plain data folder, so they show nothing for what is in the image; the Claude login sync, the terminal and ConPTY downloads, `sandbox logs` and the crash report do follow the image while it is mounted.

What it does and does not protect is in [security](security.md#contained-storage-beta); problems (a stale mount, "the image is in use") are in [troubleshooting](troubleshooting.md#contained-storage-beta).

### Where your data is kept

New installs keep everything in `%ProgramData%\AgentSandbox\users\<you>`, a folder only you (and SYSTEM and
administrators) can read. It works for an install for just you and for one for everyone, so switching between them
needs no move.

- **Upgrading** from a version that kept it in `%LOCALAPPDATA%\AgentSandbox`: nothing moves. The update pins
  `storage.root` to that folder in your `config.json` (comments kept), and the next `sandbox` command or the menu asks
  once whether to move the data to the default folder, with its size and an estimate ("Move now", "Not now" for two
  weeks, "Don't ask again"). Without a terminal nothing is asked.
- **Moving later**: `sandbox storage` shows where the data is; `sandbox storage move <folder>` moves it (a rename on the
  same drive, a verified copy to another drive, a warning above 5 GB or 200,000 files, refused when the target drive
  lacks room or a sandbox runs). The menu has the same under Settings > General > Data folder, with a folder browser.
  If a move fails, the old folder and your config are left as they were.
- **Always pinned**: after a move or `sandbox storage use`, `storage.root` is written to your `config.json`, so an older
  version you go back to finds the data too. A downgrade followed by an upgrade is offered the move again when the
  configured folder is empty and an earlier one holds data (earlier folders are remembered in
  `~\.agent-sandbox\storage-history.json`).

## Several projects in one sandbox

Starting an agent from another project while a sandbox runs adds that project to it: its own folder, `.sandbox-config.json`,
versions, toolchains, databases and environment. How that works, where each project appears inside the sandbox and the
consent prompts are in [projects](projects.md). These settings, in **your** config only (a project file can never set
them, because they map folders of your PC), decide which folders are already there:

| Setting | Default | |
|---|---|---|
| `projects.roots` | none | folders whose subfolders are your projects (e.g. `F:\Code`), mapped read/write at every start as `C:\Projects\<name>` (at their PC path with `guestWorkspace: "mirror"`). Every project inside, also one created later, opens without a restart, and is always under that folder (also when it started the sandbox) |
| `projects.all` | `false` | also map every project you have started before, at every start (`sandbox projects choose` / `all on`) |
| `projects.exclude` | none | projects left out of `all` |
| `projects.declinedRoots` | none | parent folders you said no to when asked to add them as roots (not asked again) |
| `projects.askToAddRoot` | `true` | when you start a project whose parent is not a root, ask once whether to add it (answers are saved: yes adds it, no is remembered in `projects.declinedRoots`, never turns this off) |
| `projects.allowOutsideMappings` | `"ask"` | may a project's `.sandbox-config.json` map folders outside the project (see [project settings](#project-settings))? `"ask"`, `true` or `false` |
| `projects.wsbShare` | `true` | on Windows 11 24H2+ with the updated Windows Sandbox, add other folders live with `wsb share` (untested; otherwise a restart is offered) |

## Machine settings (everyone installs)

An all-users install writes `%ProgramData%\AgentSandbox\config.json` (only administrators change it). It is read under
your own file, so your settings win. The installer puts two things in it:

```json
{ "storage": { "root": "%ProgramData%\\AgentSandbox\\users\\%USERNAME%" }, "sharing": { "otherUsers": false } }
```

`%USERNAME%` is replaced for each user, so everybody gets a private storage folder. Folders in this file must be full
paths. Whether new versions install themselves is not a
setting: it lives in the install folder's `install.json` and is changed with `sandbox update --auto on|off`.

## Network

The **Network** category of the settings (or `network` in your file):

| Setting | |
| --- | --- |
| `blockPrivateRanges` | your LAN (and SMB) is unreachable from the sandbox; DNS to the gateway still works (on by default) |
| `allowOnly` | only these hosts can be reached once the sandbox is set up (tools still download first). `*.example.com` covers its subdomains; `@developer` adds package registries, GitHub/GitLab, toolchain downloads and the AI providers. Programs go through a small proxy inside the sandbox (`HTTP_PROXY`, and the Windows proxy setting for browsers); everything else is blocked by the sandbox's firewall. Refused hosts are listed in `logs\netproxy.log` |
| `blockHosts` | names that go nowhere (the sandbox's hosts file), e.g. production servers or telemetry; exact names, no wildcards |
| `forwardPorts` | `{ "pc": 3000, "sandbox": 5173 }`: `http://localhost:3000` on your PC reaches port 5173 inside while the sandbox runs, even a dev server that only listens on localhost there. Only this PC can use it; no admin rights needed |
| `dns` | DNS servers for the sandbox, e.g. `["1.1.1.1", "9.9.9.9"]` |
| `proxy` | your HTTP proxy for everything in the sandbox (`HTTP_PROXY` / `HTTPS_PROXY`), e.g. `http://proxy.corp:8080`; with `allowOnly`, the sandbox's proxy hands on to it. No `user:password@` in the address: it would sit in plain text where the agent can read it, so it is refused (use a proxy that needs no login) |

These are applied inside the sandbox, where the agent is an administrator: they keep a well-behaved agent (and the
tools it runs) in bounds, but a determined one could undo them. `sandbox.networking: false` is the only hard isolation.
A project's `.sandbox-config.json` may add `blockHosts` and turn on `blockPrivateRanges`, nothing else here.

## VPN (alpha)

**Alpha: not yet tried on a real PC.** The **VPN** settings (Network category, or `vpn` in your file) send the sandbox's traffic through a VPN. Only the
sandbox: your PC's own connection is untouched. Plain steps for NordVPN: [vpn.md](vpn.md).

| Setting | |
| --- | --- |
| `enabled` | the VPN is on for new sandboxes (off by default). Needs a saved login: `sandbox vpn login` |
| `provider` | `nordvpn` (a recommended server is picked at every launch), `openvpn-file` (your own `.ovpn`) or `wireguard-file` (your own WireGuard `.conf`); both files are `configFile` |
| `protocol` | `udp` (faster) or `tcp` (gets through networks that block udp); WireGuard is always udp |
| `country` | NordVPN only: e.g. `uk`, `us`, `Germany`; empty = the best server anywhere |
| `configFile` | `openvpn-file`: the `.ovpn` on this PC, certificates inside it. `wireguard-file`: the `.conf` on this PC (at most 16 KB; its private key is read only when a sandbox starts). Files that run programs (`script-security`, `up`, `down`, `plugin`, `PostUp`, `PreUp` ...) are refused |
| `killSwitch` | block everything that does not go through the tunnel; when the tunnel cannot start the sandbox stays offline (on by default) |

A WireGuard config needs no saved login (the keys are in the file). The login is not a setting: it is typed hidden by `sandbox vpn login` (or Settings > Network > Set NordVPN login),
kept encrypted for your Windows user and handed to the sandbox only while it starts. A project's
`.sandbox-config.json` can turn `killSwitch` on, never off, and can never choose a VPN, a server, a profile or a login.

## GitHub token

Off by default. Sandboxes never get your PC's GitHub login. If you want `gh` and https `git` to work in them without
logging in each time, make a token only for sandboxes and save it:

1. `sandbox github login` (or Settings > Security & privacy > Set GitHub token…, or Settings > GitHub in the web UI). It
   prints the steps: at <https://github.com/settings/personal-access-tokens/new> make a **fine-grained** token, choose
   only the repositories the agent should reach, give only the permissions it needs (for example Contents and Pull
   requests read and write, Actions read) and set an expiry. Paste it when asked: it is typed hidden, kept encrypted
   for your Windows user, and never printed. A classic token (`ghp_`) is accepted with a warning; an OAuth token
   (`gho_`, from `gh auth token`) is refused, because it reaches everything your account can.
2. `sandbox config set github.shareToken true`.

| Setting | |
| --- | --- |
| `github.shareToken` | give each new sandbox the saved token (off by default). Only when its git access (`provisioning.git.access`) is `full`; otherwise the launch says why it was not sent |

The token goes to the sandbox only in the one-shot secrets file, never in `session.json`, the launch folder or a log.
Inside, `gh` logs in with it in a folder on the sandbox's own disk (gone when the sandbox closes, unlike a `gh auth
login` made inside, which is kept in `C:\AgentData\state\gh`), and https git to github.com asks `gh` for it. **The
agent in the sandbox can read the token** and use it for everything it allows. `sandbox github logout` deletes it from
this PC; revoke it on GitHub too. A project's `.sandbox-config.json` cannot set anything under `github`. More:
[security](security.md#github-cli).

## Agent environment variables

`harnesses.<agent>.environment` holds variables for one agent, such as an API key. Their values are shown as `***` in
`sandbox config show`, in the settings screen and in every `--json` output (typed with each character hidden in the
screen), and they reach the sandbox in a one-shot file that the sandbox reads and deletes, never in `session.json` or
the launch folder. The agent can read its own environment, which is the point; so can anything else it runs.
`toolchains.environment` is for tool settings (registry mirrors), not for secrets.

## Audit log

The audit log is **on by default** (`audit.enabled`; menu: Settings > Security & privacy > Audit log). It keeps a
record on your PC of what your agents did, in `<storage>\audit\<data set>`, where the sandbox cannot reach it. Turn it
off with `sandbox config set audit.enabled false`.

- **Programs started** in the sandbox, with their command lines (`audit.processes`): Windows' own process auditing,
  so it covers every agent and everything they start. Windows' background programs are left out. **Secrets are hidden**
  before a line is written: tokens and keys recognised by their shape, passwords in URLs, `Authorization:` headers,
  and the value after a flag or variable whose name says it holds one (`--password x`, `--token=x`, `API_KEY=x`,
  `-p<password>`) become `***`.
- **Files changed** in the projects while the sandbox runs (`audit.files`), seen from your PC.
- **Git commits** made in the projects while the sandbox runs (`audit.commits`): id, first line of the message
  (secrets hidden) and author, read from each project's `.git` reflog on your PC.
- **Sessions** starting and ending, and what the **repo guard** caught.

**Which agent did it.** Every program is linked to the agent session whose terminal started it (directly or further
down: a build an agent's shell started is that session's). Programs the sandbox runs itself (setup, services) are
"not linked to a session". A commit is linked to the session that ran the `git commit` (or merge, cherry-pick ...)
that made it. A file change cannot be traced to a program from your PC: it is linked only when exactly one session was
running in that project at the time, shown as *likely* (`?`) since you may have changed it yourself (a commit gets
the same "likely" link only when `audit.processes` is off). Otherwise it stays unlinked: nothing is guessed.

It stays small: one short line per event, the same event within a minute is one line with a count, at most 300 lines a
minute (the rest is counted), finished days are compressed, and days past `audit.days` (7, at most 30) or beyond
`audit.maxMb` (100 MB) are deleted, oldest first, when a sandbox starts and once a day while it runs.

See it on the **Activity** page of the web UI (totals, per agent, each session as a card that opens its own events,
filters for kind and period), in the menu (Maintenance > Activity) or on the command line:

```powershell
sandbox audit                            # the last 24 hours
sandbox audit --days 7 --kind commit
sandbox audit --session 4f2c --grep "git push"
sandbox audit --agent codex --project api
sandbox audit --json                     # for scripts
```

What the sandbox reports about the programs it ran, and which session started them, is taken as it says after checks
(an agent with admin rights there could leave things out or link them wrongly, but cannot name a session that does not
exist or write anything but program lines); file changes, sessions and repo-guard findings are observed from your PC.
Commits are what the project's reflog says: the sandbox can write that file too, so a commit listed there is a record,
not proof. The log stops growing at `audit.maxMb` (it says so in one line) until old days are deleted.

## Git-ignored files

`workspaceFilter.enabled: true` keeps what your `.gitignore` lists out of the sandbox: `.env` files, your
`node_modules`, build output, local notes. The sandbox then works on a copy of the project (in
`<storage>\views\<project>`) that has only what git does not ignore, and the two are kept in step both ways while the
sandbox runs (changes arrive within about a second; a full check runs every minute and when the sandbox closes):

- Your edits reach the sandbox; the agent's edits, new files and deletions reach your project.
- What the sandbox creates that is ignored (its own `node_modules`, `target`, `dist` ...) stays in the copy, so it
  never mixes with what you build on your PC, and is there again next time.
- A file changed on both sides at once keeps yours; the sandbox's version is saved next to it as
  `<name>.sandbox-conflict-<time><ext>`.
- Git works as usual: the project's real `.git` is mapped next to the workspace (`C:\Workspace\<name>.git`), so commits
  and branches made in the sandbox are in your repository (and the repo guard still watches it). With git access
  `none` no `.git` is mapped at all.
- The rules are git's: every `.gitignore` in the project, `!` exceptions and `.git/info/exclude`.
  `workspaceFilter.exclude` keeps more out (`secrets/`, `*.pem`), `workspaceFilter.include` lets something in that
  git ignores (`.env.example`, `data/fixtures/`).

It applies to the folder you start from. Projects that join a running sandbox, and a project that is itself a git
worktree (its `.git` is a file), are mapped as they are. A project's `.sandbox-config.json` can turn the filter on and
add `exclude` patterns, never turn it off. `sandbox data clean views` removes the copies (your projects are not
touched).

## Project settings

A project can carry a `.sandbox-config.json` (see the [example](../.sandbox-config.example.json)) for its agent,
toolchains and versions, databases, git mode, extra folders and setup scripts. Check one without starting anything:
`sandbox config check`.

A repo can ship this file, so it is treated as untrusted:

- You approve it the first time, and again whenever it changes (the approval is tied to the file's exact contents).
- Read/write folders are flagged in the approval prompt, which is shown without colours or escape codes (a file cannot
  hide lines of it).
- Its extra folders (`mappings`) inside the project are fine. Folders outside it (decided after `%VARIABLES%` and links,
  so a link cannot hide one) follow `projects.allowOutsideMappings` in **your** settings: `"ask"` (the default) asks at
  an interactive launch, once per project file and folder, listing each folder, read-only or read/write, and where it
  will appear; a yes is kept in `<storage>\allowed-requests.json` (a no is not, so you are asked again). `true` allows
  them (still flagged "outside the project" when you approve the file), `false` refuses them. Without a terminal,
  `"ask"` stops the launch and says how to allow them; `--trust-config` never does. The launch table marks them
  "(outside the project, allowed)".
- It may add apps from the catalogue (`apps.install`, added to yours), never programs of its own (`apps.custom`) and
  never `rtk` (an agent add-on that hooks every agent command: only your own settings turn it on).
- It can only make protections **stricter**: read-only, git `readonly`/`none`, the LAN block, protected client, and
  turning off network, clipboard, microphone, camera, printers, vGPU, login copying and history / claude-mem sync, and
  turning on `downloads.requireChecksum`. A looser value is used only if you allow it: starting the project from an
  interactive terminal asks once, in the same question as any folders outside the project ("Allow these for this
  project?"). Your answer is kept on this PC
  (`<storage>\allowed-requests.json`, which no repo or sandbox can write) for that project file only; `--trust-config`
  never allows one. Otherwise the launch names what was not used. Or set it in your own settings for every project.
- It can never change storage, agent executables, secrets handling or any host folder used for tools or Claude settings.

## Reopening sessions
Your own settings only (a project's file cannot set them: they start sandboxes on this PC).

| Setting | Default | What it does |
|---|---|---|
| `resume.sessions` | `"ask"` | when a sandbox starts after one that had agent sessions: `"ask"` lists them ("Last time: claude in api, codex in web (2 sessions). Reopen them?"; without a terminal it only names `sandbox resume`), `"always"` reopens them, `"afterCrash"` reopens them only when the last sandbox ended unexpectedly (and asks nothing otherwise), `"never"` leaves it to `sandbox resume` |
| `resume.restartAfterCrash` | `false` | when Windows Sandbox crashes or runs out of memory, the background sync starts the sandbox again and reopens its sessions (`"ask"` counts as `"always"` there: nobody is at the PC). At most 3 times in 6 hours; then the next launch says it stopped trying |

Each session reopens in its own folder, continuing its own conversation when the agent can open one by its id
(`harnesses.<agent>.resumeOneArguments`, with `{id}`; Claude: `--resume {id}`), else the agent's last one
(`resumeArguments`). Only sessions this tool started are reopened: terminal tabs you opened yourself inside the sandbox
are not. What ran is noted every minute while the sandbox runs, on this PC (`<storage>\sync\<data>-sessions.json`).

## Accounts

```powershell
sandbox account save personal          # the login currently in the sandbox
sandbox account save work --from-host  # or this PC's login
sandbox account default personal       # for new sandboxes
sandbox account use work               # switch now: Claude restarts and continues the conversation
```

All accounts of one data set share one Claude folder, so plugins installed in the sandbox already stay when you switch.
They do not reach another data set (`storage.dataName`). Set `claudeProfile.sharePluginsAcrossAccounts` to `true` (off by
default) and switching to an account in a data set that has no plugins yet copies them in from your other accounts: the
plugins folder and the `enabledPlugins` / `extraKnownMarketplaces` entries of `settings.json` (your own entries win,
nothing else in `settings.json` and no login is touched). The copy is kept in `<storage>\accounts\shared-plugins`, is
refreshed at every Claude launch and when a sandbox stops, refused when it holds links or is bigger than 1 GB / 20,000 files, and a project's `.sandbox-config.json` cannot turn it on. Plugins are code: turning this on lets a plugin installed in one sandbox run in your other
sandboxes too.

## Hooks

`.ps1`, `.mjs` or `.cmd` files in `~/.agent-sandbox/hooks/pre-provision`, `pre-agent` or `post-agent` run inside the
sandbox at that point, in name order. Use them for real installers, which must run again each boot.

## Agent commands (Beta)

`sandbox agent-commands on` (or `agentCommands.enabled` in the settings screen) makes the agents installed on this PC
start in the sandbox: type `claude` (or `codex`, `gemini` ...) in any project folder and it starts in a hidden sandbox
for that folder and attaches your terminal, exactly like `sandbox claude -t --headless`. Arguments go to the agent.

- It finds the agents on your PATH and writes a small forwarding command for each into `<storage>\agent-commands`, then
  puts that one folder first on **your** PATH (nothing else in PATH changes). Open a new terminal afterwards.
- `set SANDBOX_AGENT_DIRECT=1` (PowerShell: `$env:SANDBOX_AGENT_DIRECT=1`) runs the real agent on this PC instead.
- `sandbox agent-commands off` removes the commands and that PATH entry again. `status` shows what is forwarded.
- Agents installed later are picked up the next time you launch. An agent on the machine-wide PATH, not yours, is not
  overridden. Beta: it may have rough edges; it is off by default.

## CPU, RAM and GPU

Windows Sandbox has no CPU setting and would use every processor, so the sandbox caps itself: before anything starts,
its first window joins a Windows job object with a hard CPU-rate cap (`sandbox.cpuLimit`, default 80 %), and
everything this tool starts in it inherits that (agents, installs, builds, its terminal tabs). Programs started from the
sandbox's own Start menu are not covered. RAM is fixed when the sandbox starts (`memoryMb`, or "auto" within the limits
above). The GPU cannot be limited: Windows Sandbox only has it on or off (`sandbox.vGpu`, off by default).
