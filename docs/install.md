# Install

## Requirements

- Windows 10 or 11 **Pro, Enterprise or Education** (Home has no Windows Sandbox)
- Virtualization turned on in the BIOS/UEFI
- 8 GB of RAM or more is comfortable. The sandbox takes what is free, minus a reserve for your PC.
- Nothing else: the installer brings its own Node.js, used only by this tool

## One line

```powershell
irm https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/install.ps1 | iex
```

The installer:

1. checks the edition, virtualization, RAM and disk;
2. offers to turn on Windows Sandbox (this needs admin and a reboot);
3. asks who it is for: **1) Just me** or **2) Everyone on this PC** (needs admin);
4. installs, brings your saved settings up to date (`sandbox migrate`), asks once whether updates should install by
   themselves, and runs `sandbox doctor`.

## Just me, or everyone

|                          | Just me (default)                                                                                                                 | Everyone on this PC                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Program                  | `%LOCALAPPDATA%\WindowsDevelopmentSandbox`                                                                                        | `%ProgramFiles%\WindowsDevelopmentSandbox` (only admins can change it) |
| PATH and Start menu      | yours                                                                                                                             | the whole PC's                                                         |
| Saved data               | `%ProgramData%\AgentSandbox\users\<name>`, private to you (an older `%LOCALAPPDATA%\AgentSandbox` stays in use until you move it) | the same: one private folder per user                                  |
| Admin rights             | only to turn on Windows Sandbox                                                                                                   | once, to install                                                       |
| Automatic updates        | checked when you run a command                                                                                                    | a scheduled task at 03:00                                              |
| Contained storage (beta) | a permission prompt for each mount                                                                                                | the same, or no prompt with the optional storage helper                |

An install for everyone needs an admin PowerShell (right-click Start, **Terminal (Admin)**). It also:

- creates the local group **Agent Sandbox Users** and adds you (add others with `-AddUsers`). A new member must sign
  out and in once.
- asks "Let other users of this PC use a sandbox you start?" and saves the answer in the machine settings file. Windows
  runs one sandbox per PC, so this is how a second user can use it ([several users](security.md#several-users-on-one-pc)).
- asks whether to install the **storage helper** (default no). It is a small Windows service, `AgentSandboxStorage`,
  that mounts the disk image of [contained storage](configuration.md#contained-storage-beta) without a permission
  prompt. It runs as SYSTEM and only serves members of the group, each for their own image. It is built on your PC
  with the C# compiler that ships with Windows. What it checks: [security](security.md#contained-storage-beta).

## Options

The one-liner takes no options. To pass them, run the script as a script block:

```powershell
& ([scriptblock]::Create((irm https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/install.ps1))) -Scope AllUsers -AutoUpdate -AddUsers alice,bob
```

| Option                                                  | Environment variable        | What it does                                                                                                                                                                   |
| ------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-Scope CurrentUser\|AllUsers`                          | `WDS_SCOPE`                 | where to install (asked when missing)                                                                                                                                          |
| `-AutoUpdate` / `-NoAutoUpdate`                         | `WDS_AUTOUPDATE=1` / `0`    | answers the automatic-updates question                                                                                                                                         |
| `-AddUsers a,b`                                         | `WDS_ADDUSERS`              | everyone: also add these users to the group                                                                                                                                    |
| `-Share` / `-NoShare`                                   | `WDS_SHARE=1` / `0`         | everyone: answers the sharing question (also changes it on a later run)                                                                                                        |
| `-ContainedStorageHelper` / `-NoContainedStorageHelper` | `WDS_STORAGEHELPER=1` / `0` | everyone: install (or remove) the storage helper. Asked once when neither is given; the answer is kept                                                                         |
| `-StartMenuShortcut`                                    | `WDS_SHORTCUT=1`            | also make a Start menu shortcut. Off by default, because some antivirus tools (Malwarebytes "Trojan.Loader") wrongly flag it. Without this option an older shortcut is removed |
| `-Uninstall`                                            | `WDS_UNINSTALL=1`           | remove the program, PATH entry, shortcut, scheduled task and storage helper. Your data stays                                                                                   |
| `-RemoveData`                                           | `WDS_REMOVEDATA=1`          | with `-Uninstall`: also delete your saved data, after you type `DELETE` (`-Confirm:$false` skips that)                                                                         |
| `-Version x.y.z`                                        | `WDS_VERSION`               | install this release instead of the latest (older ones too)                                                                                                                    |
|                                                         | `WDS_PACKAGE`, `WDS_SHA256` | install this package (a file or https address) instead, checked against that checksum                                                                                          |
|                                                         | `WDS_ALLOW_UNVERIFIED=1`    | install a release that GitHub lists no SHA-256 for                                                                                                                             |

The release package is checked against the SHA-256 that GitHub lists for it (the asset digest, else the release's
`SHA256SUMS`). If there is none, the installer stops rather than install something it cannot check.

## What is installed

```
<install folder>\
  node\v22.x.y\node.exe            private Node.js (official zip, SHA-256 checked)
  versions\1.5.0\package\          the release, one folder per version
  bin\sandbox.cmd, ...             the commands on your PATH (they read the two files below)
  active-version                   which version runs
  active-node                      which Node runs it
  install.json                     scope, group, automatic updates, storage helper
  helper\AgentSandboxStorage.exe   everyone, when chosen: the storage helper service
  update-state.json                what the updater did
```

An update changes only the two `active-*` files. So a new version is checked before it is used, and the old one stays
for a rollback. Only `bin\` goes on your PATH, not Node itself.

## Updating

`sandbox update` installs the newest version. `--check` only looks, and `--rollback` goes back one version. A running
sandbox keeps the version it started with until it restarts. A version that fails to start is not used, and is not
tried again until a newer one exists.

`sandbox update --auto on` makes updates install by themselves:

- **Just me:** checked when you run a command, at most once a day.
- **Everyone:** the scheduled task `\WindowsDevelopmentSandbox\Update` (daily at 03:00 with up to an hour of random
  delay, as SYSTEM). Changing this needs an admin terminal.

After an automatic update, your next command tells you once ("Updated to 1.6.0", or that it failed and was undone).

`sandbox update` does not rebuild the storage helper; it keeps working across updates. Running the installer again
rebuilds it.

An npm install is updated with npm: `sandbox update` prints the command.

### When an update fails

If an update or installer run fails part way (bad checksum, broken package, a version that does not start, a failed
`sandbox migrate` ...), the previous version is put back and the half-installed one is deleted. **Automatic updates
are then switched off** (`autoUpdate: false` in `install.json`). You are told once:

> The update to X failed and was undone (you are on Y). Automatic updates are off; turn them back on in Maintenance >
> Updates or with `sandbox update --auto on`.

A network error before anything was downloaded changes nothing. Your saved data is never touched.

### Rolling back, or installing an older version

`sandbox update --rollback` returns to the version the last update replaced. To go further back, run the installer
with `-Version x.y.z` (for example `-Version 1.4.0`). Your data folder is pinned in your settings, so an older version
still finds it.

## Upgrading from an older version

Run the one-liner again. It finds the old version however it was installed and replaces it:

- An npm package (`windows-development-sandbox` or the old `agent-sandbox`) is uninstalled. The 1.x commands are
  replaced in the same place, so your PATH entry stays.
- Your saved settings are brought up to date by `sandbox migrate`, after a backup. `--dry-run` lists what it would
  change; `--restore <backup>` puts a backup back.
- Moving from "just me" to "everyone": your data stays where it is. The next command offers to move it, showing size
  and time, or run `sandbox storage move` any time ([where your data is kept](configuration.md#where-your-data-is-kept)).

## Just me and everyone do not mix

The PC's PATH comes before yours, so an install for just you would never run next to one for everyone. So:

- With an install for everyone present, `-Scope CurrentUser` is refused. The installer prints the command to remove
  the other one first (`-Uninstall -Scope AllUsers` in an admin PowerShell; your data is kept).
- `-Scope AllUsers` offers to remove an install for just you and the old `C:\Scripts\agent-sandbox` layout.

`sandbox doctor` lists every copy of the commands on your PATH. See
[the wrong version runs](troubleshooting.md#install-and-updates).

## Uninstall

```powershell
& ([scriptblock]::Create((irm https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/install.ps1))) -Uninstall -Scope AllUsers
```

Without `-Scope` it removes the install there is (and asks which if there are both). Add `-RemoveData` to delete your
saved data too. For everyone, the storage helper is removed first: it is stopped, the images it mounted are dismounted,
and the service is deleted. A running sandbox keeps its image mounted: close it and run `sandbox repair` later. The
helper's log in `%ProgramData%\AgentSandbox\logs` stays until your saved data is removed.

## By hand, with npm

```powershell
# 1. Windows Sandbox, in an admin PowerShell, then reboot
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All

# 2. The package (needs Node.js 20+; updates then come through npm)
npm install -g windows-development-sandbox

# 3. Check
sandbox setup     # edition, virtualization, Windows Sandbox, RAM, disk, Node
sandbox doctor    # what will be copied from this PC or downloaded
```

## First start

The first start downloads what the project needs and cannot copy from your PC. It takes a few minutes, once, with
installs running in parallel. The launch tells you first, with a rough size. With `-t` (or `sandbox start`) your
terminal shows the current step and download on one line. Without `-t`, follow along with `sandbox logs -f`. Later
starts take seconds.
