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

### R3. Code signing, ready for a certificate — Sonnet

Status: built (release.yml signing step, Azure Artifact Signing action pinned to v2.0.0, docs/development.md "Signing
releases"). Waiting for the owner's signing account and the six secrets; nothing is signed until then.

Why: antivirus heuristics flagged unsigned files before (a Start menu shortcut; HostTools.exe). Signing needs the
owner's account (Azure Trusted Signing is the cheapest), so the pipeline must exist and do nothing until it is set up.

- `.github/workflows/release.yml`: an optional signing step using `azure/trusted-signing-action` (pin the version by
  commit SHA) that runs only when the secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `TRUSTED_SIGNING_ENDPOINT`, `TRUSTED_SIGNING_ACCOUNT`, `TRUSTED_SIGNING_PROFILE` exist; signs `scripts/install.ps1`
  (Authenticode for scripts) before it is uploaded. Without the secrets: skipped, the release works as today.
- HostTools.exe, HcsHost.exe and memgov.exe are compiled on the user's PC and cannot be signed by us; document that and
  keep their file details accurate (a test already checks the version).
- docs/development.md "Signing releases": what to create in Azure, which secrets to add, how to check a signature
  (`Get-AuthenticodeSignature`).
- Ask the advisor before choosing anything that would sign files on the user's PC (it would need a private key there:
  do not do that).

### R4. Raw mouse input for agents (backlog) — Sonnet

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
