# Security

The sandbox is treated as hostile, and your PC as precious. Review what an agent writes like a contribution from a
stranger.

## Containment

- The agent can write only your project folder (and the other projects you map, see
  [several projects](#several-projects)) and its own storage.
- Drive roots, your user profile, system folders and this tool's folders are refused as workspaces.
- `workspaceFilter.enabled` keeps what git ignores (`.env` files with real keys, `node_modules`, build output) out of
  the sandbox entirely ([git-ignored files](configuration.md#git-ignored-files)).
- Your LAN is blocked from inside (DNS excepted). `network.allowOnly` and `network.blockHosts` limit it further; these
  are guardrails inside the sandbox ([network](configuration.md#network)). `sandbox.networking: false` cuts all network
  access.
- vGPU is off by default.
- `C:\AgentData` (tools and databases) is shared by every project's sandbox. Give a repo you do not trust its own data
  set with `storage.dataName`.
- Inside the disposable sandbox only, the "Do you want to run this file?", SmartScreen and firewall prompts are off.

## Secrets

Before your Claude settings are copied in, these are stripped:

- `settings.json` `env`
- credential helpers (`apiKeyHelper`, `awsCredentialExport` ...)
- every MCP server's env, headers, URL and arguments

And these are removed from the environment:

- AWS, Azure, Google Cloud and Cloudflare credentials, and hosting, CI, registry, payment and AI API keys
- database URLs
- anything named `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, `*_KEY` or `*PROD*`
- values that look like keys, whatever they are called

`secrets.allow` lets named variables through, and `secrets.patterns` strips more. A project file cannot weaken this
([project settings](configuration.md#project-settings)). The launch output lists what was kept back, and warns about
files like `.env` or `*.pem` that the agent can read because they are in the project folder.

### Your own logins and keys

- **Saved logins are encrypted.** Accounts saved with `sandbox account save` and the VPN login are sealed with Windows
  DPAPI for your Windows user. The files in `<storage>\accounts` and `<storage>\vpn` hold only names, dates and e-mail
  addresses in the clear. Nobody else can open them, even with a copy of the files.
- **Your storage folder is private.** A new, empty one gets permissions for you, SYSTEM and administrators only. A
  folder that already holds files is not rewritten; `sandbox doctor` shows how it is protected.
- **Secrets never sit in files the sandbox keeps.** `session.json` and the launch folder (mapped read-only and kept for
  days) hold no API key, no agent `environment` value, no Claude login and no VPN login. Those go in a one-shot file in
  `<data>\secrets` (not in `run\`, so other users of a shared sandbox cannot touch it). The sandbox reads and deletes it
  at once; anything left is removed when the sandbox stops. A shared sandbox never gets your values.
- **What the agent can always see:** its own environment, the login it was started with, and everything in your project
  folder. The agent is an administrator inside. Treat every key you give it as one it can read, use and leak: use keys
  you can revoke, with the smallest rights.
- **Settings print `***`** for secret values (`sandbox config show`, the settings screen, `doctor`, every `--json`).
- **The audit log** ([audit log](configuration.md#audit-log), on by default) records command lines, file names and
  commit messages, on your PC only (`<storage>\audit`), for `audit.days` (7) at most. Credentials are hidden first, but a
  secret with no recognisable shape or name can still appear: treat the folder like your shell history.
- `network.proxy` takes no `user:password@`, because it would be stored in plain text where the agent can read it.

## Nothing runs on your PC

- Your PC and the sandbox talk through small JSON files. The sandbox can ask for four things (start a session, run a
  command, restart, ping), and everything it writes is validated and size-capped.
- Text from the sandbox loses its escape sequences before it reaches your terminal. When you attach, the output passes a
  filter that drops clipboard reads (OSC 52), terminal macros and other control strings; colours, titles, links and
  progress pass. The agent's "copy" (an OSC 52 clipboard write) passes only where the sandbox can already reach your
  clipboard: in the sandbox's own terminal, and in `sandbox attach` while `sandbox.clipboard` is on. The web UI drops it.
- Programs and scripts (`.exe`, `.ps1`, `.bat`, `.cmd`, `.msi`, `.lnk` ...) that appear or change in your project while
  a sandbox runs get Windows' "downloaded from the internet" mark (`storage.markSandboxFiles`, on by default). SmartScreen
  then asks before one runs, and PowerShell's RemoteSigned policy refuses an unsigned marked script. Programs you build
  on your PC at that time get it too; `Unblock-File` removes it.
- What the sandbox adds to a project that tools on your PC would run by themselves is moved to
  `agent-sandbox-quarantine`: git hooks and program-running git config (also in submodules and nested repos), hooks in
  a `core.hooksPath` folder (husky), commands planted in the project root under names you type (`node.exe`,
  `sandbox.cmd` ...), Claude Code hooks, helper commands, MCP servers, plugins and whole-tool permissions such as
  `"Bash"` (`.claude/settings*.json`, `.mcp.json`), VS Code folder-open tasks and program paths, and `.envrc`. Ordinary
  edits to those files stay. Scripts that a hook, task or MCP server names elsewhere in the project are not checked:
  review them like any other change. `sandbox status` lists what was quarantined.
- Links the sandbox plants are never followed, and files it writes are read with bounded effort.
- Attaching from your terminal connects only into the sandbox's Hyper-V network, with a token per session.

## Downloads

Toolchain, database and tool downloads are checked against the SHA-256 or SHA-512 their publisher lists, and a mismatch
deletes the file. Some sources list none (for example a script from a vendor's site); those are allowed by default.
`downloads.requireChecksum: true` refuses any download without a published checksum. A project file can turn this on,
never off. The installer checks its own package the same way ([install](install.md#options)).

## Coming back

- Only data files return with history, and only for the projects in the sandbox. A conversation the sandbox writes for
  any other project never reaches your PC.
- Going in, only the sandbox's own projects' history is copied (`claudeProfile.historyScope: "project"`). `"all"` copies
  everything.
- claude-mem's database does **not** come back by default: it is loaded into every Claude session on your PC, so a
  compromised agent could plant instructions there. `claudeProfile.syncClaudeMemBack: true` brings it back (the database
  files only). Its settings (API keys), `.env` files and backups are never copied in.
- Git hooks, dangerous git config and planted commands are quarantined before your own git or shell can run them (see
  above).

## Git access

`provisioning.git.access`, which a project can set (only stricter):

|                  |                                                              |
| ---------------- | ------------------------------------------------------------ |
| `full` (default) | git as normal                                                |
| `readonly`       | status, log, diff, show, blame and listing branches and tags |
| `none`           | no git; the repository is invisible                          |

`ssh` comes with Git, but no keys are copied in and your LAN is blocked, so deploys stay on your PC.

## GitHub CLI

`gh` never gets your PC's login (`GH_TOKEN` and `GITHUB_TOKEN` are stripped). It is installed only with git access
`full`, because it can push and merge through the GitHub API. A `gh auth login` made inside is kept in
`C:\AgentData\state\gh`.

**A token for sandboxes (opt-in).** You can save a GitHub token made only for sandboxes (`sandbox github login`) and
turn on `github.shareToken` ([how](configuration.md#github-token)):

- Only that token is shared, never your PC's `gh` login. Make it **fine-grained**: limited repositories, only the
  permissions needed, and an expiry. A classic token gets a warning; OAuth tokens (`gho_`) are refused.
- On your PC it is encrypted with DPAPI (`<storage>\github\token.json`) and never printed. `status` shows only whether
  one is saved, its kind and its date.
- It is handed over only when `github.shareToken` is on **and** git access is `full`, and not when any other project
  mapped at boot has `readonly` or `none` (the token would let the agent push past the git guard). A project file cannot
  set `github`. It travels only in the one-shot secrets file: never in `session.json`, the launch folder, `run\`, logs or
  process arguments.
- Inside, `gh auth login --with-token` reads it into a gh folder on the sandbox's own disk (wiped with the sandbox), and
  `gh auth setup-git` makes https git use it.
- **The agent can read it** (`gh auth token`) and use it for everything it allows. Revoke it on GitHub when you no longer
  need it; `sandbox github logout` deletes it from your PC.
- If you share your running sandbox with another Windows user, their sessions in it can use your token too. Their own
  launches never get it.
- gh lives in the shared tools folder, which other sandboxes using the same data set can write. Keep untrusted projects
  in a data set of their own.

## Service sign-ins

Sign-ins for game stores, engines and app signing (Epic, Steam, Unity, Cfx.re, an Android keystore, Google Play, Expo,
App Store Connect) can be kept for sandboxes ([accounts](accounts.md)). Each one is off until you turn on
`accounts.<service>.share`.

- On your PC each one is encrypted with DPAPI (`<storage>\accounts\<service>.json`, host-only storage) and never
  printed. It travels only in the one-shot secrets file the sandbox reads and deletes at boot, and only to a sandbox
  where a toolchain that uses it is on.
- **The agent can use every sign-in its sandbox gets.** A project file can turn sharing off, never on; when one project
  in a sandbox turns it off, the sandbox does not get it.
- Epic, Steam and Unity work in one place at a time: one sandbox holds each (your PC keeps the hold, in host-only
  storage). Renewed ones come back through the data folder (`state\accounts\<service>.json`, readable by sandboxes using
  that data set until your PC takes it): your PC takes one only from the sandbox that holds it, within its size limit,
  of the right shape and never through a link, and deletes anything else unread.
- `sandbox account logout <service>` deletes the saved one, its hold, and copies a sandbox left behind.

## Licences and big installs

A project file can never accept a licence for you: every `toolchains.<name>.acceptLicense` (MSVC, Unreal, Unity, the
FiveM server, the Android SDK) is a protection a project can only turn off. Those toolchains are 1-60 GB, so "auto"
installs them only once you accept. Big installs check for room first, and `sandbox data` lists their sizes.

## Installs on this PC

`pcInstalls` maps games, engines and editors installed on your PC into sandboxes **read-only** (under `C:\PcInstalls`),
so nothing is copied. The agent can read their files. These settings are yours only: a project file cannot have them,
and each folder is checked like any other mapping (never a whole drive, a user profile or this tool's own folders).

## Several projects

Every project mapped into a sandbox is visible to every agent in it, read and write. Keep untrusted repos out of your
roots and out of `projects.all` (`sandbox projects exclude <folder>`), or give them their own sandbox and
`storage.dataName`. More: [projects](projects.md#security).

## Several users on one PC

With an all-users install, each user has a private storage folder under `%ProgramData%\AgentSandbox\users\<name>`
(accounts, logins, history, approvals) that only they, SYSTEM and administrators can open. An empty storage folder that
belongs to another account is refused; an administrator must delete it.

Windows runs one sandbox per PC, and its window belongs to the user who started it. Other users can use it only when the
owner turns on `sharing.otherUsers`. While it runs, members of **Agent Sandbox Users** may then pass through the owner's
storage and data folders (no listing, no reading) and read and write the data set's `run` folder, where sessions and
requests are. These permissions are removed when the sandbox ends.

That lets them list sessions, attach to one, run commands, and stop the sandbox after typing the owner's name. They use
the agent logins already in the sandbox, history goes to the owner, and they can read what an agent can read. **Share
only with people you would let sit at your keyboard.**

Your own secrets stay out of someone else's sandbox: your agent environment values are not sent and `--account` is
refused. Restarting it, adding a project, showing its window and starting a new one are the owner's alone. Everything
read from the owner's folders is checked like anything from a sandbox.

## Agent commands (Beta)

Off by default. When on, it adds one folder (in this tool's storage) to the start of your own PATH, holding only the
forwarding commands it wrote. `off` removes them and the entry. A project file cannot turn it on.
[How it works](configuration.md#agent-commands-beta).

## Remote access to the web UI (Beta)

Off by default ([web-ui.md](web-ui.md#remote-access), [design](design/remote-access.md)).

- **Access is control.** The web UI runs as you. A remote user with control can type into your agents' terminals and
  read what they can read, logins included. View cannot change anything, but sees terminal output, logs and the audit
  log.
- **Local network only.** LAN mode listens on one private IPv4 address of a real adapter, on the Private network it was
  turned on for. It drops every connection that is not from a private address on that network (or that comes from this
  PC or a sandbox). Its firewall rule allows only the local subnet. No tunnels or port mapping.
- **Devices** sign in with a one-time code from your screen (40 bits, 5 minutes, one use, wrong tries limited). Their
  credential is a `__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict` cookie. Only its SHA-256 is kept, sealed with
  DPAPI, and it ends after `web.remote.rememberDays`. Signing out (or LAN mode off) closes their open pages.
- **The certificate** is made on your PC (397 days, key sealed with DPAPI) and kept, so a second warning on a phone
  means someone may be in between. Someone who clicks through the first warning without comparing the fingerprint could
  be fooled by an attacker already on the network at that moment.
- **Other Windows users** are identified by Windows, through your web UI's named pipe (low-integrity processes,
  AppContainers and services are refused). Only users you list get in.
- **Roles fail closed.** An operation is the owner's unless it says otherwise. Settings, remote access, logins and the
  audit log stay yours. The server checks every call and logs every remote action.
- **Your own cookie** is tied to your own connections when HostTools can be built, and `sandbox web open` checks that
  the server on the port holds the token before opening the link.

## VPN (Alpha)

`vpn.enabled` sends the sandbox's traffic through a VPN ([vpn.md](vpn.md)).

- **It is not a cage.** The agent is the administrator inside, so it can read the VPN login while the sandbox runs and
  turn the tunnel off. The VPN keeps a well-behaved agent off your normal connection and hides your address from the
  sites it visits; it does not contain a hostile one.
- **Your login** is encrypted on your PC and handed over only in the one-shot secrets file. The NordVPN login is a
  **service credential** you can revoke, not your account password.
- **The kill switch** (on by default) blocks everything outside the tunnel before the tunnel starts, so a failed tunnel
  means no internet, not an open connection. A project can turn it on, never off, and can never choose a VPN, server,
  profile or login.
- **VPN profiles are untrusted.** An OpenVPN profile is checked on your PC and again in the sandbox: anything that could
  run a program (`script-security`, `up`, `down`, `plugin`, `route-up`, `tls-verify` ...) is refused. A WireGuard config
  is checked the same way: only known keys are accepted, and `PreUp`, `PostUp`, `PreDown`, `PostDown`, `Table`,
  `SaveConfig` and anything unknown are refused (a refusal never prints a key). The agent can read the WireGuard private
  key while the sandbox runs: use a key you can revoke.
- **Installers** for OpenVPN and WireGuard are checked against a SHA-256 stored in this program. Tool downloads before
  the tunnel is up (the first minutes of a boot) use your normal connection.
- **What the sandbox says about its tunnel** (`run\vpn.json`) is its own word. `sandbox vpn status` compares the address
  it reports with your PC's, but a compromised agent can lie.

## Contained storage (Beta)

`storage.contained: "vhdx"` ([configuration](configuration.md#contained-storage-beta)) keeps the sandbox's tools,
state, logs, databases and caches in one disk image that is mounted only while a sandbox runs. **Beta, not yet tried on a
real PC.**

- **It is about tidiness and exposure, not encryption.** While no sandbox runs, those files are one file instead of
  hundreds of thousands, so scanners and indexers have one file to look at. The image is not encrypted: anyone who can
  read the file can read what is in it, just as with loose folders (use BitLocker for that). While mounted, it is an
  ordinary disk.
- **Who can reach it.** The image and its mount folder are in your private storage folder. The disk's root is limited to
  you and SYSTEM, and it gets **no drive letter**, so it does not show in Explorer.
- **The sandbox sees only the same folders as before** (`tools`, `state`, `logs`, `databases`, `cache` from the image,
  and `run` from the data folder). It never gets the image file or the disk, so it cannot hand your PC a crafted disk.
- **Admin rights, once per mount.** Windows shows one permission prompt when a sandbox starts and one when it ends. It
  runs a fixed script of this package (`mount-contained.ps1`, `dismount-contained.ps1`) in elevated PowerShell. The
  script checks everything again before it acts: the exact image and mount folder paths, no links on the way, that they
  are yours, that the image is a real VHDX with no parent and within your limit, that an existing image is only attached
  (never formatted or deleted), and that the mount folder is empty. If any check fails, it stops and changes nothing.
  The prompt names "Windows PowerShell", not the script, and a program already running as you that can edit the
  installed scripts could change what runs (the all-users install keeps them admin-only). Do not approve a prompt you
  did not just cause.
- **A crash can leave the image mounted** until `sandbox repair` dismounts it. Nothing is lost.
- **A project cannot turn it on or off.**

### The storage helper

An all-users install can add a Windows service, `AgentSandboxStorage`, so mounting needs no prompt. It is built on your
PC from `native/csharp/StorageHelper` into the Program Files install folder and runs as SYSTEM. It does the same mount
and dismount, with the same checks, for the user who asks, and nothing else:

- **Who may ask.** Its pipe `\\.\pipe\AgentSandboxStorage` opens only for SYSTEM, administrators and **Agent Sandbox
  Users**, never over the network. Windows identifies the caller (the pipe client's token and process), not what it
  sends. Programs at low integrity, in an app container or with a restricted token are refused. The service creates the
  pipe and its lock when Windows starts, so no other user can put their own pipe in its place.
- **What it may be asked.** One line: `mount` or `dismount` and a data set name. No path, size or user: the service
  reads the machine settings file (which must belong to administrators) and your own `.agent-sandbox\config.json`
  (opened as you), and builds the paths from them. A size limit in the machine file is a ceiling your own file cannot
  raise.
- **What it checks, on open handles.** Every folder from the drive root to the mount folder is held open while it
  works, so nothing can be swapped for a link mid-way. None may be a link. The storage folder, `images`, `mounts`, the
  mount folder and the image must be **yours**, and only you, SYSTEM and administrators may change them. The drive must
  be a fixed NTFS drive, not inside another mounted disk, and the image must have one name only (no hard links). The
  same open handle is checked by the disk driver (a VHDX, not a differencing disk, within the limit) and attached. An
  image whose log needs replaying is left to the permission prompt. A dismount only removes a mount point of this
  image's own disk.
- **A record and a log.** What it mounted is listed in `%ProgramData%\AgentSandbox\storage-helper`, and every call (who,
  which program, what, the result) is logged to `%ProgramData%\AgentSandbox\logs\storage-helper.log`; both are
  admin-only. It answers at most 10 calls a minute per user (60 in all) and 30 connections a minute per user, one
  operation at a time, and records at most 8 mounts per user. Its lock must belong to administrators: one that someone
  else made first stops the service instead. A slow open of your files (over 30 seconds) is cancelled and your next calls wait five minutes, so no user can
  stall the others. At Windows start it removes mount points whose disk is gone; uninstalling it dismounts everything
  it mounted.
- **What it does not protect against.** A member of the group can make your PC read a disk image they prepared: they
  can change its raw bytes while it is not mounted, and its volume can hold NTFS links a normal user could not make.
  That is like plugging in a USB disk, which is why the helper is optional and an administrator chooses the group. A
  mount that another command reports is still checked, so a stale mount point cannot lead into someone else's disk. The
  sandbox cannot do any of this: it never gets the image file.
- Without the helper (not installed, stopped, another version, or a command run with `--config`,
  `AGENT_SANDBOX_CONFIG` or `AGENT_SANDBOX_HOME`), the permission prompt is used.

## The HCS engine (Alpha) compared with Windows Sandbox

`sandbox.engine: "hcs"` is off by default and cannot start a sandbox yet. When it can, the boundary will be different,
not simply stronger or weaker:

- Both put the agent in a virtual machine with its own kernel. HCS runs a Hyper-V isolated Server Core container from an
  image already on your PC; Windows Sandbox runs a dynamic copy of your own Windows. Both share folders over virtual
  SMB; the HCS engine turns off direct file mapping on every share.
- It has no desktop, GPU, clipboard, microphone, camera, printers or network adapter yet, which removes those surfaces.
- It needs more of you: Windows features (Containers, Hyper-V or Virtual Machine Platform) and an account in
  Administrators or Hyper-V Administrators. This tool never adds you to a group or turns a feature on.
- Its helper (`HcsHost.exe`) is built on your PC from this package's sources, takes no data from the sandbox, and never
  mounts a disk image on your PC.
- Not verified yet: how a link made inside a shared folder behaves, and the exact isolation of the Server Core guest.
  Both are in the go/no-go test in [design/engines.md](design/engines.md).
