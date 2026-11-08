# Memory gate: smoothing build bursts in the sandbox (design and work plan)

Status: planned. Owner of suspend state: `memgov.exe` (one process, two ledgers). Packages: A (Sonnet, code and
tests), B (Haiku, docs).

## 0. Evidence and what this does NOT claim

- The crash report shows **the PC was not out of memory** when the sandbox closed: 42 GB RAM free and 52 GB commit
  free. `vmwp.exe` (the Hyper-V worker on the PC) crashed with an access violation in `ntdll.dll` (Application Error
  1000, 0xc0000005, offset 0x21afd), with vGPU on, about 2 s after a wave of about 20 `cl.exe` started.
- Inside the sandbox, the trigger is **the speed of guest memory growth**, not its level: 20 `cl.exe` each commit about
  2.6 GB within a second; guest commit went from 11 to 41 GB in about 5 s (13:37:45 to 13:37:53); RAM actually used
  lagged far behind (8.6 GB).
- So the gate is **a mitigation of the trigger, not the fix** of the vmwp crash, which is investigated separately
  (crash dumps are out of scope here).
- **The gate's level is NOT based on the PC running out of commit or RAM.** It limits the RATE at which the agents'
  programs gain committed memory: at most `growthMb` per `windowMs`. Above that, newly started heavy build programs are
  frozen and released one at a time.
- No host watchdog change. No new channel request. No new setting.

## 1. Why this helps

- **The existing protections all poll and are too slow for a 5 s ramp.** The governor checks every 2 s and smooths
  growth over several samples; the host watchdog every 10 s; the backstop sits at the guest commit limit.
- **Windows tells memgov the moment the job crosses a mark.** A job object's notification limit
  (`JobObjectNotificationLimitInformation`, `JOB_OBJECT_LIMIT_JOB_MEMORY`) posts `JOB_OBJECT_MSG_NOTIFICATION_LIMIT` to
  an I/O completion port at the allocation that crosses it; allocations do not fail. memgov moves the mark every 500 ms
  to "lowest job commit in the last `windowMs` + `growthMb`", so a notification means exactly: "the agents' programs
  grew by more than `growthMb` within `windowMs`".
- **New compilers are caught at birth.** `JOB_OBJECT_MSG_NEW_PROCESS` reports each new process in the job as it is
  created. During a burst a new compiler is frozen before it has taken any lock or committed its 2.6 GB.
- **The burst becomes a ramp.** Release is paced: one process every `releaseMs`, oldest frozen first. The Unreal wave
  (20 × 2.6 GB in 1 s) becomes about one `cl.exe` every 1.5 s. Ordinary cargo and MSBuild builds never reach 4 GB in
  3 s and are untouched.
- **Nothing is ever killed. Every hold ends by `maxHoldMs` (30 s) at the latest.**

## 2. Verified Windows behaviour (Microsoft Learn)

| Fact | Consequence |
| --- | --- |
| Notification limit: processes continue to run and can allocate beyond it; the message goes to the job's completion port. Windows 8 and later. | It never fails a build. |
| No further `JOB_OBJECT_MSG_NOTIFICATION_LIMIT` until `QueryInformationJobObject(JobObjectLimitViolationInformation = 13)` is called. | Re-arming = querying. After each trip memgov queries, then moves the mark to job memory + `growthMb`: no flood. |
| `JOBOBJECT_LIMIT_VIOLATION_INFORMATION.JobMemory` = the job's committed memory at the notification (valid when `ViolationLimitFlags & 0x200`). | Used as the job level at the trip. |
| Notification-limit messages are guaranteed to arrive; NEW_PROCESS / EXIT_PROCESS are not. | Birth detection also has a 500 ms fallback (pid diff in poll mode; pruning by age). |
| One completion port per job; on Windows 8 and later NULL removes the association. | memgov first sets NULL, then its own port: a restarted memgov takes over cleanly. |
| Nested jobs: messages go to every port in the parent chain. | UBA or any tool nesting jobs under the agents' job still reports to our port. |
| `lpOverlapped` = pid; `lpNumberOfBytes` = message id. NEW_PROCESS 6, EXIT_PROCESS 7, ABNORMAL_EXIT_PROCESS 8, NOTIFICATION_LIMIT 11. | Pids can be reused: memgov keeps a process handle for every process it tracks or holds. |
| `SetInformationJobObject` needs `JOB_OBJECT_SET_ATTRIBUTES` (0x0002). Classes: AssociateCompletionPort 7, NotificationLimit 12. | The gate opens its own job handle with `0x0004 \| 0x0002`. |

Not confirmed in the docs (the design does not depend on them): whether a notification fires at once when the limit is
set below current usage (the 500 ms software check catches it), and whether the violation query returns current job
memory when nothing was exceeded (the job's memory is read by summing its processes' private memory instead).

**PtyHost does NOT associate a completion port** (sandbox/csharp/PtyHost.cs lines 1836-1908 only set
`JobObjectExtendedLimitInformation` with `JOB_OBJECT_LIMIT_JOB_MEMORY` as the hard backstop). The port is free.

## 3. Decisions

### Who owns the port: `memgov serve`

- A child of the daemon; it lives across sessions (ptyhosts come and go, the daemon stays).
- It already opens the agents' job by name and keeps the handle, which keeps the job alive between sessions.
- It is already the only process that suspends anything, so suspend state stays in one place.
- governor.ts restarts it 30 s after any exit; the new memgov removes the old port association (NULL) and sets its own.
- Rejected: the first ptyhost (it ends with its session); a new helper (one more process, two suspenders).

### One owner of suspend state: memgov

- Two ledgers under the existing `lock (Gate)`: `Paused` (the governor's timed `suspend`) and `GateHeld` (the gate).
- A pid is never in both: the governor's `Suspend` skips gate-held pids; the gate skips `Paused` pids. No process is
  ever suspended twice (`NtSuspendProcess` counts).
- `HeldFile` stores both sets, so `RecoverHeld` undoes gate holds after a crash too. `ResumeAll` resumes both.

### What may be frozen: `GATE_NAMES`

- The governor's COMPILERS set plus `shadercompileworker`, minus NEVER; decided in TypeScript (decide.ts) and passed
  to memgov as `--gate-names`. memgov touches nothing else.
- Never frozen: agents (claude, codex, opencode, node, …), shells, ptyhost, memgov, git, conhost; build coordinators
  (UnrealBuildTool, UbaHost, dotnet, msbuild, cargo, ninja, cmake, make, mspdbsrv); UnrealEditor and UnrealEditor-Cmd.
  Coordinators hold pipes, locks and job tokens others wait on; `mspdbsrv` serves every `cl.exe`; UnrealEditor-Cmd is
  one long process the agent waits on (its ShaderCompileWorkers are gated instead).

### When to freeze

- **Burst active** = less than `windowMs` since the last trip. (Not "something is held": with fast compiles the queue would never empty and every later program would start one per `releaseMs` while memory is calm.)
- **At birth (NEW_PROCESS):** while a burst is active, every new process in `GATE_NAMES` is frozen at once.
- **At a trip (notification, or the 500 ms software check):** freeze every young process in `GATE_NAMES` (started less
  than `windowMs` ago, not held before) and the process that caused the notification if its name is in `GATE_NAMES`.
- Older, already-running compilers are left to the governor's dial.

### Release order: oldest frozen first (FIFO)

One release every `releaseMs`, only while no trip happened in the last `releaseMs`. FIFO keeps the build's start order
and bounds every wait.

### Maximum hold

A process held `maxHoldMs` (30000 = memgov's `MaxSuspendMs`) is released at once, outside the pacing; never killed. A
released process is not frozen again by later trips unless it is itself the process that caused the notification.

### Parameters per profile (`BURST_GATE` in shared/memory/policy.ts)

| Profile | growthMb | windowMs | releaseMs | maxHoldMs |
| --- | --- | --- | --- | --- |
| normal | 4096 | 3000 | 1500 | 30000 |
| gentle (vGPU on) | 3072 | 3000 | 2000 | 30000 |

The observed burst was about 11 GB per 3 s; 4096 MB per 3 s lets one or two PCH `cl.exe` start freely and paces the
rest. No setting: the gate is on whenever the governor is on (`sandbox.pressureResponse`, already "yours only"), so
`NEVER_LOOSER`, `DEFAULTS` and `config.example.json` do not change; only the `pressureResponse` description does.

### Hard backstop: unchanged

It stays just below the guest commit limit (`sandbox.agentMemoryHeadroomMb`). The PC was not short of memory; lowering
it would only make builds fail. The notification limit and the hard limit are separate job settings.

### Fallback ("poll" mode) and "off"

- **Poll mode** if `CreateIoCompletionPort`, associating the port, or `SetInformationJobObject(12)` fails: the 500 ms
  tick does the software trip, and new processes are found by diffing the job's pid list between ticks.
- **Off** if the job cannot be opened with set-attributes access (error 5), or `--gate` is invalid: the governor works
  exactly as today.
- Without `--gate` the gate never starts: the self-test and older daemons never touch the real job's port.

## 4. Package A (Sonnet): implementation and tests

Follow CLAUDE.md. C#: C# 5, Allman braces, P/Invoke only in the nested `NativeMethods` with `SetLastError = true`
(ntdll calls without it, as today), `Win32Exception` for failures, named constants, handles closed in `finally`, no
`$""`, `?.`, `nameof` or expression bodies. TypeScript: `function` declarations with explicit return types,
`readonly`, `import type`, no enums.

### A1. `src/shared/memory/policy.ts`, after `maxCompilers`

```ts
/** The memory gate in memgov: new build programs wait when the agents' programs grow faster than this. */
export interface BurstGate {
  /** Growth (MB of committed memory) that counts as a burst... */
  readonly growthMb: number;
  /** ...within this many ms. */
  readonly windowMs: number;
  /** Held programs go on one at a time, this far apart (oldest first). */
  readonly releaseMs: number;
  /** No program waits longer than this (memgov's own cap is 30000); never killed. */
  readonly maxHoldMs: number;
}

export const BURST_GATE: Readonly<Record<LoadProfile, BurstGate>> = {
  normal: { growthMb: 4096, windowMs: 3000, releaseMs: 1500, maxHoldMs: 30000 },
  gentle: { growthMb: 3072, windowMs: 3000, releaseMs: 2000, maxHoldMs: 30000 },
};
```

### A2. `src/guest/governor/decide.ts`

- Below `canPause`:

  ```ts
  /** What the memory gate in memgov may freeze (compilers, linkers, Unreal's shader workers); passed as --gate-names. */
  export const GATE_NAMES: readonly string[] = [...COMPILERS, 'shadercompileworker'].filter((n) => !NEVER.has(n)).sort();
  ```

- Add `readonly gateHeld?: number;` to `MemSample` with `/** Build programs the memory gate holds now (memgov). */`.

### A3. `src/guest/governor/core.ts`

- Imports: `z` from 'zod'; `BURST_GATE` and `type LoadProfile` from `../../shared/memory/index.js`; `GATE_NAMES` from
  `./decide.js`.
- `memgovArgs`:

  ```ts
  /** memgov.exe's arguments: samples every 2 s and the memory gate for this profile. */
  export function memgovArgs(profile: LoadProfile): string[] {
    const g = BURST_GATE[profile];
    return [
      'serve', '--interval', '2',
      '--gate', [g.growthMb, g.windowMs, g.releaseMs, g.maxHoldMs].join(':'),
      '--gate-names', GATE_NAMES.join(','),
    ];
  }
  ```

- `GateEventSchema`: `z.discriminatedUnion('kind', …)` of strict objects, each with `event: z.literal('gate')` and
  `at: z.number()`:
  - `ready`: `mode: z.enum(['notify','poll'])`, `growthMb: z.number().int().min(0)`, `windowMs: z.number().int().min(0)`
  - `off`: `reason: z.string().max(200)`
  - `trip`: `grewMb`, `ms`, `jobMb` (each `z.number().int().min(0)`), `held: z.array(z.strictObject({ pid:
    z.number().int(), name: z.string().max(128) })).max(64)`
  - `hold`: `pid`, `name` (max 128)
  - `release`: `pid`, `name`, `heldMs: z.number().int().min(0)`, `forced: z.boolean()`

  Export `type GateEvent = z.output<typeof GateEventSchema>`.
- `gateLine(e: GateEvent): string` (pure; names cut to 64 characters). Exact texts:
  - ready: `gate: on (<mode>): new compilers wait when the agents' programs grow by more than <growthMb> MB within <windowMs/1000> s`
  - off: `gate: off (<reason>): builds are only slowed down by the dial`
  - trip: `gate: the agents' programs grew <grewMb> MB in <(ms/1000).toFixed(1)> s (now <jobMb> MB); holding <held.length>: <first 8 as "name (pid)" joined ", "><" …" if more than 8>`
  - hold: `gate: <name> (<pid>) waits at start while a build burst goes through in turn`
  - release: `gate: <name> (<pid>) goes on after <(heldMs/1000).toFixed(1)> s<" (the longest it may wait)" if forced>`
- `GovernorSnapshot`: add `readonly held: number;`. In `onSample` set `held: sample.gateHeld ?? 0` in `this.latest`
  and in `status`.
- New method `onGate(event: GateEvent): void { this.note(gateLine(event)); }` (`note` writes `'governor: ' + text`
  and sets `lastAction`).

### A4. `src/shared/channel/schema.ts`

- `PressureStatusSchema`: add `held: z.number().int().min(0).max(1024).optional()` with
  `/** Build programs the memory gate holds right now (let go one at a time). */`.
- `HeartbeatSchema`: the same optional `held` field.

### A5. `src/guest/daemon/heartbeat.ts`

In `buildHeartbeat` add `...(snapshot && snapshot.held > 0 ? { held: Math.min(1024, snapshot.held) } : {})`.

### A6. `src/host/life/last-end.ts` (`heartbeatLine`)

After the step and hostStep part append `(hb.held ? ', ' + hb.held + ' builds held by the memory gate' : '')`.

### A7. `src/guest/governor/governor.ts`

- `SampleSchema`: add `gateHeld: z.number().int().min(0).max(1024).optional().catch(undefined)`.
- `MemGovProcess`: constructor `(private readonly args: readonly string[], private readonly onSample: (s: MemSample)
  => void, private readonly onGate: (e: GateEvent) => void)`; spawn with `[...this.args]`; line handler:
  `const raw: unknown = JSON.parse(line); if (typeof raw === 'object' && raw !== null && (raw as { event?: unknown
  }).event === 'gate') this.onGate(GateEventSchema.parse(raw)); else this.onSample(SampleSchema.parse(raw));`. The
  existing catch stays; its warn text becomes `'governor: bad line from memgov: '`.
- `Governor.start`: `new MemGovProcess(memgovArgs(profile), (s) => this.core?.onSample(s), (e) => this.core?.onGate(e))`.
- `describe()`: append `'; holds new compilers when memory grows faster than ' + BURST_GATE[profile].growthMb + ' MB
  in ' + BURST_GATE[profile].windowMs / 1000 + ' s'` to the profile text (not the off text).
- One sentence about the gate in the file header comment.

### A8. `sandbox/csharp/MemGov.cs`: the gate (all in this file)

**Header comment:** add `serve [--interval s] [--gate growthMb:windowMs:releaseMs:maxHoldMs --gate-names a,b,c]`, the
stdout event line format `{"event":"gate","kind":...}`, and the sample field `gateHeld`.

**Constants:** `JobObjectSetAttributes` 0x0002, `JobObjectAssociateCompletionPortInformation` 7,
`JobObjectNotificationLimitInformation` 12, `JobObjectLimitViolationInformation` 13, `JobObjectLimitJobMemory`
0x00000200, `JobMsgNewProcess` 6, `JobMsgExitProcess` 7, `JobMsgAbnormalExitProcess` 8, `JobMsgNotificationLimit` 11,
`GatePollMs` 100, `GateTickMs` 500, `GateRearmStepMb` 64, `ErrorAccessDenied` 5, `MaxTripList` 64; and
`static readonly IntPtr InvalidHandleValue = new IntPtr(-1)`.

**Structs (Sequential):**

- `CompletionPortLink { public IntPtr CompletionKey; public IntPtr CompletionPort; }`
- `NotificationLimit { public ulong IoReadBytesLimit; public ulong IoWriteBytesLimit; public long PerJobUserTimeLimit;
  public ulong JobMemoryLimit; public int RateControlTolerance; public int RateControlToleranceInterval; public uint
  LimitFlags; }` (48 bytes on x64)
- `LimitViolation { public uint LimitFlags; public uint ViolationLimitFlags; public ulong IoReadBytes; public ulong
  IoReadBytesLimit; public ulong IoWriteBytes; public ulong IoWriteBytesLimit; public long PerJobUserTime; public long
  PerJobUserTimeLimit; public ulong JobMemory; public ulong JobMemoryLimit; public int RateControlTolerance; public int
  RateControlToleranceLimit; }` (80 bytes)

**NativeMethods additions (kernel32, `SetLastError = true`):** `CreateIoCompletionPort(IntPtr file, IntPtr existing,
UIntPtr key, uint threads)`; `GetQueuedCompletionStatus(IntPtr port, out uint bytes, out UIntPtr key, out IntPtr
overlapped, uint ms)`; `SetInformationJobObject` overloads with `ref CompletionPortLink` and `ref NotificationLimit`
(`EntryPoint = "SetInformationJobObject"`); a `QueryInformationJobObject` overload with `ref LimitViolation info, int
length, IntPtr returnLength`.

**Helper classes (private sealed, fields only):** `GateSettings { int GrowthMb, WindowMs, ReleaseMs, MaxHoldMs;
HashSet<string> Names; }`, `Tracked { IntPtr Handle; string Name; DateTime Started; DateTime HeldAt; }`.

**State (static):** `GateSettings gate` (null = off), `Dictionary<int, Tracked> Young`, `Dictionary<int, Tracked>
GateHeld`, `List<KeyValuePair<DateTime,long>> window`, `DateTime lastTrip = DateTime.MinValue`, `DateTime lastRelease
= DateTime.MinValue`, `long armedMb = -1`, `HashSet<int> seenPids` (poll mode), `object OutLock`.

**Output:** `static void Emit(string json)` writes under `lock (OutLock)` with `Console.Out.WriteLine` and `Flush`;
the sample loop uses `Emit` too (two threads write stdout).

**Main:** parse `--gate` (split on `:`, 4 ints; `growthMb >= 64`, `windowMs` 500..60000, `releaseMs` 100..60000,
`maxHoldMs` 1000..MaxSuspendMs) and `--gate-names` (split on `,`, lowercase, non-empty, at most 64). `--gate` invalid:
emit off with reason `bad --gate`, no gate. `--gate` absent: nothing (no event at all). Valid: start background thread
`GateLoop` after `RecoverHeld`.

**Sample():** append `,"gateHeld":N` (N = `GateHeld.Count` under `lock (Gate)`).

**`Suspend(pid, ms)`:** add `if (GateHeld.ContainsKey(pid)) return;` inside the lock.

**`ResumeAll()`:** also `NtResumeProcess` every `GateHeld` handle, close them, clear `GateHeld`; close `Young` handles.

**`SaveHeld()`:** write `Paused.Keys` ∪ `GateHeld.Keys`.

**`GateLoop()`** (whole body in try/catch; on exception emit off with the message cut to 150 characters, return):

1. Open the job: loop while `!stop`: `h = OpenJobObjectW(JobObjectQuery | JobObjectSetAttributes, false, JobName())`;
   non-zero: break; last error 5: emit off `cannot open the agents' job (access denied)` and return; otherwise sleep
   500 ms and retry (the job does not exist until the first ptyhost).
2. Connect the port: `port = CreateIoCompletionPort(InvalidHandleValue, IntPtr.Zero, UIntPtr.Zero, 1)`; mode =
   "notify". `port == Zero`: mode = "poll". Else set the link {Zero, Zero} ignoring the result (removes a dead
   memgov's port), then the link {(IntPtr)1, port}; on failure close the port, mode = "poll".
3. Arm: `now = UtcNow`; `jobMb = JobCommitMb(h)`; `window = [(now, jobMb)]`. If notify and `!SetLimit(h, jobMb +
   GrowthMb)`: mode = "poll". In poll mode fill `seenPids` with the current job pids. Emit ready.
4. Main loop while `!stop`: notify: `GetQueuedCompletionStatus(port, out msg, out key, out ov, GatePollMs)`; if true,
   `pid = (int)ov.ToInt64()`: msg 6 → `OnBirth(pid)`; 7 or 8 → `OnExit(pid)`; 11 → `OnNotified(h, pid)`. Poll:
   `Thread.Sleep(GatePollMs)`. Every `GateTickMs`: `Tick(h, mode)`. Every pass: `ReleaseDue()`.
5. Finally: `SetLimit(h, 0)` (`LimitFlags = 0`); set the link {Zero, Zero}; close the port and `h`.

**`JobCommitMb(h)`:** sum of `PrivateUsage` (via `OpenProcess(ProcessQueryLimited)` + `GetProcessMemoryInfo`, as
`Entry` does) over `JobProcessIds()`, excluding `SelfId`, in MB.

**`SetLimit(h, mb)`:** a `NotificationLimit` with `LimitFlags = mb > 0 ? JobObjectLimitJobMemory : 0` and
`JobMemoryLimit = mb * BytesPerMb`; returns the bool; on success `armedMb = mb`.

**`OnBirth(pid)`:** `pid == SelfId`: return. Open with `ProcessQueryLimited | ProcessSuspendResume`; Zero: return.
`QueryFullProcessImageNameW` → lowercase file name without extension; not in `gate.Names`: close, return. Under
`lock (Gate)` add `Young[pid] = new Tracked{…, Started = UtcNow}` (exists: close the new handle, return). If
`BurstActive(UtcNow)`, `Hold(pid)`; on success emit hold.

**`OnExit(pid)`:** under `lock (Gate)` remove from `Young` and `GateHeld` and close the handles; if removed from
`GateHeld`, `SaveHeld()`.

**`OnNotified(h, pid)`:** query `LimitViolation` (class 13): this re-arms the notification and must be called even if
the next steps fail. `jobMb = (v.ViolationLimitFlags & JobObjectLimitJobMemory) != 0 ? v.JobMemory / BytesPerMb :
JobCommitMb(h)`. `Trip(h, pid, jobMb)`.

**`Tick(h, mode)`:** `now`; `jobMb = JobCommitMb(h)`; append `(now, jobMb)` to `window`, drop entries older than
`WindowMs`; `min`/`minAt` = the smallest value and when. Prune `Young` entries older than `WindowMs` (close handles).
Poll mode: `OnBirth` each job pid not in `seenPids`, then `seenPids` = current pids. If `jobMb - min >= GrowthMb`:
`Trip(h, 0, jobMb)` and return (software trip). Notify mode: `target = min + GrowthMb`; if `Math.Abs(target - armedMb)
>= GateRearmStepMb`, `SetLimit(h, target)`.

**`Trip(h, causePid, jobMb)`:** `now`; `grew = jobMb - min(window)`, `ms = now - minAt` (0 for both if `window` is
empty); `lastTrip = now`. Victims under the lock: every `Young` entry younger than `WindowMs`, oldest started first,
and `causePid` if non-zero and in `Young`; if `causePid` is not in `Young`, open it, read its name and include it if in
`gate.Names`. `Hold` each; collect those held. Emit trip with the held list (at most `MaxTripList`), even if empty.
Reset `window = [(now, jobMb)]`. Notify mode: `SetLimit(h, jobMb + GrowthMb)`.

**`BurstActive(now)`:** `(now - lastTrip).TotalMilliseconds < WindowMs`.

**`Hold(pid)`** (inside `lock (Gate)`): `Paused` or `GateHeld` has it: return false. Move the `Tracked` from `Young`;
`HeldAt = UtcNow`; `GateHeld[pid] = t`; `SaveHeld()`. `status = NtSuspendProcess(t.Handle)`; non-zero: remove, close,
`SaveHeld()`, return false. Return true.

**`ReleaseDue()`** (inside `lock (Gate)`; emit after leaving the lock): forced: every entry with `now - HeldAt >=
MaxHoldMs`. Paced: if `GateHeld.Count > 0`, `now - lastTrip >= ReleaseMs` and `now - lastRelease >= ReleaseMs`,
release the smallest `HeldAt` (ties: smallest pid), `lastRelease = now`. Release = `NtResumeProcess`, close the handle,
remove, `SaveHeld()`, emit release with pid, name, heldMs, forced.

**Event JSON:** `{"event":"gate","kind":"<kind>","at":<ms since 1970-01-01 UTC as long>, ...}`; names through the
existing `Json()`; numbers with `CultureInfo.InvariantCulture`; booleans lowercase.

### A9. Test fixture `src/selftest/fixtures/memory-burst/MemoryBurst.cs` (new, C# 5)

Usage `MemoryBurst.exe <totalMb> <progressFile>`. Until it has `totalMb`: `VirtualAlloc(IntPtr.Zero, 64 MB,
0x3000, 0x04)` (failure: `throw new Win32Exception(Marshal.GetLastWin32Error())`), write one byte every 4096 bytes
(`Marshal.WriteByte`), append `<epochMs> <mbSoFar>` to `progressFile`. Then append `done`, sleep 300 ms, exit 0.
Usage error: exit 2. Nested `NativeMethods` with `SetLastError = true`; named constants; Allman braces.

### A10. Unit tests in `src/selftest/heavy-load.test.ts`

Section `t.section('the memory gate (rate of growth)')`:

1. GATE_NAMES includes `cl`, `link`, `rustc`, `clang-cl`, `lld-link`, `shadercompileworker`; none of `node`, `claude`,
   `codex`, `opencode`, `cmd`, `pwsh`, `powershell`, `msbuild`, `dotnet`, `cargo`, `ninja`, `unrealbuildtool`,
   `ubahost`, `unrealeditor`, `unrealeditor-cmd`, `mspdbsrv`, `ptyhost`, `memgov`; every entry satisfies
   `canPause(n) || n === 'shadercompileworker'` and `!isNeverTouched(n)`.
2. `memgovArgs('normal')` deep-equals `['serve','--interval','2','--gate','4096:3000:1500:30000','--gate-names',
   GATE_NAMES.join(',')]`; gentle has `'3072:3000:2000:30000'`.
3. Both profiles: `growthMb >= 1024`, `maxHoldMs <= 30000`, `releaseMs < maxHoldMs`, `windowMs >= 1000`; and
   `BURST_GATE.gentle.growthMb <= BURST_GATE.normal.growthMb`.
4. `GateEventSchema` parses one valid example of each kind and rejects a 129-character name, a held list of 65,
   `kind: 'boom'` and a missing `event`.
5. A `GovernorCore` (fake port as in the existing test) fed `onGate` trip `{grewMb: 4210, ms: 1800, jobMb: 23456,
   held: [{pid: 101, name: 'cl'}]}` and release `{forced: true, heldMs: 30000}`: logs contain `governor: gate: the
   agents' programs grew 4210 MB in 1.8 s (now 23456 MB); holding 1: cl (101)`, a line ends with `(the longest it may
   wait)`, and `core.current` is unchanged (`step === 0`).
6. `onSample({...sample(60, 40, procs), gateHeld: 3})`: the saved status has `held === 3` and passes
   `PressureStatusSchema`; `core.snapshot?.held === 3`; `HeartbeatSchema` accepts a beat with `held: 3`;
   `heartbeatLine({...beat, held: 3})` contains `3 builds held by the memory gate`.
7. In the existing Windows part (`served = spawnSync(memgov, ['serve','--interval','1'] …)`) check that
   `served.stdout` has no line containing `"event":"gate"`: a test memgov never takes the real job's port.

### A11. Live test in `src/selftest/live-terminal.test.ts`

New section after the backstop section: `t.section('the memory gate: a burst is held at once and let go in turn')`.

1. Own job: `jobName = 'Local\\AgentSandboxAgentsJobTest' + process.pid + '-gate-' + Date.now()` (never the real job).
2. Compile `memgov.exe` from `sandbox/csharp/MemGov.cs` and `MemoryBurst.exe` from the fixture with `compile()` into
   `t.at(...)`; check both compile.
3. Start ptyhost A with the existing `holder` command (PING, `PTYHOST_BACKSTOP_MB: 'none'`, `PTYHOST_JOB_NAME:
   jobName`); wait until its log has `agent job:`.
4. Start memgov: `spawn(memgovExe, ['serve','--interval','1','--gate','512:3000:800:4000','--gate-names',
   'memoryburst'], { env: {...process.env, MEMGOV_JOB_NAME: jobName}, stdio: ['pipe','pipe','ignore'], windowsHide:
   true })`; collect stdout lines; parse `"event":"gate"` lines with `GateEventSchema` from `../guest/governor/core.js`.
5. Wait up to `WAIT.screen` for `kind: 'ready'`; check `mode === 'notify'` ("the gate listens to the job's
   notifications (no polling)").
6. Start ptyhost B on the same job with command `'"' + burstExe + '" 1536 "' + progress + '"'` (`progress =
   t.at('burst-progress.txt')`); wait up to 15000 ms for `done` in the progress file.
7. Checks: (a) at least one trip whose held list contains `memoryburst`, first trip `grewMb` between 512 and 1024 ("a
   burst past the gate is held at once"); (b) for each trip T and its hold's next release R, no progress line has a
   timestamp in `(T.at + 200, R.at)` ("the held program made no progress more than 200 ms after the trip until it was
   let go"); (c) every release has `heldMs <= 4500` and at least one has `forced === false` ("held programs go on in
   turn, never longer than the most allowed"); (d) `done` was reached and there were at least 2 trips.
8. Cleanup: `memgov.stdin.end()`; wait up to 5000 ms; check `exitCode === 0`; kill ptyhosts A and B (same try/catch
   pattern as the existing section).
9. Live sections may flake under load: do not loosen 200 ms; rerun once before treating a failure as real.

### A12. Schema description and generated files

Append to the `pressureResponse` description in `src/core/schema/sandbox.ts`: ` A memory gate also holds new
compilers and linkers for a moment when the build programs' memory grows faster than 4 GB in 3 seconds (3 GB with
vGPU), and lets them go one at a time.` Do not change `agentMemoryHeadroomMb`. `npm run build` regenerates
`schemas/config.schema.json`: commit it.

### A13. CLAUDE.md

No change (`governor/decide` and `governor/core` are already allowed test imports).

### Acceptance for A

- `npm run build` succeeds; `schemas/*.json` changed only in the `pressureResponse` description.
- `npm test -- heavy-load,live-terminal,layout,config,channel` prints `ALL TESTS PASSED`.
- `npm test` (full) prints `ALL TESTS PASSED`.
- `npm run lint` and `npm run format:check` pass.

## 5. Package B (Haiku): docs (after A is merged)

1. `docs/troubleshooting.md`, "The sandbox closes under heavy load": a row after "Governor in the sandbox":
   `Memory gate` — When the programs the agents started gain committed memory faster than 4 GB within 3 seconds (3 GB
   with vGPU), new compilers, linkers and Unreal shader workers are held the moment they start (Windows reports it
   instantly through the agents' job). They then go on one at a time, every 1.5 s (2 s with vGPU), oldest first, never
   longer than 30 s. Nothing is killed; agents, shells, build tools such as UnrealBuildTool, MSBuild and cargo, and the
   editor are never held. It does not wait for your PC to run low: a burst itself is what it smooths. It logs
   `governor: gate:` lines and `held` in `run\pressure.json`; the crash report says "N builds held by the memory gate"
   — on (`sandbox.pressureResponse`). Replace the "Last-resort backstop" text with: Everything the agents start shares
   one Windows job object, with one hard limit just below the sandbox's commit limit (`sandbox.agentMemoryHeadroomMb`).
   The memory gate and the governor act long before it; it only matters when Windows inside the sandbox is about to
   refuse memory to everyone: then a build is refused instead. After the table: "A crash of the sandbox itself
   (vmwp.exe on your PC) has also been seen right after a large build burst with plenty of memory free; the memory
   gate makes such bursts gradual."
2. `docs/configuration.md`, `sandbox.pressureResponse`: "slow the heaviest builds down when memory runs low (the
   governor), and hold new compilers for a moment when memory grows very fast (the memory gate)".
3. CHANGELOG.md and version: untouched (the coordinator releases).

## 6. Risks

- **Freezing a lock holder.** At birth the process holds nothing; at a trip only young (< 3 s) build programs are
  frozen. Every hold is time-bounded and agents, coordinators and `mspdbsrv` are never frozen: delay, never deadlock.
- **UBA/UBT detours.** UbaHost and UnrealBuildTool are never frozen; detoured `cl.exe` are real processes in the job
  (nested jobs report to our port). UBT already caps parallel compiles (1.27.4).
- **ptyhost's tree record and `--end-tree`.** A frozen process can still be ended; EXIT_PROCESS drops it from
  `GateHeld`; a missed EXIT only resumes a dead handle at the forced release.
- **memgov restart while holding.** `HeldFile` has the pids; the next memgov resumes them first (`RecoverHeld`) and
  re-takes the port.
- **Governor and gate fighting.** One process, one lock, disjoint ledgers; the gate never changes priorities.
- **No notification limits / association refused.** Poll mode; access denied: off (today's behaviour).
- **Notification flood.** Re-armed only by the query after acting.
- **Slower builds.** Only during bursts faster than about 1.4 GB/s; a held build continues within 30 s at worst.
- **Self-test touching the real job.** The gate starts only with `--gate`; tests pass it only with a `…JobTest…`
  `MEMGOV_JOB_NAME`, and a check enforces that a plain `serve` emits no gate events.

## 7. Open questions and the answers chosen

- A setting for the gate? No: it rides `sandbox.pressureResponse` (yours only).
- Should the host watchdog lower the gate? No: the gate is about rate, and the PC was not short of memory.
- Lower the hard backstop? No (see §3).
- Freeze UnrealEditor-Cmd? No (its ShaderCompileWorkers are gated).
- FIFO or smallest first? FIFO.
- Freeze the process that caused the notification even if old? Yes, if its name is in `GATE_NAMES`.
- Show "builds held" in the menu and web? Not now: they do not read `pressure.json` today (`readPressure()` has no
  callers). A later `src/app` feature.
