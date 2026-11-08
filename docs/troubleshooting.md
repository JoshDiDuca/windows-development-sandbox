# Troubleshooting

Start with `sandbox repair`, then `sandbox doctor` and `sandbox logs -f`.

## What doctor checks and repair can fix

`sandbox doctor` and `sandbox repair` run the same checks, grouped under headings, one line each. A line that is not
fine says what it means and what to do. A check that takes more than 20 seconds is skipped with "took too long".

- **`sandbox doctor`** only looks. If some problems can be fixed, it asks "N problems can be fixed. Fix them now?"
  (`--fix` fixes without asking).
- **`sandbox repair`** lists what it will change, asks once (`--yes` skips that), fixes it, checks again and prints
  "fixed", "needs you" or "still not right" for each. It writes a log to `<storage>\logs\repair-<time>.log`. Repair never
  deletes your settings, logins, history or projects: it removes leftovers and links the sandbox made, and puts
  pointers back.
- **`--json`** prints the results (`id`, `group`, `status`, `detail`, `fixable`, and what a fix changed). With
  `--json`, repair changes nothing unless you add `--yes`.
- **Menu:** Maintenance > Health > "Run the checks and fix what can be fixed".

| Group          | Check                                                                                                                                                                                   | Fixed by repair                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| This PC        | Windows, its release and whether it still gets fixes, edition, CPU virtualization, memory, Node.js, a Windows restart waiting                                                                                                        | no (it says what to turn on)                                                                                |
| Install        | managed or npm install, and its scope; `install.json` readable                                                                                                                          | no (run the installer again)                                                                                |
|                | `active-version` and `active-node` name installed folders                                                                                                                               | yes: points them at the newest complete version (nothing is deleted)                                        |
|                | the commands in `bin` exist and read the active version                                                                                                                                 | yes: rewrites them                                                                                          |
|                | `bin` is on the right PATH (yours, or the PC's for everyone)                                                                                                                            | yours: yes; the PC's: no (run the installer in an admin PowerShell)                                         |
|                | everyone: the automatic-update task matches `install.json`                                                                                                                              | yes in an admin terminal, else it gives the command                                                         |
|                | every copy of `sandbox` on the PATH, which one runs, and how to remove the others; a second install for just you; the old `agent-sandbox` npm package | no: it shows the commands and never deletes ([the wrong version runs](#install-and-updates))                |
|                | everyone: you can read the PC's settings and are in the group Agent Sandbox Users                                                                                                       | no ("sign out and in", or the command an admin runs)                                                        |
| Data folder    | where it is, that it is not a link, that you can write there, free disk space                                                                                                           | no                                                                                                          |
|                | your data in an old folder, another known folder, or two (a move that stopped half way)                                                                                                 | no: points at `sandbox storage move` / `use`                                                                |
|                | everyone: your data folder is private to you, SYSTEM and Administrators                                                                                                                 | yes. A folder with many files takes minutes (repair waits up to 30)                                         |
|                | everyone: the group's permissions on your folders match whether you share                                                                                                               | yes: removes or restores only those entries                                                                 |
|                | links made inside the data folder                                                                                                                                                       | yes: removes them without following them                                                                    |
|                | interrupted downloads, half-installed toolchains, a damaged `resolved-versions.json`                                                                                                    | yes: removes them (the next start redoes them)                                                              |
|                | **(Beta)** contained storage: the image is there, the mount record is right, the folders are private                                                                                    | yes: dismounts an unused mount (Windows asks), corrects the record, makes the folders private               |
| Settings       | `config.json` loads                                                                                                                                                                     | yes, when an update saved a good copy: puts it back and keeps the broken one as `config.json.broken-<time>` |
|                | updates to your saved settings are waiting                                                                                                                                              | yes: runs them (with a backup)                                                                              |
|                | approved project files that changed since                                                                                                                                               | no (the next launch there asks again)                                                                       |
| Sandbox        | `WindowsSandbox.exe` and the Windows Sandbox feature                                                                                                                                    | no (`sandbox setup`)                                                                                        |
|                | a running sandbox that is not yours or has no status files                                                                                                                              | no                                                                                                          |
|                | state, session and request files of a sandbox that is gone; old sharing records                                                                                                         | yes: clears them                                                                                            |
|                | records of sync watchers that are gone; watchers running with no sandbox                                                                                                                | yes: removes the records and stops the orphans                                                              |
|                | launch folders older than 7 days                                                                                                                                                        | yes: removes them                                                                                           |
|                | `HostTools.exe` built; the conpty and Windows Terminal downloads whole                                                                                                                  | yes: builds it; removes a broken download                                                                   |
|                | crash dumps of the sandbox's VM (`vmwp.exe`) are on or off; a warning after such a crash while off | yes: turns them on (Windows asks for administrator permission) |
| Agents & tools | the default agent is set up; each agent's saved login is in use                                                                                                                         | no (`sandbox account use`)                                                                                  |
| Network        | proxy variables make sense; github.com can be reached                                                                                                                                   | no                                                                                                          |

A fix that touches the folders of a running sandbox waits until it is closed.

## Common problems

### Install and updates

| Problem                                                                                           | Try                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows Sandbox is missing                                                                        | `sandbox setup` checks the edition and virtualization, and offers to turn it on                                                                                                                                                                                                                                                                                                                                                                                      |
| Install commands fail                                                                             | `npm install -g` needs Node.js 20+ (the one-liner brings its own). Check your internet and try again                                                                                                                                                                                                                                                                                                                                                                 |
| `sandbox update` says it needs admin rights                                                       | The install is for everyone, and only admins can change it. Run it in an admin PowerShell (right-click Start, Terminal (Admin))                                                                                                                                                                                                                                                                                                                                      |
| "Update to X failed; still on Y"                                                                  | Your version is unchanged. `sandbox update` shows why. The failed version is not tried again, only a newer one                                                                                                                                                                                                                                                                                                                                                       |
| The wrong version runs, or a fix is missing after an update                                       | More than one copy is on the PATH, and the first one runs. `sandbox --version` says where the running copy is; `Get-Command sandbox -All` lists every copy; `sandbox doctor` shows the command that removes each other one. Usual fixes: `npm uninstall -g windows-development-sandbox` (an npm copy), `install.ps1 -Uninstall -Scope CurrentUser` (an install for just you), or delete `C:\Scripts\agent-sandbox` and take its `bin` off your PATH (the old layout) |
| "There is already an install for everyone on this PC; an install for just you would never run"    | Keep using the install for everyone, or remove it first in an admin PowerShell with `-Uninstall -Scope AllUsers` (your data is kept)                                                                                                                                                                                                                                                                                                                                 |
| Malwarebytes (or another antivirus) reports "Trojan.Loader" for `Windows Development Sandbox.lnk` | A false positive: the Start menu shortcut starts a command script. Leave it in quarantine. Installers from 1.8.0 make no shortcut unless you pass `-StartMenuShortcut`                                                                                                                                                                                                                                                                                               |
| Explorer says "You don't have permission to access this folder" for `%ProgramData%\AgentSandbox`  | Do not press Continue: Explorer then adds a permission that the next update must remove again (minutes). Look from an admin PowerShell, or use `sandbox storage show`                                                                                                                                                                                                                                                                                                |

### Starting

| Problem                                                    | Try                                                                                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "A Windows Sandbox is already running"                     | Only one runs at a time: `sandbox status`, then `sandbox show` or `sandbox stop`                                                                             |
| The first start is slow                                    | Expected once: it downloads what the project needs. Later starts reuse it                                                                                |
| A toolchain failed on first start                          | The rest still works. `sandbox repair` removes the half-install, so the next start tries again                                                           |
| A database did not start                                   | Check `sandbox logs`. Turn it on with `databases.<name>.enabled: true`                                                                                   |
| MSVC is not installed                                      | Set `toolchains.msvc.acceptLicense: true`. The launch output says when a project would use it                                                            |
| Cannot delete `tools\msvc`                                 | Close the sandbox first. MSVC's telemetry helper (`vctip.exe`) is removed at each start so nothing keeps it locked                                       |
| Settings errors                                            | The message names the setting and the problem. `sandbox config show` prints the settings in use                                                          |
| Disk filling up                                            | `sandbox data` shows what is big; `sandbox data clean <part>` frees it                                                                                   |
| pnpm, Bun or npm workspaces fail with EPERM                | Mapped folders allow no symlinks; see [mapped folders](toolchains.md#mapped-folders)                                                                     |
| No Vulkan                                                  | Windows Sandbox has none: `toolchains.mesa.vulkan: true` gives software Vulkan, `sandbox.vGpu: true` Direct3D 12                                         |
| winget is missing                                          | Windows Sandbox has no winget. Everything here installs portably; real installers go in a [hook](configuration.md#hooks)                                 |
| `sandbox launch` says you are inside the sandbox           | Commands that control the sandbox run from your PC, not from inside it                                                                                   |
| `self-test` or `npm test` refuses to run                   | By design: it only runs inside a Windows Sandbox (`sandbox start`) or on GitHub Actions                                                                  |
| "nvm + Node X setup failed ... did not leave ...\node.exe" | nvm could not download or unpack that Node version. Check your internet and free disk space, and start again                                             |
| "Git setup failed ... robocopy ... failed (exit 9: ...)"   | Some of Git for Windows could not be copied from your PC (a file in use). The copy retries more slowly and names the file; start again if it still fails |

### Sessions and terminals

| Problem                                                                                   | Try                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cannot select or copy text in an agent's session                                          | The agent takes the mouse: hold Shift while you drag, then Ctrl+C or right-click. The agent's own copy works in the sandbox's terminal, and in `sandbox attach` while `sandbox.clipboard` is `"text"` (the default) or `"shared"`                                                                                             |
| Copy from the sandbox does not reach the PC                                               | The sandbox window must be in front: a copy reaches your PC only while it is, or within 2 seconds after you leave it. Check `sandbox.clipboard` is `"text"` or `"shared"` and `sandbox.clipboardDirection` is not `"toSandbox"`. `sandbox doctor` shows the "Clipboard" line. Refused copies are counted in the watcher log `host-sync-<data>.log` (never the text) |
| The mouse wheel or a click does nothing in an agent session                               | While the agent tracks the mouse, the wheel goes to it: Shift+wheel scrolls the terminal and Shift+drag selects text. `provisioning.conpty.enabled: false` uses Windows' own pseudo console instead (no mouse for the agent)                                                                              |
| A command is "not recognized" in a new terminal tab                                       | Every shell rebuilds its PATH at start. `sbx-agent list` shows the agents (a missing one installs on first use). `C:\nvm\bin\pathsync.exe` prints the PATH a new shell should have                                                                                                                        |
| Codex says its local database is damaged (disk I/O error, code 8714)                      | SQLite cannot run in the shared data folder, so Codex runs its databases from the sandbox's disk (`harnesses.codex.localState`). If your settings pin your own `harnesses.codex`, add that key                                                                                                            |
| Codex's commands hang and never print anything                                            | Codex's own command sandbox was setting itself up (minutes, every boot). Boot now turns it off (`sandbox_mode = "danger-full-access"` in the sandbox's Codex `config.toml`): Windows Sandbox already contains Codex, which reaches what the other agents reach. A `sandbox_mode` you set yourself is kept |
| The sandbox's disk is full and agents stop working                                        | The disk is about 40 GB and cannot grow. It holds the paging file and every build (Visual Studio is kept on the data disk once it is saved). Put big build folders (a Cargo target, game files) under `C:\AgentData` or the workspace, which live on your PC's disk                                                                   |
| Node.js still running after the sandbox closed                                            | The background watcher stops within 3 minutes of the sandbox closing                                                                                                                                                                                                                                      |
| The sandbox slows my PC down                                                              | Lower `sandbox.cpuLimit` (e.g. `50`) and `sandbox.maxMemoryPercent`. They apply from the next start                                                                                                                                                                                                       |
| "PROTECTION MISSING: attach: the firewall rule for the session host could not be created" | The rest of the sandbox works, but `sandbox attach` may not connect. Restart the sandbox, and report it with `logs\guest-*.log` if it repeats                                                                                                                                                             |
| "App shortcuts could not be created"                                                      | Only the shortcuts are missing; the apps are in `tools\apps`. The message ends with PowerShell's own error                                                                                                                                                                                                |

### Projects and folders

| Problem                                                                            | Try                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check a project file                                                               | `sandbox config check` checks `.sandbox-config.json` and lists what it changes                                                                                                                                                                                                                                                                      |
| A project's `vGpu: true` (or another looser setting) is not used                   | A project file may only tighten your settings. Start it once from an interactive terminal and answer yes to "Allow these for this project?", or set it in your own settings                                                                                                                                                                         |
| "maps N folders outside the project"                                               | The project file maps folders from elsewhere on your PC. Start it from an interactive terminal and answer yes, or set `projects.allowOutsideMappings` to `true`. `sandbox config check` previews every folder                                                                                                                                       |
| "mapped folders cannot be used"                                                    | Each folder is named with the reason. Leave `guest` out to use the same path as on your PC, or give a full path such as `C:\Games\<name>`                                                                                                                                                                                                           |
| Another project "needs a restart"                                                  | Windows Sandbox cannot add folders while it runs. Folders inside a project root open at once: `sandbox projects roots add <parent folder>` (from the next start). See [several projects](projects.md#adding-a-project-to-a-running-sandbox)                                                                                                         |
| "<project> wants vGPU and 2 folders (...), but this sandbox started without them." | These are fixed when Windows Sandbox starts. Choose "Restart with them", or run the printed command. To have them in every sandbox, put them in your own settings (`sandbox.vGpu`, `mappings`)                                                                                                                                                      |
| "needs stricter protection than the running sandbox has"                           | Stricter git access, no network, the LAN block or read-only cannot be added to a running sandbox. Stop it and start from that project                                                                                                                                                                                                               |
| Git worktrees "prunable", or Claude will not resume an agent in its worktree       | Git and Claude store absolute paths, and the project's place inside moved (up to 1.4.0, or after adding a root, changing `guestWorkspace` or turning on `mirror`). In the sandbox, in the main checkout, run `git worktree repair <each worktree folder>`, then resume. Conversations kept only inside the sandbox stay under the old folder's name |
| Hooks quarantined in a project root                                                | A project that appeared in a root after the start has no "before" picture, so its git hooks count as added inside. `sandbox status` lists them; move them back if they are yours                                                                                                                                                                    |
| Getting `wsb`                                                                      | See [getting wsb](projects.md#adding-a-project-to-a-running-sandbox). `sandbox doctor` says whether it is found                                                                                                                                                                                                                                     |

### Live folders (HCS, alpha)

| Problem                                                                                        | Try                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "the running sandbox was started while projects.liveFolders was off"                           | Turn the setting on, then restart the sandbox once                                                                                                                                                 |
| "exactly one running Windows Sandbox is needed"                                                | Another user's sandbox or Edge Application Guard is running too. Nothing was shared; restart instead. If neither is running, please report what `HcsHost.exe enumerate` shows in an admin terminal |
| "the sandbox did not read the test share" or "wrong token"                                     | Your folder was not shared. Check `C:\AgentData\logs\daemon-*.log` inside, restart instead, and report it with `<storage>\state\live-folders.log`                                                  |
| "Windows did not give permission"                                                              | Each add or remove asks once: choose Yes. A standard user needs an admin's password                                                                                                                |
| A refused folder (system folder, your profile, storage, a link, "you cannot read this folder") | Only plain folders you can use yourself are shared. Pick the project folder itself, by its real path                                                                                               |
| "could not hide" on remove                                                                     | Files in it are open inside the sandbox. Close them and try again; otherwise it goes when the sandbox stops                                                                                        |

### Several users on one PC

| Problem                                                                                  | Try                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| "A Windows Sandbox started by alice is already running (Windows allows one per PC)"      | If alice shares it, use it with `sandbox attach` or `sandbox exec`. Otherwise start yours after it stops               |
| The sandbox window is not on my screen                                                   | It is on the desktop of the user who started it. You can still use its agents with `sandbox attach` when they share it |
| Added to Agent Sandbox Users, but sharing does not work                                  | Membership counts after the user signs out and in once                                                                 |
| "Not shared: sharing.otherUsers is on, but no all-users install was found"               | Sharing needs the install for everyone. Install with `-Scope AllUsers`                                                 |
| "Could not change the folder permissions ... ETIMEDOUT" (every launch fails, sharing on) | A bug in 1.5.0: run `sandbox update`. The first update afterwards may take a few minutes once                          |

## The sandbox was gone in the morning

The next launch says why, from Windows' own logs. A crash report (what Windows logged, blue screens, the last memory
samples) is kept in `<storage>\logs\crashes`; `sandbox logs --crash` prints the last one.

- **Your conversations are kept.** `sandbox resume` starts the sandbox again and reopens its sessions, each in its own
  conversation (or `/resume` in Claude). `resume.sessions` can do it at the next launch, and
  `resume.restartAfterCrash` by itself after a crash ([reopening sessions](configuration.md#reopening-sessions)).
- **Sleep, sign-out and restarts close it.** Switching user does not. `sandbox.keepAwake` (on by default) stops the PC
  from sleeping while a sandbox runs. The launch and `sandbox doctor` warn when Windows Update is waiting to restart:
  restart first, or pause updates.
- **Memory.** Inside the sandbox, `C:\AgentData\logs\memory-*.log` samples memory every 30 seconds (every 5 when it is
  high), and `memory-pressure.txt` says ok, high or critical. Fewer builds at once (cargo `build.jobs`) helps. See
  [heavy load](#the-sandbox-closes-under-heavy-load).
- **It just vanished.** When Windows logged nothing, but the sandbox was working and left no word of leaving, it counts
  as a crash ("ended suddenly while it was working"; the guest cannot tell a closed window from a crash). The report
  says what it was doing in its last seconds, and also reads graphics driver resets (Display 4101, GPU live kernel
  events) and Hyper-V or `vmwp.exe` errors. Closing the window while it sits idle is still on purpose.
- **"A program that runs the sandbox VM (vmwp.exe) crashed."** That program is part of Windows (Hyper-V), so the fault is
  in Windows' own code or a driver it uses (with vGPU on, usually the graphics driver). To learn which, let Windows keep
  a dump of it: after such a crash the next interactive launch asks once ("Keep a crash dump of the sandbox's VM?",
  Windows asks for administrator permission), or run `sandbox vm-dumps on` (`off` turns it off, `status` says). It sets
  Windows Error Reporting's LocalDumps for `vmwp.exe` (mini dump, the last 5 kept) in
  `%ProgramData%AgentSandboxm-dumps`; nothing else on your PC changes. The doctor shows the setting under
  Sandbox ("VM crash dumps"), and repair can turn it on.
- **What the report's dump lines mean.** After a `vmwp.exe` crash the crash report reads the newest dump itself (no
  debugger needed) and adds "What the dump shows: access violation (0xc0000005) in ntdll.dll+0x21afd; on its stack:
  a.dll, b.dll", then one line on what that points at: the graphics (vGPU) path (update the graphics driver, or keep
  `sandbox.vGpu` off for unattended runs), Hyper-V's own devices (update Windows), or Windows' VM worker (update
  Windows). The report also names your Windows release and edition, and with vGPU on the graphics adapter and driver
  version and date.
- **Is your Windows release still serviced?** A crash inside Windows' VM code is only fixed by a Windows update, and a
  release that is out of servicing gets none. Doctor (This PC > Windows release) and the crash report say so, with the
  date, for example "Windows 11 22H2 gets no more fixes since 15 Oct 2025 (Enterprise)"; the launch repeats it at most
  once a day. The release comes from the build and edition Windows reports, not from file versions (22H2 and 23H2 share
  the same ones).
- **Blue screens on your PC too?** Test its memory (Windows Memory Diagnostic, or turn off XMP/EXPO for a while).

## A program a build just made will not run: "The file or directory is corrupted and unreadable" (os error 1392)

Seen as a Rust build script (`build-script-build.exe`), a test program or a linker temp file that cannot start or be
read, now and then, or every time on a folder shared with this PC (the workspace, `C:\AgentData`).

- **Cause (measured in a sandbox, 5 Nov 2026).** MSVC's `link.exe` writes the executable into a mapped folder as a file
  of the right size that holds only zeros (Windows reports it as a corrupt image). The same link to the sandbox's own
  `C:` is fine, a plain copy of a good exe into the mapped folder is fine, and Rust's own lld (`lld-link`) writes the
  same file whole into the mapped folder. So it is how `link.exe` writes through the mapped folder, not your PC's
  disk, its free space, an antivirus (Defender is off in the sandbox) or the pagefile. Why it is "sometimes" in other
  people's logs is not known: in this test it failed every time. `cvtres.exe` (resources) and other MSVC tools that write
  into a mapped folder can show the same error.
- **What the sandbox does.** On the MSVC host, Rust links with lld (`rust.linker` `"lld"`, the default; the boot
  summary says `rust linking: lld`). If it still happens, check `rust.linker` is not `"gnu"` and that no
  `CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER` or `.cargo\config.toml` sets `link.exe` again.
- **Other build tools** that run `link.exe` (CMake, MSBuild, `cl /link`) have no such switch: build into the sandbox's own
  disk (`rust.targetDir` `"local"`, or an output folder under `C:\`) and copy the result into the workspace.
- **Nothing to do on your PC**: this is not caused by disk health or AV on the host.

## The PC froze or restarted during heavy builds

If the whole PC stops responding and restarts (not only the sandbox window closing), check these in order:

1. **vGPU.** With `sandbox.vGpu` on, the sandbox uses your graphics card, and with some drivers heavy use freezes the
   whole PC. A hard freeze with Kernel-Power 41 and nothing in `C:\Windows\Minidump` is typical of a graphics driver
   hang. Turn it off (`sandbox config set sandbox.vGpu false`) unless a program needs the GPU; Mesa gives software
   OpenGL. While vGPU is on, the sandbox runs gentler by itself, and the launch and `sandbox doctor` say so.
2. **`sandbox logs --crash`** prints the report of the last crash: when this PC was last seen working and when it
   restarted, the Windows events that matter and what they usually mean, any crash dump, and this PC's memory during
   the run (`<storage>\logs\host-memory-<data>.log`).
3. **Event Viewer** (Windows Logs > System, or Applications and Services Logs > Microsoft > Windows > Hyper-V-Worker
   and Hyper-V-Compute):
   - `Kernel-Power 41`: the unexpected restart. BugcheckCode 0 means a freeze, a power cut or a held power button;
     otherwise it is the blue screen's stop code.
   - `BugCheck 1001` (source WER-SystemErrorReporting): the stop code of a blue screen.
   - `WHEA-Logger 17, 18, 19, 47`: hardware errors (CPU, memory, bus, disk). Heat or failing hardware, not something a
     sandbox setting fixes.
   - `Resource-Exhaustion-Detector 2004`: this PC ran out of memory (RAM plus paging file), with the biggest users.
   - `C:\Windows\Minidump` and `C:\Windows\MEMORY.DMP` hold blue-screen dumps; the report lists their names and times.
4. **Memory:** see the next section.

## Windows says the sandbox was signed out, or one is already running

After the sandbox died (a crash, or Windows stopping it), Windows Sandbox can leave its own programs behind
(`WindowsSandbox.exe`, `WindowsSandboxClient.exe`, `WindowsSandboxRemoteSession.exe`, `WindowsSandboxServer.exe`) and
its service (`CmService`) can keep the old session. The next start then fails, or Windows says the sandbox was signed
out. The known way out is to close those leftover programs and try again, and when Windows still refuses, to restart
the Windows Sandbox service (that needs administrator permission).

The sandbox does this for you, after asking:

- **Starting** a sandbox: when it finds Windows Sandbox programs but no sign of life from your sandbox (the sandbox
  writes a heartbeat every 10 seconds; its watcher saw it end, or the heartbeat stopped minutes ago), it asks to close
  them and goes on. It never closes a sandbox that is working, one that started a moment ago, or another Windows
  user's, and it ends only the four Windows Sandbox programs above in your own Windows session.
- **Menu and web:** the Sandbox page shows "Windows Sandbox: programs left over" with a **Clean up** action. It asks
  first; if the programs will not go it offers to restart the Windows Sandbox service (Windows asks for permission).
- **`sandbox cleanup`** does the same on the command line (`--service` also restarts the service), and
  `sandbox repair` lists it as "Leftover Windows Sandbox programs".

If Windows still refuses after both, restart the PC.

## The sandbox closes under heavy load

`sandbox.memoryMb` is a ceiling, not a reservation: the sandbox takes memory from your PC as it goes (it shows as
`vmmem`). So whether heavy builds slow down or the sandbox closes depends on your PC's _commit limit_ (RAM plus paging
file), not only the sandbox's size. These protections are on by default and need no setting:

| Protection              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Default                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Memory sizing           | `memoryMb: "auto"` gives the sandbox at most the free RAM and the PC's unused commit, minus `reserveHostMb`. Whatever you ask, it never gets more than your PC can keep in RAM for it: your RAM minus max(`reserveHostMb`, 25 %), plus 4 GB with vGPU. A larger fixed `memoryMb` is lowered, and the launch says so                                                                                                                                                                                                                                                                                                                                                                                                               | on                              |
| Build budget            | Programs see only the CPUs and memory they may use: with a CPU cap they run on that share of the processors, and `NUMBER_OF_PROCESSORS` matches. Each session gets `CARGO_BUILD_JOBS` and `CMAKE_BUILD_PARALLEL_LEVEL` (if not set) from a budget of one job per 3 GB after 6 GB, at most 8 per session and shared with other sessions. `run\budget.json` (path in `SANDBOX_BUDGET_FILE`) holds the numbers                                                                                                                                                                                                                                                                                                                       | on                              |
| Governor in the sandbox | Every 2 seconds it checks the sandbox's memory and turns a dial in steps. **1** (below 15 % free RAM or above 80 % commit): compilers, linkers and build tools run at lower CPU and memory priority. **2** (10 % / 88 %): idle priority, compilers share at most 60 % of the CPU and take turns (paused a few seconds at a time, never killed). **3** (6 % / 94 %): 35 % CPU, a third of the compilers at a time, the waiting ones moved to the paging file. **4** (4 % / 97 %): 15 % CPU, one compiler at a time. It turns up at once and down one step after three calm samples. Agents, shells and Windows are never touched. It logs to `C:\AgentData\logs\memory-*.log` (lines starting `governor:`) and `run\pressure.json` | on (`sandbox.pressureResponse`) |
| Memory gate | When the programs the agents started gain committed memory faster than 4 GB within 3 seconds (3 GB with vGPU), new compilers, linkers and Unreal shader workers are held the moment they start (Windows reports it instantly through the agents' job). They then go on one at a time, every 1.5 s (2 s with vGPU), oldest first, never longer than 30 s. Nothing is killed; agents, shells, build tools such as UnrealBuildTool, MSBuild and cargo, and the editor are never held. It does not wait for your PC to run low: a burst itself is what it smooths. It logs `governor: gate:` lines and `held` in `run\pressure.json`; the crash report says "N builds held by the memory gate" | on (`sandbox.pressureResponse`) |
| Watchdog on your PC     | Every 10 seconds it checks your PC. When RAM, commit, CPU or disk run short for a while, it asks the governor for at least step 2. When your PC is nearly out of memory (under 1.5 GB free, or commit near its limit), it asks for step 4 at once. A disk queue at twice the limit for 40 seconds (or the limit itself for three times as long) also asks for step 4, and builds then get very low disk priority. It logs to `host-sync-<data>.log`                                                                                                                                                                                                                                                                                                                                                                                                                                              | on                              |
| Gentler with vGPU       | The CPU cap is 15 points lower (at least 50 %), every governor step and the watchdog start earlier, compilers run below normal priority from the start, and at most max(2, cores / 4), never more than 4, heavy compilers run at once from step 1. While a compiler or linker runs, the dial is at step 2 at least. Your PC keeps 4 GB more RAM free for the graphics driver. Games and other GPU programs are never touched; only build programs are slowed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | automatic                       |
| Last-resort backstop | Everything the agents start shares one Windows job object, with one hard limit just below the sandbox's commit limit (`sandbox.agentMemoryHeadroomMb`). The memory gate and the governor act long before it; it only matters when Windows inside the sandbox is about to refuse memory to everyone: then a build is refused instead | on                              |

A crash of the sandbox itself (vmwp.exe on your PC) has also been seen right after a large build burst with plenty of memory free; the memory gate makes such bursts gradual.

The settings for all of this are in [CPU, RAM and GPU](configuration.md#cpu-ram-and-gpu). A project file cannot change
them.

**Your paging file.** `sandbox doctor` ("This PC", "Memory for the sandbox") checks it. If it is fixed or off and too
small for the sandbox plus what your PC uses now, it warns: when your PC runs out, Windows closes the sandbox instead
of slowing it down. Let Windows manage it (System > Advanced system settings > Performance > Settings > Advanced >
Virtual memory: "Automatically manage paging file size"), or make it at least the size doctor names. Nothing changes it
for you.

If it still closes, `sandbox logs --crash` and the last lines of `C:\AgentData\logs\memory-*.log` show what used the
memory.

### Heavy builds plus a GPU game with vGPU: the known crash pattern

The whole sandbox (the Windows Sandbox VM) can be killed from your PC's side, with nothing wrong inside it, when:
many compilers and linkers (rustc, ld, link, clang) run at once, a GPU-heavy game or program runs in the sandbox too,
and `sandbox.vGpu` is on. The graphics driver's shared memory comes out of your PC's RAM, and build output written
through a mapped folder can saturate your PC's disk. Windows then stops the VM. The sandbox now does the following by
itself:

- With vGPU on, builds run at step 2 or harder while any compiler or linker is running, and at most 4 heavy compilers
  run at once. The game is never slowed.
- Compilers and linkers get low disk priority (very low from step 3), and linkers run one at a time from step 2.
- Your PC keeps 4 GB more RAM free with vGPU on.
- A disk queue that stays high now asks for the hardest step (4), not only a mild slowdown.
- Rust builds go to the sandbox's own disk when C: has 25 GB free (`toolchains.rust.targetDir: "auto"`), so they do
  not write through your PC's disks.
- Every 10 seconds the sandbox writes what it was doing; after a crash, `sandbox logs --crash` and `sandbox status`
  say what it was doing in its last seconds.

If it still happens, turn vGPU off (`sandbox config set sandbox.vGpu false`) while you build, or play the game outside
the sandbox.

## Contained storage (Beta)

For `storage.contained: "vhdx"` ([configuration](configuration.md#contained-storage-beta)). **Beta, not yet tried on a
real PC.** If something goes wrong, `sandbox storage contained off` is the way back, and `sandbox doctor` says what it
sees.

| Problem                                                                                        | What to do                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Contained storage is still mounted from an earlier sandbox", or doctor says "nothing uses it" | A sandbox ended without dismounting. `sandbox repair` dismounts it (Windows asks). The image is fine. By hand, in an admin terminal: `diskpart`, then `select vdisk file="<storage>\images\<name>.vhdx"` and `detach vdisk` |
| Doctor says "the record says the image is mounted, but it is not"                              | Only the record `<storage>\mounts\state.json` is out of date. `sandbox repair` corrects it                                                                                                                                  |
| "The image is still attached (something is using it)" / "the image is in use"                  | A program has a file open in the image (Explorer, a terminal, a scanner, an editor). Close it and run `sandbox repair` again. The sandbox must be closed too                                                                |
| "The image is attached somewhere else"                                                         | It was attached with Disk Management or another tool. Detach it there (or with diskpart above), then start again                                                                                                            |
| Windows did not give permission                                                                | Mounting and dismounting each need one permission prompt. Run the command again and choose Yes, or turn the feature off                                                                                                     |
| "The mount folder is not empty" / "is a mount point already"                                   | Something this tool did not put there is in `<storage>\mounts\<name>`. Nothing was changed: remove what does not belong (or detach that disk), then try again                                                               |
| "The image is missing"                                                                         | The `.vhdx` under `<storage>\images` was moved or deleted. Put it back, or turn the feature `off` and `on` for a new empty image (tools download again)                                                                     |
| "The image is bigger than the limit" / "differencing disk" / "not yours"                       | The image is not one this tool made. Nothing was changed. Raise `containedMaxGb`, or use the image you made                                                                                                                 |
| "Someone else may change ..." (storage helper)                                                 | The helper only mounts folders and images that only you, SYSTEM and admins may change. `sandbox repair` fixes the images and mounts folders; for the storage folder, remove the extra permission or `sandbox storage move`  |
| "Not yours (owner ...)" (storage helper)                                                       | A folder or the image belongs to another account, often Administrators (made from an admin terminal). Take ownership back (Properties > Security > Advanced > Owner), or make a new image                                   |
| "The storage helper used other folders ..."                                                    | The helper reads `%USERPROFILE%\.agent-sandbox\config.json` and the machine file; this command used others. Run without `--config`, or put the storage folder in your usual settings                                        |
| "The image was not closed cleanly ... permission prompt"                                       | The PC lost power while it was mounted. The permission prompt repairs it once; then the helper works again                                                                                                                  |
| "Too many calls; wait a minute" / "Only members of the Agent Sandbox Users group"              | The helper answers 10 calls a minute per user. Membership counts after signing out and in; without it, the permission prompt is used                                                                                        |
| A file `main.vhdx.failed-<time>` appears in `images`                                           | The first creation did not finish, and the unfinished image was renamed. It holds nothing of yours: delete it when you like                                                                                                 |
| "Contained storage cannot be used: ... inside a Windows Sandbox"                               | Disk images cannot be mounted in a sandbox. Run the command on your PC                                                                                                                                                      |
| `sandbox storage move` says the contained storage is mounted                                   | Dismount first (`sandbox repair`, or close the sandbox and wait)                                                                                                                                                            |
| `sandbox data` shows little after turning it on                                                | It still reads the plain data folder; your tools, state and logs are in the image                                                                                                                                           |
