# Parallel boot (plan, 2026-11-03)

Baseline: master 1.21.0. Written by the planning agent from measured boot timings. Owner's words: "make parts of the
1-9 setup on sandbox start and bootstrap parallel; execute required ones first"; "Downloads and installs need to work
parallel".

## 0. Where the time goes (measured, boot of 2026-11-03 00:52)

| Time | Event | Took |
| --- | --- | --- |
| 00:52:56.7 | main.js starts | |
| 00:52:58 -> 00:53:01 | steps 1-2 (firewall, personalize.reg, set-desktop.ps1, browser GPU) | ~4.5 s |
| 00:53:01 -> 00:53:08 | every non-VS toolchain | ~7 s |
| 00:53:04 -> 00:58:21 | **Visual Studio** (layout attempt + full install + WebView2) | **5m17s** |
| 00:58:24 -> 00:58:35 | Unreal step (DirectX redist + DXSETUP, shortcuts) | ~11 s |
| 00:58:35 -> 00:58:40 | set-machine-environment.ps1 (3 s), install-shell-path.ps1 (2 s) | ~5 s |
| 00:58:40 | git config | ~1 s |
| 00:58:43 -> 00:59:11 | step 6: robocopy claude-mem, then **Headroom spawn -> port wait** | **~28 s** |
| 00:59:11 -> 00:59:14 | link-profile-dirs.ps1, agent check | ~3 s |
| 00:59:14 -> 00:59:17 | daemon, wt.exe, ptyhost, claude.exe | ~3 s |
| **Total** | | **6m21s** |

Estimated "agent ready": VS boots 6-8 min -> ~35-40 s (VS finishes in the background); normal boot with Headroom
~47 s -> ~30-32 s; without Headroom 24-38 s -> 17-25 s; first boots / many downloads: another 20-40 % (downloads
overlap installs and each other, totals capped).

Most boot actions are synchronous (`spawnSync`, `exec`, `runScript`): running them "in parallel" gains nothing until
they are async. Real overlap only comes from tasks that await work (toolchains, Headroom, downloads, agent install,
VPN). Only the slow sync calls on the critical path are converted to async (step 16).

## 1. Dependency graph

**Prelude (strictly sequential, not tasks; it changes `process.env`, so it finishes before anything spawns):** workspace
check, mkdir tools/run -> `takeSecrets` (keep an immutable `const secrets` snapshot) -> `serviceAccounts` ->
`applyBootEnvironment` -> `prepareGithubFolder` -> `installPools()` (new, section 2).

Notation: id (stage) [C] critical / [S] soft / [B] background; after: dependencies; why. Critical = failure stops the
boot (today's non-`soft` calls). Soft = today's `soft()`.

**Stage 1 - network and session host**
- `ptyhost` (1) [S]: no deps (csc compile).
- `network` (1) [S]: after `ptyhost` (the firewall attach rule needs the ptyhost exe). Before any download.
- `audit` (1) [S]: no deps. Before `session` (the daemon reads events from its own start).
- `headroomSpawn` (6) [S]: after `network`, only when Headroom is already installed (app marker present and
  `!refresh`); otherwise it is spawned after the Apps step (3.10). Env gets `proxyEnv()` (pure). Headroom makes no
  traffic until Claude calls it, so starting before VPN/allowOnly is safe. Never while Apps may replace its folder.

**Stage 2 - pre-provision hooks and desktop**
- `hooksPreProvision` (2) [C]: after `network`. stdio inherit.
- `desktop` (2) [S]: no deps; before `session`.
- `browserGpu` (2) [S]: no deps; before `session` (Playwright MCP starts Edge).
- `claudeProfile` (6) [S]: no deps (local files; reads `secrets.claudeCredentials`).
- `claudeMem` (6) [S]: no deps (local robocopy).
- `agentState` (6) [S]: no deps; ONE task in this order: `resetMachineBound` -> `codexBootConfig` ->
  `restoreLocalState` (all three touch codex state).
- `profileLinks` (7) [C] (not soft today; keep): no deps; before agent install and daemon.

**Stage 3 - developer tools**
- `toolchains` (3) [C at task level; steps stay soft inside the scheduler]: after `network`, `hooksPreProvision`.
  Foreground toolchain steps only (3.8).
- `dbCommands` (3) [C]: no deps; writes `localDir\bin`, returns one prepend entry.
- `allowOnly` (3) [S]: after `toolchains` (its firewall refuses downloads: every foreground download must be done).
- `vscode` (3) [S]: after `toolchains`, `allowOnly` (today's order); reads `tools.vars`, returns summary lines.
- `env` (3) [C]: after `toolchains`, `dbCommands`, `allowOnly`: `agentEnv` + `persistEnvironment` +
  `installShellPath`. PATH final before the agent.
- `bootEnv` (3) [S]: after `env`, `vscode`: `saveBootEnv`, `saveProjectStatus`, print the summary.

**Stage 4 - VPN**
- `vpn` (4) [S]: after `toolchains`, `allowOnly`, `ptyhost`. The kill switch must not cut running downloads; it must
  be up before git, the GitHub login and the agent use the network.

**Stage 5 - git**
- `gitConfig` (5) [S]: after `env` (git on PATH); local only, may overlap `vpn`.
- `githubLogin` (5) [S]: after `vpn`, `gitConfig`.

**Stage 6 - Claude settings**
- `mcpServers` (6) [S]: after `toolchains`, `claudeProfile` (Apps paths; same `.claude.json`).
- `headroomReady` (6) [S]: after `headroomSpawn` (if that was skipped, this task spawns it after `toolchains`);
  returns the URL or null.
- `managedSettings` (6) [S]: after `headroomReady`, `toolchains`.
- `guide` (6) [S]: after `bootEnv`, `managedSettings`, `mcpServers`, `network`, `vscode`. Last of the files the agent
  reads.

**Stage 7 - agent**
- `agentProvision` (7) [C]: after `env`, `vpn`, `profileLinks`.

**Stage 8 - pre-agent hooks**
- `hooksPreAgent` (8) [C], `exclusive: true`: after every foreground task (user contract; stdio inherit).

**Stage 9 - start**
- `session` (9) [C]: after `hooksPreAgent`: status `ready`, start the daemon (`secrets.harnessEnvironment`,
  `liveFoldersKey` from the snapshot), request file, `waitForPrimary`, then `viewSession`.

**Background** (gate: after `session` started the daemon and the first session runs):
- `toolchainsLater` [B]: the deferred toolchain steps (Visual Studio, and whatever depends on it: Unreal, Rust only with
  an msvc host). Then re-merge env in plan order, re-run `persistEnvironment` (additive), `saveBootEnv`,
  `saveProjectStatus`, `writeGuides`.
- `prune` [B]: `pruneToolLeftovers`.

Deferral is OFF (today's behaviour, VS foreground) when: `session.vpn` is set (kill switch would cut VS), 
`network.allowOnly` is set (proxy refuses Microsoft hosts), dry-run, or `duringSession()` (daemon runs the plan for
projects that join later).

Critical path (no VS): `network` -> `hooksPreProvision` -> `toolchains` (~7 s) -> `allowOnly` -> `env` (~5 s) ->
`gitConfig`/`vpn` -> `agentProvision` (~3 s) -> `hooksPreAgent` -> `session` (~3 s). In parallel: `headroomSpawn`
at t~2 s -> `headroomReady` t~30 s -> `managedSettings` -> `guide`. Headroom stays the critical path (~30-32 s).

## 2. Execution model

**Runner: new pure file `src/guest/boot/runner.ts`** (no runtime imports; inject `say`, `warn`, `status`, `now`,
dry-run). Add to `PURE_GUEST` in `src/selftest/layout.test.ts` and to the guest import list in CLAUDE.md.

```ts
export interface BootTaskDef<Id extends string = string> {
  readonly id: Id; readonly stage: number; readonly title: string;
  readonly after: readonly Id[];
  readonly critical: boolean;          // failure stops dependants and fails the boot
  readonly background?: boolean;       // only after the gate; logs to the file only
  readonly exclusive?: boolean;        // runs alone (stdio-inherit hooks)
}
export type TaskRun = () => Promise<void> | void;
export interface TaskOutcome { id: string; state: 'done' | 'failed' | 'skipped'; ms: number; error?: string }
export class BootRunner<Id extends string> {
  constructor(defs: readonly BootTaskDef<Id>[], impl: Readonly<Record<Id, TaskRun>>, o: RunnerOptions);
  run(which: 'foreground' | 'background'): Promise<TaskOutcome[]>;   // rejects with the first critical error
}
```

Rules: constructor checks (no duplicate ids, every `after` exists, no cycles via Kahn, no foreground task depends on a
background one: throw). `parallel` = `dryRun ? 1 : 4`. Ready tasks start in declaration order (deterministic; with
parallel 1 it equals a topological order that keeps today's 1-9 order). Exclusive tasks wait until nothing runs and
block new starts. Soft failure: `warn(title + ' failed (continuing): ' + msg)` (today's text); dependants still run
(`after` is ordering only for soft tasks, as today). Critical failure: dependants `skipped` (`X skipped: Y failed`),
running/independent tasks finish (nothing killed), then `run()` rejects with the first critical error (main.ts writes
`failed` as today). Delete `soft()` and `step()` from boot.ts.

**Shared state, single writer:** `BootState` in boot.ts (`ptyHost`, `lan`, `tools`, `dbBin`, `env`, `headroom`,
`later`), each field written by exactly one task; readers list the writer in `after` (directly or transitively). The
graph table declares `writes` and `reads`; the graph test checks it. Tasks never push into `tools.summary`:
`allowOnly` and `vscode` return their lines; `bootEnv` merges in declaration order (toolchain summary, then
`networkProblems()` lines, then allowOnly, then vscode). `secrets` is a frozen snapshot (no re-assignment of
`this.secrets`).

**Pools: new pure `src/shared/concurrency/limiter.ts` (+ `index.ts`):** `Limiter(n)` with `run(work)`, FIFO, two
priorities (foreground before background). It tracks the held slot with `AsyncLocalStorage`; acquiring a second pool
while holding one throws ("nested pool") so deadlock is impossible: acquire at the leaf, one pool at a time.

**Guest pools `src/guest/runtime/pools.ts`:** `installPools()` (called in the Boot prelude and in the daemon entry):

| Pool | Size | Guards |
| --- | --- | --- |
| `net` | 4 | HTTP bodies (`downloader.limit`; host code keeps `null`) |
| `heavy` | 2 | `extractArchive`, 7-Zip/NSIS unpack, npm ci/install, uv venv/pip, Steam `/S`, VS layout robocopy, rustup/cargo installs |
| `installer` | 1 | every `msiexec` (/i and /a), vcredist, DXSETUP, the VS bootstrapper (layout and install) |

`runInstaller(file, args, opts)` wraps the spawn in `installer.run` and retries on exit 1618 (another process holds
`Global\_MSIExecute`) up to 20 times with 15 s waits; pure `installerRetry(code, attempt)`. Background work enqueues at
low priority and starts after the gate. The background VS bootstrapper gets `os.setPriority(pid,
PRIORITY_BELOW_NORMAL)` (children inherit it).

**Progress:** see "Console output" below (superseded the first version's interleaved `[n/9] Task: started` lines and
`Task title | ` prefixes). Background completion writes a file-only line `Background done in 5m31s: ...`.

**Log file:** every file line gets an ISO timestamp. Background tasks run `quiet: true` (file only: once
`viewSession` owns the console nothing else may print); their warnings go to the file and into status
`background[].state = 'failed'`.

### Console output

What the sandbox's terminal shows while it starts: the first thing the user sees.

```
Agent sandbox · mw2-agent · claude · C:\Projects\AgentProjects\mw2-agent

  ✓ 1  Network and session host                   8.5s
  ✓ 2  Pre-provision hooks and desktop            8.5s
  ⠴ 3  Developer tools                           13.3s  Visual C++ runtime, Apps (9/13)
  · 4  VPN (off)                                        waiting
  · 5  Git identity                                     waiting
  ⠴ 6  Claude settings, history and claude-mem   13.3s  Headroom start
  ⠴ 7  Agent: claude                             10.7s  Agent logins
  · 8  Pre-agent hooks                                  waiting
  · 9  Starting claude                                  waiting

  ! gh: the GitHub login from an earlier sandbox was kept in Windows Credential Manager, which is…
```

- **One header line**, then (a terminal) a fixed block of nine stage rows that redraws in place ten times a second:
  mark, number, short stage name (`stageName`), elapsed time, and on a running row the tasks that run now (the
  toolchain row names the scheduler's active steps and `done/total`). Marks: spinner running, `✓` done, `!` a soft
  task failed, `✗` a critical one failed, `-` skipped, `·` waiting. Rows are cut to the terminal's width (never
  wrapped, so the redraw can move up over them). Windows Terminal (`WT_SESSION`) gets braille and check marks; the
  classic console (Consolas) gets `- \ | /`, `√` and `x`. ANSI only; Node's console writer handles VT on both.
- **Warnings** are collected (deduplicated) and shown under the block, one line each (the last four); in full once at
  the end, yellow, without task prefixes.
- **Info lines** of the modules (`log()`) go to the file only while the block is live. Programs the boot starts
  (`exec`, `execAsync`, `runScript*`) hand their output to the log instead of writing over the block or between the
  plain stages, and still after the release (the background steps must not write into the session; `routeOutput` in
  `runtime/process.ts`). The hooks keep the terminal (`aside()`: the block steps aside, the hook prints, the block
  comes back below it).
- **At the end**, before `viewSession` takes the console: the block once more as a still list, `Warnings`, `Tools`
  (the summary as aligned name/detail columns, wrapped under the detail column), notices (`notice()`: "If Claude asks
  you to sign in ..."), then `Ready in 46.8s (slowest: Headroom proxy 24.6s, ...)`, `Still installing in the
  background: Visual Studio, Unreal, Rust (a few minutes; it does not hold you up)` when work is deferred, and the log
  path. The view then lets go of the console (`release`); nothing of it prints again. A failed boot releases it too
  (the stages so far and the warnings), then main.ts prints the error.
- **Not a terminal** (logs, CI, the dry run): plain lines without colours, in stage order. A stage is buffered and
  printed once it and every stage before it have finished: `[3/9] Developer tools  13.6s`, then its info lines
  indented under it (critical failures and skips as `x ... failed: ...` / `- ... skipped (...)`), so overlapping tasks
  never interleave. No per-task lines. Then the same Warnings / Tools / Ready sections.
- **The log file** keeps every line in time order: `2026-11-04T12:07:44.388Z [Developer tools] Installing ...`
  (UTC, zero-padded; colours stripped; one timestamp per line of a multi-line message), plus the runner's per-task
  `[3/9] Developer tools: started` / `done in 13.5s` trace lines and `[background] ...` for the background tasks.

Code: `boot/progress-view.ts` (pure: the model, the plain renderer, the live frame, the final report; tested by text
snapshots in the `boot-console` suite), `boot/boot-console.ts` (the thin terminal side: picks the mode, routes
`log()`/`warn()`/`notice()` and program output to the view, the redraw timer), `runtime/log-line.ts` (pure file
line format). The runner only emits events (`RunnerObserver`: started / finished) and file-only `trace` lines.

**Status file `run\sandbox.json`:** the runner is the only writer during boot. `progress.step` = lowest stage with an
unfinished foreground task; `active` = running task titles + the scheduler's active steps (new `RunOptions.progress`
callback instead of the scheduler calling `setSandboxStatus`). `phase`: `booting` until stage 1 done, then
`provisioning`, `ready` when `session` starts. New optional `background: { name: Text(64), state:
'running'|'done'|'failed' }[] (max 16)` on `SandboxStatusSchema` (`.optional().catch(undefined)`); host may show "VS
installing in background".

**Dry run:** same graph, parallel 1; background tasks run in place right after `session` (awaited), so `guest-boot`
string checks still pass.

## 3. File-level changes, in order

1. `src/shared/concurrency/limiter.ts` + `index.ts` (new).
2. `src/shared/download/downloader.ts`: `limit: Limiter | null = null`; wrap only `fetchRetry` + `pipeline` in
   `this.limit?.run(...) ?? ...`; `verify` (signature check) and the rename stay outside the slot. `archive()` calls
   `file()` then `extractArchive` in sequence (not nested).
3. `src/shared/download/archive.ts`: module `let extractLimit: Limiter | null` + exported `limitExtraction(l)`; wrap
   the body of `extractArchive`.
4. `src/guest/runtime/pools.ts` (new): `installPools()`, `heavy`, `installer`, `runInstaller`, `installerRetry`,
   `belowNormal(pid)`.
5. Call sites onto the pools: `runInstaller` in `toolchains/native/vcruntime.ts`, `toolchains/native/unreal.ts`
   (redist `/Q /T:`, `DXSETUP /silent`), `toolchains/native/visual-studio.ts` (layout and install spawns),
   `toolchains/native/msvc/packages.ts` (`msiexec /a`), `apps/unpack.ts` (`msiexec /a`), `vpn/openvpn.ts`,
   `vpn/wireguard.ts`; `heavy` in `visual-studio.ts` (robocopy), `apps/unpack.ts` (7-Zip/NSIS),
   `apps/app-installer.ts` (`installLocked` npm ci/uv and npm install), `toolchains/steam/client.ts`,
   `agents/agent-installer.ts` (npm, `uv tool install`), Rust's rustup/cargo spawns. Download first (net pool via
   `signedInstaller`), then take the installer lock, so one toolchain's download overlaps another's install.
6. `src/guest/toolchains/step.ts`: `fetch?(): Promise<void>` (download only; no-op when present) and `background?:
   boolean` on `ToolchainStep`; `deferHeavy?: boolean` on `ToolchainOptions` (true only at boot with no VPN, no
   allowOnly, not dry-run).
7. `src/guest/toolchains/scheduler.ts`: at `run()` start, fire every enabled step's `fetch()` at once, outside step
   slots and `after` (only the net pool limits them; failures swallowed with a comment: install downloads again);
   keep `PARALLEL = 4`; `RunOptions.progress?({active, done, total})` (when given, no `setSandboxStatus`);
   `onDone?(name)` so boot can start Headroom when "Apps" finishes.
8. `src/guest/toolchains/plan.ts`: Visual Studio `background: o.deferHeavy === true`. Rust `after: rustHost(config)
   === 'msvc' ? ['C/C++','MSVC','Visual Studio','Unreal'] : ['C/C++']` (gnu Rust no longer waits for VS). Add `fetch`
   where a helper exists: VS bootstrapper, Unreal's DirectX redist, PHP zip, Kotlin zip, Android cmdline-tools,
   rustup-init. Apps: `AppInstaller.prefetch(entries)` for non-locked, non-npm entries without a marker (resolve +
   `downloader.file` into the staging path `download()` reuses).
9. `src/guest/toolchains/setup.ts`: `setupToolchains(..., { gate?: Promise<void> })`; background is transitive (a
   step whose `after` has a background step is background); returns `ToolchainResult & { later:
   Promise<ToolchainResult> | null }`; `later` runs background steps after `gate` and merges only those, in plan
   order. Daemon calls pass no gate (today's behaviour).
10. `src/guest/setup/headroom.ts`: split into `spawnHeadroom(env): boolean` and `awaitHeadroom(env): Promise<string |
    null>` (same messages). Early spawn only with the Headroom app marker and `!session.provisioning.refresh`;
    otherwise from `onDone('Apps')`. Early env: `agentEnv({ vars: { ...session.toolchains.environment, ...proxyEnv()
    }, prepend: [], append: [] })`; keep the `ANTHROPIC_BASE_URL` check.
11. `src/guest/boot/graph.ts` (new, pure): `STAGE_TITLES` (today's 9 titles; stage 4 `VPN (server)` / `VPN (off)`),
    `BOOT_TASKS` (section 1) `as const satisfies readonly (BootTaskDef & { writes; reads })[]`, `type BootTaskId`. Add
    to `PURE_GUEST`.
12. `src/guest/boot/boot.ts`: keep the prelude; methods become task functions in `const impl = {...} satisfies
    Record<BootTaskId, TaskRun>`; `run()`: `await new BootRunner(BOOT_TASKS, impl, opts).run('foreground')`, summary,
    then (not dry-run) `const bg = runner.run('background')`, `viewSession`, `await bg`; with `autoSession === false`
    or no TTY await `bg` before exiting. `writeDbCommand` returns the dir; `env` uses `[...tools.prepend, dbBin]`
    (today's order). Background completion: `persistEnvironment` (additive), `saveBootEnv`, `saveProjectStatus`,
    `writeGuides`, status `background` entry.
13. `src/guest/runtime/log.ts`: file timestamps, task context (prefix, quiet), `withLogContext(ctx, fn)`.
14. `src/guest/runtime/status.ts` + `src/shared/channel/schema.ts`: `background` field; runner merges the scheduler's
    `active`. `npm run build` regenerates `schemas/*.json` (commit them).
15. `sandbox/scripts/set-machine-environment.ps1`: wrap the HKLM `Path`/variables read-modify-write in a named mutex
    `Global\AgentSandboxMachineEnv` (WaitOne 60 s, ReleaseMutex in `finally`): the background re-persist and the
    daemon both call it.
16. Make the slow sync calls on the critical path async: `persistEnvironment`, `installShellPath` (~5 s; add
    `runScriptWithJsonAsync` / `runScriptAsync` to `runtime/process.ts`) and `linkProfileDirs`.
17. Docs and CLAUDE.md: docs/configuration.md (hooks keep their contract; Visual Studio installs in the background
    unless a VPN or allowOnly is on); CLAUDE.md pure-guest import list + a Recipes line: "Boot actions are tasks in
    `boot/graph.ts`; acquire pools at the leaf, one at a time".

**Stays sequential:** the prelude; `hooksPreProvision` before toolchains; `allowOnly` after all foreground downloads;
`vpn` before git/gh/agent traffic; `claudeProfile` before `mcpServers`; `headroomReady` -> `managedSettings` ->
`guide`; `hooksPreAgent` exclusive, then `session`; the three codex/local-state calls in one task.

## 4. Tests

New suite `src/selftest/boot-runner.test.ts` (registered in `src/selftest/index.ts`; deferred promises, fake tasks,
no machine state):
- ordering respects every `after`; with parallel 1 the order equals declaration-order topological sort;
- 6 independent tasks with parallel 2 never exceed 2 running; `exclusive` runs alone;
- `Limiter(2)` peaks at 2; foreground queued after background still goes first; nested acquire throws "nested pool";
- soft failure: `failed (continuing)` warning, siblings and dependants run, outcome `failed`;
- critical failure: dependants `skipped`, an independent long task completes, `run()` rejects;
- background: nothing starts before `run('background')`; quiet context set;
- constructor throws on a cycle, unknown dependency, duplicate id, foreground-depends-on-background;
- `installerRetry(1618, n)` retries up to the limit; 0 / 1603 do not;
- timing: 3 independent 100 ms tasks with parallel 3 finish < 250 ms; 3 on `Limiter(1)` take >= 300 ms.

Graph checks on `BOOT_TASKS`: acyclic, deps exist; `session` depends transitively on every foreground task;
`hooksPreAgent` exclusive; required orderings (transitive): `network` < `toolchains`; `toolchains` < `allowOnly` <
`env`; `vpn` < `githubLogin`, `agentProvision`; `gitConfig` < `githubLogin`; `headroomReady` < `managedSettings` <
`guide`; `bootEnv` < `guide`; `claudeProfile` < `mcpServers`; `audit` < `session`; `profileLinks` <
`agentProvision`; single-writer (`reads` have their writer among transitive deps).

Scheduler: `fetch` starts before the step's `after` deps finish; background steps (and dependants) excluded from the
foreground result and start only after the gate; merged PATH order equals plan order whichever step finishes first.

Existing suites must pass: `guest-boot` (add checks: `[1/9]` .. `[9/9]` in order, `Boot ready in`), `layout`, `channel`
(status with and without `background`); then `npm run build`, `npm test` (ALL TESTS PASSED), `npm run lint`,
`npm run format:check`.

## 5. Risks

- PATH/env races: all env merging in one task (`env`) from parts returned in plan order; background re-persist is
  additive under the script mutex; only VS/Unreal (summary only) and msvc-host Rust are deferred.
- `process.env` mutated only in the prelude.
- Registry: tasks write different keys; the shared Environment key has the mutex.
- MSI collisions: one in-process installer lock + 1618 retry across processes and with VS's own msiexec.
- Machine overload (the earlier crashes): caps net 4, heavy 2, installer 1, 4 steps (replaces today's unbounded 4
  steps x 3 apps); VS at BELOW_NORMAL after the agent starts; the governor still applies.
- Windows Terminal / Explorer: `desktop`, `browserGpu` before `session`; `wt.exe` only from the daemon in `session`.
- Mapped-folder writes: downloads keep `.part` + rename-after-remove; the guide rewrite has a tiny partial-read window
  after session start (acceptable); Headroom early spawn only when Apps won't replace it.
- Logs: one `appendFileSync` per line; task prefix while overlapping; timestamps; background file-only.
- allowOnly/VPN: deferral off; both wait for every foreground download.
- A project joining while VS installs: improve the daemon's refusal: "Visual Studio is still installing in the
  background; it is ready in a few minutes" when status `background` lists it running.
- Boot failure: running tasks finish before `run()` rejects; background never starts unless `session` succeeded.
- Deadlock: one pool per async context (throws), leaf-only pools, cycle checks.

Note (1.20.1): the Visual Studio layout is now built on C: before the install and copied to the data disk, so from the
second boot VS installs offline; the background install above still applies to the first boot and to offline installs.
