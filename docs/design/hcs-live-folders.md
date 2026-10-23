# Live folders through HCS (design)

Status: **built as an opt-in alpha (`projects.liveFolders: "hcs"`, off by default), unreleased, untested on a real PC.**
The owner asked for it to be built, which counts as going ahead with the narrow HcsHost exception (`wsb-share`) below;
every rule in [Safety](#4-safety) applies. It must not replace the restart until the real-PC test in the
[Test plan](#test-plan) has passed. What was built and decided is in [As built](#as-built-alpha).

Goal (from the owner): add a folder to a Windows Sandbox that is already running, on PCs without Windows 11 24H2's
`wsb share`, through the Host Compute Service (HCS), and only if it can be done safely and tested on GitHub too.

**Recommendation: a conditional go.** Build it as an opt-in alpha (`projects.liveFolders: "hcs"`, off by default). It
replaces the restart only after the real-PC test below has passed on Windows 10 22H2 and Windows 11 23H2. The guest
half has been shown to work (in the Windows Sandbox this note was written in). The host half uses a request Microsoft
documents and hcsshim sends on every container mount. Three things can only be answered on a real PC: whether HCS lets
an administrator change Windows Sandbox's own compute system, whether Windows Sandbox's service leaves the change alone,
and which `Owner` Windows Sandbox's compute system reports. If any of those fails, it is a no-go and the restart stays.
Changing a compute system this tool did not create breaks the HcsHost rule ("only systems this tool created"). This
note proposes one narrow exception for that, described under [Safety](#4-safety). The owner must review it before any
code that uses it is merged.

## Findings

### 1. How a folder gets into a running Windows Sandbox

**Two halves:** a vSMB share is added to the VM on the host, and a bind-filter mapping is made in the guest.

*Seen inside Windows Sandbox* (the sandbox this note was written in, Windows 11 22H2 guest, started from a .wsb with 14
mapped folders; `scripts/experiments/hcs/BindMount.cs list` calls `BfGetMappings`):

```
flags 0x20  \Device\HarddiskVolume2\Projects\AgentProjects
    -> \Device\vmsmb\VSMB-{dcc079ae-60ba-4d07-847c-3493609c0870}\3ad483dec1a233132da4197c9790dcda06668793230cd6d9e94b1882e0f7f29c\
flags 0x21  \Device\HarddiskVolume2\HostTools\node
    -> \Device\vmsmb\VSMB-{dcc079ae-60ba-4d07-847c-3493609c0870}\f0469c0653c51651c5360330f3025da1a964aec7cf88010f904cb8791041f5de\
... (one line for every <MappedFolder>)
```

- Every `<MappedFolder>` is a **vSMB share** of the VM. In the guest, vSMB shares are reached through the vmsmb
  redirector under the fixed vSMB service id `VSMB-{dcc079ae-60ba-4d07-847c-3493609c0870}`. That is the same prefix
  hcsshim uses (`internal/uvm/vsmb.go`, ``vsmbSharePrefix = `\\?\VMSMB\VSMB-{dcc079ae-...}\` ``). Windows Sandbox names
  its shares with 64 hex digits, which look like a SHA-256.
- The folder shows up at its sandbox path through a **global bind-filter mapping** (`bindflt.sys`, made with
  `BfSetupFilter` and job handle 0). The flags are `0x20` (`BINDFLT_FLAG_CLOUD_FILES_ECPS`) for writable folders and
  `0x21` (`| BINDFLT_FLAG_READ_ONLY_MAPPING`) for `<ReadOnly>true</ReadOnly>`; flag names are from BuildXL's
  `NativeContainerUtilities.cs`. The folder is a plain directory, not a reparse point (`fsutil reparsepoint query`
  says so, and `GetFinalPathNameByHandle` returns the virtual path). That is why tools inside cannot tell it is mapped.
- The guest agent that makes these mappings is **CmAgent** ("Container Manager Agent", `cmagent.dll` in a svchost,
  LocalSystem). There is no GCS (`vmcomputeagent`) in the Windows Sandbox guest. Filters on `\Device\vmsmb`: `bindflt`,
  `wcifs`, `FileInfo`.

*Host side, from Microsoft's documentation:* `HcsModifyComputeSystem(system, operation, configuration, identity)` takes
a `ModifySettingRequest`. Its resource table lists `"VirtualMachine/Devices/VirtualSmb/Shares"` with `Settings` of type
`VirtualSmbShare` and "No Limit" on `RequestType` ([HcsModifyComputeSystem][modify]). The schema in
`src/selftest/fixtures/hcs-schema/windows-11-21h2.json` has `ModifySettingRequest {ResourcePath, RequestType
(Add|Remove|Update), Settings, GuestRequest}`, `VirtualSmbShare {Name, Path, AllowedFiles, Options}` and
`VirtualSmbShareOptions` (ReadOnly, ShareRead, CacheIo, NoOplocks, TakeBackupPrivilege, UseShareRootIdentity,
NoDirectmap, ... SingleFileMapping, SupportCloudFiles). hcsshim's `AddVSMB` / `removeVSMB` send exactly this
(`internal/hcs/resourcepaths/virtualmachine.go`: `VSMBShareResourcePath = "VirtualMachine/Devices/VirtualSmb/Shares"`).

**What `wsb share` does (inferred, not observed).** No 24H2 PC was available, and wsb.exe and its service are closed
source. The likely sequence is: the Windows Sandbox service (CmService) calls HcsModifyComputeSystem to add a vSMB share,
then asks CmAgent to make the bind mapping at `--sandbox-path`, the same way it handles .wsb mapped folders. `wsb share`
works as a normal user, because Microsoft's service does the work. A PC with 24H2 can confirm this: run
`BindMount list` in the sandbox before and after `wsb share`.

**Not used:** `Plan9/Shares` is for Linux guests. `MappedDirectory` / `Container/MappedDirectories` is for a container
silo, and Windows Sandbox is a whole VM, not a container. `GuestRequest` goes to a GCS, which this guest does not have.

#### Exact request shapes

Add (read-only, the default):

```json
{
  "ResourcePath": "VirtualMachine/Devices/VirtualSmb/Shares",
  "RequestType": "Add",
  "Settings": {
    "Name": "agentsbx-5f2c0d9e7a1b4c33",
    "Path": "D:\\code\\other-project",
    "Options": { "NoDirectmap": true, "ReadOnly": true, "ShareRead": true, "CacheIo": true, "PseudoOplocks": true }
  }
}
```

Writable: `"Options": { "NoDirectmap": true }`. Remove: `{"ResourcePath": same, "RequestType": "Remove", "Settings":
{"Name": "agentsbx-5f2c0d9e7a1b4c33"}}`.

- The read-only options are hcsshim's `DefaultVSMBOptions(readOnly)`.
- `NoDirectmap` is always on. hcsshim only removes a share if it was never direct-mapped, because removing a
  direct-mapped one needs a GCS capability (`PurgeVSmbCachedHandlesSupported`) that the Windows Sandbox guest does not
  have.
- `ReadOnly` is enforced by the vSMB server on the host. The guest's read-only bind flag is extra protection only: the
  guest is admin and can remove its own mappings.

Guest, as an administrator:

```
BfSetupFilter(NULL, BINDFLT_FLAG_NO_MULTIPLE_TARGETS | BINDFLT_FLAG_READ_ONLY_MAPPING,
              L"C:\\Workspace\\other-project",
              L"\\\\?\\GLOBALROOT\\Device\\vmsmb\\VSMB-{dcc079ae-60ba-4d07-847c-3493609c0870}\\agentsbx-5f2c0d9e7a1b4c33\\",
              NULL, 0)
BfRemoveMapping(NULL, L"C:\\Workspace\\other-project")     // on remove
```

### 2. Using our HcsHost against Windows Sandbox before 24H2

- **Technically likely.** Windows Sandbox's VM has a VirtualSmb device (seen above), and adding a share to a running VM
  is a documented operation. `hcsdiag` (inbox) is documented as working with Windows Sandbox and has a
  `share [-uvm] [-readonly] <id> <host folder> <container folder>` verb ([Thomas Maurer, hcsdiag][hcsdiag]). We do not
  know whether that verb works on Windows Sandbox, because it may expect a GCS in the guest.
- **What identifies it.** Every compute system reports `Id`, `SystemType`, `Owner`, `State` and `RuntimeId` (schema
  `ComputeSystemProperties`; HcsEnumerateComputeSystems takes a `SystemQuery {Ids, Names, Types, Owners}`). A community
  table built from `hcsdiag list` names the Windows Sandbox owner **`Madrid`** and lists `CmService` separately
  ([gist][owners]). That is unconfirmed, so the PC test records the real values. Expected: one `VirtualMachine`, a GUID
  `Id`, Owner `Madrid`, State `Running`. Before 24H2, Windows runs one Windows Sandbox per PC (README, docs/projects.md),
  but it may belong to **another Windows user** (`docs/troubleshooting.md`, "started by alice").
- **Rights.** HCS calls need Administrators or Hyper-V Administrators (`HCS_E_ACCESS_DENIED`, aka.ms/hcsadmin; already
  mapped in `Hcs.cs`). The CLI runs unelevated. So every add or remove needs one UAC prompt (the same pattern as
  contained storage's mount scripts), or the user is in Hyper-V Administrators. We must **not** suggest joining that
  group for this feature: it gives control over every VM on the PC.
- **Does Windows Sandbox undo it?** Unknown. Nothing public describes CmService checking its VM's devices. vSMB
  shares live in the VM worker process (vmwp) and die with the VM, so closing the sandbox removes them. The PC test
  checks that the share survives 10 minutes, the host sleeping and resuming, and the sandbox window being closed and
  reopened (where possible), and that it is gone after the sandbox closes. Share names cannot clash with Windows
  Sandbox's own (64 hex digits): ours are `agentsbx-` plus hex.

### 3. Inside the guest

Shown in this sandbox (`BindProbe`/`BindMount`, admin, as our daemon runs):

| Target given to `BfSetupFilter` | Result |
| --- | --- |
| `\\?\GLOBALROOT\Device\vmsmb\VSMB-{dcc0...}\<existing share>\` | `S_OK`; the folder lists the share (`mw2-agent, windows-sandbox, ...`); `BfRemoveMapping` `S_OK` |
| `\Device\vmsmb\VSMB-{dcc0...}\<share>\` (the form `BfGetMappings` prints) | `0x80070003` path not found |
| `\\?\UNC\VMSMB\VSMB-{dcc0...}\<share>\` | `0x80070035` network path not found |
| `...\agentsbx-0123abcd\` (no such share yet) | `0x80070002`, and nothing is created (correction, 2026-10-23: that was with `C:\Workspace` missing; with it there the answer is `0x80070490` ERROR_NOT_FOUND) |

- The virtual root does not need to exist. bindflt shows it while the mapping lives, and after `BfRemoveMapping` it is
  gone (`Test-Path` false). **Its parent must exist** (seen 2026-10-23): without `C:\Workspace`, `BfSetupFilter` gives
  `0x80070002` even for an existing share, so the daemon makes `C:\Workspace` first and treats both `0x80070002` and
  `0x80070490` as "the share has not arrived".
- A read-only mapping refused a write ("Access to the path is denied").
- The mapped folder is a plain directory, like a .wsb mapped folder.

So **our daemon makes the folder appear**. CmAgent does not need to be involved, and a symlink would be the wrong
choice: tools would see a link, and `assertNoLinks` / `lstat` checks would trip on it. No `net use` or LanmanWorkstation
start is needed, because the vmsmb redirector instance is already running (Windows Sandbox always has shares).
`0x80070002` gives the daemon a clean "the share is not there (yet)".

### 4. Safety

What can go wrong, and the rule against each:

| Risk | Rule |
| --- | --- |
| Changing the wrong compute system (WSL, Docker, Hyper-V VMs, **another user's** Windows Sandbox) | Exception scope: HcsHost verb `wsb-share` only. It acts only if (a) there is exactly one compute system that is `SystemType == "VirtualMachine"`, `State == "Running"`, has a GUID `Id` and an `Owner` from a fixed list confirmed on PCs (`Madrid`), and (b) that id equals the id the host passes in. The host passes it only when its `SessionLedger` says this user's launch is running and not someone else's (`host/sharing`). (c) Before the real folder, a canary share with a random token must come back through our daemon (below). The ledger alone does not give the HCS id, so (c) is what proves it. |
| A malformed or broader request | HcsHost builds the request itself from `{action, name, path, readOnly}`. ResourcePath is fixed to `VirtualMachine/Devices/VirtualSmb/Shares`. RequestType is only `Add` or `Remove`, never `Update`. The name must match `^agentsbx-[0-9a-f]{8,32}$`. Options are fixed: never `TakeBackupPrivilege` (lets the guest read past ACLs through the backup privilege), `UseShareRootIdentity`, `AllowedFiles`, `RestrictFileAccess`, `SingleFileMapping` or `VmSharedMemory`. Remove only takes names with our prefix that are in our record. |
| Sharing the wrong host folder | Only from a host command the user ran (`sandbox projects add` / starting a project in a new folder). **Never on a request from the guest:** nothing read from `run/` can ask for a share. The host's `assertSafeWorkspace` refuses this tool's own storage, the package, system folders, the profile root and drive roots. HcsHost checks again: full local path, an existing folder, not a drive root, no `.`/`..`, no reparse point on the folder or any parent. The share appears in `sandbox projects` with its mechanism (`hcs`). |
| Writable when it should not be | Read-only unless the user asked for write (`--write`, or the project's existing mapping is writable, as for root mappings today). Read-only is enforced on the host by the vSMB server. |
| A hostile guest abusing the share | The guest gets exactly what a .wsb `<MappedFolder>` would give it: the same vSMB server, the same confinement to the share root, and the same refusal to create links from inside (CLAUDE.md: mapped folders refuse symlinks and junctions). Links that already exist on the host inside the folder are expected to behave as they do for boot-time mappings, and whose rights the vSMB server uses is still a PC test. The guest daemon's reply (`run/`, zod) only echoes the canary token, and the host never acts on guest text beyond that. |
| Crashing the user's sandbox | Hot-adding vSMB shares is routine (hcsshim does it for every container mount). The risky part is removing a direct-mapped share, which `NoDirectmap` avoids. Bounded waits: 60 s per HCS operation, and HcsHost never terminates, pauses or saves the sandbox. Opt-in, alpha, with the warning shown: "if it fails, the sandbox may close; save your work first". |
| Shares left behind | They cannot outlive the VM: vSMB lives in vmwp and closing the sandbox ends it. The host record (`<storage>\state\live-folders.json`, outside the data folder) is cleared on the stop event. `sandbox projects remove` removes the guest mapping first, then the share. If the guest has files open, the remove fails and the user is told the folder stays until the sandbox stops. |
| Racing with 24H2's `wsb share` or a Windows update changing Windows Sandbox | Off where `wsb share` exists (`detectWsb().has('share')`): the official path wins. The owner list and the "exactly one" rule fail closed: an unknown owner or two candidates means a restart is offered. |
| An elevated helper as an attack surface | Same pattern as the contained-storage scripts: the request is a JSON file in a private temp folder, its SHA-256 goes on the command line, and HcsHost re-checks every field. In addition: DLLs load from System32 only, the exe runs from an admin-only copy whose hash is checked, and HcsHost hashes the exact bytes it parses (see the review list below). |

**Canary first (proves the id before any real folder is exposed).**
1. The elevated helper creates a fresh, empty folder in its private temp folder holding one file with a random
   128-bit token. It shares that folder read-only as `agentsbx-<random>` to the candidate system.
2. The host writes `run/live/<canary name>.json`. The daemon maps the canary and writes the token it read **from the
   share** back to `run/`.
3. Only a matching token within 30 s lets the helper share the real folder. Then the canary is removed.
4. Otherwise both are removed and a restart is offered.

Only our sandbox can see our `run/` folder, and only the system that got the share can read the token. So the token
ties the HCS id to our sandbox, and a wrong system only ever sees an empty folder with a random token. (An earlier
draft read a nonce from `run/` itself, which proved nothing: see the review.)

**The review's other findings, and how the plan takes them in.** An Opus model reviewed this section; its findings are
below. Items marked (branch) are already done on this branch; the rest are rules the implementation must follow.
- **Guest requests come only from the host.** The daemon's request folder `run/live` and its mapping record must not
  be writable by the agent user. Use the daemon's own admin-only folder, or have the host sign requests with an HMAC
  key the agent user cannot read. The guest value of `readOnly` can never loosen what the host recorded.
- **Guest folder names.** Folder names must match `^[a-z0-9][a-z0-9_-]{0,63}$`, under `C:\Workspace` only, and the
  folder must not exist yet. That rules out `..`, `foo.` and `foo `, which are aliases of other folders. (branch:
  `BindMount.cs`)
- **Path checks in HcsHost:**
  - refuse `/`, any `:` after the drive (streams), trailing dots or spaces, `~` (short names), and paths where
    `GetFullPath(p)` differs from `p`; the drive must be fixed (branch: `Share.cs`);
  - the real verb also opens the folder with `FILE_FLAG_OPEN_REPARSE_POINT`, shares the long-name
    `GetFinalPathNameByHandle` form, refuses `subst` drives (`QueryDosDevice`), and applies its own case-insensitive
    denylist on the final path (Windows, Program Files, ProgramData, other profiles, this tool's storage). It does not
    rely on the unelevated TypeScript for any of this;
  - it checks that the unelevated user can read the folder (AccessCheck with the linked token), so the elevated caller
    can never share something only an administrator can read.
- **Whose rights vSMB uses** for a share added by an elevated caller (the caller's token, SYSTEM, or the VM's account)
  is unknown. So "the same exposure as a .wsb folder" is **not proven**: it is a PC test (below). If the guest can read
  a file the user is denied, it is a no-go unless HcsModifyComputeSystem's `identity` token (the user's linked,
  unelevated token) fixes it.
- **The elevated helper:**
  - load computecore/computestorage from System32 only (branch: `[assembly: DefaultDllImportSearchPaths(System32)]`);
  - copy HcsHost.exe to an admin-only folder, and have the elevated script check the copy's hash before running it;
  - HcsHost hashes the exact bytes it parses and compares them with the SHA-256 on its command line, so a request file
    swapped after the check is caught.
- **TOCTOU between enumerate and open by id.** Small: GUIDs are not reused, the canary covers a swap, and HcsHost
  re-reads `Owner`/`State` through the opened handle before modifying.
- **Other Container Manager VMs** (Defender Application Guard / MDAG) may report the same Owner. The "exactly one
  candidate" rule plus the canary fail closed. The PC test runs with Edge Application Guard open too.
- **Least access.** `HcsOpenComputeSystem` asks for the narrowest right that allows modify, not `GENERIC_ALL`. The
  share record keeps the names this tool added, and remove takes only those.
- **Writable shares.** Record what Windows Sandbox itself sends for writable folders (it may set `SupportCloudFiles`,
  to match the guest's `CLOUD_FILES_ECPS` flag) instead of guessing.

### 5. Testing on GitHub

- **Windows Sandbox cannot run on the runners.** `Containers-DisposableClientVM` is a Windows client feature; the
  prerequisites are "Windows 11 or Windows 10, version 1903 or later" ([install][install]). The runners are Windows
  Server 2022/2025, and the workflow's facts step already lists their features.
- **The request shape can be tested honestly there.** The existing `hcs-engine.yml` creates and starts **our own**
  utility VM (its document has a `VirtualSmb` device). On this branch, `Test-HcsLifecycle.ps1` adds these
  "live folder" steps, informational until they have passed on both runners:
  - add a read-only share and a writable share with `HcsHost share`;
  - the same name twice is refused by HCS;
  - the guest reads a file through `\\?\VMSMB\VSMB-{dcc0...}\<name>` (`hcsdiag exec`, informational: needs the UVM's
    GCS);
  - remove both shares;
  - removing a share that is already gone fails cleanly;
  - the VM is still `Running` afterwards.
- **What the runners cannot show:** Windows Sandbox's owner and id, the access check on its system, CmService's
  reaction, and the bind mapping in a Windows Sandbox guest. The last one was shown here by hand. The others are the
  PC test.

## Implementation plan

1. **HcsHost.**
   - `share <request.json>` (on this branch): our own systems only (id prefix + Owner, like start/terminate). It uses
     the shared request builder `ShareRequest` (`native/csharp/HcsHost/Share.cs`).
   - New `wsb-share <request.json>` (the exception, after review): same builder, plus the Windows Sandbox
     identification rules from section 4. `Guard.WindowsSandboxProblem(id)` does the enumerate, the owner list, the
     single running candidate and the id match. It refuses any id with the `agent-sandbox-` prefix, and `share`
     refuses GUIDs, so neither verb can reach the other's systems.
   - The C# 5 rules apply.
2. **Host (TypeScript).**
   - `src/host/engines/hcs/live-folders.ts`: `LiveFolders` (class, state file `<storage>\state\live-folders.json`
     with zod) with `add(host, guest, readOnly)` and `remove(name)`.
   - It runs HcsHost elevated with one UAC prompt per add or remove (a fixed `.ps1` run by path:
     `native/scripts/hcs-live-share.ps1`), with the request file and SHA-256 like `mount-contained.ps1`.
   - `mapper.ts`: after "inside a root" and "wsb share", try `hcs` when `projects.liveFolders === 'hcs'` and wsb share
     is missing; on any refusal or failure, `NeedsRestart` with the reason. `Mechanism` gains `'hcs'` (registry
     schema, `MECHANISM_TEXT`).
   - Stop events clear the record.
3. **Guest.**
   - `src/guest/daemon/live-folders.ts` takes HMAC-signed requests from `run/live/*.json` (the key goes through the
     one-shot secrets file into the daemon's admin-only state, never readable by the agent user). It checks them with
     zod, the name regex and a guest path from `shared/paths/projects.ts`: `C:\Workspace\<plain name>`, not existing
     yet.
   - The daemon echoes the canary token (section 4).
   - It calls `BfSetupFilter` through a small csc helper `sandbox/csharp/BindMount.cs` (from the prototype, run by
     path) with retries while the result is `0x80070002`, then writes the reply.
   - On remove: `BfRemoveMapping`. On daemon start: re-applies recorded mappings, in case the guest rebooted.
4. **Settings.** `projects.liveFolders: "off" | "hcs"` (default `"off"`; schema, `DEFAULTS`, `config.example.json`,
   settings category text). It is never in `LocalOverrides`: a repo cannot switch it on.
5. **Doctor / health.** A row "Add folders while the sandbox runs" shows wsb share, HCS (alpha), or restart, with the
   reason (for example "needs an administrator prompt each time").
6. **Docs.** `docs/projects.md` (the third way in), `docs/design/engines.md` (HcsHost verbs), the troubleshooting rows
   for the refusals, and the CHANGELOG.

## Test plan

- **Unit (self-test, no Hyper-V):**
  - `hcs` suite: HcsHost refuses before HCS is asked. Foreign ids (GUID, `WindowsSandbox`), Windows Sandbox's 64-hex
    names, `update`, relative paths, drive roots, missing folders, dotted paths, `/` paths, streams, trailing dots or
    spaces, short names, linked folders and a non-boolean `readOnly` are all refused. This is on this branch. Still to
    add: a planted `computecore.dll` next to the exe is ignored, and a request file changed after hashing is refused.
  - For `wsb-share`, feed `Guard` recorded enumerate JSON through a test hook: zero, one or two candidates, wrong
    owner, stopped, non-GUID.
  - `LiveFolders` with a fake helper: record, remove, clearing on stop. A canary token mismatch or a timeout removes
    the canary and never adds the real folder.
  - `mapper` chooses roots, then wsb, then hcs, then restart.
  - The guest handler with a fake bind function: refuses names and paths outside the rules (`..`, `foo.`, `foo `, an
    existing folder), retries on `0x80070002`, and ignores requests in a folder the agent user can write.
- **GitHub (`hcs-engine.yml`, by hand):** the live-folder steps against our own utility VM (above). Make them required
  once they pass on windows-2022 and windows-2025.
- **Real PC (owner, elevated shell, Windows 10 22H2 and Windows 11 23H2; never on a PC with work open in the
  sandbox):**
  1. Start a throwaway sandbox with this tool. Run `scripts/experiments/hcs/Test-Hcs.ps1` and
     `WsbShareProbe.exe find`. Record Id, SystemType, Owner and State (does `Owner` equal `Madrid`?).
  2. `WsbShareProbe.exe add <id> agentsbx-00000001 <a new empty folder with one file>` (read-only). Record the HRESULT.
     Then, inside: `BindMount.exe map C:\Workspace\live1 agentsbx-00000001` and read the file. A write fails.
  3. Leave it for 10 minutes; sleep and resume the PC; the folder is still there. Close and reopen the sandbox window
     if the version allows it.
  4. `BindMount unmap`, then `WsbShareProbe remove`: both `S_OK`, and the sandbox keeps running.
  5. Add again and close the sandbox: no vmwp or share remains, and the next sandbox does not show it.
  6. Unelevated: `find` fails with access denied (expected; this confirms the UAC design).
  7. On a 24H2 PC: `BindMount list` before and after `wsb share` (confirms section 1's inference).
  8. **Identity:** share a folder that holds one file the user is denied but Administrators may read. The guest must
     not be able to read it. If it can, retry with the `identity` token. A failure here is a no-go.
  9. **Links:** a junction and a symlink inside the shared folder that point outside it. Record what the guest sees,
     and compare it with the same folder mapped by a .wsb.
  10. **Other systems:** with Edge Application Guard (if available) or a second Windows user's sandbox (fast user
      switching) running, `find` reports "not exactly one" and nothing is shared.
  11. **The sandbox's own folders** still work after an add and a remove. Removing while the guest has a file open
      fails cleanly. Two adds at once are serialised.
  12. Read the Hyper-V-Compute and CmService event logs (Applications and Services Logs) for errors after each step.

  Any failure in steps 2 to 5, 8 or 10 is a no-go for the HCS route.

## As built (alpha)

Files: `native/csharp/HcsHost/` (`WsbShare.cs`, `WsbGuard.cs`, `FolderAccess.cs`, `Share.cs`), the elevated
`native/scripts/hcs-live-share.ps1`, `src/host/engines/hcs/live-folders.ts` (`LiveFolders`, `ScriptLivePort`),
`src/host/projects/mapper.ts` (order and `addFoldersRow`), `src/shared/channel/live.ts` (signed messages),
`src/guest/daemon/live-folders.ts` + `live.ts` (the handler), `sandbox/csharp/BindMount.cs`, the `live-folders`
self-test suite and the manual `scripts/experiments/hcs/Test-LiveGuest.ps1`.

Decisions where this note left room (an Opus advisor was asked; its answers were followed):
- **The HMAC key** is made per launch only when `projects.liveFolders` is `"hcs"` at the start (otherwise a restart is
  offered and the doctor says why), kept on the host sealed with DPAPI in `<storage>\state\live-folders.json`, handed
  over in the one-shot secrets file, and kept by the daemon in `C:\ProgramData\AgentSandboxDaemon` (Administrators and
  SYSTEM). The MAC is over the exact payload text (`{payload, mac}`), the payload carries the launch id and its time
  (two minutes either way), and the seen ids are kept on the sandbox's disk so a daemon restart does not reopen them.
  **The agent is the sandbox's administrator, so "a key the agent user cannot read" is not possible**: the signature
  stops other users of a shared sandbox (who may write `run\`, never `secrets\`) and stale or replayed files. The test
  plan's "ignores requests in a folder the agent user can write" is therefore "ignores every request without a valid
  signature" (and deletes planted files and links unread). The boundary is that only the host decides what is shared.
- **One HcsHost process, one handle** for the canary and the real add (no separate find then share). The first add
  passes no id; HcsHost returns the id the canary proved, the host records it, and later adds and removes must match it.
  `HcsOpenComputeSystem` documents no narrower right than `GENERIC_ALL`, so the "least access" item stays open.
- **The canary folder** is made by HcsHost next to its own administrator-only copy with its DACL applied at creation:
  Administrators, SYSTEM and Virtual Machines (`S-1-5-83-0`, the VM worker) read only; the user is left off. The
  unelevated host relays the token through `answer.txt` in the request's private temp folder; HcsHost compares it in
  fixed time. Cleanup is in `finally`.
- **The exe copy** goes to a fresh random folder under `%ProgramData%\AgentSandboxLiveFolders` (made once with a
  protected Administrators + SYSTEM DACL, owner Administrators; checked on every run, refused if anyone else may use
  it), its SHA-256 compared with the request's, and the folder removed afterwards. The `.ps1` itself runs from the
  package folder (same-user malware is out of scope; UAC is not a boundary).
- **Folder checks in the elevated process**: the real path is resolved unelevated first (a subst drive is not visible
  to the elevated session and is refused there); HcsHost opens the folder without following links, compares
  `GetFinalPathNameByHandle`, refuses drives, Windows, Program Files, ProgramData, the users folder, the profile root
  and other profiles, the storage and data folders (and folders holding them), and runs `AccessCheck` with the linked
  (unelevated) token for read and traverse, plus write for a writable share. `identity` stays `NULL` (PC test 8).
- **Writable or not**: the project's own `readOnly` setting decides (as at a launch); read-only when it is not known.
- **Concurrency**: the mutex `Global\AgentSandboxLiveFolders` (two minutes, an abandoned one counts as taken).
- **Remove**: the daemon hides the folder and confirms the mapping is gone, then the share is removed; any failure keeps
  the record and the project. Each add and remove is logged in `<storage>\state\live-folders.log`. A stop clears the
  record and its key (the watcher); the next launch makes a new key.

## Sources

- Microsoft, [HcsModifyComputeSystem][modify] (resource paths and Settings types); HCS schema JSON in
  `src/selftest/fixtures/hcs-schema/` (from MicrosoftDocs/Virtualization-Documentation).
- microsoft/hcsshim (main): `internal/uvm/vsmb.go` (AddVSMB, DefaultVSMBOptions, removeVSMB, vsmbSharePrefix),
  `internal/hcs/resourcepaths/virtualmachine.go`, `.../silo.go`, `internal/gcs-sidecar/vsmb.go` (vmsmb device names),
  `vendor/github.com/Microsoft/go-winio/pkg/bindfilter/bind_filter.go` (BfSetupFilter / BfGetMappings layout),
  `test/functional/uvm_vsmb_test.go`.
- microsoft/BuildXL `NativeContainerUtilities.cs` (bindflt flag names).
- Microsoft, [Windows Sandbox command line][cli] (`wsb share`, "sessions for the current user"); [Install Windows
  Sandbox][install].
- [hcsdiag][hcsdiag] (Thomas Maurer); [hcsdiag owner names][owners] (community gist, unconfirmed).
- Observations in a Windows Sandbox guest, 2026-10-19: `fltmc instances`, `BfGetMappings`, the `CmAgent` service, and
  the BindProbe results above.

[modify]: https://learn.microsoft.com/en-us/virtualization/api/hcs/reference/hcsmodifycomputesystem
[cli]: https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli
[install]: https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-install
[hcsdiag]: https://www.thomasmaurer.ch/2020/06/hcsdiag-exe-hyper-v-host-compute-service-diagnostics-tool/
[owners]: https://gist.github.com/jdgregson/434e44d4a4c31a137b2c081829b3d214
