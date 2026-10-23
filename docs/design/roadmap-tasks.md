# Roadmap tasks (specs for contributors)

The open roadmap items ([roadmap.md](../roadmap.md)) as tasks a contributor can pick up one at a time. Everything here
follows CLAUDE.md (read all of it first: hard rules, coding standard, Gotchas) and [shared-core.md](shared-core.md) for
anything a user can see or run. Task numbers are kept from earlier versions of this list: R1 (`sandbox engine clean`)
shipped in 1.11.1 and is no longer listed.

## How every task is done

1. Work on a branch from the latest `master`. Read CLAUDE.md, this task's section, and every file the task names
   before you change anything.
2. **Ask an advisor instead of guessing.** When you hit a design decision the spec does not settle, anything touching
   security (elevation, ACLs, secrets, services, signing), or anything that could change the user's PC, stop and ask
   an advisor: start an Agent with `model: "opus"` and a short, self-contained question (the facts, the options you
   see, what you need decided). Follow its answer and mention it in your report.
3. Done means: `npm run build`, `npm run lint`, `npm run format:check` pass and `npm test` prints `ALL TESTS PASSED`
   (gate on that text; live tests can flake: run once more). New settings: DEFAULTS + `config.example.json` + schema
   + docs. New commands: through the shared core (`src/app/features/...`), never hand-written.
4. Never change the user's PC from a test; never run the self-test outside a sandbox; never weaken a test to pass.
5. Report: files, what you verified, what needs a real PC, any advisor decision, anything left undone.

## Tasks

### R2. Contained storage without an admin prompt per launch — Sonnet, Opus review before merge

Status: **built (unreleased)**: `native/csharp/StorageHelper/`, `native/scripts/set-storage-helper.ps1`,
`src/host/storage/contained/helper-port.ts`, the `storage-helper` self-test suite. The service itself waits for a test on
a real PC ([roadmap](../roadmap.md)).

Why: `storage.contained` mounts its disk image with one UAC prompt per launch (native/scripts/mount-contained.ps1 via
run-elevated.ps1). An all-users install already has admin at install time, so it can install a tiny helper once.

Design (binding; ask the advisor before deviating):
- A Windows service `AgentSandboxStorage`, installed and removed by `scripts/install.ps1` for AllUsers installs only
  (asked once, like automatic updates; `-ContainedStorageHelper` / `-NoContainedStorageHelper`), running as
  LocalSystem, code in `native/csharp/StorageHelper/` (C# 5, built at install time with the Windows csc into the
  Program Files install folder, which normal users cannot write), with full file details (AssemblyInfo).
- One named pipe `\\.\pipe\AgentSandboxStorage` with a DACL allowing only SYSTEM, Administrators and the
  "Agent Sandbox Users" group (the install's `groupSid`); the client's identity is taken with
  `GetNamedPipeClientProcessId` + impersonation, never from the message.
- Two verbs only: `mount <set>` and `dismount <set>`. The message carries only the data set name; the service derives
  the image and mount paths itself from the client user's storage root (read from that user's config the same way the
  CLI does, or from the machine config for an all-users install), then runs exactly the checks of
  `contained-common.ps1` (exact paths, no links up to the drive root, owner = the client user, VHDX header: no parent,
  size cap) — reuse those scripts by running them with the user's request rebuilt by the service, or port the checks
  to C# with the same tests. The image is opened by handle and checked before attaching (no check-then-attach race).
- Every call logged to `%ProgramData%\AgentSandbox\logs\storage-helper.log` (who, what, result). Rate-limited.
- The CLI uses the pipe when the service exists and answers; otherwise it falls back to today's UAC prompt.
- Tests: the pure path derivation and validation (shared with the scripts' tests), the message schema, the fallback
  decision; the C# compiles. Mark the service itself "needs a real PC".
- Security review: before asking for merge, start an Opus advisor with the full diff and the question "can a normal
  user, another user, or a process in the sandbox make this service mount, attach or open anything else, or run
  anything as SYSTEM?" and fix everything it finds.

### R4. Raw mouse input for agents (done, unreleased)

Findings (October 2026):
- **Input path.** The viewer and `sandbox attach` put their console in raw mode and turn on
  `ENABLE_VIRTUAL_TERMINAL_INPUT` (`console-input.ts` runs `sandbox/scripts/enable-vt-input.ps1`, about 2 s); from then
  on Node reads the terminal's bytes as they are, mouse reports included (SGR, X10, urxvt). Before that it reads
  console key records, and ConPTY hands a terminal's DEL over as 0x7f; keys typed in that window used to be swapped
  (DEL became ^H, deleting a word: the live-terminal check that kept failing). They now wait (`KeyGate`).
- **ConPTY.** conpty.dll (OpenConsole, passthrough) forwards the program's DECSET 1000 / 1002 / 1003 / 1006 to the
  terminal and passes the reports back unchanged to a program in VT input mode; the stand-in agent got drags
  (`ESC[<32;..M`) and moves (`ESC[<35;..M`) through both hops. Windows' own pseudo console (inbox conhost) swallows
  every mouse mode request, so a real terminal never sends reports to a program behind it.
- **The web terminal.** xterm.js reports per the modes it sees in the output (1000, 1002, 1003, 1006), so it needed no
  change except turning tracking off when the program restarts or exits.
- **What programs ask for.** Claude Code turns on click tracking with SGR (1000 + 1006) for its buttons; vim
  (`mouse=a`, `ttymouse=sgr`) and neovim use button-event tracking (1002, 1003 with `mousemoveevent`); crossterm
  programs (helix and other Rust TUIs) turn on 1000, 1002, 1003, 1015 and 1006 together; tmux asks for what its own
  clients need. (From their documentation and source; only Claude Code's request was seen here.)
- **Selection and Ctrl+C.** Shift+drag selects in Windows Terminal while a program tracks the mouse; Ctrl+C arrives
  as 0x03 (no signal in raw mode) and `attach.confirmCtrlC` still applies.

Built: `MouseModes` (shared/pty) follows the mouse modes in the output the client already filters (and RIS / DECSTR
resets) and drops the reports the program did not ask for: moves only with 1003, drags only with 1002 or 1003, none
without tracking. Only with conpty.dll, where the modes are visible; with Windows' own console input passes as before.
Leaving a session writes mouse-off (and bracketed paste off when the program had it on), then drops reports still on
their way until input is quiet. The web bridge sends mouse-off before "restarting" and "exit". Tests: `channel`
(MouseModes, KeyGate), `web` (the bridge), `live-terminal` (a drag and a move reach the agent only after it asked).

The original task:

Why: `sandbox attach` passes the mouse clicks 1.4.1 supports; programs that need raw mouse input (drag, motion
reports) get nothing.

- Investigate first (report before coding): how `src/shared/pty/console-input.ts`, `terminal.ts` and
  `sandbox/scripts/enable-vt-input.ps1` read input today; whether Node can read raw VT mouse sequences on Windows with
  `ENABLE_VIRTUAL_TERMINAL_INPUT` and the mouse modes the agent requests (1000/1002/1003/1006); what breaks (selection
  with Shift, Ctrl+C).
- Then pass motion and drag reports through to the agent only while the agent has asked for them (track the DECSET
  mouse modes in the output the client already filters), restore everything on detach. Live test in
  `live-terminal.test.ts` (the existing "mouse wheel ... reach the agent" check fails in some sandboxes: do not make it
  worse; ask the advisor if it is in your way).

### R5. NordLynx (NordVPN over WireGuard) — later, Sonnet

Blocked until the owner has tested NordVPN with OpenVPN on a real PC (docs/vpn.md). Then: an access token from the
Nord Account dashboard (stored with SecretStore), the credentials endpoint for the WireGuard private key (unverified:
ask the advisor to research the current API first), the WireGuard path from `vpn.provider: wireguard-file` for the
tunnel. Do not start before the owner says so.

## Needs the owner's PC (not tasks for an agent)

- `scripts/experiments/Test-ContainedStorage.ps1` (contained storage go/no-go), then the checklist in
  [engines.md](engines.md).
- `scripts/experiments/hcs/Test-Hcs.ps1` and the Docker Desktop go/no-go test for the HCS engine (engines.md).
- NordVPN / OpenVPN / WireGuard file and the kill switch (docs/vpn.md "What is not tested yet").
- The heavy-load protections under a real heavy build (job memory limit, compiler holds, the host watchdog's CPU and
  disk-queue thresholds).
