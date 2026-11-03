# Several projects

One Windows Sandbox can hold several of your projects. Each has its own folder, tools, versions, databases,
`.sandbox-config.json` and environment. The commands are in [commands](commands.md#several-projects) and the settings
in [configuration](configuration.md#several-projects-in-one-sandbox).

## What a project is

A project is the folder you start from, or any folder you add later. A **project root** is a folder whose subfolders
are projects: for example `F:\Code`, with `F:\Code\api` and `F:\Code\web` inside. Set roots with
`sandbox projects roots add <folder>` (`projects.roots`).

Only one Windows Sandbox runs at a time, and its mapped folders are fixed when it starts. That is why a project can
join a running sandbox only in the ways below.

## Adding a project to a running sandbox

Run `sandbox claude` (any agent, or `start`, `exec`, `db`) in a folder the running sandbox does not have yet. It is
added without a restart when it can be:

1. **Inside a project root:** at once, also for folders made after the start.
2. **With `wsb share`** (Windows 11 24H2+ with the updated Windows Sandbox; untested): added live. Any error falls back
   to a restart.
3. **With live folders through HCS** (alpha, only if `projects.liveFolders: "hcs"` was on when the sandbox started):
   added live after one admin prompt. Any error falls back to a restart. See
   [below](#live-folders-through-hcs-alpha).
4. **Otherwise, a restart** that maps it too. It lists the sessions that will end, keeps your files, tools, databases
   and logins, and reopens those sessions afterwards. `--yes` skips the question; without a terminal it never restarts
   without `--yes`.

The project is then set up on demand: its toolchains, versions, databases, and its `.sandbox-config.json` (approved as
at a launch). Tools already installed cost nothing. Inside the sandbox, `sbx-shell <project>` opens a terminal in a
project with its tools.

When you start a project whose parent folder is not a root, you are asked once whether to add the parent as a root
(`projects.askToAddRoot`). A no is remembered (`projects.declinedRoots`).

**Getting `wsb`:** in Settings > Windows Update, turn on "Get the latest updates as soon as they're available" (or use
the Windows 11 Installation Assistant), then update Windows Sandbox from the Microsoft Store. Check with
`wsb --version`. `sandbox doctor` says whether it is found.

## Where a project appears inside the sandbox

A project is always at the same place inside, whichever project started the sandbox. That keeps git worktrees and
Claude's project history working, since both store absolute paths.

| The project is                                                                  | Inside the sandbox (default)    | With `guestWorkspace: "mirror"`                   |
| ------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------- |
| inside a project root, e.g. `F:\AgentProjects\app` with root `F:\AgentProjects` | `C:\Projects\AgentProjects\app` | `F:\AgentProjects\app`                            |
| anywhere else                                                                   | `C:\Workspace\app`              | its PC path (a shared folder: `C:\Workspace\app`) |

- Starting from `app` maps its whole root and opens `app` inside it (no second mapping).
- The sandbox guide (the managed `CLAUDE.md` every agent reads) names each mapped root as
  `C:\Projects\AgentProjects\*` = the PC folder, so agents know every project in it persists, and lists the tools of
  each project that was set up.
- Some projects keep their own `C:\Workspace\app` mapping even in a root, with a note at launch: a fixed
  `guestWorkspace` path, `readOnly`, or `workspaceFilter` (the root would show the folder unfiltered and writable).
- Two projects with the same folder name: the second gets `C:\Workspace\app-2`.
- Adding a root moves its projects from `C:\Workspace\<name>` to `C:\Projects\<root>\<name>` once. Git worktrees made at
  the old place need a repair ([troubleshooting](troubleshooting.md#projects-and-folders)).

Each mapped folder passes the same checks as a launch folder: no drive roots, your profile, system or tool folders.

## Consent

Some things are fixed when a sandbox starts, or only you may allow them. You are asked, and nothing changes without
your answer (or `--yes` for a restart).

**A project needs something the running sandbox lacks.** Things fixed at boot (vGPU or another device you allowed for
the project, a larger fixed `memoryMb`, its approved mappings) cannot be added later. Each missing item is named and you
choose:

- **Restart with them**: the sessions end, the sandbox restarts, and they reopen and continue.
- **Continue without them**: join the sandbox as it is.
- **Cancel**.

If the project's own settings are stricter than the running sandbox's (for example vGPU off while it is on), it asks
"Join with the sandbox's settings?" instead; `--yes` accepts. Without a terminal it continues and prints the restart
command. A sandbox that starts with several projects boots with what each of them wants and you allowed. A device
turned on that way is on for every project in it (the launch says so).

**Stricter protections.** Machine-wide protections (git access, network, the LAN block, clipboard and the other `.wsb`
settings, read-only) are fixed at start. A project that needs a stricter one than the running sandbox has cannot join
it, and says which setting. A project that asks for a looser one just gets the sandbox's stricter value. Nothing is
ever loosened.

**Folders outside the project.** A project's `.sandbox-config.json` may map folders outside the project only as
`projects.allowOutsideMappings` allows ([project settings](configuration.md#project-settings)).

## Live folders through HCS (alpha)

**Alpha, untested on a real PC.** On Windows without `wsb share` (Windows 10, Windows 11 before 24H2), this adds a
folder to the running sandbox through the Windows Host Compute Service, the way Windows Sandbox adds its own mapped
folders. It is off by default. Turn it on **before** the sandbox starts:

```
sandbox config set projects.liveFolders hcs
```

> If it fails, the sandbox may close: save your work first. Each add or remove asks for admin permission. It has not
> passed the real-PC tests in [the design note](design/hcs-live-folders.md#test-plan) yet, so use it only with a
> sandbox you can lose.

What happens when you start a project outside your roots:

1. The sandbox must be **yours** and started with the setting on.
2. Windows asks for permission. The helper finds the one running Windows Sandbox (if there are two, it stops). It first
   shares a test folder with a random token, and shares your folder only when the sandbox reads that token back.
   Otherwise nothing is shared and a restart is offered.
3. The folder appears at `C:\Workspace\<name>` (lower case), **read-only** in this alpha. `sandbox projects` and
   `sandbox status` list it as "live folder through HCS, alpha".
4. `sandbox projects remove <folder>` hides it inside, then removes the share (another prompt). If files in it are open
   in the sandbox, it stays until the sandbox stops.

Live folders end with the sandbox; a restart maps them at boot like any other project. Refused: drives, Windows,
Program Files, ProgramData, user profile folders themselves, this tool's storage and data folders, network drives,
folders with a link on the way, and folders you cannot read (or write, for a writable one). A subst drive is shared by
its real path. Each add or remove is logged in `<storage>\state\live-folders.log`.

## Security

**Every project mapped into a sandbox is visible to every agent in it, read and write.** That includes the launch
folder, every folder in your `projects.roots`, every project mapped with `projects.all`, and every project added while
it runs. An agent started for project A can read and change project B. Keep untrusted repos out of your roots and out
of `projects.all` (`sandbox projects exclude <folder>`), or give them their own sandbox and `storage.dataName`.

- Only your own settings can map more folders. A project's `.sandbox-config.json` cannot set `projects.*`.
- The repo guard covers every project the sandbox can write. A project that appears in a root after the start has no
  "before" picture, so any git hook, program-running git config or planted command in it is quarantined as if the
  sandbox had added it.
- Live folders are shared only from a command you ran, never on a request from the sandbox. The sandbox only shows what
  your PC shared, and read-only is enforced on your PC.
- A restart that adds a project needs your consent (a prompt or `--yes`).

The rest of the sandbox's protections: [security](security.md).
