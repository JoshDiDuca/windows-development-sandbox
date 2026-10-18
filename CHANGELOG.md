# Changelog

What shipped in each version, newest first. Planned work is in [docs/roadmap.md](docs/roadmap.md).

The command is `sandbox`. The old names `agent-sandbox`, `claude-sbx`, `codex-sbx` and `gemini-sbx` still work.
Some older names stay on purpose so that existing installs keep working: the `~/.agent-sandbox` folder, the
environment variables `AGENT_SANDBOX_HOME`, `AGENT_SANDBOX_CONFIG`, `AGENT_SANDBOX=1` and `AGENT_SANDBOX_WORKSPACE`, the
`agent-sandbox-quarantine` folder, and the Visual Studio instance ID that `vswhere` uses.

## 1.11.1

- The menu no longer closes when an action fails: the problem is shown where you chose it (for example when an option
  could not be read or saved), and you can go on.
- More of the tool in the web UI: Maintenance > Updates, Data, Storage, Health, Logs and Engine, Settings export and
  import, and the Web UI's own server in the menu. Each is written once for the command line, the menu and the browser.
- VPN in the web UI, under Settings: its status, and saving or deleting the login (typed hidden, never shown).
- **VPN (alpha) fixes from the first real try.** OpenVPN now installs in Windows Sandbox (its installer asks WMI about
  services, which Windows Sandbox could not answer). The kill switch now holds: Windows Sandbox allows all outbound
  traffic itself, so the kill switch is made of block rules, and a direct connection is tried before the sandbox is
  said to be offline. Before, a failed tunnel left the sandbox online while it said "no internet".
- **(Alpha)** `sandbox engine clean` stops HCS systems a crashed command left running, after naming them. Only your
  own are touched: HCS sandboxes now carry a tag for the Windows user that started them.
- A check for PowerShell variable mistakes (built-in names, letter-case clashes, settings leaking out of functions)
  runs over every script in the self-test.

## 1.11.0

- **Web UI (beta), rebuilt.** A new look in dark and light; a sidebar with the sandbox's live state; a search over
  pages, sessions and every setting (Ctrl+K). Settings show one category at a time with a search, and each setting's
  control sits in its row: switches and choices save at once, text and numbers when you press Enter. Folders and files
  are picked with a folder browser instead of typed. Sessions show as cards with a New session button. The terminal
  has find, text size, full screen, clickable links and, on phones, a row of the keys a phone keyboard lacks. Areas
  that are not in the web UI yet are no longer dead links. Everything still runs through the same shared code as the
  CLI and the menu.
- **More of the tool in the web UI**, each written once for the command line, the menu and the browser: Agents (start
  one, which then opens its terminal, add one, make one the default, remove one), Accounts (save, use, rename and remove
  logins), Apps (switch catalogue apps on and off per scope, your own programs, request an app) and Sandbox > Projects
  (project roots, projects, all or chosen), with nested navigation. Starting an agent from the web now runs the same
  operation as the menu (the old `POST /api/sessions` is gone). Maintenance follows.
- The menu's Sessions page has a New session key (n).
- **Builds no longer fail with "the paging file is too small" (os error 1455) or out-of-memory errors in a healthy
  sandbox.** Every new session re-applied its own memory limit to the job shared by all agents, so a session that
  joined later could shrink everyone's limit (to 6 GB on a 32 GB sandbox). The job's limit is now only a last-resort
  backstop just below the sandbox's commit limit (RAM plus paging file), set once by whoever creates the job and never
  changed by a session that joins; slowing builds down comes first. `sandbox.agentMemoryHeadroomMb` now means the
  distance of that backstop below the commit limit.
- **The memory governor slows builds down in steps, like a PC, instead of pausing one compiler.** As the sandbox's
  memory fills, build programs get lower CPU and memory priority (Windows trims their pages before the agents'), then
  less CPU together (60 %, 35 %, 15 %), then compilers take turns (the others wait, suspended a few seconds at a time and
  always resumed, who waits changing every 20 seconds) and the waiting ones are trimmed to the paging file. It also acts
  when commit would run out within seconds at the rate it grows. Builds get slower; nothing fails. It never touches the
  agents, also when they run as node.exe (Codex, Gemini ...).
- When this PC is nearly out of memory (under 1.5 GB of RAM free, or commit within 4 % of its limit), its watchdog says
  so at once and the sandbox's builds go straight to the governor's last step until it passes; when the PC is only low,
  builds go to step 2 as before.
- **The sandbox never gets more memory than this PC can keep in RAM for it**: the PC's RAM minus max(reserveHostMb,
  25 %), and 2 GB more with vGPU on. A fixed `sandbox.memoryMb` above that is lowered (the launch says so). More would
  be paged to this PC's disk while the sandbox pages to its own, the most likely cause of whole-PC freezes under heavy
  builds.
- **Agents see what the sandbox can really give them.** With a CPU cap, the sandbox's programs run on that share of the
  processors, so cargo, .NET, ninja and `nproc` count right, and `NUMBER_OF_PROCESSORS` says the same. Each session
  gets cargo and CMake job counts from a build budget (one job per 3 GB after 6 GB, up to 8 per session), and
  `run\budget.json` (`SANDBOX_BUDGET_FILE`) states the real numbers for agents to plan with.
- More links at once: `toolchains.rust.linkSlots: "auto"` allows one per 3 GB after 6 GB, 2 to 8 (was 2 to 4), now that
  the governor slows links down when memory runs short.
- Web UI: connections no longer pile up. The server pings every page and drops those gone without closing, a new page
  always connects (the oldest connection makes room instead of the new one being refused), a hidden tab stops reading
  live data and lets go of its connections, a closed one closes them at once, and a server of another version (left
  running across an update) is replaced instead of reused. The server ends by itself after 30 minutes unused while no
  sandbox runs.
- An HCS engine workflow for GitHub Actions, run by hand (Actions > HCS engine (alpha)): it builds, checks the HCS
  documents and tries a Hyper-V utility VM on hosted Windows runners, and says which isolation really worked
  (docs/development.md).
- The VPN is labelled alpha everywhere it shows (settings, `sandbox vpn`, the launch warnings, docs): it has not been tried on a real PC yet.
- Terminals no longer show a second copy of the agent's screen at the bottom when another viewer (the web UI, a
  terminal on the PC) joins or types: with conpty.dll the session is resized only when the size really changes, and a
  viewer that only looks leaves the size to the one in use until it types.
- The memory governor no longer writes a broken sample when a process ends while it is being read (it logged "bad
  sample" and skipped that round).

## 1.10.0

- The web UI starts with every sandbox when `web.enabled` is on (before, nothing started it, so nothing answered on its
  port), and the new `web.openOnLaunch` opens it in your browser already signed in.
- Boot fixes: the firewall rule that limits the terminal channel to this PC was never created (its program path was a
  short 8.3 name netsh cannot resolve); it is now made from the full path, retried, and a missing protection shows in
  the boot summary. App shortcuts failed whenever there were two or more (Windows PowerShell 5.1 passed the list as one
  object). Node is copied from this PC when the version matches before nvm is tried; copies that robocopy cannot finish
  are retried; claude-mem saves skip files the agent removes mid-copy and never copy SQLite journals.
- A compiler paused by the memory governor is always resumed, also when the governor itself is killed mid-pause.

- One shared core for the command line, the menu and the web UI (`src/app`, docs/design/shared-core.md): status,
  sessions, restart, stop, show/hide and settings are each written once and drawn by all three. The web UI moved from
  Bootstrap to Mantine, with the menu's sections down the left, and gained the Sandbox and Settings pages (change or
  reset any setting; secrets show as `***`).
- New: `sandbox config reset <setting>` and `sandbox config list [--json]`.
- Heavy load slows builds down instead of closing the sandbox (docs/troubleshooting.md): memory sizing also respects
  this PC's commit limit, everything the agents start shares one job object with a memory limit
  (`sandbox.agentMemoryHeadroomMb`), a governor in the sandbox lowers the priority of compilers and pauses the biggest
  one for a few seconds when memory runs low (`sandbox.pressureResponse`), the background sync asks the sandbox to
  slow down when this PC itself runs low on memory or CPU, and cargo jobs fit the memory. With vGPU on the sandbox
  runs gentler (CPU cap 15 points lower, earlier thresholds, at most max(2, cores / 4) compilers at once). The PC watchdog also watches the disk queue. doctor checks the PC's paging file and warns about vGPU.
- `sandbox logs --crash` prints the last crash report, now with the freeze gap, blue-screen codes, WHEA and
  resource-exhaustion events, crash dumps, this PC's memory log and whether vGPU was on.

## 1.9.0

Everything new here is opt-in; with the defaults a sandbox starts exactly as before (a test compares the files
byte for byte).

- Sandbox engines: Windows Sandbox now runs behind an engine layer, so other engines can plug in. `sandbox engine`
  shows the engine in use and what each can do; `sandbox engine check hcs` lists what this PC lacks for the HCS engine,
  with the exact commands, and changes nothing.
- **Contained storage (beta)**, `storage.contained: vhdx` / `sandbox storage contained on|off|status`: the sandbox's
  tools, logins, logs, databases and caches live in one disk image per data set instead of loose folders, mounted on a
  private folder only while a sandbox runs (one Windows permission prompt). Doctor finds and fixes a mount left behind.
  Not yet tried on a real PC: run `scripts/experiments/Test-ContainedStorage.ps1` first.
- **HCS engine (alpha)**, `sandbox.engine: hcs`: the base for headless agents in a Hyper-V isolated Server Core
  container whose storage disk is attached to the VM, never mounted on your PC. Its documents are checked against
  Microsoft's published HCS schema, and its helper only ever touches compute systems and disks this tool made. Starting
  it is not enabled yet.
- Fixes: the HCS helper refused nothing by id before (it now acts only on systems this tool owns), and HCS error codes
  are reported with Microsoft's own wording.

## 1.8.0

- The menu is fast while agents work: nothing it draws or a key does waits for Windows any more (the process list is
  read in the background; a key used to take one to two seconds on a busy PC), only changed lines are redrawn, slow
  screens show "Loading…" and keep your place. Maintenance > Health runs its checks when you ask (Enter).
- `sandbox config export` / `import` (and Settings > General): share your settings as a file. Only what differs from
  the defaults; never secrets, the data folder or paths of this PC; an import shows what changes and asks first.
- The menu remembers the last section, category and search between runs.
- Apps > Request an app… (key `r`) opens a prefilled request on GitHub.
- VPN: your own WireGuard file (`vpn.provider: wireguard-file`), checked like the OpenVPN one (no scripts), its keys
  handed to the sandbox only through the one-shot file. Not yet tried on a real PC.
- Antivirus false positives: the installer no longer makes a Start menu shortcut (Malwarebytes reported it as
  "Trojan.Loader"; `-StartMenuShortcut` makes one anyway) and removes the old one. HostTools.exe has a plain name and
  full file details (publisher, product, description, version).
- `scripts/experiments/`: two read-only or self-cleaning probes to run on a PC before contained storage and an HCS
  engine are built (see docs/roadmap.md).

## 1.7.1

- Codex could not run any command ("CryptUnprotectData", "please restore the workspace runner"): its own command
  sandbox keeps local users' passwords sealed to the sandbox that created them, and every sandbox is a new machine.
  Those files are now removed at each boot (harness `bootReset`) and Codex sets its sandbox up again.
- Copying text from an agent's session: the agent's own copy now reaches the clipboard in the sandbox's terminal, and
  in `sandbox attach` while `sandbox.clipboard` is on. Clipboard reads stay blocked. To select with the mouse while an
  agent has it, hold Shift while you drag.

## 1.7.0

VPN (NordVPN first; built and tested in a sandbox, still to be tried on a real PC: [docs/vpn.md](docs/vpn.md))

- NordVPN inside the sandbox only, your PC's own connection untouched: sign in to your Nord account on the website
  with your normal login once, copy its service credentials, and `sandbox vpn login` keeps them encrypted on this PC.
  Each sandbox picks a NordVPN server, connects with OpenVPN and, with the kill switch on (the default), has no
  internet when the tunnel is down. `sandbox vpn status` and Settings > Network show it. Your own `.ovpn` works too
  (`vpn.provider: openvpn-file`).

Credentials

- Saved logins (every agent) are encrypted at rest with Windows DPAPI for your user; older saved logins are encrypted
  the first time they are read.
- Agent API keys (`environment`), a copied Claude login and the VPN login never go into launch folders,
  `session.json` or the folder other users may write to: the sandbox reads them once from a file it deletes.
- Secret settings print as `***` in `config`, the menu and every `--json` output. A proxy with a password in its
  address is refused.

Install copies and folder permissions

- `sandbox doctor` lists every `sandbox`, `agent-sandbox` and `claude-sbx` on the PATH, says which runs and how to remove each other one. `sandbox --version` says where it runs from (`--version --short` is the plain number). A copy that is not the installed one says so once per version.
- `npm run install:global` refuses while a managed install exists (`-- --force` to override). The installer refuses a just-you install next to an everyone install and offers to remove an older per-user install and `C:\Scripts\agent-sandbox`.
- Sharing finds the all-users install from any copy, and a launch says so when sharing is on but there is no such install.
- A launch with sharing off skips the permission step when the sharing group has no entry on your folders. Repair makes a data folder with files private without the 30 second limit, and says it can take minutes.

## 1.6.0

Fixes
- An all-users install could not start a sandbox when your storage held many files: every launch rewrote folder
  permissions over everything inside it and stopped after two minutes with "Could not change the folder permissions
  ... ETIMEDOUT". A launch now writes only the entries that change, on those folders alone, and takes under a second.
  The installer no longer rewrites the permissions of `%ProgramData%\AgentSandbox` when they are already right.
- Starting an agent from another project folder in the running sandbox failed with "the running sandbox works on ...
  and Windows Sandbox cannot add folders while it runs", even for a folder in one of its roots, when another copy or
  version of `sandbox` had started it. The sandbox's projects are now read from any version and rebuilt from its
  launch folder when needed.
- A launch can no longer hang without a word: time limits on the Windows tools it runs, a check that Windows Sandbox
  really started, and a clear message when the sandbox never reports in.
- Codex starts: its databases live on the sandbox's own disk (SQLite cannot run on a mapped folder) and are saved,
  also while Codex runs.
- Every new terminal tab has the right PATH (PowerShell, pwsh, cmd, Git Bash), every configured agent works by name in
  any tab, and an agent that is not installed yet installs itself the first time you type it.
- A failed update or install puts the previous version back and turns automatic updates off (you are told once).

New
- Your data folder: new installs keep it in `%ProgramData%\AgentSandbox\users\<you>`, readable only by you, for both
  kinds of install. Existing data stays where it is; you are offered a move (size, time, a warning when it is big)
  after an upgrade or a switch of install type, in Settings > General (with a folder browser) and with
  `sandbox storage move`. Older versions still find it after a move.
- The menu: navigation on the left as a tree, Agents (start, add your own, make default, remove), Settings in 8
  categories, inputs that fit each setting (choices, number ranges, folder pickers, list editors).
- The command line: help grouped by topic, "did you mean", pickers when an argument is missing, confirmations before
  anything is deleted, `sandbox config get/set`, `--agent` (`--harness` still works).
- `sandbox doctor` and `sandbox repair`: live grouped output, 31 checks (most can fix what they find), a repair log,
  and `doctor --fix`.
- `claudeProfile.sharePluginsAcrossAccounts` (off by default): Claude plugins follow you to your other data sets.
- `sandbox web` (beta, off by default): your sessions in a browser on this PC, with a live terminal.

## 1.5.0

- The installer asks "Just me" or "Everyone on this PC", and installs side by side versions with a private Node.js and
  commands that read two pointer files. It replaces npm and 1.x installs, brings your settings up to date, and can be
  run with options or uninstalled (`-Uninstall`, `-RemoveData`). Releases list a `SHA256SUMS` file and the package
  carries its dependencies.
- `sandbox update` checks, installs, and rolls back versions, and `--auto on|off` switches automatic updates (a
  scheduled task for everyone, a daily check at command start for one user). The Maintenance tab has an Updates row.
- Other Windows users of an all-users install can use the sandbox you started when `sharing.otherUsers` is on:
  `status`, `sessions`, `attach`, `exec`, `db` work for them, `stop` needs the owner's name typed, and the rest is the
  owner's alone. Their own logins and agent environment are never sent into your sandbox.
- `sandbox migrate` brings your saved settings up to date after an upgrade, with a backup. A storage folder an old
  `config init` wrote into your config no longer overrides the shared folder of an all-users install.
- A new menu: the areas are tabs along the top, every command has its own screen, and Settings keeps unsaved changes
  until you save (Ctrl+S) or discard them.
- Saved logins for every agent, not just Claude: Codex, Gemini, OpenCode, Qwen, Copilot, Kilo, Amp, Cline, Continue,
  Kimi, Reasonix, CodeWhale, Aider and the rest. `sandbox accounts --agent <name>` and the Accounts tab.
- Any agent can join a running sandbox, from any project folder. When the sandbox lacks something the project needs:
  Restart (the open sessions come back and continue their conversations), Continue without it, or Cancel.
- `sandbox resume` reopens the sessions of the last sandbox, each in its own conversation. `resume.sessions` and
  `resume.restartAfterCrash` choose what happens after a crash or restart.
- Every boot tool can be `true`, `false` or `"auto"` (installed when the project uses it): Bun, uv, gh, pwsh, VS Code
  and the rest.
- Optional reverse-engineering tools in `apps.install`: REA (Reverse Engineer Anything), Ghidra, x64dbg, ILSpy,
  dnSpyEx, Detect It Easy, PE-bear, Cutter, radare2 and JADX.
- `sandbox host <agent>` runs an agent on this PC (not sandboxed) while your agent commands are forwarded to the
  sandbox.

## 1.4.3

- Rust builds on the GNU host link with lld, and only a few links run at once across the sandbox. This uses much less
  memory.
- Crash reports: the next launch says why the last sandbox ended. Reports are kept in `<storage>\logs\crashes` for
  crashes inside the sandbox and for this PC's blue screens.
- A memory log every 5 seconds while memory is high, and `memory-pressure.txt` (ok, high or critical) inside the sandbox.
- `claude` is on PATH in new terminal tabs. `py`, `pip` and `python3` work in Git Bash.

## 1.4.2

- Mapped folders appear where you asked: at the PC path or at the guest path you give.
- Joining a running sandbox asks first. A project that needs stricter settings is refused with the reason. A project
  that needs something the sandbox lacks gets Continue anyway, Restart with them, or Cancel.
- The background watcher never outlives the sandbox. The installer stops watchers left by older versions.

## 1.4.1

- A project's folders outside it (game installs and similar): `projects.allowOutsideMappings` ("ask", true or false).
  A guest path can be left out, and `sandbox config check` previews every folder.
- A project keeps the same path in the sandbox whichever project starts it, so git worktrees keep working.
- Joining a running sandbox that lacks what the project needs (vGPU, folders, memory) offers Continue anyway, Restart
  with them, or Cancel.
- First start: a heads-up with the download size, live progress, "still working" messages and "Ready in ...".
- Agent sessions: the mouse wheel and clicks reach the agent again, and split key sequences no longer leave stray letters.

## 1.4.0

Also contains 1.3, listed below.

- Audit log (optional): programs started in the sandbox, files changed, sessions and repo-guard findings. Kept for a set
  number of days and size-capped. Read it with `sandbox audit`.
- Containment without admin: programs and scripts the sandbox writes into a project get the "downloaded from the
  internet" mark (`storage.markSandboxFiles`). A warning when the persisted data passes `storage.warnDataGb`.
- Agents left overnight: the PC stays awake while a sandbox runs (`sandbox.keepAwake`). A warning when Windows Update
  waits to restart. The next launch says why the last sandbox ended.
- Windows inside the sandbox crashed under heavy parallel builds. Fixed with a fixed-size paging file
  (`sandbox.pageFileMb`), a memory log in `C:\AgentData\logs` (size-capped), and fewer cargo jobs per agent by default.
- A project's looser request (vGPU and similar) can be allowed once, for that project only. With vGPU, Vulkan runs on
  the GPU.
- The CPU cap and paging file helpers are small C# files with readable scripts around them.

### 1.3 (released inside 1.4.0)

- Git-ignored files and folders (node_modules, .env, build output) stay out of the sandbox (`workspaceFilter`). The
  sandbox works on a copy kept in step both ways, and the real `.git` is mapped beside it.
- A project asking for something only you can allow (vGPU and similar) is told at launch, with how to allow it.
- Rust: `CARGO_TARGET_DIR` per checkout, so git worktrees of several agents no longer share one target folder. GNU
  defaults that fit Windows (fewer jobs, line-table debug info).
- Git in the sandbox uses `core.autocrlf=input`, so checkouts made inside keep LF line endings.
- claude-mem keeps a few dated backups instead of replacing its only copy. The `py` launcher is next to `python`.
- Network settings: allow only some hosts (proxy and firewall), blocked hosts, the LAN block, DNS, an upstream proxy,
  and port forwarding from the PC into the sandbox.
- Security sweep: history syncs back for this project only, with no other projects' transcripts. Sandbox text is shown
  without escape codes everywhere. Attach connects only to the sandbox's own address.

## 1.2.0

- A full-screen menu (`sandbox` with no arguments): categories, search, command forms that show the live command line,
  and running sessions to attach to.
- A settings editor in the menu, with two tabs: All projects and This project. It shows value, default and source for
  each setting, and has editors for lists, maps, folders and agents.
- An apps catalogue of 60 apps and command-line tools, by category, installed portably. Your own programs can be added
  (`apps.custom`).
- VS Code set up for the sandbox's tools, with the extensions for the languages the project uses.
- Windows Terminal: new tabs open in the project folder.
- Agent sessions use Microsoft's newer pseudo console: no garbled screen after resizing, real scrollback, and late
  viewers get a replay.
- Security: the attach output filter was rewritten (it closed an OSC 52 clipboard bypass). Project files cannot map
  folders outside the project. The repo guard covers agent and editor files, submodules and more git keys.

## 1.1.0

- The sandbox's CPU is capped at 80 % by default, and its RAM share at 80 % by default.
- Several projects in one sandbox: join a running sandbox from another project folder, start several agents at once
  (`--session`), and restart to add projects when needed.
- Agent commands (Beta): typing `claude`, `codex` and similar on the PC starts them in a hidden sandbox.
- Command-line polish: progress lines, `NO_COLOR`, clearer prompts and option checks, and a global `--config`.
- `downloads.requireChecksum`. The installer refuses a release package with no listed SHA-256, unless
  `WDS_ALLOW_UNVERIFIED=1` is set.

## 1.0.5

- Databases start on demand: `sbx-db`, `sandbox db`, and `--database` at launch.
- Published to npm: the first version from the PC, then every release from CI.

## 1.0.4

- MSVC is installed without its installer, when `toolchains.msvc.acceptLicense` is on. PowerShell 7, command-line tools
  (`gh`, `zstd`, `openssl`), software Vulkan, and mirrored paths for game projects (`guestWorkspace: "mirror"`).
- The Node install uses a temp folder on the data disk, which fixes failed installs.

## 1.0.3

- A settings screen in the menu.
- `attach.auto` and `attach.autoHide` settings.

## 1.0.2

- Only what the project needs is installed: toolchains are detected from the project's files on the PC.
- `sandbox attach`, `sessions` and `status` also work inside a sandbox.
- Safer deletes: nothing can reach a profile, a drive or Windows.
- `sandbox claude` and `claude-sandbox` are the names to use; `claude-sbx` is the old name.

## 1.0.1

- Install commands that work, a short README with a docs folder, and CLAUDE.md for agents.
- `sandbox data` shows disk usage per drive.
- Fixes from review of the host and sandbox code, with fewer lookups at each boot.

## 1.0.0

- The first release of the npm package: a `sandbox` command with sessions, attach, toolchains, and sync of your Claude
  history between the sandbox and the PC.
