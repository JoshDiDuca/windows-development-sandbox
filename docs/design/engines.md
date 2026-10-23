# Sandbox engines and storage providers (design)

Status: **1.9, opt-in: contained storage (beta), HCS engine (alpha)**. Phase 3 (HCS engine) is built but start is disabled
(see Phases). Windows Sandbox stays the default engine and keeps every feature it has; everything here is an extra you
switch on, and one setting switches it off again. The first research notes for the HCS engine were removed when it was
built; they are in git history (commit 2051ae1, `docs/design/hcs-backend.md`).

## Goals

- Hybrid: all of Windows Sandbox (desktop, Windows Terminal, GPU, clipboard, audio, printers, apps), plus extras: contained
  storage, and later a headless HCS engine for agents.
- Works with every Windows Sandbox version this tool supports today (with or without the `wsb` CLI); nothing new is
  required to keep using it.
- One way back: `sandbox.engine: "windows-sandbox"` and `storage.contained: "off"` are the defaults and give exactly
  today's behaviour, byte for byte (the `generate` golden tests prove the .wsb and launch folder are unchanged).
- Room to grow: a new engine or storage kind is one module behind an interface, chosen by a setting.

## Never

- Nothing on Windows is enabled, installed or changed without asking first (Windows features, services, groups, the
  firewall of the PC). An engine that needs one of those says so in `sandbox engine check` and doctor, with the exact
  command, and stops.
- Nothing irreversible: everything an engine or provider creates is listed in its state file and removed by
  `sandbox engine clean` / `sandbox storage contained off`; a failed start leaves the PC as it was.
- No guest data is executed or mounted by the host beyond what is described here; the hostile-guest rules in CLAUDE.md
  apply unchanged.

## Shape

```
launch (cli) ──> LaunchPlan (neutral, pure) ──> engine.plan() ──> engine.start()
                     ▲                              │
            storage provider.prepare()      windows-sandbox: .wsb + start (today's code)
            (mappings or disks)             hcs: compute-system documents + HcsHost.exe (alpha)
```

- `src/host/engines/` (barrel `index.ts`):
  - `types.ts`: `EngineId` ('windows-sandbox' | 'hcs'), `EngineCapabilities` (desktop, gpu, clipboard, audio, video,
    printers, liveFolderAdd, attachedDisks, multipleInstances, hvsocket), `EngineCheck` ({ available, reasons[],
    fixes[] }), `LaunchPlan` (mappings: host/guest/readOnly; memoryMb; cpu; networking; devices; logon command; storage
    attachments), `EnginePlan` (engine-specific, opaque to callers), `RunningSandbox` (id, engine, started).
  - `engine.ts`: `interface SandboxEngine { id; capabilities(); check(): Promise<EngineCheck>; plan(LaunchPlan):
    EnginePlan; start(EnginePlan): Promise<RunningSandbox>; running(): Promise<boolean>; stop(): Promise<void> }`.
  - `windows-sandbox/`: today's code behind the interface (wsb-file, platform start/confirm/isRunning). No behaviour
    change; capabilities come from the probe (wsb CLI present → liveFolderAdd).
  - `hcs/` (alpha): `documents.ts` (pure: HCS schema 2.x JSON for a Hyper-V isolated container / utility VM: SCSI
    attachments, VirtualSmb shares, HvSocket, no NIC by default), `helper.ts` (runs `HcsHost.exe` with JSON files in a
    private temp folder), `check.ts` (features, vmcompute, Hyper-V Administrators membership, base image present),
    `images.ts` (an `ImageStore` interface; the first store only uses an image already present, see below).
  - `registry.ts`: `engineFor(config)` picks the engine; refuses `hcs` unless its check passes, with the reasons.
- `src/host/storage/providers/` (barrel): `interface StorageProvider { id; check(); prepare(dataSet):
  Promise<PreparedStorage>; release(): Promise<void> }`; `PreparedStorage` is either folder mappings (Windows Sandbox)
  or disk attachments (HCS). Providers: `folder` (today) and `vhdx-mounted` (Windows Sandbox contained storage). The id
  `vhdx-attached` (HCS) is reserved in the type; no provider is built for it yet.
- The data set splits in two when contained: `run\` (the host<->guest channel) always stays a host folder shared in,
  because the host must read it; `tools\`, `state\`, `logs\` go into the container image.
- `native/csharp/HcsHost/` (C# 5, built on first use like HostTools, file details set): verbs `check`, `enumerate`,
  `properties <id>`, `create <doc.json>`, `start <id>`, `terminate <id>`, `grant-vm-access <id> <vhdx>`,
  `create-vhdx <path> <maxGb>` (CreateVirtualDisk; never attaches to the host). JSON in and out through files; every
  handle closed in `finally`; failures as Win32Exception messages.
- Contained storage for Windows Sandbox: `native/scripts/mount-contained.ps1` (fixed, run elevated with one UAC prompt
  per launch; mounts only `<storage>\images\<set>.vhdx` at `<storage>\mounts\<set>` after checking both are inside your
  private storage, not links, owned by you; no drive letter; mount folder ACL you + SYSTEM) and `dismount-contained.ps1`;
  a refcount state file outside the image; stale mounts found and fixed by doctor/repair.

## Settings (core/schema, DEFAULTS, docs)

- `sandbox.engine`: `"windows-sandbox"` (default) | `"hcs"` (alpha; refused with reasons when its check fails).
- `storage.contained`: `"off"` (default) | `"vhdx"`; `storage.containedMaxGb` (default 64).
- Neither can be set by a repo's `.sandbox-config.json`.

## Commands

- `sandbox engine` (status: the engine in use, each engine's capabilities and check), `sandbox engine check hcs`,
  `sandbox engine clean` (removes what an engine created, listed first).
- `sandbox storage contained on|off` (creates or retires the image; offers to move today's tools/state/logs in, with
  size and time, like `storage move`).

## Phases

1. Engine layer + Windows Sandbox engine (no behaviour change), settings, `sandbox engine` status. Storage provider
   interface with `folder`.
2. Contained storage for Windows Sandbox (`vhdx-mounted`), after `scripts/experiments/Test-ContainedStorage.ps1` passes
   on a PC.
3. HCS engine, alpha: documents, HcsHost.exe, check; start is enabled only after the go/no-go test (Docker Desktop,
   Windows containers, Hyper-V isolation: ptyhost + Node + csc inside Server Core) passes. First image store: an image
   already imported on the PC (e.g. by Docker), never a download of ours; our own importer later.

### Phase 3 status (HCS engine, built, start DISABLED)

Built and tested without HCS (the test machines have no Hyper-V): `src/host/engines/hcs/` (`documents.ts`, `check.ts`,
`images.ts`, `helper.ts`, `engine.ts`) and `native/csharp/HcsHost/` (verbs `check`, `enumerate`, `properties <id>`,
`create <request.json>`, `start <id>`, `terminate <id>`, `grant-vm-access <vmId> <file>`, `create-vhdx <path> <maxGb>`; JSON
answer in a file; never attaches a disk). `sandbox engine check hcs` and the doctor row "HCS engine (alpha)" (only when
`sandbox.engine` is `hcs`) say what a PC lacks, with the exact commands, and never run them.

- `HcsEngine.start()` refuses with "The HCS engine is in alpha and starting it is not enabled yet" unless
  `AGENT_SANDBOX_HCS_EXPERIMENTAL=1` is set, and always refuses inside the self-test. Do not set the flag before the
  go/no-go test below has passed.
- `engineFor` (sync) never hands out HCS; `openEngine` runs the check and returns it only when the check passes.
- Not built: the writable (scratch) layer and layer import, running the logon command in the container
  (`HcsCreateProcess`), the control channel over Hyper-V sockets, networking, formatting the blank agent VHDX inside the
  utility VM, our own image importer. `sandbox engine clean` (built in 1.11.1) removes the systems a crashed command left
  running. Field names that came from the Microsoft schema reference
  are checked; hcsshim-derived details are marked [U] in `documents.ts`.

**Go/no-go test before start() is enabled** (owner's PC, elevated or Hyper-V Administrators, Docker Desktop in Windows
containers mode, `docker pull mcr.microsoft.com/windows/servercore:ltsc2022`):
1. `sandbox engine check hcs` reports "can be used"; `HcsHost.exe check` shows `computecore: yes`.
2. With `AGENT_SANDBOX_HCS_EXPERIMENTAL=1`, `sandbox generate` then start with `sandbox.engine: hcs` and a throwaway
   project: the utility VM and the container both reach the running state (`HcsHost enumerate`), with no network adapter.
3. Inside: the code share is visible and read-only where the plan says, a file written to `C:AgentDatastate` is in the
   VHDX after a restart, and a link made in a code share does not lead out of it.
4. Inside the Server Core container: `powershell.exe` 5.1, `csc.exe`, Node (unzipped), and PtyHost (ConPTY) run and a
   terminal attaches.
5. `terminate` removes both systems and nothing of ours is left in `enumerate`; a blank VHDX can be formatted and
   mapped as described above.
Any failure is a no-go for that item; the design above lists what each failure would mean.

## Phase 2 as built: contained storage for Windows Sandbox (beta)

Code: `src/host/storage/contained/` (layout, state/refcount, disk port, `ContainedStorage`, transfer, resolve),
`src/host/storage/providers/contained.ts` (`vhdx-mounted`), `native/scripts/{mount,dismount,check}-contained.ps1` +
`contained-common.ps1`, `sandbox storage contained`, the repair checks `data-contained` and `data-contained-privacy`.

- **Split.** `run\` stays the plain data folder mapped to `C:\AgentData\run`; `tools state logs databases cache` are
  mapped from `<storage>\mounts\<set>\<name>` to `C:\AgentData\<name>`. The launch hands the split to
  `generateSandbox` as `dataMappings` (without them the whole data folder is mapped as before, byte for byte).
- **Mount record.** `<storage>\mounts\state.json` (outside the image): per set `mounted` and `holders` (`launch` while
  the launch runs, `watcher` for the background sync). The launch mounts and holds first; the watcher holds until the
  sandbox ends and its last sync is done, then lets go; no live holder and no running sandbox = dismount (Windows
  permission prompt). Dead holders are dropped by pid. A lock file serialises writes.
- **Scripts.** Request in a JSON file in a private temp folder + its SHA-256 on the command line; everything re-checked
  in the script (exact `images\<set>.vhdx` / `mounts\<set>`, no links on the way, owner, VHDX header read directly:
  signature, no parent locator, virtual size within the limit); `-DryRun` prints the diskpart lines. New image: create,
  attach, partition, format, assign, root ACL private; existing image: attach, `select partition 1`, assign (never
  format). A failed first creation detaches and renames the image `*.failed-<time>`.
- **Host readers.** `hostDataFolder` / `hostDataRoot` point the Claude login sync, terminal/ConPTY downloads, `sandbox
  logs`, the crash report, the first-start notice and the doctor's tools folder at the image while it is mounted (and only
  when the mount folder is another volume). Not yet: `sandbox data`, `sandbox clean`, other agents' account stores.

**Checklist on a PC (not yet done; all of this is untested):**
1. Run `scripts/experiments/Test-ContainedStorage.ps1` first: it answers whether a folder inside a mount point can be
   mapped into Windows Sandbox and how fast it is.
2. `sandbox storage contained on`: one prompt; `images\main.vhdx` appears (a few MB); Disk Management shows no letter;
   `icacls` on `mounts\main` and on the mounted root show only you and SYSTEM (and administrators on the folder).
3. `sandbox launch`: one prompt; the sandbox sees `C:\AgentData\tools` etc. and can write there (SQLite WAL in
   `databases` still cannot map shared memory, as before); `fs.statSync(mount).dev` differs from `mounts`; Node's
   `lstat` of the mount folder is not a symlink (else `assertNoLinks` refuses the sync paths).
4. Close the sandbox: the watcher's prompt appears and the image is dismounted; `state.json` says `mounted: false`.
5. Kill the sandbox and the watcher: the next command prints the stale-mount line; `sandbox repair` dismounts.
6. `sandbox storage contained off`: files move back, size/time shown, the image is only deleted after the question.
7. Decline a prompt at each step and confirm nothing is left half done; mount twice quickly (two terminals).
8. `diskpart`'s `select partition 1` after `attach vdisk` selects the new disk's first partition (the probe used
   `create partition` right after `attach`, which relies on the same focus rule).

**The storage helper (unreleased).** `native/csharp/StorageHelper/` is the service `AgentSandboxStorage` (task R2 in
[roadmap-tasks.md](roadmap-tasks.md)); `src/host/storage/contained/helper-port.ts` (`HelperDiskPort`) asks it first and
falls back to the scripts. It does not use diskpart: virtdisk (`OpenVirtualDisk` / `CreateVirtualDisk`,
`AttachVirtualDisk` with no drive letter and permanent lifetime), the disk IOCTLs for a new disk's one GPT partition,
fmifs `FormatEx` for NTFS, and `FSCTL_SET_REPARSE_POINT` on the held mount folder for the mount point (the mount manager
is not told, so the service clears a mount point whose disk is gone when it starts). Images made by the scripts (MBR, one
partition) are accepted too: the rule is one partition, one NTFS volume. In a Windows Sandbox all of it works except
diskpart (no Virtual Disk Service), so the helper was tested end to end there: install, a non-admin group member's
create, mount, remount, dismount, restart tidy, a non-member refused, removal dismounting.

**Checklist for the helper on a PC (not yet done):**
1. Install for everyone with `-ContainedStorageHelper`; `Get-Service AgentSandboxStorage` runs, start type Automatic;
   `sc qprivs AgentSandboxStorage` lists only the five privileges.
2. As a non-admin member: `sandbox storage contained on` and `sandbox launch` with no prompt; the log shows the calls.
3. An image made earlier by the scripts (MBR) mounts through the helper; one made by the helper mounts through the
   scripts (helper stopped).
4. Restart the PC while mounted: after sign-in the stale mount point is gone and the next launch mounts.
5. A second member's launch uses their own folder; a non-member gets the prompt.
6. Uninstall: the service is gone, nothing stays mounted, `helper\` is gone.
