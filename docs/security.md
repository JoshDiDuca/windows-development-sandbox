# Security

The sandbox is treated as hostile and your PC as precious.

## Containment

- The agent writes only your project folder (and the other projects you map, see [several projects](projects.md#security)) and its own storage.
- Drive roots, your user profile, system folders and this tool's folders are refused as workspaces.
- `workspaceFilter.enabled` keeps what git ignores (`.env` files with real keys, your `node_modules`, build output) out
  of the sandbox entirely: it works on a copy without them, synced both ways
  ([details](configuration.md#git-ignored-files)).
- Your LAN is blocked from inside the sandbox (DNS excepted). `network.allowOnly` limits it to the hosts you list, `network.blockHosts` blocks names (see [network](configuration.md#network)); these are guardrails inside the sandbox. `sandbox.networking: false` cuts all network access.
- vGPU is off by default.

## Secrets

Before anything from your Claude settings is copied in, these are stripped:

- `settings.json` `env`
- credential helpers (`apiKeyHelper`, `awsCredentialExport` ...)
- every MCP server's env, headers, URL and arguments

Removed:

- AWS, Azure, Google Cloud and Cloudflare credentials, plus hosting, CI, registry, payment and AI API keys
- database URLs
- anything named `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, `*_KEY` or `*PROD*`
- values that look like keys, whatever they're called

`secrets.allow` lets named variables through, and `secrets.patterns` adds more to strip. A project file cannot weaken
these settings, cannot set variables that redirect an agent's API or carry logins (`*_BASE_URL`, `ANTHROPIC_*`,
proxies ...) in `toolchains.environment`, and its `scripts` must be files inside the project. The launch output lists what was kept back, and warns about files like `.env` or `*.pem` that the agent
can read because the whole folder is mapped.

### Your own logins and keys

- **Saved logins are encrypted at rest.** Accounts saved with `sandbox account save` (Claude and the other agents) and
  the VPN login are sealed with Windows DPAPI for your Windows user: the files in `<storage>\accounts` and
  `<storage>\vpn` hold only names, dates and e-mail addresses in the clear. Nobody else, and no other Windows user, can
  open them, not even with a copy of the files. They are decrypted only when you switch to one or start a sandbox with
  it. Logins saved by older versions are encrypted the first time they are read.
- **Your storage folder is private.** One that is created empty (the default under `%ProgramData%\AgentSandbox\users`,
  or a folder you chose) gets permissions for you, SYSTEM and administrators only. A folder that already holds files is
  never rewritten (that takes minutes); `sandbox doctor` shows how it is protected.
- **Agent environment values and your Claude login do not travel in files the sandbox keeps.** The launch folder is
  mapped read-only into the sandbox and kept for days, so `session.json` and everything in it hold no API key, no
  `harnesses.<agent>.environment` value, no copy of your Claude login and no VPN login. They go in a one-shot file in
  `<data>\secrets` (next to `run\`, not in it, so other users of a shared sandbox cannot touch it) that the sandbox reads
  and deletes at once; whatever it did not read is removed when the sandbox stops and before the next launch. The same goes
  for the keys of an agent started later (`sandbox codex` in a sandbox started for claude). A shared sandbox never gets
  your values.
- **What the agent can always see:** its own environment, the login it was started with (Claude's `.credentials.json`
  inside the sandbox, the files of another agent's login, the VPN service credentials while it connects) and
  everything in your project folder. The agent is an administrator inside the sandbox; treat every key you give it as one it
  can read, use and leak. Use keys you can revoke, with the smallest rights.
- **Settings print `***`** for secret values (`sandbox config show`, the settings screen, `doctor`, every `--json`).
- `network.proxy` takes no `user:password@`: it would be stored in plain text in a file the sandbox reads.

## The HCS engine (Alpha) compared with Windows Sandbox

`sandbox.engine: "hcs"` is off by default and, in this alpha, cannot start a sandbox yet. When it can, the boundary is
different, not stronger or weaker in every way:

- Both put the agent in a virtual machine with its own kernel. HCS runs a Hyper-V isolated Server Core container from
  an image already on your PC; Windows Sandbox runs a dynamic copy of your own Windows. Both share folders with the
  guest over virtual SMB, so that surface is the same; the HCS engine turns off direct file mapping on every share.
- It has no desktop, GPU, clipboard, microphone, camera or printers, and no network adapter at all in this beta, which
  removes those surfaces.
- It needs more of you: Windows features (Containers, Hyper-V or Virtual Machine Platform) and an account in
  Administrators or Hyper-V Administrators, because the Host Compute Service refuses anyone else. Windows Sandbox needs
  no such membership. A member of those groups is already trusted on this PC; this tool never adds you to one and never
  turns a feature on by itself (the check prints the commands for you to run).
- The helper (`HcsHost.exe`) is built on your PC from the sources in this package, takes no data from the sandbox, and
  never mounts a disk image on your PC: the agent disk is attached to the virtual machine only.
- Not verified yet: how a link made inside a shared code folder behaves, and the exact isolation of the Server Core
  guest; both are in the go/no-go test in `docs/design/engines.md`.

## Contained storage (Beta)

`storage.contained: "vhdx"` ([configuration](configuration.md#contained-storage-beta)) keeps the sandbox's tools, state,
logs, databases and caches in one disk image that is mounted only while a sandbox runs. **Beta, not yet tried on a real
PC.** What it does and does not do:

- **It is a tidiness and exposure measure, not encryption.** While no sandbox runs, those files are one file
  (`<storage>\images\<name>.vhdx`) instead of hundreds of thousands, so scanners and indexers have one file to look at
  and other programs do not walk the tree. The image is not encrypted: anyone who can read the file can read what is in
  it, exactly as with the loose folders (use BitLocker for that). While a sandbox runs it is an ordinary mounted disk
  and scanners see its files as they would any other.
- **Where it is, who can reach it.** The image and its mount folder are in your private storage folder (you, SYSTEM and
  administrators). The mount folder is made private before the mount, and the new disk's root is limited to you and
  SYSTEM when the image is made. The disk gets **no drive letter**, so it does not show in Explorer. The folder it is
  mounted in is on your PC's own disk and only a mount point while a sandbox runs.
- **The sandbox sees only the same folders as before.** It is given `tools`, `state`, `logs`, `databases` and `cache`
  from inside the image and `run` from the data folder, at the same `C:\AgentData\...` paths, and nothing else from
  the image. It gets no access to the image file or to the disk itself; it can only create files through the shared
  folders, as before, so it cannot hand the host a crafted disk. The rules for a hostile guest are unchanged (links in
  those folders are not followed, what it writes is validated).
- **Administrator rights, once per mount.** Mounting a disk needs them, so Windows shows one permission prompt when a
  sandbox starts and one when it ends. It runs a fixed script of this package (`mount-contained.ps1`,
  `dismount-contained.ps1`) in elevated PowerShell. The request goes in a file in a private temp folder with its
  checksum, and the script **checks everything again** before it does anything: the image is exactly
  `<storage>\images\<name>.vhdx` and the mount folder `<storage>\mounts\<name>`; no folder on the way is a link; they
  are yours; the image is a real VHDX with no parent file and not bigger than your limit; an existing image is only
  attached (never formatted, never deleted) and a new one is made only where no file exists; the mount folder is empty;
  every `diskpart` command names that one image. If any check fails it stops with the reason and changes nothing.
  What it cannot do: the prompt names "Windows PowerShell", not the script, and a program already running as you that
  can edit the installed scripts could change what is run. That holds for every per-user install of anything; the
  all-users install keeps its files administrator-only. Do not approve a prompt you did not just cause.
- **A crash can leave the image mounted** until `sandbox repair` dismounts it (the next command says so). Nothing is lost.
- **A project cannot turn it on or off**: `storage.contained` and `storage.containedMaxGb` are your settings only.
- **Not covered yet**: `sandbox data`, `sandbox clean` and some menu screens still look at the plain data folder, so
  what is in the image is not listed or cleaned by them.

## Nothing runs on your PC

- Host and sandbox talk through small JSON files. The sandbox can ask for four things (start a session, run a command,
  restart, ping), and everything it writes back is validated and size-capped.
- Text from the sandbox loses its escape sequences before it reaches your terminal. When you attach, the session's
  output passes a filter that drops clipboard reads (OSC 52 `?`, however they are split or disguised), terminal macros
  and other control strings; colours, titles, links and progress pass. The agent's "copy" (an OSC 52 clipboard write)
  passes only where the sandbox can already reach your clipboard: in the sandbox's own terminal, and in
  `sandbox attach` while `sandbox.clipboard` is on (with it off, clipboard writes are dropped too). The web UI drops
  them.
- Programs and scripts (`.exe`, `.ps1`, `.bat`, `.cmd`, `.msi`, `.lnk` ...) that appear or change in your project while
  a sandbox runs get Windows' "downloaded from the internet" mark (`storage.markSandboxFiles`, on by default): SmartScreen
  asks before one runs, and PowerShell's RemoteSigned policy refuses an unsigned marked script. Programs you build
  yourself on your PC while a sandbox runs get it too; `Unblock-File` or the file's Properties removes it.
- What the sandbox adds to a project that tools on your PC would run by themselves is moved to
  `agent-sandbox-quarantine`: git hooks and program-running git config (also in submodules and nested repositories),
  hooks in a `core.hooksPath` folder inside the project that the repo already used (husky), commands planted in the
  project root, Claude Code hooks, helper commands, MCP servers, plugins and whole-tool permissions such as `"Bash"`
  (`.claude/settings*.json`, `.mcp.json`), VS Code folder-open tasks and program paths, and `.envrc`. Ordinary edits to
  those files stay. Scripts that a hook, task or MCP server names elsewhere in the project are not compared: review them
  like any other change.
- Links the sandbox plants are never followed.
- Files it writes are read with bounded effort.
- Attaching from your terminal connects only into the sandbox's Hyper-V network, with a per-session token.

## Downloads

Toolchain, database and tool downloads are checked against the SHA-256/SHA-512 their publisher lists, and a mismatch
deletes the file. Some sources list none (for example a script fetched from a vendor's site). By default those are
still allowed. Set `downloads.requireChecksum` to `true` to refuse any download that has no published checksum; the
failure names the file and the setting. A project's `.sandbox-config.json` can turn this on but never off. The
installer checks its release package the same way ([install](install.md#one-line)).

## Coming back

- Only data files return with history, and only for the projects in the sandbox: a conversation or prompt the sandbox
  writes for any other project never reaches your PC (`claude --resume` there would load it).
- Going in, only the sandbox's own projects' history is copied by default (`claudeProfile.historyScope: "project"`);
  other projects' conversations, file backups and prompts stay on your PC. `"all"` copies everything.
- claude-mem's database does **not** come back by default: whatever is in it is loaded into every Claude session on
  your PC, so a compromised agent could plant instructions there. `claudeProfile.syncClaudeMemBack: true` brings it
  back (the database files only). Its settings (API keys), `.env` files and backups are never copied in.
- Git hooks and dangerous git config added inside the sandbox are quarantined before your own git can run them.
- So are executables planted in the project under names you type there (`node.exe`, `sandbox.cmd` ...).
- `sandbox status` lists anything that was quarantined.

## GitHub CLI

`gh` is never given your PC's login (`GH_TOKEN`, `GITHUB_TOKEN` are stripped) and is only installed with git access
`full`, because it can push and merge through the GitHub API. A login made inside is kept in `C:\AgentData\state\gh`.

**A token for sandboxes (opt-in).** You can save a GitHub token made only for sandboxes (`sandbox github login`) and
turn on `github.shareToken`. What is shared, and how:

- Only that token, never your PC's `gh` login. Make it **fine-grained**: limited to the repositories the agent should
  reach, with only the permissions it needs, and an expiry. A classic token reaches every repository you can, so it
  gets a warning; OAuth tokens (`gho_`, what `gh auth token` prints) are refused.
- On this PC it is kept encrypted with Windows DPAPI for your Windows user (`<storage>\github\token.json`), and never
  printed or shown; `status` gives only whether one is saved, its kind and its date.
- It is handed over only when `github.shareToken` is on **and** the sandbox's git access is `full` (with `readonly` or
  `none` it would let the agent push past the git guard through the API). A repo's `.sandbox-config.json` cannot set
  `github` at all. It travels only in the one-shot secrets file the sandbox reads and deletes at boot: never in
  `session.json`, the launch folder, `run\`, logs or process arguments.
- In the sandbox `gh auth login --with-token` reads it on stdin, into a gh folder on the sandbox's own disk (wiped with
  the sandbox; not the persistent `C:\AgentData\state\gh` other sandboxes and projects share), and `gh auth setup-git`
  makes https git use it.
  It is also held back when any other project mapped into the sandbox at boot has git access `readonly` or `none`.
- **The agent can read it** (it can run `gh auth token`) and use it for everything the token allows, as long as the
  token is valid. Revoke it on GitHub when you no longer need it; `sandbox github logout` deletes it from this PC.
- If you share your running sandbox with another Windows user, their sessions in it can use your token too. Their own
  launches never get it.
- gh itself lives in the shared tools folder (`C:\AgentData\tools`), which sandboxes using the same data folder can
  write, like the node and git that already see the Claude login. Keep untrusted projects in a data folder of their own.

`ssh` comes with Git, but no keys are copied in and your LAN is blocked, so deploys stay on your PC.

## Agent commands (Beta)

Off by default. When on, it adds one folder (inside this tool's storage) to the start of your own PATH, holding only
forwarding commands it wrote; `off` removes them and the entry. A repo's `.sandbox-config.json` cannot turn it on. How it
works: [configuration](configuration.md#agent-commands-beta).

## Git access

`provisioning.git.access`, settable per project:

| | |
|---|---|
| `full` (default) | git as normal |
| `readonly` | status, log, diff, show, blame and listing branches/tags only |
| `none` | no git; the repository is invisible to it |

## Several projects

Every project mapped into a sandbox is visible to every agent in it, read and write. Keep untrusted repos out of your
roots and out of `projects.all` (`sandbox projects exclude <folder>`), or give them their own sandbox and
`storage.dataName`. What is mapped, the consent prompts, the machine-wide protections and the repo guard for several
projects are in [projects](projects.md#security).

## Several users on one PC

With an all-users install, each user keeps a private storage folder under `%ProgramData%\AgentSandbox\users\<name>`
(accounts, logins, history, approvals): only that user, SYSTEM and administrators can open it. An empty storage folder
that belongs to another account (someone made it before you first ran the tool) is refused rather than used; an
administrator must delete it. Windows runs one sandbox
per PC and its window belongs to the user who started it, so other users can only use it when its owner turned on
`sharing.otherUsers`.

What sharing opens, for members of the local group **Agent Sandbox Users**, while the sandbox runs: they may pass
through the owner's storage and data folders (no listing, no reading) and read and write the set's `run` folder, which
is where sessions and requests are. Nothing else of the owner's is opened, and the permissions are taken away again when
the sandbox ends. What that lets them do: list sessions, attach to one (the session token is the credential), run
commands, and stop the sandbox after typing the owner's name. Commands run with the agent logins already in the sandbox,
history goes to the owner's account, and they can read what an agent in it can read. Share only with people you would
let sit at your keyboard.

Other users' secrets stay out: when the sandbox is someone else's, your agent environment values are not sent and
`--account` is refused. Restarting it, adding a project, showing its window and starting a new one are the owner's
alone. Everything read from the owner's folders is checked like anything from a sandbox (validated, links refused,
text cleaned). The "By" label shown for a request is a label, not proof of who sent it.

## VPN

`vpn.enabled` sends the sandbox's traffic through a VPN ([vpn.md](vpn.md)). What to know:

- Your login is encrypted on your PC and given to the sandbox only while it starts (a one-shot file, never in
  `session.json`). The NordVPN login is a **service credential** that you can revoke on Nord Account, not your account
  password. The agent can read it while the sandbox runs, and it can turn the tunnel off, because it is the
  administrator there. The VPN keeps a well-behaved agent and its tools off your normal connection and hides your address
  from the sites they visit; it does not contain a hostile agent.
- The kill switch (on by default) blocks everything outside the tunnel before the tunnel starts, so a failed tunnel
  means no internet, not an open connection. A project can turn it on, never off, and can never set a VPN, a server, a
  profile or a login.
- The VPN profile is untrusted data: it is fetched on your PC (a bounded download), checked, and only profiles made of a
  short list of harmless settings are used; anything that could run a program (`script-security`, `up`, `down`,
  `plugin`, `route-up`, `tls-verify` ...) is refused, here and again in the sandbox.
- A WireGuard config (`wireguard-file`) holds your private key. It is read on your PC when a sandbox starts (at most 16 KB) and checked as untrusted data: only `PrivateKey`, `Address`, `DNS`, `MTU`, `ListenPort` and, per peer, `PublicKey`, `PresharedKey`, `AllowedIPs`, `Endpoint`, `PersistentKeepalive` are accepted; `PreUp`, `PostUp`, `PreDown`, `PostDown`, `Table`, `SaveConfig` and anything unknown are refused (a refusal never prints a key). It is written again from the checked values and handed over only in the one-shot secrets file: never in `session.json`, the launch folder or `run\`. In the sandbox it is checked again and written to a file that is deleted once the tunnel service has it. The agent can read the key while the sandbox runs (it is the administrator there): use a key you can revoke on the VPN server.
- OpenVPN and WireGuard are installed from the publisher's MSI, checked against a SHA-256 stored in this program (`downloads.requireChecksum`
  does not refuse it). Tool downloads before the tunnel is up (the first minutes of a boot) go through your normal connection.
- What the sandbox says about its tunnel (`run\vpn.json`) is its own word: `sandbox vpn status` compares the address it
  reports with your PC's, but a compromised agent can lie.

## Shared tools

`C:\AgentData` (tools and databases) is shared by every project's sandbox. For a repo you don't trust, give it its own
data set with `storage.dataName`.

Inside the disposable sandbox only, the "Do you want to run this file?", SmartScreen and firewall prompts are off.

Review what the agent writes like a contribution from a stranger.
