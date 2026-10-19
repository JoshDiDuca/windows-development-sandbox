# Security review, October 2026

A sweep of the whole tool for sandbox escapes, ways to run code or read secrets on the host, and ways it could harm
the PC. The rules it checks against are CLAUDE.md's hard rules and what [security.md](security.md) promises.

## Scope and method

Three reviewers each read one area of the code. Every finding below was then checked against the code, and the fixed
ones have a test.

- **A. Sandbox to host:** `run\` files and their validation, `SandboxChannel`, the one-shot secrets file, links under
  the data folder, the repo guard and quarantine, history / claude-mem / plugin sync, workspace view, port forwards,
  attach, the mark-of-the-web watcher.
- **B. Programs on the host:** the web server (token, cookie, CSRF header, Host/Origin, WebSocket, RPC allow-list,
  limits, static files), CLI spawns, updater and installer, elevated scripts and the all-users install, HcsHost,
  HostTools, SecretStore, the GitHub token and VPN login flows, sharing with other Windows users.
- **C. Inside the sandbox and repository inputs:** `.sandbox-config.json` rules (NEVER_LOOSER, policy, approval),
  project detection, the git shim and access levels, planted executables, the VPN kill switch, memgov, ptyhost, the
  guest daemon.

Not covered: the audit log and agent add-ons, which other work was changing at the time
(`src/sync` audit, `src/guest/audit`, `src/app/features/audit`, `src/shared/apps`, `src/guest/apps`,
`src/guest/setup/agent-addons.ts`). None of the fixes touch those files.

## Threat model

- **Attackers:** a hostile agent with administrator rights inside the sandbox; a hostile repository (its files,
  `.sandbox-config.json`, git hooks and config, planted programs); another local Windows user; a malicious web page in
  the user's browser aimed at the loopback web UI; a man-in-the-middle on downloads.
- **What they want:** to run code on the host; to read host files or secrets (API keys, logins, VPN and GitHub tokens,
  the web token); to write outside the allowed folders; to persist on the host; to become administrator through the
  tool's elevated paths; to crash the host or use up its resources.

## Findings

Severity is for this tool's users: **high** means code execution or secret theft on the host with little user action.

| # | Severity | Area | Finding | Status |
| --- | --- | --- | --- | --- |
| 1 | High | C | Repo `scripts` could copy any PC file into the sandbox | Fixed, tested |
| 2 | High | C | Repo `toolchains.environment` could undo git access and redirect agent APIs | Fixed, tested |
| 3 | High | B | Another user could create your storage folder first | Partly fixed, tested; rest needs a decision |
| 4 | High | A | Git config guard missed keys and was fooled by `]` in a section name | Fixed, tested |
| 5 | Medium | C | A second mapping of the project got past `readOnly` and the workspace filter | Fixed, tested |
| 6 | Medium | A | Hooks in a repo's own `core.hooksPath` folder (husky) were not guarded | Fixed, tested |
| 7 | Medium | A | Whole-tool Claude permissions and plugins were not guarded | Fixed, tested |
| 8 | Medium | A | Nested repositories in `build\`, `dist\` ... were not guarded | Fixed, tested |
| 9 | Medium | B | Another user could fake or block a shared-sandbox record | Needs a decision |
| 10 | Medium | B | The fixed loopback port and port-blind cookie of the web UI | Needs a decision |
| 11 | Medium | A | Marked programs were re-marked every second (host churn) | Fixed, tested |
| 12 | Low | C | Repo version files reached the terminal with escape codes, and repo files were read unbounded | Fixed, tested |
| 13 | Low | C | Repo could turn on `copyFromHost` and lower the RAM kept for the PC | Fixed, tested |
| 14 | Low | C | Git `readonly` allowed options that run programs or write files | Fixed, tested (guardrail) |
| 15 | Low | A | Planted commands matched a fixed extension list, not PATHEXT | Fixed, tested |
| 16 | Low | A | VS Code settings that name tool homes were not guarded | Fixed |
| 17 | Low | A | A removed "from the sandbox" mark is not put back | Accepted risk |
| 18 | Low | A | Attach and port forwards trust any Hyper-V adapter subnet | Needs a decision |
| 19 | Low | A | History sync checks for links, then copies (no handle) | Accepted risk |
| 20 | Low | A | Shared plugins carry one sandbox's plugins to other projects | Accepted risk (documented) |
| 21 | Low | B | Race between the elevated mount script's checks and diskpart | Accepted risk |
| 22 | Low | A | Scripts that hooks/tasks/MCP name elsewhere in the project are not compared | Accepted risk (documented) |

### 1. Repo `scripts` could copy any PC file into the sandbox (high, fixed)

- **Where:** `core/local-config/overrides.ts` (`normalizeOverrides`) and `host/launch/stage.ts` (`stageScripts`).
- **Attack:** a repo ships `"scripts": ["%USERPROFILE%\\.ssh\\id_ed25519"]` or `..\..\.aws\credentials`.
  - `%VAR%` and `..` were accepted, and the only check was that the file exists.
  - On approval, or with `--trust-config` and no prompt at all, the file was copied into the launch folder
    (`C:\AgentLaunch`, kept for days) where the agent reads it.
- **Fix:**
  - A project file's scripts must be inside the project, judged by where they really are (links and short names
    followed, the same `insideProject` check that mappings use).
  - Staging copies only regular files of up to 4 MB.
- **Test:** `local-config`: an absolute path, a `..` path, and a path through a junction are all refused.

### 2. Repo `toolchains.environment` could undo git access and redirect agent APIs (high, fixed)

- **Where:** `core/schema/config.ts` (`LocalOverridesSchema`) and `guest/toolchains/setup.ts`.
- **Attack:** the environment from the project file was applied after the git step, with any names allowed.
  - `AGENT_GIT_ACCESS=full` or `GIT_CONFIG_COUNT=0` undid `provisioning.git.access` without the looser-setting consent.
  - `PATH` and `BASH_ENV` removed the guard.
  - `NODE_OPTIONS` hooked the guard's own node.
  - `ANTHROPIC_BASE_URL` (or any `*_BASE_URL` or proxy variable) would send the user's API key or login token to the
    repo's server.
- **Fix:**
  - A project file may not set reserved names (`reservedEnvName`): `AGENT_*`, `GIT_*`, `GH_*`, `GITHUB_*`, `NODE_*`,
    `SSL_*`, agent and cloud prefixes (`ANTHROPIC_*`, `CLAUDE*`, `OPENAI_*`, `AWS_*`, ...), `*_PROXY`, `*_BASE_URL`,
    `*_ENDPOINT`, CA bundles, `PATH`, `PATHEXT`, `BASH_ENV`, `COMSPEC`, interpreter hooks and profile folders.
  - In the guest, the git guard's variables are applied last, so they win over `toolchains.environment` from any
    source.
- **Test:** `local-config`: six reserved names are refused; a registry mirror is still accepted.

### 3. Another user could create your storage folder first (high, partly fixed)

- **Where:** `scripts/install.ps1` gives the "Agent Sandbox Users" group `CreateDirectories` on
  `%ProgramData%\AgentSandbox\users`, with an inheritable `CREATOR OWNER` entry. The default storage root is
  `users\%USERNAME%`.
- **Attack:**
  1. A group member creates `users\bob` before Bob first runs the tool, and so owns it.
  2. As owner she can add an inheritable entry for herself.
  3. Every file Bob creates later inherits it, including the one-shot secrets file with his API keys and tokens, and
     `bin\<hash>\HostTools.exe`, which the tool runs if it exists (code execution as Bob).
- **Fixed:** the `private` operation of `set-folder-access.ps1` now refuses a folder owned by another account (only
  you, or Administrators when you are elevated). `ensureStorageRoot` makes an empty `users\<you>` private before use,
  so a pre-created empty folder now stops the command with "an administrator must delete it".
  - Test: `sharing`, a folder given to SYSTEM is refused.
- **Still open (needs a decision):** a pre-created folder that already holds a file is not made private (by design, so
  a big tree is not walked), so its owner is not checked. Options:
  - (a) Have the installer, or an elevated step, create each user's folder named by SID, and drop the group's
    `CreateDirectories`.
  - (b) Check the owner of `users\<you>` once, in a PowerShell call when the folder is first seen, and remember the
    result outside it (for example under `%LOCALAPPDATA%`).
  - (c) Add the owner to the doctor's `machine-private` check.
  - Recommended: (a). (b) is a stopgap.
  - Also worth adding: record a hash of HostTools.exe / HcsHost.exe after building and check it before each run.
    Today any exe already in `bin\<hash>` is trusted.

### 4. The git config guard missed keys and was fooled by `]` (high, fixed)

- **Where:** `host/guard/git-config.ts`.
- **What was wrong:**
  - The header regex stopped at the first `]`. So `[filter "x]y"] smudge = calc.exe` hid the key; a filter is
    selected through `.gitattributes`, so this means code execution at the next checkout on the PC.
  - `""!cmd` and line-continued `!` aliases got past the `!` check.
  - Not covered: `[protocol] allow` (turns on `ext::`), `[url] insteadOf`, `submodule.<x>.update = !cmd`,
    `remote.<x>.vcs`, `sendemail.{tocmd,cccmd,smtpServer}` and `instaweb.httpd`.
- **Fix:**
  - Headers are parsed the way git parses them. A line that starts like a header but is not one git accepts counts as
    risky.
  - Every new key in `[protocol]`, `[url]` and `[pager]` is risky, as is every new `[alias]` line with a `!`.
  - The missing keys are added.
- **Test:** `repo-guard`, the "security review 2026-10" section.

### 5. A second mapping of the project got past `readOnly` and the filter (medium, fixed)

- **Where:** `host/launch/mappings.ts`.
- **Attack:** `"mappings": [{"host": ".", "guest": "C:\\Data"}]` is inside the project, so nobody is asked about it.
  It showed the raw project, with the git-ignored `.env` files that `workspaceFilter.enabled` keeps out, and could be
  writable when `readOnly` is on. Both of those settings are tighten-only.
- **Fix:**
  - A mapping whose real path is inside the project follows the project's `readOnly`.
  - While the filter is on, such a mapping is refused, with a fix.
- **Test:** `local-config`.

### 6. Hooks in a repo's own `core.hooksPath` folder (medium, fixed)

- **Where:** `host/guard/git-dirs.ts`.
- **What was wrong:** only `.git\hooks` was fingerprinted. A husky project (`core.hooksPath = .husky/_`) runs
  `.husky/pre-commit` at the next commit on the PC, and the sandbox can write it.
- **Fix:**
  - When the pre-launch config's `core.hooksPath` points inside the work tree, the hook-named files there are
    fingerprinted (and the parent folder too, for husky's `_`).
  - Changed ones are quarantined into `.git\agent-sandbox-quarantine`.
  - Older snapshots without this field are not checked, so the user's own files are never moved.
- **Test:** `repo-guard`.

### 7. Whole-tool Claude permissions and plugins (medium, fixed)

- **Where:** `host/guard/agent-files.ts`.
- **What was wrong:** a sandbox could add `"permissions": {"allow": ["Bash"]}`, `enabledPlugins` or
  `extraKnownMarketplaces`. Claude Code on the PC then runs any command without asking, or loads plugin hooks and MCP
  servers.
- **Fix:**
  - Whole-tool rules (`"Bash"`, `"Bash(*)"`), `enabledPlugins` and `extraKnownMarketplaces` count as risky.
  - Narrow rules such as `Bash(npm test)`, which Claude writes when you click "always allow", stay ordinary edits.
  - Decision point: narrow rules can still allow running repository code (`npm test`). Quarantining every new allow
    rule would be stricter but noisy.
- **Test:** `repo-guard`.

### 8. Nested repositories in skipped folders (medium, fixed)

- **Where:** `host/guard/nested-repos.ts`.
- **What was wrong:** `build`, `dist`, `bin`, `obj`, `target` and `venv` were skipped at the top level, but VS Code's
  repository scan opens a repository directly inside them.
- **Fix:** only `node_modules`, `.git` and the quarantine folder are skipped at the top level. The insides of the
  others are still skipped, which keeps the scan bounded.
- **Test:** `repo-guard`.
- **Not fixed:** a new nested `.git` *file* (`gitdir:` elsewhere) is not reported. It is reported only for the
  project's own `.git`.

### 9. Fake or blocked shared-sandbox records (medium, needs a decision)

- **Where:** `host/sharing/active-record.ts`, `owner.ts` and `borrow.ts`. The group has `CreateFiles` on `active\`.
  `readAll` checks only that the file name equals the `sid` inside it; it never checks who owns the file.
- **Attack:**
  1. A group member writes `active\<some sid>.json` with the owner's `windowsSession` and `dataPath` pointing into
     her own `users\mallory\data\x`.
  2. Another user's `attach`/`exec` then talks to her folder, so she sees the commands they run and controls what
     comes back.
  3. Separately, pre-creating `active\<owner-sid>.json` blocks the owner's launch, because they cannot replace a file
     she owns.
- **Proposal:**
  - Read each record's file owner (a small HostTools verb) and keep it only when owner = `sid` = file name.
  - Require that `users\<name>` in `dataPath` is owned by that SID.
  - Have records created by an elevated step, or give the group no way to pre-create another SID's file.
- **Why not changed now:** each option needs an owner query on every list or attach, or a change to the installer's
  permissions. That is a design choice for the all-users install, and it needs testing on a real multi-user PC.

### 10. The web UI's fixed loopback port and port-blind cookie (medium, needs a decision)

- **Where:** `core/schema/web.ts` (port 47800), `host/web/auth.ts`, `app/features/web/web.run.ts`.
- **Attack:**
  - While the UI is stopped, another local user binds `127.0.0.1:47800`.
  - A tab the user reopens there registers a service worker for that origin. The worker later intercepts the real
    UI's `#k=<token>` navigation.
  - `currentServer` also trusts any server on the recorded port that answers `/api/health`.
  - Cookies ignore ports, so the session cookie is also sent to `network.forwardPorts` listeners, which are servers
    the guest runs. The guest cannot reach the host's loopback to use it, but a local user could.
- **Proposal:**
  - Use a random port on each start (the state file already records it).
  - Answer `Service-Worker: script` requests with a script that unregisters itself, and send
    `Clear-Site-Data: "storage"` on `/` and `/api/login`.
  - Check a challenge (an HMAC with the token) in `currentServer` instead of a plain 200.
  - Optionally serve the UI on `localhost` and forwards on `127.0.0.1`, which keeps their cookie jars apart.
- **Why not changed now:** the fixed port is a user-visible setting and bookmark target.
- **Checked and sound:** Host/Origin and the CSRF header (DNS rebinding and cross-site requests are refused), the
  `HttpOnly; SameSite=Strict` cookie, the constant-time 256-bit token, the RPC allow-list and size limits.

### 11. Marked programs re-marked every second (medium, fixed)

- **Where:** `host/guard/mark-of-the-web.ts`.
- **What was wrong:** writing the `Zone.Identifier` stream raises a change event for the file itself. The watcher
  therefore marked, and reported, every marked program again once a second for as long as the sandbox ran. A build
  that writes thousands of `.exe`/`.dll` files kept the PC rewriting them nonstop.
- **Fix:** a file that already has the mark is skipped.
- **Test:** `repo-guard`: one report in 3.5 seconds, not one per second.

### 12. Repo text in the terminal, unbounded repo reads (low, fixed)

- **Where:** `core/run/versions.ts`, `core/local-config/file.ts`, `host/launch/project-scan.ts`.
- **What was wrong:**
  - The first line of `.nvmrc`, `.node-version` or `.python-version` went raw into the launch table, so escape codes
    such as an OSC 52 clipboard write or a screen rewrite reached the user's terminal.
  - Those files, `package.json` and `.sandbox-config.json` were read whole, so a multi-gigabyte file stopped a launch.
- **Fix:**
  - Version lines are used only when they look like a version spec.
  - Reads go through one handle with a cap (`readSmallFile` in `core/util`): 64 KB for version files, 4 MB for
    `package.json`, 1 MB for `.sandbox-config.json` (refused with a message when bigger).
- **Test:** `hostile-input`.

### 13. `copyFromHost` and the RAM kept for the PC (low, fixed)

- `provisioning.copyFromHost` is now tighten-only. Turning it on maps the PC's Node, Git, nvm and agent folders into
  the sandbox.
- A project can no longer set `sandbox.reserveHostMb`, `maxMemoryPercent` or `maxMemoryMb`. The 25 % floor already
  held; these are the PC owner's to choose.
- **Test:** `local-config`.

### 14. Git `readonly` options that run programs or write files (low, fixed)

- **Where:** `guest/git/decision.ts`.
- **What was allowed:** `grep -O<cmd>` / `--open-files-in-pager`, `ls-remote --upload-pack` / `-u`, `--output=<file>`
  and `--ext-diff`.
- **Fix:** they are now refused.
- This is a guardrail only: the agent is an administrator and can edit `.git\config` directly. The repo guard covers
  what reaches the PC.
- **Test:** `git-access`.

### 15 and 16. PATHEXT commands; VS Code tool homes (low, fixed)

- Planted commands are also matched against the PC's PATHEXT, because the Python installer adds `.PY`/`.PYW` and cmd
  runs `git.py` from the current folder.
  - Test: `repo-guard` (checked when `.PY` is in PATHEXT).
- VS Code settings keys containing `alternateTools`, `home`, `goroot`, `tsdk` or `sdk` count as program paths.

### 17. A removed mark is not put back (low, accepted)

- **What happens:** deleting a `Zone.Identifier` stream raises no file event on NTFS (this was tested), so the watcher
  cannot see it.
- **Why accepted:** whether the guest can reach streams through the shared folder at all is unverified. The mark is a
  speed bump, not a boundary.
- **Possible follow-up:** re-check `isMarked` for known programs in the guard's periodic pass.

### 18. Attach and port forwards trust any Hyper-V adapter subnet (low, needs a decision)

- **Where:** `host/channel/attach.ts`.
- **Risk:** with an external Hyper-V switch, the LAN adapter is itself a `vEthernet` adapter. A sandbox could then
  point attach (the user's keystrokes plus the token) or a forward at a LAN machine.
- **Proposal:** accept only the subnet that held the sandbox's first reported address at launch, saved host-side, and
  refuse the network and broadcast addresses. This needs a PC with an external switch to test.

### 19. History sync checks, then copies (low, accepted)

- **Where:** `sync/history.ts` (`writeSafely`, `copyNewer`).
- **Risk:** the link check and the copy are separate steps.
- **Why accepted:** guests cannot create links in mapped folders. For the HCS engine this is still to be verified
  (security.md says so).
- **Follow-up if HCS ships:** open the source and check it with `fstat` on the handle, write to a temp file and rename
  it into place, and cap total files and bytes per sync.

### 20. Shared plugins spread between projects (low, accepted)

- With `sharePluginsAcrossAccounts` on, a plugin installed in one sandbox runs in other projects' sandboxes.
  configuration.md already says so ("Plugins are code ...").
- A repo cannot turn the setting on.

### 21. Race in the elevated mount script (low, accepted)

- **Where:** `native/scripts/mount-contained.ps1`.
- **Risk:** the link and owner checks run before `diskpart`, which then opens paths by name. A program running as the
  user could swap in a junction in between.
- **Why accepted:** this is the "program already running as you" case that security.md accepts. The post-mount check
  detaches a wrong volume.
- **Hardening:** hold handles without `FILE_SHARE_DELETE` on the image and mount folder across the `diskpart` call.

### 22. Scripts that hooks, tasks or MCP servers name (low, accepted, documented)

- The guard compares the part of `.claude/settings*.json`, `.mcp.json` and `.vscode/tasks.json` that names what to
  run, not the files those commands point at elsewhere in the project.
- Resolving arbitrary command lines to files is unreliable, so this is now stated in security.md.

## Checked and found sound

- **`run\` messages:**
  - strict file names, an 8 MB cap before parsing, zod everywhere (`readValid`);
  - invalid requests are deleted unread;
  - `dropResponse`/`reset` refuse links;
  - guest text goes through `safeText`/`plainText`.
- **`safeRemove`:** refuses protected folders and device paths, and removes a link itself, never what it points to.
- **Secrets file:**
  - written atomically under `<data>\secrets` (outside `run\`) after `assertNoLinks`;
  - cleared before a launch and after a failed one;
  - agent environments are stripped from requests; secret schema fields print `***`.
- **History and plugin sync:**
  - safe names only, and only this project's transcripts come back;
  - no memory folders; claude-mem only when that setting is on;
  - plugin copies refuse links and oversized trees.
- **Port forwards:** listen on `127.0.0.1` only; relay ports come from the forward's index; no netsh, so no argument
  injection.
- **Workspace view:** never writes through an existing link and skips links when walking; guests cannot create links
  in mapped folders.
- **Web server:**
  - 256-bit token compared in constant time, rate-limited login, token only in the `#k=` fragment;
  - Host check on HTTP; Origin plus Host on WebSocket upgrade;
  - CSRF header on login, stop and WebSockets;
  - bodies capped at 16 KB; WebSocket payloads and connection count capped;
  - strict CSP and `no-referrer`;
  - RPC only for definitions on the web surface, zod-checked;
  - static files: no `..`, `\` or NUL, must be within the folder, a regular file, and an allowed extension.
- **Spawns:** no `shell: true`; programs via `SYSTEM.*` or absolute paths; `.cmd` through `cmd /d /c` with the user's
  own arguments; `openBrowser` behind a strict regex.
- **Updater and installer:**
  - SHA-256 from GitHub's digest or `SHA256SUMS`;
  - version and Node folder names checked against patterns; extraction by bsdtar (refuses `..`);
  - the SYSTEM task runs only the machine-scope `sandbox.cmd`.
  - Note: the checksum comes over the same channel as the download. Release signing (R3) is the planned answer.
- **Elevated scripts:** the request hash is computed from the exact bytes read, then every field is checked again
  (plain absolute paths, no links on the way, owner, VHDX header, no parent disk, size).
- **HcsHost:**
  - acts only on systems with the tool's id prefix and Owner `agent-sandbox`, checked through HCS before start,
    terminate and share;
  - DLLs load from System32; it runs with the caller's own token.
- **SecretStore:** DPAPI for the current user, data passed on stdin, the box kind is pinned.
- **Sharing ACLs:** Traverse on the data path, Modify only on `run\`, links refused.
- **`.sandbox-config.json`:**
  - `strictObject` everywhere, so `__proto__` and unknown keys are refused;
  - the hash covers exactly the bytes parsed;
  - `keepStrictest` runs after the merge;
  - `allowOnly`, storage, executables, secrets and host folders cannot be set;
  - outside mappings resolve links and 8.3 names; reserved guest paths are protected.
- **ptyhost:** 24-byte random token compared in constant time; `PTYHOST_BIND=any` binds inside the guest only;
  ProcessTree checks process start times (no PID reuse) and runs only in the guest.
- **memgov:** guest-only, driven by the daemon's stdin, nothing on the host.
- **Kill switch:** block rules beat allow rules; DNS and global IPv6 are blocked before the tunnel. Theoretical gaps,
  not reachable in Windows Sandbox: VPN server IPs are open on every port, and NAT64 `64:ff9b::/96` sits outside
  `2000::/3`.
- **Guest daemon:** every request kind is zod-validated with id patterns and caps. A sharing user who writes
  `project`/`restart` requests gets no more than `exec` already gives them.
