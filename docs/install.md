# Install

## Requirements

- Windows 10 or 11 **Pro, Enterprise or Education** (Home has no Windows Sandbox)
- Virtualization turned on in the BIOS/UEFI
- 8 GB RAM or more is comfortable; the sandbox takes what is free, minus a reserve for your PC
- Nothing else: the installer brings a private Node.js just for this tool

## One line

```powershell
irm https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/install.ps1 | iex
```

It checks the edition, virtualization, RAM and disk, offers to turn on Windows Sandbox (that step asks for admin and
needs a reboot), and asks who it is for:

```
1) Just me
2) Everyone on this PC (needs admin)
```

Then it installs, brings your saved settings up to date (`sandbox migrate`), asks once whether new versions should
install themselves, and runs `sandbox doctor`.

## Just me, or everyone

| | Just me (default) | Everyone on this PC |
|---|---|---|
| Program | `%LOCALAPPDATA%\WindowsDevelopmentSandbox` | `%ProgramFiles%\WindowsDevelopmentSandbox` (only administrators change it) |
| PATH and Start menu | yours | the whole PC's |
| Saved data (accounts, history, storage) | `%ProgramData%\AgentSandbox\users\<name>` (private to you); an earlier `%LOCALAPPDATA%\AgentSandbox` stays in use until you move it | `%ProgramData%\AgentSandbox\users\<name>`, one private folder per user |
| Admin rights | only to turn on Windows Sandbox | once, to install |
| Automatic updates | checked when you start a command | a scheduled task at 03:00 |
| Contained storage (beta) | a permission prompt for each mount | the same, or no prompt with the optional storage helper |

For everyone, the installer also creates the local group **Agent Sandbox Users** and puts you in it (add others with
`-AddUsers`). A user added to the group must sign out and in once before it counts. It asks "Let other users of this PC
use a sandbox you start?" and saves the answer in the machine settings file (see [Configuration](configuration.md)).
Windows runs one sandbox per PC, so this is how a second user can still use it: [Security](security.md#several-users-on-one-pc).

For everyone, it also asks whether to install the **storage helper** (default no): a small Windows service,
`AgentSandboxStorage`, that mounts the disk image of [contained storage](configuration.md#contained-storage-beta)
without a Windows permission prompt each time. It runs as SYSTEM, answers only members of the group, and only for
their own image in their own storage folder; what it checks and what it cannot protect against is in
[Security](security.md#contained-storage-beta). It is built on your PC with the C# compiler that ships with Windows,
from the sources in the installed package, into the install folder.

Everyone installs need an admin PowerShell (right-click Start, Terminal (Admin)). Without admin the installer stops and
says so.

## Options

The one-liner takes no options. To pass them, run the script as a script block:

```powershell
& ([scriptblock]::Create((irm https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/install.ps1))) -Scope AllUsers -AutoUpdate -AddUsers alice,bob
```

| Option | Environment variable | What it does |
|---|---|---|
| `-Scope CurrentUser\|AllUsers` | `WDS_SCOPE` | where to install (asked when missing) |
| `-AutoUpdate` / `-NoAutoUpdate` | `WDS_AUTOUPDATE=1` / `0` | answer the automatic-updates question |
| `-AddUsers a,b` | `WDS_ADDUSERS` | everyone: also put these users in the group |
| `-Share` / `-NoShare` | `WDS_SHARE=1` / `0` | everyone: answer the sharing question (also changes it on a later run) |
| `-ContainedStorageHelper` / `-NoContainedStorageHelper` | `WDS_STORAGEHELPER=1` / `0` | everyone: install the storage helper service (or remove it); asked once when neither is given, then the answer is kept |
| `-StartMenuShortcut` | `WDS_SHORTCUT=1` | also make a Start menu shortcut. Off by default: some antivirus tools (Malwarebytes "Trojan.Loader") flag a shortcut that starts a command script, a false positive. Without it an earlier shortcut is removed |
| `-Uninstall` | `WDS_UNINSTALL=1` | remove the program, PATH entry, shortcut, scheduled task and storage helper; your data stays |
| `-RemoveData` | `WDS_REMOVEDATA=1` | with `-Uninstall`: also delete saved data, after you type `DELETE` (`-Confirm:$false` skips that) |
| `-Version x.y.z` | `WDS_VERSION` | install this release instead of the latest (also an older one) |
| | `WDS_PACKAGE`, `WDS_SHA256` | install this package (a file or https address) instead of the latest release, checked against that checksum |
| | `WDS_ALLOW_UNVERIFIED=1` | install a release GitHub lists no SHA-256 for |

The release package is checked against the SHA-256 GitHub lists for it (the asset digest, else the release's
`SHA256SUMS`). If there is none, the installer stops instead of installing something it cannot check.

## What is installed

```
<install folder>\
  node\v22.x.y\node.exe     private Node.js (official zip, SHA-256 checked)
  versions\1.5.0\package\   the release, one folder per version
  bin\sandbox.cmd, ...      the commands on your PATH (they read the two files below)
  active-version            which version runs
  active-node               which Node runs it
  install.json              scope, group, automatic updates, storage helper
  helper\AgentSandboxStorage.exe   everyone, when chosen: the storage helper service
  update-state.json         what the updater did
```

Only the two small `active-*` files change when you update, so a new version is checked before it is used and the old
one stays for a rollback. Your PATH only gets `bin\`, not `node` itself.

## Updating

`sandbox update` installs the newest version (`--check` only looks, `--rollback` goes back one version). It never runs
while a Windows Sandbox is running. A version that fails to start is not used, is recorded as failed, and is not tried
again until a newer one exists.

`sandbox update` does not rebuild the storage helper: it keeps working across updates (the CLI and the service agree
on a protocol version and the CLI uses the permission prompt when they do not). Running the installer again rebuilds it
from the new version.

`sandbox update --auto on` makes this happen by itself. For one user it is checked when you start a command, at most
once a day. For everyone it is the scheduled task `\WindowsDevelopmentSandbox\Update` (daily 03:00, up to an hour of
random delay, as SYSTEM); switching that needs an admin terminal. After an automatic update you are told once on your
next command ("Updated to 1.6.0", or that the update failed and was undone).

### When an install fails

An update or an installer run that fails after it started changing the install (bad checksum, unpackable or broken
package, a version that does not start, the commands or pointers cannot be switched, `sandbox migrate` fails) puts the
previous version back: the active-version and active-node pointers and the commands in `bin\`. The half-installed
version is deleted and **automatic updates are switched off** (`autoUpdate: false` in `install.json`; for everyone the
scheduled task is removed too, and a task that stays does nothing because it reads `install.json`). You are told once:
"The update to X failed and was undone (you are on Y). Automatic updates are off; turn them back on in Maintenance >
Updates or with `sandbox update --auto on`." A plain network error before anything arrived changes nothing and leaves
automatic updates on. Your saved data is never touched.

### Rolling back and installing an older version

`sandbox update --rollback` returns to the version the last update replaced (pointers and commands). To go further back,
run the installer with `-Version x.y.z` (`WDS_VERSION`), for example `-Version 1.4.0`; it says "Installing an older
version: 1.4.0 over 1.5.0". The data folder is pinned in your settings when it moves, so an older version still finds it.

## Upgrading from an older version

Run the one-liner again. Whichever way the old version was installed, the installer finds it and replaces it:

- the npm package (`windows-development-sandbox` or the old `agent-sandbox`) is uninstalled, and the 1.x private-Node
  wrappers are replaced by the new commands at the same place (so your PATH entry stays);
- your saved settings are brought up to date by `sandbox migrate` (a backup is kept first; `--dry-run` lists what it
  would change, `--restore <backup>` puts a backup back);
- moving from just you to everyone: your data stays where it is until you move it. The next `sandbox` command (or the
  menu) offers to move it to `%ProgramData%\AgentSandbox\users\<you>` with its size and time; `sandbox storage move`
  does it any time ([where your data is kept](configuration.md#where-your-data-is-kept)). A storage folder that an old
  `sandbox config init` wrote into your config is removed when the shared folder has the data or the old one is empty;
  one you set yourself stays (and that sandbox cannot be shared).

## Install for everyone and for just you do not mix

The PC's PATH comes before yours, so an install for just you never runs next to one for everyone. The installer therefore
refuses `-Scope CurrentUser` while an install for everyone exists and prints the command that removes it first (an admin
PowerShell, `-Uninstall -Scope AllUsers`; your data is kept). With `-Scope AllUsers` it offers to remove an install for
just you and an older `C:\Scripts\agent-sandbox` layout (default no; without a terminal it only prints the commands).
`sandbox doctor` lists every copy of the commands on the PATH. See
[the wrong version runs](troubleshooting.md).

## Uninstall

```powershell
& ([scriptblock]::Create((irm https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/install.ps1))) -Uninstall -Scope AllUsers
```

Without `-Scope` it removes the install there is (and asks which when there are both). Add `-RemoveData` to delete the
saved data as well. For everyone, the storage helper goes first: the service is stopped, every image it mounted is
dismounted (a running sandbox keeps its image mounted: close it and run `sandbox repair` later), and the service is
deleted. Its log in `%ProgramData%\AgentSandbox\logs` stays until the saved data is removed.

## By hand

```powershell
# 1. Windows Sandbox, in an admin PowerShell, then reboot
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All

# 2. The package (Node.js 20+ needed; updates are then done with npm)
npm install -g windows-development-sandbox

# 3. Check
sandbox setup     # edition, virtualization, Windows Sandbox, RAM, disk, Node
sandbox doctor    # what will be copied from this PC or downloaded
```

An npm install works fully, but `sandbox update` only prints the npm command for it.

## First start

The first start downloads what the project needs and cannot copy from your PC: a few minutes, once, with installers
running in parallel. The launch says so first, with a rough size. With `-t` (or `sandbox start`) your terminal then
shows the current step and what is downloading on one line, says when nothing has changed for a few minutes, and ends
with how long it took. Without `-t`, follow along with `sandbox logs -f`. Everything is kept in persistent storage, so
later starts take seconds.
