# Work plan, November 2026 (for docs/design/work-plan-2026-11.md)

Baseline: master `cda7d6e` (1.18.2). Resume points: FiveM `worktree-agent-acf9f090247dce693` @ `9b14bd9`, Perplexity `worktree-agent-a020c7d9063eecb26` @ `867a4ab`. Both WIP commits sit on `b9abdd2`, which is 9 commits behind master: they are missing Steam P2 and the 1.18.x key fix.

Everything below comes from reading the code and logs. Items marked **[PC]** can only be checked on a real PC. The owner should run `sandbox logs --crash` on the PC and paste the output, so the crash cause in Stream 0 can be confirmed.

## 0. Rules for every agent (read with CLAUDE.md)

- **Branches.** One worktree per stream, branched from master `cda7d6e`. The two resume streams (S5a, S5b) start from their WIP commit and merge master in first (§S5).
- **Generated files.** Never hand-merge `schemas/*.json`. Re-run `npm run build` and commit the result.
- **Shared files.** These are edited by several streams: `src/core/config/defaults.ts`, `config.example.json`, `CHANGELOG.md`, `docs/configuration.md`, `src/selftest/index.ts`, `src/app/features/defs.ts`, `src/app/registry.ts`, `src/cli/menu/views.ts`, `src/app/features/settings/categories.def.ts`.
  - Only **add** lines or keys in them; never reorder or reformat existing content.
  - Each stream lists exactly what it adds.
  - CHANGELOG entries go under `## Unreleased`, one bullet per stream, appended at the end of that list.
- **Done means:**
  - `npm run build`
  - `npm test` prints `ALL TESTS PASSED`; run once more if a live suite flakes
  - `npm run lint` and `npm run format:check` pass
  - `npm test app` shows no parity gaps
  - docs are updated
  - `config.example.json` equals `DEFAULTS`
- **No version bump inside streams.** Integration bumps it (§I).
- **Every new operation or view is on every surface.** It goes in `defs.ts` (OPERATIONS/QUERIES/VIEWS), `registry.ts` (IMPLEMENTATIONS), a view's `operations`, `MENU_VIEWS` and, if it is a new area, `NAV`.
- **No menu or web text may tell the user to run a command** (rule B4, §S4). Use an action. CLI-only text uses `only: 'cli'` notes or `Empty.cliText`.

---

## Master checklist (nothing dropped)

| #      | Item                                                                                                     | Stream                                          | Round                                         |
| ------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------- |
| 0.1    | Crash root cause: disk-queue watchdog too weak, no I/O priority, linkers, build output on mapped folders | S0                                              | 1                                             |
| 0.2    | Guest heartbeat + "why the last sandbox ended" on status/menu/web                                        | S0                                              | 1                                             |
| 0.3    | VS layout exit 3762504530 (= 0xE0434352, an unhandled .NET exception in the VS installer)                | S2                                              | 1                                             |
| A-key  | One shared Anthropic key pattern (`sk-ant-api\d{2}-` and `sk-ant-usr\d{2}-`)                             | S1                                              | 1                                             |
| B1     | C++/VS/MSVC persistence; Unity stub hidden                                                               | S2                                              | 1 (Unity itself R2)                           |
| B2     | Codex still uses its inner sandbox; Codex settings on every surface                                      | S1                                              | 1                                             |
| B3     | NordVPN fails (AUTH_FAILED); diagnostics in the UI                                                       | S3                                              | 1                                             |
| B4     | Menu/web text that names commands → real actions; error `action`; self-test                              | S4                                              | 1                                             |
| B5     | Consistent pattern for Accounts/Apps/Toolchains/Settings/GitHub/VPN                                      | S4 (spec + Accounts/GitHub/VPN pages), U (rest) | 1 / 3                                         |
| AC     | Agent commands: review, fixes, menu/web toggle, drop "Beta"                                              | S3                                              | 1                                             |
| A-P5   | FiveM/RedM: rebase, finish `cfx` import `--from server.cfg`, tests, docs                                 | S5a                                             | 1                                             |
| A-P8   | Perplexity/computer use: rebase, finish, verify                                                          | S5b                                             | 1                                             |
| A-env  | Claude environment-variables editor (incl. max subagents), menu + web                                    | S1                                              | 1                                             |
| GH     | GitHub token: pre-filled creation link, verify after save, expiry warning, GitHub card on Accounts       | S4                                              | 1                                             |
| MC     | Menu-coverage audit + enforcement test                                                                   | S4                                              | 1                                             |
| C-stub | No user-facing "not available yet"                                                                       | S2 (hide)                                       | 1                                             |
| C-dup  | Duplicated helpers (freeBytes, signer, readBounded)                                                      | S2 (freeBytes, signer) + R2-C                   | 1 / 2                                         |
| C-dead | Dead exports/files                                                                                       | R2-C                                            | 2                                             |
| P3     | Unreal engines, Godot, game-dev apps                                                                     | R2-P3                                           | 2                                             |
| P4     | Unity                                                                                                    | R2-P4                                           | 2                                             |
| P6     | Android/Kotlin/MAUI/signing                                                                              | R2-P6                                           | 2                                             |
| P7     | Flutter/Dart/RN/iOS cloud                                                                                | R2-P7                                           | 2 (after P6 merges, or against its interface) |
| U      | UI/UX simplification + wording pass + glossary + banned-terms test + text snapshots + web clean-up       | Round 3 U1-U5                                   | 3 (last)                                      |

---

## ROUND 1 (parallel; merge order in §I)

### S0. Crash root cause and build I/O (owner: sonnet; highest priority)

**Evidence**

- Session mw2-agent, booted 20:45; logs stop at 21:31-21:32 and the whole VM died.
- The guest was not out of memory: RAM 9.3/31.7 GB, commit 14.1/48.1 GB.
- About 210 processes, with many rustc and `ld` at 1.6-1.7 GB each.
- 21:15:01 `governor: this PC is low (this PC's disks have had a queue of 18 for 30 seconds); builds to step 2`, and nothing stronger followed.
- The same boot ran the 5-8 GB Visual Studio download and install, because the layout failed (S2).

**Most likely cause:** the host's disks were saturated by build output and VS payloads written through mapped folders.

**What the code does now**

- `src/host/life/watchdog.ts` `watchdogStep` sets `severe` (the governor's last step) only for memory (`severeHost`). A disk queue, however long, stays a "low" request at the normal step.
- `HOST_THRESHOLDS` in `src/shared/memory/policy.ts`: diskQueue 32/40 s (normal), 16/30 s (gentle).
- `sandbox/csharp/MemGov.cs` sets the CPU priority class and memory priority, but **no I/O priority**.
- `toolchains.rust.targetDir` defaults to `'separate'` (`<workspace>\target\sandbox`, which is on the mapped workspace).
- `linker: 'lld'` is the default, yet the log shows `ld` (the project's setting, or GNU ld from MinGW); `linkSlots` exists.

**Steps**

1. **Disk-queue severity, `src/host/life/watchdog.ts`**
   - Add `diskSevere`: true when `diskQueue >= 2 * t.diskQueue` for `>= t.diskSeconds`, or `>= t.diskQueue` for `>= 3 * t.diskSeconds`.
   - `severe = low && ((memory !== null && severeHost(memory)) || diskSevere)`.
   - Add `diskSevereSeconds` to `WatchdogState` and `WATCHDOG_START`.
   - The reason text says "this PC's disks are overloaded (queue N for S seconds)".
   - Keep the hysteresis: calm still needs `diskHigh === 0`.
2. **I/O priority, `sandbox/csharp/MemGov.cs`**
   - New verb `iopriority <pid> <verylow|low|normal>`, through `NtSetInformationProcess(handle, ProcessIoPriority = 33, ref int, 4)`.
   - P/Invoke goes in `NativeMethods` (ntdll, `SetLastError` is not used for NTSTATUS: check `status != 0` and throw a `Win32Exception` with `RtlNtStatusToDosError`). Values: VeryLow=0, Low=1, Normal=2.
   - Use the PROCESS_SET_INFORMATION access right. C# 5 only.
   - Also set the page (memory) priority as it does now.
   - In `src/guest/governor/core.ts`, add `setIoPriority(pid, to)` to the governor port interface (next to `setPriority` and `setMemoryPriority`, lines 11-14).
   - In `src/guest/governor/decide.ts`, compilers and linkers that the decision puts at `below` get `low` I/O; at step ≥ 3 (or `hostStep` from a disk-severe request) they get `verylow`.
   - Restore `normal` on release.
   - Pure decision lives in `decide.ts` (importable by the self-test); add the action kind `{ kind: 'io', pid, to }`.
3. **Linkers.** Wherever `linkSlots: 'auto'` is resolved (`src/guest/toolchains/native/rust.ts` and the governor's compiler cap), add a pure function in `src/guest/governor/decide.ts`:
   - `linkerSlots(totalMb, cpus) = clamp(floor(totalMb / 6144), 1, 4)`
   - At governor step ≥ 2, linkers (`ld`, `ld.lld`, `lld-link`, `link`) run one at a time.
   - Make sure the process-name list in decide.ts includes `ld.exe` and `ld.lld.exe`.
4. **Build output on the local disk when it is safe.**
   - New `toolchains.rust.targetDir` value `'auto'`: `'local'` when C: has ≥ 25 GB free at boot, else `'separate'` with a boot warning ("Rust builds write through the mapped workspace; this can overload your PC's disk").
   - Make `'auto'` the default: `DEFAULTS` + `config.example.json`, and the schema `.describe()` in `src/core/schema/toolchains.ts:60-65`.
   - Resolve it in `rust.ts` with `freeBytes('C:\\')` (the S2 shared helper).
   - Tell the agent which folder: put it in the toolchain summary line.
5. **Heartbeat / last known state**
   - Guest: the daemon writes `run\heartbeat.json` every 10 s with `{at, uptimeS, ramFreePct, commitPct, step, hostStep, topProcesses (≤5: name, privateMb), diskQueueReported?, phase}`, via `writeJsonAtomic`. Schema in `src/shared/channel/schema.ts` (zod, bounded strings and arrays).
   - Host: `src/host/life/life-record.ts` reads it through `RunDir` (zod; `assertNoLinks`) when the life record has no end. `saveCrashReport` (`crash-report.ts`) appends "last seen inside: …" printed through `safeText`.
   - Add a `lastEnd` fact (label "Last sandbox", value "ended unexpectedly 21:31: PC disk overloaded / Windows stopped it / …", tone warn) to `sandboxStatus` output in `src/app/features/sandbox/sandbox.def.ts`, so the CLI status, the menu Sandbox page and the web Overview show it.
   - Add an action "Show crash report" (an existing logs operation with `{crash: true}` if one exists; otherwise add `logs.crash` as a query + view entry).
6. **Paging file note:** the log shows the paging file fixed at 16384 MB on a 40 GB C:. Do not change it now. Add a doctor line in the repair/health checks (`src/cli/commands/repair/checks/sandbox.ts`) when `sandbox.pageFileMb > 0.4 * C: size`.
7. **Docs:** docs/configuration.md (rust `targetDir` 'auto'), docs/troubleshooting (or the existing crash section): "If the sandbox vanished: `sandbox logs --crash`".

**Tests** (new suite `src/selftest/governor-io.test.ts`, registered in `selftest/index.ts`, or added to the existing governor suite):

- watchdog: queue 2× for 30 s gives `severe`; queue 1× for 90 s gives `severe`; calm needs the queue gone.
- decide: compilers below normal get `io low`; disk-severe gives `verylow`; release restores `normal`; linker slots at step 2 = 1.
- heartbeat schema rejects oversize; crash text uses `safeText`.
- MemGov `iopriority` argument parsing, if the C# has a parse helper exercised by the live suite.

**[PC]** Confirm with `sandbox logs --crash`. Confirm `NtSetInformationProcess` IoPriority works inside Windows Sandbox (it needs no privilege for VeryLow/Low).

**Owns:** `src/host/life/{watchdog,life-record,crash-report}.ts`, `src/shared/memory/policy.ts`, `src/guest/governor/*`, `sandbox/csharp/MemGov.cs`, `src/guest/toolchains/native/rust.ts`, the daemon heartbeat writer (new `src/guest/daemon/heartbeat.ts`).

**Shared edits:** `defaults.ts` (rust.targetDir 'auto'), `config.example.json`, `src/shared/channel/schema.ts` (+HeartbeatSchema), `sandbox.def.ts` (+lastEnd fact), CHANGELOG.

---

### S1. Agents: Codex fix + Codex settings + Claude environment editor + one Anthropic key pattern (owner: sonnet)

#### B2 Codex: root cause

- `C:\AgentData\state\codex\config.toml` has `sandbox_mode = "danger-full-access"` at the top (written 18:59 by `codexWithoutInnerSandbox`, `src/guest/agents/local-state.ts:118`). It still ends with `[windows] sandbox = "elevated"`.
- `C:\AgentData\state\codex\.sandbox\sandbox.2026-11-02.log` at 19:00:38 shows `Windows sandbox selection: elevated`. At 19:01:03 a plain `pwsh Get-Location` command hit `sandbox setup required` and ran the full elevated setup: CodexSandboxOffline users, firewall rules, read ACEs over the whole profile.
- So codex 0.166 ignores the top-level `sandbox_mode` here. Likely reasons:
  - (a) the explicit `[windows] sandbox = "elevated"`;
  - (b) a resumed thread (`resumeArguments: ['resume','--last']`) restores its saved permission profile;
  - (c) the newer `default_permissions` / permission-profile system takes precedence. The binary has strings "`sandbox_mode` and `default_permissions` overrides cannot both be set" and "permission profile cannot be represented as a legacy sandbox".
- The boot step runs whenever codex is configured (`session.agents?.codex`), not only for the boot agent, so it is not the problem. CODEX_HOME comes from `home.env`, so the shim's codex sees the same config.

#### B2 Codex: fix (flags beat config and resumed threads)

1. **Schema.** New optional `codex` block in `src/core/schema/harness.ts`. Better: a typed section `harnesses.codex.options` validated only when the harness name is `codex`. Simplest: add a top-level `codex` settings object in `src/core/schema/config.ts`:
   ```ts
   codex: z.strictObject({
     sandboxMode: z.enum(['danger-full-access','workspace-write','read-only']).describe(...),  // default 'danger-full-access'
     approvalPolicy: z.enum(['never','on-request','on-failure','untrusted']),                // default 'never'
     model: z.string().max(100),                     // '' = Codex's default
     reasoningEffort: z.enum(['default','minimal','low','medium','high','xhigh']),
     windowsSandbox: z.enum(['off','unelevated','elevated']),  // default 'off'
     mcpLoginsInFile: z.boolean(),                    // default true (P8's mcp_oauth_credentials_store)
   })
   ```
   - `DEFAULTS.codex = {sandboxMode:'danger-full-access', approvalPolicy:'never', model:'', reasoningEffort:'default', windowsSandbox:'off', mcpLoginsInFile:true}`.
   - `LocalOverrides`: none. A project may not loosen this. Add `codex.sandboxMode` to the tighten-only rules in `core/local-config/overrides.ts` only if you add it to overrides at all; recommended: user-only.
2. **Launch arguments.** New pure `codexArguments(c: Config['codex']): string[]` in `src/guest/agents/agent-files.ts`:
   - `--sandbox <sandboxMode>`, `--ask-for-approval <approvalPolicy>`, `-c model="…"` when the model is set, `-c model_reasoning_effort="…"` when not default.
   - When the mode is `danger-full-access` and the policy is `never`, use `--dangerously-bypass-approvals-and-sandbox` instead (the string exists in codex 0.166). It is the one flag that skips the Windows sandbox setup for certain.
   - Apply it where harness arguments are built: `src/guest/daemon/sessions.ts:143` (`base = [...launch.args, ...harness.arguments]`) and `src/guest/boot/boot.ts:343`, only when the agent name is `codex`.
   - It must also apply to `resumeArguments`: `resume --last` + flags; codex accepts the flags after the subcommand. **[verify with `codex resume --help` inside a sandbox]**
   - The terminal shim `codex.cmd` (`shimText`, agent-files.ts:51): when the shim is for codex, append the flags before `%*` so a `codex` typed in a sandbox terminal behaves the same.
3. **Config file ownership** (rename the function to `codexBootConfig`).
   - New pure `codexConfigOwned(toml, c): string` replaces `codexConfigWithoutSandbox` (agent-files.ts:113-124). It:
     - removes any top-level `sandbox_mode =` and `approval_policy =` lines it wrote before (marker comment `# Set by the sandbox`);
     - in the `[windows]` table, sets `sandbox = "<windowsSandbox>"` when not `off`, or **removes** the `sandbox =` line when `off`;
     - keeps every other line byte for byte;
     - writes `mcp_oauth_credentials_store = "file"` when `mcpLoginsInFile` and the key is unset (P8 adds a similar function: S1 owns the merge; see the S5b note).
   - Bounded: refuse files over 1 MB (log and skip).
   - Keep the old function name exported as a wrapper until P8 merges, then delete it.
4. **Settings category.** In `categories.def.ts`, add `'codex'` to the `agents` category keys, and `NAMES.codex = 'Codex'`. Also LABELS: `'codex.sandboxMode': "Codex's own sandbox"`, `'codex.windowsSandbox': 'Windows sandbox mode for Codex'`.
   - The `.describe()` text says: "Inside Windows Sandbox Codex's own sandbox only slows it down (it re-grants file permissions over your profile at every boot)."
5. **Environment.** `harnesses.codex.environment` is already editable as a map in Settings. It is covered by the generic environment editor below: no catalogue for codex.

#### A-env: Claude environment variables editor

**Pure catalogue:** `src/shared/agents/claude-env.ts` (web-safe, zod only).

```ts
export interface EnvVarSpec {
  readonly name: string;
  readonly group: 'Models' | 'Limits' | 'Subagents' | 'Behaviour' | 'Network' | 'Privacy' | 'Providers';
  readonly label: string;
  readonly kind: 'flag' | 'number' | 'text' | 'enum';
  readonly choices?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly secret?: boolean;
  readonly description: string;
  readonly defaultText?: string;
}
export const CLAUDE_ENV: readonly EnvVarSpec[];
```

Verified in `C:\AgentData\tools\agents\claude\claude.exe` (bounded `grep -a -o -w` on 2026-11-02):

| Group                     | Variables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subagents (owner request) | `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (number; code default 20: `isr(){return a.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS??kFo}`, kFo=20; error text "Concurrent subagent limit reached … increase CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"), `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (number; default from a feature flag, likely 3), `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` (number), `CLAUDE_CODE_SUBAGENT_MODEL` (text), `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (flag), `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` (number), `CLAUDE_CODE_FORK_SUBAGENT` (flag)                                                                                                  |
| Models                    | `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL` (enum low/medium/high/xhigh/max **[verify the values in the binary]**), `MAX_THINKING_TOKENS`, `CLAUDE_CODE_DISABLE_THINKING`, `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`, `CLAUDE_CODE_DISABLE_1M_CONTEXT`, `CLAUDE_CODE_DISABLE_FAST_MODE`                                                                                                                                                                                                                                    |
| Limits                    | `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, `MAX_MCP_OUTPUT_TOKENS`, `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`, `BASH_MAX_OUTPUT_LENGTH`, `TASK_MAX_OUTPUT_LENGTH`, `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`, `API_TIMEOUT_MS`, `CLAUDE_CODE_MAX_RETRIES`, `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`, `CLAUDE_CODE_MAX_TURNS`, `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`, `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS`, `SLASH_COMMAND_TOOL_CHAR_BUDGET`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `DISABLE_AUTO_COMPACT`                                                |
| Behaviour                 | `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR`, `CLAUDE_CODE_SHELL`, `CLAUDE_CODE_GIT_BASH_PATH`, `CLAUDE_CODE_TMPDIR`, `CLAUDE_ENV_FILE`, `USE_BUILTIN_RIPGREP`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `CLAUDE_CODE_ENABLE_TASKS`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`, `CLAUDE_CODE_NO_FLICKER`, `CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL`, `ENABLE_TOOL_SEARCH` |
| Privacy                   | `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_COST_WARNINGS`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`, `DISABLE_AUTOUPDATER` (already default `1`: show it "set by the sandbox"), `DISABLE_PROMPT_CACHING`, `CLAUDE_CODE_ENABLE_TELEMETRY`                                                                                                                                                                                                                                                                                                                                                             |
| Network                   | `HTTPS_PROXY`, `NO_PROXY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS` (secret)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Providers                 | `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `AWS_BEARER_TOKEN_BEDROCK` (secret), `ANTHROPIC_AUTH_TOKEN` (secret), `ANTHROPIC_API_KEY` (secret: say "use Accounts > Save an API key instead")                                                                                                                                                                                                                                                                                                                                                                                                                            |

**Rules for the agent building the catalogue**

- Before adding any name, run a bounded check: `timeout 150 grep -a -o -w -E "<name1>|<name2>…" C:\AgentData\tools\agents\claude\claude.exe | sort -u`. Drop names it does not find; this sandbox's binary is the reference.
- Cross-check the descriptions with code.claude.com/docs (the "Environment variables" settings page) through WebFetch. Do not list internal names (anything with codenames, `_FOR_SUBAGENTS_ONLY`, `OAUTH`, `GROWTHBOOK`, `TEST`, `ACCOUNT_UUID`, …).
- Flags are written as `"1"`; empty value = unset.

**Feature `src/app/features/agents/env.def.ts` + `env.run.ts`**

- Query `agents.env` with input `{agent: 'claude'}`. Output: `rows: {name, group, label, value: string|null (null for secrets: '***' or empty), set: boolean, fromSandbox?: boolean}` plus `custom: {name, set}` for names not in the catalogue.
- Operation `agents.env.set` with input `{agent, name: /^[A-Za-z_][A-Za-z0-9_]{0,100}$/, value: string|null}`. It writes `harnesses.<agent>.environment.<name>` in user scope through the settings service (the same path `settings.set` uses; reuse the `ConfigFile` / `editConfigText` from `src/app/features/settings/settings-file.ts`). `null` removes the key. It validates against the spec (number bounds, enum).
- **Secrets:** environment values are `secret()` in the schema and redacted everywhere. The run reads raw values from `ConfigFile` host-side and returns them only for catalogue entries with `secret !== true`.
- View `agentEnv` (title "Claude environment"):
  - one section per group;
  - items with `primary: action(agentsEnvSet, {agent, name}, {inline: true, fields:[fieldFor(spec)], initial:{value}})`;
  - section "Your own variables" for custom names, with an "Add variable…" action (fields name + value).
- Reach it from the Agents view (agent card for claude: action "Environment…", a `view` link `{view:'agentEnv', params:{agent:'claude'}}`) and from Settings > Agents (a row link).
- Add it to `MENU_VIEWS` (section 'Agents') and to `NAV` children under the agents entry (web: a sub-page through `embeds` like Settings, or a plain child "Claude environment").
- **Max-subagent shortcut** (owner request): in the claude agent's card / Settings row, show "Subagents at once: 20 (Claude's default)" with an inline number field bound to `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`.

#### A-key: one Anthropic key pattern

- New pure `src/shared/accounts/anthropic.ts` (web-safe):
  ```ts
  export const ANTHROPIC_KEY_PATTERN = /^sk-ant-(api|usr)\d{2}-[A-Za-z0-9_-]{20,400}$/;
  export function anthropicKeyProblem(key: string): string | null; // the texts from claude-login.ts:42-48
  export const ANTHROPIC_KEY_HINT = /^sk-ant-\.\.\.[A-Za-z0-9_-]{4}$/;
  ```
- Export it from `src/shared/accounts/index.ts`.
- `src/host/profile/claude-login.ts:37-48` re-exports it as `apiKeyProblem = anthropicKeyProblem` (keep the name for callers: `accounts.run.ts:102`, `claude-login.ts:103,106`, `accounts.ts:214,297`).
- `src/host/profile/accounts.ts:84` uses `ANTHROPIC_KEY_HINT`.
- The env editor: `ANTHROPIC_API_KEY` set through `agents.env.set` is validated with `anthropicKeyProblem`.
- Docs: docs/configuration.md:340-344 and docs/commands.md:193 say "`sk-ant-api03-…` or `sk-ant-usr…`".
- Tests (accounts.test.ts): add `sk-ant-usr01-` + 60 chars accepted; `sk-ant-usr1-x` refused; the env editor refuses a bad key.
- `secret-patterns.ts:118` (`sk-(ant-|…)`) already covers both: no change.

#### Tests for S1 (new `src/selftest/agent-settings.test.ts`)

- `codexArguments` for each mode/policy (bypass flag only for full-access+never).
- `codexConfigOwned`: removes `[windows] sandbox = "elevated"` when off, keeps other lines and tables, idempotent, keeps a user `mcp_oauth_credentials_store`.
- The shim text for codex includes the flags.
- Catalogue: names unique, all match `/^[A-Z][A-Z0-9_]+$/`, groups valid.
- `agents.env.set` with `fakeIO` writes and removes the key in a temp config; secrets never returned.
- `npm test app` parity.

**[PC/sandbox]** Start codex in a sandbox and check `.sandbox\sandbox.*.log` shows no "setup required" for a command.

**Owns:** `src/guest/agents/{agent-files,local-state}.ts`, `src/app/features/agents/env.*`, `src/shared/agents/claude-env.ts`, `src/shared/accounts/anthropic.ts`, `src/host/profile/claude-login.ts`.

**Shared edits:** `core/schema/config.ts` (+codex), `defaults.ts`, `config.example.json`, `categories.def.ts` (+codex key, names, labels), `defs.ts`, `registry.ts`, `menu/views.ts`, `daemon/sessions.ts:143`, `boot/boot.ts:343`, docs/configuration.md (Codex section + "Claude environment"), CHANGELOG.

---

### S2. Persistence: Visual Studio / MSVC / C++, hide stubs, shared install helpers (owner: sonnet)

#### B1 root causes

1. **VS layout fails every boot.** Exit `3762504530 = 0xE0434352`, the CLR "unhandled managed exception". So `vs_community.exe --layout C:\AgentData\tools\visualstudio\layout` crashes. Most likely cause: the layout download writes to %TEMP% and renames/moves into the mapped folder, which refuses rename-over (CLAUDE.md gotcha). The "keep install files" path never completes (`visual-studio.ts:86-115`), so every boot downloads 5-8 GB and installs. That is the "not persisting" the owner sees, and S0's disk load.
2. **VS itself is on C:** by design (`visual-studio.ts` header). The Setup API instance state (`C:\ProgramData\Microsoft\VisualStudio\Packages\_Instances`, `HKLM\SOFTWARE\Microsoft\VisualStudio\Setup`, the COM server `Microsoft.VisualStudio.Setup.Configuration.Native.dll`, plus MSI-installed Windows SDK under `C:\Program Files (x86)\Windows Kits`) is wiped each boot.
3. **C++ (`toolchains.cpp`)** persists correctly: `tools\mingw` checked by `exists(gcc)` (`cpp.ts:12-23`), winflexbison likewise. **MSVC portable** persists (`tools\msvc`, `MARKER`, `msvc/index.ts:40-48`), but it is disabled when VS is wanted (`plan.ts:90`, `vs === null`).

#### Fix

1. **Layout that completes** (`src/guest/toolchains/native/visual-studio.ts`, `layoutInstaller`).
   - (a) Run the bootstrapper with `TEMP`/`TMP` set to `tools\visualstudio\tmp` (same volume as the layout; `spawnAsync` with an `env` option: check `shared/download` `spawnAsync` supports env, else add it).
   - (b) If the exit is still non-zero, fall back to staging: `--layout C:\vs-layout-staging` (local disk; `assertLocalRoom(12 GB)`), then copy to the data disk with robocopy (`SYSTEM.robocopy()`, add it to `shared/system.ts` if missing; `/E /COPY:DAT /R:1 /W:1`, never `/MOV`), write `.complete.json`, and delete the staging folder.
   - (c) On failure, log the decoded exit (`0xE0434352: the Visual Studio installer crashed`) and the newest `%TEMP%\dd_bootstrapper_*.log` path, and copy that log to `C:\AgentData\logs\vs-layout-<date>.log`.
   - Pure helper `vsExitText(code: number): string` in `vs-request.ts` (importable by tests): 0, 3010, 1602 cancelled, 5007, 8006 (VS running), 0xE0434352.
2. **Offline install from the layout** (already coded: `--noWeb`). Once the layout works, each boot installs from the data disk, so no download. This is the round-1 deliverable. **[PC]** time it.
3. **Unreal without Visual Studio** (new option, round 1 code, **[PC]** verify): `toolchains.unreal.visualStudio: 'full' | 'autosdk'`, default `'full'`.
   - `'autosdk'` skips the VS install. It builds an Unreal AutoSDK tree from the portable MSVC (`tools\msvc`) at `tools\unreal\autosdk\HostWin64\Win64\VS2022\<msvcVersion>` and `…\Windows Kits\10` with **copies, not links** (mapped folders refuse junctions), and sets `UE_SDKS_ROOT`.
   - `visualStudioWanted` returns null for unreal when `'autosdk'`; the msvc step then runs (`plan.ts:90`).
   - Document it as "experimental: UnrealBuildTool finds MSVC through AutoSDK; the editor's Visual Studio integration is not available".
4. **VS on the data disk + re-registration:** NOT in round 1. Research spike for round 2 on a PC: `--installPath C:\AgentData\tools\visualstudio\install`, snapshot `_Instances` + the Installer folder + `HKLM\SOFTWARE\Microsoft\VisualStudio\Setup` + the CLSID `{177F0C4A-1CD3-4DE7-A32C-71DBBB9FA36D}` registration. The Windows SDK MSIs would still need a reinstall. Write the findings into docs/design/engines.md.
5. **Docs:** docs/toolchains.md "C/C++ and Visual Studio: what persists" table:

   | What          | Kept between sandboxes                              |
   | ------------- | --------------------------------------------------- |
   | MinGW         | kept                                                |
   | MSVC portable | kept                                                |
   | VS layout     | kept                                                |
   | VS install    | redone from the layout at boot, ~10-20 min **[PC]** |
   | autosdk       | kept                                                |

#### C-stub: no user-facing "not available yet" (until R2 lands each)

- New pure `src/shared/readiness.ts`:
  ```ts
  export const NOT_READY = {
    toolchains: ['unity', 'godot', 'android', 'flutter', 'dart', 'reactNative', 'fivem'],
    kinds: ['unity', 'keystore', 'play', 'expo', 'appstore', 'cfx'],
    unreal: ['engines'],
  };
  ```
  Remove `fivem`/`cfx` when S5a merges; P8's kinds are ready.
- `src/app/features/settings/settings-rows.ts` skips rows whose key path is `toolchains.<notReady>`.
- `services.def.ts` (`listServices` view) filters `NOT_READY.kinds`. The CLI `account status` still lists them, with "coming".
- Detection: `core/detect/toolchains.ts` resolves `auto` to off for `NOT_READY.toolchains`, so they never run.
- Guest: `not-yet.ts` keeps its log line but no summary line. `src/host/accounts/source.ts:39` message: "… comes in a later version" (CLI only).
- Each R2 package deletes its own entry from `NOT_READY`; integration checks it is empty by the end of round 2.
- Test: settings rows contain no `toolchains.unity`; no Page text contains "not available yet" (add to the S4 text test).

#### C-dup (install-side)

- **freeBytes.** `src/guest/toolchains/persisted.ts:64` and `src/core/disk.ts:63` (`freeBytesAt`). Move one implementation to `src/shared/io/disk.ts` (`freeBytesAt(dir, statfs?)`, nearest existing parent, null on error). `core/disk.ts` re-exports it; `persisted.ts` `freeBytes` calls it (keep the `deps.statfs` injection). Guest may import `shared/`.
- **signer.**
  - Today: `src/guest/toolchains/native/vcruntime.ts:13-18` (`MICROSOFT_SIGNER`, `signerOf` via `get-signer.ps1`), `installers.ts` (`SIGNERS`, `signedBy`, `signatureCheck`), and P8's `get-signature.ps1` + `guest/apps/signature.ts` + `shared/apps/signer.ts`.
  - S2 creates `src/shared/signer.ts` (pure) with `AppSigner {subject: string[] (regex sources), issuer?: string[]}`, `Signature`, `signerMatches` (copy P8's `shared/apps/signer.ts` verbatim), and moves `get-signature.ps1` (subject+issuer JSON) from 867a4ab into `sandbox/scripts/` now. `guest/toolchains/signature.ts` gets `signatureOf(file)` and `signedBy(file, AppSigner)`.
  - Rewrite `SIGNERS` as `AppSigner`s: microsoft `['^CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US$']`, valve `['^CN="?Valve(,| Corp)']`, unity `['^CN="?Unity Technologies']`.
  - Delete `get-signer.ps1` and `signerOf` (update `vcruntime.ts:38`).
  - S5b then imports `shared/signer.ts` instead of its own copy (§S5b).
  - Tests: `persisted-installs.test.ts` keeps passing; add `signerMatches` cases.

**Owns:** `src/guest/toolchains/{persisted,installers,not-yet,plan}.ts`, `native/{visual-studio,vs-request,vcruntime,unreal}.ts`, `shared/io/disk.ts`, `shared/signer.ts`, `shared/readiness.ts`, `sandbox/scripts/get-signature.ps1`.

**Shared edits:** `core/schema/toolchains.ts` (+unreal.visualStudio), `defaults.ts`, `config.example.json`, `settings-rows.ts` (filter, 3 lines), `services.def.ts` (filter, 2 lines; S4 and S5 also edit it: keep it to the filter), `core/detect/toolchains.ts`, docs/toolchains.md, CHANGELOG.

**Tests:** `persisted-installs.test.ts` + new cases: `vsExitText`; layout staging decision (injected statfs); `visualStudioWanted` with autosdk → null; AutoSDK path builder pure function (`autosdkLayout(msvc, sdk)` returns copy pairs).

---

### S3. VPN (B3) + Agent commands (AC) (owner: sonnet)

#### B3 NordVPN: root cause from the logs

`C:\AgentData\logs\openvpn.log` (19:15): TLS to `de1505.nordvpn.com:1231` (UDP) succeeds, then `AUTH: Received control message: AUTH_FAILED`. So these all work:

- the OpenVPN install (2.7.8, DCO driver loads);
- the server pick and profile download (`host/vpn/nordvpn.ts`);
- the kill switch letting the server IP:port through (the handshake got through);
- DNS before the block.

**The credentials are refused.** Likely causes:

- (a) the user saved the account e-mail/password, or Nord's "service credentials" were pasted with stray characters;
- (b) the menu's masked text input (`src/cli/tui/dialogs/text-screen.ts:124-127`) drops line breaks but keeps leading/trailing spaces and any bracketed-paste markers `\x1b[200~ … \x1b[201~` (terminal.ts:140 accepts `str >= ' '`, so the ESC is filtered but `[200~` text is kept). Verify this.
- `VpnLogin.save` trims only the username, not the password (`host/vpn/login.ts:52`).

**Fixes**

1. **Paste safety.**
   - In `text-screen.ts` `key.text` handling, strip `/\x1b?\[20[01]~/g` before inserting.
   - In `src/cli/tui/terminal.ts` `push`, map readline's `paste-start`/`paste-end` key names to no-ops.
   - Test in `menu.test.ts`: a pasted `\x1b[200~abc\x1b[201~` becomes `abc`.
2. **Credential checks** (`login.ts` `loginProblem`).
   - Refuse a username that looks like an e-mail when the provider is `nordvpn`: "That looks like your NordVPN account e-mail. Use the service credentials: Nord Account > NordVPN > Manual setup".
   - Trim the password of surrounding whitespace; Nord service passwords have none.
   - Nord service credentials are alphanumeric, ~24 chars: warn (do not refuse) when `!/^[A-Za-z0-9]{16,64}$/`.
3. **Verify after save.** Optional operation `vpn.check` (host, PC only), which needs no sandbox: it cannot run OpenVPN on the host, so skip the network check. Instead, `vpnStatus` gets `lastFailure` from the last sandbox's `run\vpn.json` (state failed, message), kept in host storage `<storage>\vpn\last.json` by the Watcher's final sync, read via `RunDir` + zod + `safeText`.
4. **Diagnostics in the UI** (`vpn.def.ts` `vpnPage`):
   - New fact "Last attempt" with value e.g. "login refused by NordVPN (2 Nov 19:15)", tone danger, and the action "Save the login again…" (`vpnLogin`).
   - The guest's `failureReason` (`guest/vpn/tunnel.ts:30-44`) keeps the plain reason; add a stable `code` field to `VpnStatus` (`auth`, `unreachable`, `driver`, `timeout`, `other`) in `shared/channel/schema.ts`.
   - Replace the CLI-only "Next: sandbox vpn login" notes (vpn.def.ts:165, 170) with the action (rule B4).
   - `vpn.run.ts:39` message: "Saved." + a page action "Turn the VPN on" (the toggle already exists).
   - `prepare.ts:35,51,64,95` fixes that name commands: keep them for the CLI, but add `action` (S4's error action) once S4 merges. Coordinate: S3 writes `failWith(message, fix, action)` only after S4's kernel change; until then leave a TODO list in the PR description for integration.
5. **Kill switch.** `vpn.ts` already allows the server addresses (`killSwitchCommands(servers…)`) and checks it holds. No change. Add the protocol fallback: when the code is `unreachable` with UDP, the next launch suggests `vpn.protocol tcp` (a page action `setSetting vpn.protocol 'tcp'`).
6. **Docs.** docs/vpn.md: "Login refused" troubleshooting with the Nord steps; drop the Alpha label only if a PC test passes **[PC]**.

**Tests** (`src/selftest/vpn*.test.ts` or the network suite): `loginProblem` e-mail rule; password trim; `failureReason` → code; `vpnPage` shows "Last attempt" and the action; no `sandbox ` text in the page.

#### AC Agent commands: review findings (code read: `src/host/agent-commands/*`, `cli/commands/agent-commands.ts`, `cli/services/agent-commands-service.ts`)

1. **Bug: uninstall leaves PATH pointing to deleted files.** `scripts/install.ps1` `-Uninstall` (lines 295+) removes only `$binFolder` from PATH. `<storage>\agent-commands` stays first on the user's PATH, and its `claude.cmd` calls `node.exe` + the removed `dist\bin\sandbox.js`, so typing `claude` on the PC breaks after an uninstall.
   - Fix (a): in install.ps1's Uninstall, remove HKCU PATH entries that end in `\agent-commands` under the storage root, and delete files containing the marker `windows-development-sandbox agent command`.
   - Fix (b): `forwardingCmd` adds `if not exist "<node>" goto direct` and `if not exist "<entry>" goto direct`; `forwardingSh` adds `[ -f entry ] || exec real`.
2. **Bug: updates break the forwarders.** The entry is `packageRoot\dist\bin\sandbox.js` (`agent-commands-service.ts:81`). Under the managed install that is `versions\<ver>\package`, which the updater removes. Fix: forward to the stable launcher of the managed install (the `$binFolder\sandbox.cmd` the installer writes, **[verify the path in install.ps1]**) when present, else `packageRoot`. Also call `reconcile` after a successful update (`cli/commands/maintenance/update.ts`), plus fix 1b.
3. **Bug: the "on PATH" check reads the process PATH, not HKCU.** `reconcile.ts:69-72` uses `process.env.PATH`. A terminal opened before turning it on makes every launch re-edit HKCU and broadcast. Fix: add `HostTools user-path --has <dir>` (exit 0/1) in `native/csharp/HostTools` (C# 5) and `edit-user-path.ps1 -Query`; call it from `editUserPath`'s sibling `userPathHas(dir, storageRoot)`.
4. **Bug: web/RPC toggles don't apply.** `settings.set` of `agentCommands.*` (web, or a CLI `config set`) does not reconcile; only the menu's Ctrl+S (`menu.ts:193`) and the next launch do. Fix: new feature `src/app/features/agent-commands/` (def + run):
   - query `agentCommands.status` (`{enabled, dir, found:[{command, harness, real}]}` from `statusAsync`);
   - operation `agentCommands.set` `{on: boolean}` (calls `service.setEnabled`; `requireOnPc`; returns the lines that `cli/commands/agent-commands.ts` prints now);
   - CLI hint `{name:'agent-commands', positional…}` keeping `status|on|off` (replace the hand-written handler: remove `'agent-commands'` from `commands/registry.ts` HANDLERS and the manifest entry);
   - `settings.run.ts`: after a user-scope set or reset of a key starting with `agentCommands`, call `new AgentCommandsService(ctx).reconcile(...)`.
   - View: a section "Agent commands" on the Agents view: fact on/off, `inline` boolean action `agentCommands.set`, items per found agent ("typing claude starts it in a sandbox").
   - Replace the custom `hostAgents` rows in `cli/menu/pages/agents-page.ts:265` with the view section.
5. **Quoting.** `%*` passes arguments raw: cmd keeps `"…"` and passes `&`/`|` inside quotes correctly. Unquoted `^` and `%` in user arguments are expanded by cmd before the forwarder runs; that is normal for any .cmd. Document it. Test: `forwardingCmd` output unchanged for safe paths.
6. **PowerShell resolution of the extensionless sh file** **[PC]**: check that `claude` in pwsh 7 and Windows PowerShell 5.1 runs `claude.cmd`, not `claude` (no extension). If pwsh picks the extensionless file, write the sh forwarder only when Git Bash is installed, and name it so only bash finds it (bash also finds `claude` without an extension: keep it, but verify).
7. **Running sandbox / another user / none.** `launch --headless --terminal` joins the running sandbox (the projects join flow) or starts one; for another user's sandbox the typed confirmation asks in the terminal. Add a test that `forwardingCmd` passes `--terminal` and that `launch` with `--terminal` + another user's sandbox asks (`host-sim` suite if it fits; otherwise document).
8. **Windows Terminal vs conhost:** `--terminal` attaches to the console it was typed in; nothing differs. Verify **[PC]**.
9. **Drop "Beta"** everywhere: `forwarders.ts:10,25` comments; the output strings in `agent-commands.ts` and `menu.ts:193-203` ("Agent commands (Beta)" → "Agent commands"); `categories.def.ts:44,77`; README.md:125 (move the row out of the "Beta and alpha features" table into the feature list); docs/configuration.md:46, 375 (heading "## Agent commands", anchor `#agent-commands`; fix links in docs/security.md:202-206); docs/security.md:202 heading.

**Tests** (`src/selftest/agent-commands.test.ts`): forwarders contain the `if not exist` fallbacks; stable-launcher selection (pure `forwardTarget(packageRoot, installRoot)`); `agentCommands.set` with `fakeIO` refuses inside the self-test (`/self-test|PATH/`) like today; the settings-set hook calls reconcile (inject a fake service); the view on all surfaces (`npm test app`).

**Owns:** `src/host/vpn/*`, `src/guest/vpn/*`, `src/app/features/vpn/*`, `src/host/agent-commands/*`, `src/app/features/agent-commands/*`, `src/cli/services/agent-commands-service.ts`, `native/csharp/HostTools` (user-path `--has`), `native/scripts/edit-user-path.ps1`, `scripts/install.ps1` (uninstall block), `src/cli/tui/dialogs/text-screen.ts`, `src/cli/tui/terminal.ts`.

**Shared edits:** `shared/channel/schema.ts` (VpnStatus `code`), `settings.run.ts` (hook, about 6 lines), `agents.def.ts` (+section), `cli/menu/pages/agents-page.ts`, `commands/registry.ts`, `cli/manifest.ts`, `defs.ts`, `registry.ts`, README, docs, CHANGELOG.

---

### S4. Command hints → actions, error actions, menu coverage, GitHub token, Accounts consistency (owner: sonnet)

#### B4a Kernel

1. **`UserError`** (`src/core/util/errors.ts`) gets an optional third field `action?: ErrorAction` where:
   ```ts
   interface ErrorAction {
     readonly op: string;
     readonly input?: Readonly<Record<string, unknown>>;
     readonly label: string;
     readonly cli: string;
   }
   ```
   `cli` is the command line the CLI prints as the fix. Add `failWith(message: string, fix: string, action: ErrorAction): never`.
2. **`WireErrorSchema`** (`src/app/kernel/errors.ts:11-15`): add `action: z.strictObject({op: z.string().max(100), input: z.record(z.string(), z.unknown()).optional(), label: z.string().max(200)}).optional()`. Never send `cli` over the wire. `toWireError` / `fromWireError` carry it.
3. **Surfaces**
   - CLI (`src/cli/report.ts` or wherever UserError is printed): prints `fix`, then "Run: <cli>" when there is an action.
   - Menu (`src/cli/menu/io-menu.ts` error handling): the message screen offers a button with the action's label that runs it through `MenuOperations`.
   - Web (`web/src/render/states.tsx` `ErrorState` and the notification in `rpc/hooks.tsx`): a button that runs it via `useRunAction`.
4. **New `Target` kind** in `view.ts:17`: `{ kind: 'setting'; key: string }` opens Settings at that row. Menu: `follow()` in `io-menu.ts` jumps to the Settings page focus `key`. Web: navigate to `/v/settings?focus=<key>` (CategoryPage scrolls to and highlights it: a hint for every page, not per view).
5. **Retire `Target.kind: 'command'`** for menu/web content. Keep the type for now but add a parity check: no Page built in the reference tests contains a command link.

#### B4b Replace every menu/web command hint (grep list from master; `file:line`)

**Accounts and services**

- `accounts.def.ts:80` → title "Services" (no command).
- `accounts.def.ts:92,95` empty text → `empty.action = action(saveAccount …)` and `cliText` keeps the command.
- `accounts.run.ts:68` → `failWith(…, action save)`.
- `services.def.ts:153-154` → actions `serviceImport`/`serviceLogin` (already ops: make them item actions; keep the command lines only under `only:'cli'` notes).
- `services.def.ts:165` → share fact with inline `setSetting accounts.<kind>.share`.
- `services.run.ts:109,129,190-191` → action-bearing messages.

**Agents, apps, audit, data**

- `agents.def.ts:30,62,72,83` and `apps.def.ts:153,167,180` are `surfaces.except` reasons (not shown in the UI): leave them.
- `audit.def.ts:331,425` (cli-only, ok); `:451` → page action `setSetting audit.enabled true`.
- `data.def.ts:107,122` (`next`, CLI) ok; `:205` → `only:'cli'` + the existing clean action.
- `data.run.ts:72` fix → `only cli`.

**Engine, GitHub, health**

- `engine.run.ts:91` stays (admin terminal needed) but reword: "Open an administrator terminal and run …" is CLI-only; the menu shows "Needs administrator rights" + action "Open an admin terminal" (`link command` is not allowed; use an operation `engine.cleanElevated` that starts an elevated `sandbox engine clean` through `runas`; or `surfaces.except` with a reason).
- `github.def.ts:116,140,145`, `github.run.ts:25` → actions (see GH).
- `health.def.ts:125` "Fix: sandbox repair will…" → item action `repair` (an existing operation? if not, `only:'cli'`).

**Projects, sandbox, sessions**

- `projects.def.ts:188,198,233` → actions `projects.roots.add` (fields: path), `setSetting projects.all`, `projects.choose`.
- `projects.run.ts:25,77,133,160,163` → `next`/messages: CLI only (`next` is CLI) or action.
- `sandbox.def.ts:187` "hidden (sandbox show opens it)" → value "hidden" + action show (exists).
- `sandbox.def.ts:194` → value "none selected" + action "Choose account" (`accounts.use`).
- `sandbox.def.ts:214` → a `start-agent` link.
- `sandbox.run.ts:100` fix → `failWith(action stop {force:true})`.
- `sessions.def.ts:147-148,162` (examples, CLI) ok; `:231` cli-only ok; `:267` cliText ok.
- `sessions.run.ts:74,119` → "Open Sessions" view link action.

**Settings, storage, updates, VPN, web**

- `settings-rows.ts:139` → text "Search settings by name" (no command).
- `settings.run.ts:144` → action `settings.export`.
- `storage.def.ts:48-49,160` → actions `storage.move` (fields path), `storage.use`, view link data, `storage.contained` on/off.
- `storage.run.ts:62,81,178,328` → `failWith` with actions or `only cli`.
- `update-lines.ts:32`, `updates.run.ts:45` → action `updates.install` / `updates.rollback`.
- `vpn.*` → S3.
- `web.def.ts:36,39`, `web.run.ts:62,67,99` → actions `web.start` / `web.open`; `:67` "Run sandbox _web to see why" → show the log tail via `logs` view link.
- `access.def.ts:280`, `access.run.ts:85` → action `web.lanOn` (exists as an op? if not, `setSetting web.remote.lan.enabled`).
- `cli/menu/remote-menu.ts:107` → reword "Attach from your own terminal" + the session id (no command).
- `web/src/pages/SignIn.tsx:63` (`<Command text="sandbox web open" />`) is the one legitimate place (the browser is not signed in): keep it, exempt by file in the test.
- Guest/host prepare errors (`host/vpn/prepare.ts` …) → S3 at integration.

#### B4c Self-test (new `src/selftest/ui-text.test.ts`)

- Build every view's Page with the sample data in `src/selftest/support/web-preview.ts` (it already has sample outputs) and the menu screens from `src/selftest/menu-screens.ts` `renderScreens`.
- Collect all visible strings: titles, labels, hints, values, descriptions, notes without `only:'cli'`, empty text (not `cliText`), action labels, facts.
- Fail on `/\bsandbox [a-z][a-z-]+/` (command suggestions), `/\bnot available yet\b/i`, and the banned-term list from the glossary (round 3 fills it; start with `["(Beta)", "not available yet"]`).
- Exemptions: an explicit list of `{view, text}` with a reason.
- Also check that no `link({kind:'command'})` appears in any built Page.

#### MC Menu coverage (new checks in `src/selftest/app.test.ts` parity section, or a new `menu-coverage.test.ts`)

- (a) Every operation/query is reachable in the menu (exists: extend so `surfaces.except.menu` needs a reason **and** is in an allow-list file `src/cli/menu/coverage-exempt.ts`).
- (b) Every hand-written command in `cli/manifest.ts` `COMMANDS` has a menu entry: the menu's command list or an action. List the ones that are not, as an audit table in the PR; currently `agent-commands` (fixed by S3), `doctor`/`repair` (Maintenance has them? check), `db`, `self-test`, `_web` (internal: exempt).
- (c) Every setting leaf in the config schema appears on the menu Settings page: walk `schema-node` over `ConfigSchema` and compare with `settingsOf(...)` rows; leaves inside maps/records count via their parent.
- The audit is part of the PR description: a table "command/setting → menu place".

#### GH GitHub token (`src/app/features/github/*`, `src/shared/github/token.ts`, host token store)

1. **Pre-filled link.** `NEW_TOKEN_URL` (github.def.ts:17) becomes:
   `https://github.com/settings/personal-access-tokens/new?name=Windows%20Sandbox%20<host>&description=…&expires_in=90&contents=write&pull_requests=write&metadata=read&workflows=write`
   **[verify the parameter names with WebFetch on docs.github.com, "Creating a fine-grained personal access token" (template URL parameters)]**; drop any parameter the docs do not list. Pure builder `newTokenUrl(o: {name, days, permissions})`.
2. **Verify after save.** `github.login` run calls the new host helper `verifyGithubToken(token): Promise<{login, expiresAt: string|null, repos: {count, sample: string[≤5]}, scopes?: string}>`:
   - `GET https://api.github.com/user` with `Authorization: Bearer`, 10 s timeout, bounded body via `fetchBounded` (`host/vpn/nordvpn.ts:16`; move that helper to `src/shared/download/bounded-fetch.ts` and import it from both);
   - expiry from the `github-authentication-token-expiration` response header;
   - `GET /user/repos?per_page=100&affiliation=owner,collaborator,organization_member` for the count and sample.
   - It saves `{login, expiresAt, repoCount, checkedAt}` (no token) beside the sealed token, so the status shows them.
   - A 401 means the token is not saved: "GitHub refused this token".
3. **Expiry warning.** `githubStatus` adds `expiresAt`. The view adds a fact "Expires 3 Feb 2027 (in 12 days)", tone warn under 14 days and danger when expired, with the action "Make a new token…" (opens the URL: a new `Target` `{kind:'url', href}`; menu prints/opens it with `SYSTEM.explorer`/`start`, web `window.open`; allow only https://github.com/).
   - At launch (`generate.ts`, where the token is shared), add a launch note when it expires within 7 days.
4. **GitHub card on the Accounts page.** `accountsView` (`accounts.def.ts`) adds the `githubStatus` query and appends a GitHub section in the service-card shape (B5 spec). The Settings embed stays for the share toggle. In the web, NAV `embeds` keeps GitHub under Settings until round 3.

#### B5 spec (one pattern; S4 applies it to Accounts, GitHub, VPN; round 3 to the rest)

Every "thing you connect" (Claude account, service sign-in, GitHub, VPN, app) is one card/item:

- `label`: the thing ("NordVPN", "GitHub", "Steam").
- `badges`, at most 2: state first, using only `saved` (ok), `not saved` (muted), `can't be read` (danger), `expires soon` (warn), `in use by <sandbox>` (warn); then `shared` (accent) when it is given to sandboxes.
- `hint`: the same state as one word (menu/CLI).
- `description`: one sentence of what it is for. Warnings go in `details` (max 2 lines; the rest in docs).
- `primary`: the next step. None saved → "Sign in…" / "Import from this PC…"; saved → "Share with sandboxes" inline toggle.
- `actions` (max 2): "Sign in again…", "Remove…" (danger, always last, label "Remove…").
- Secrets: never a value; at most `pplx-...abcd` / `sk-ant-...abcd` in `details`.
- Wording: "Sign in" (not login/log in), "Remove" (not delete/logout), "Share with sandboxes" (not share/handover).
- Empty state: "Nothing saved yet." + the primary action.

Apply it in `accounts.def.ts` (`agentSection`), `services.def.ts` (`serviceSection`), `github.def.ts` (`githubPage`) and `vpn.def.ts` (coordinate with S3: S3 owns vpn.def.ts; S4 sends a 10-line patch at integration). The menu `accounts-page.ts` renders the view; check it with `menu-screens.ts`.

**Tests:** `ui-text.test.ts`; errors: `toWireError` carries the action without `cli`, the CLI renders `Run: …`; `newTokenUrl`; `verifyGithubToken` with a fake fetcher (200 + headers, 401, oversize); expiry tones; accounts view has a github section; `npm test app`.

**Owns:** `src/app/kernel/{errors,view}.ts`, `src/core/util/errors.ts`, `src/cli/report.ts`, `src/cli/menu/io-menu.ts`, `web/src/render/{states,actions}.tsx`, `web/src/rpc/hooks.tsx`, `src/app/features/{github,accounts,projects,storage,web,access,updates,audit,data,sessions,sandbox,settings(rows text only)}/*` text edits, `src/shared/github/*`, `src/selftest/ui-text.test.ts`, coverage test.

**Conflicts to expect:** `sandbox.def.ts` with S0 (lastEnd fact: different lines), `services.def.ts` with S2 (filter) and S5b, `accounts.def.ts`/`services.run.ts` with S5a/S5b (the `askFields` change). Merge S4 after S5.

---

### S5. Resume P5 FiveM and P8 Perplexity (owner: sonnet; two sub-streams in their own worktrees)

#### Common first step

```
git -C <worktree> merge master        # master = cda7d6e; expect conflicts in:
#   src/shared/accounts/index.ts (Steam export added on master: keep both),
#   docs/accounts.md, docs/README.md, CHANGELOG.md (keep both entries),
#   src/selftest/steam.test.ts / src/shared/accounts/kinds/steam.ts (take master's),
#   P8 only: src/host/accounts/kinds/steam.ts untouched by P8 → no conflict.
npm run build && npm test     # fix fallout before continuing
```

#### S5a FiveM, commit 9b14bd9

**Done:** templates (lua/js/ts/cs + server.cfg), `add-firewall-port.ps1`, `fivem.ts` / `artifacts.ts` / `scaffold.ts` / `serve-plan.ts`, `devtools/fivem.ts`, the guest cfx adapter, hints, `catalogue-modding.ts`, docs/fivem.md, `fivem.test.ts` + fixtures, `ServiceField.loginOnly` + `askFields(forImport)` (`services.run.ts`), cfx `sources: ['typed','file']`, `maxBytes` 256 KB.

**Left:**

1. **`src/host/accounts/kinds/cfx.ts` `fromFile(bytes)`.** It is missing: the file still says "Only typed".
   - Read with `decodeText` (`shared/io/text.ts`); split lines (cap 20 000).
   - Strip `#` and `//` comments outside quotes.
   - Match `^\s*(?:set[rs]?\s+)?sv_licenseKey\s+"?([^"\s]+)"?` and `^\s*set[rs]?\s+steam_webApiKey\s+"?([A-Fa-f0-9]{32})"?` (case-insensitive key). The last one wins.
   - Validate with `CfxPayloadSchema`. With no key: `fail('That server.cfg has no sv_licenseKey.', …)` with an action `serviceLogin cfx`.
   - Fix the header comment.
2. **Tests in `fivem.test.ts`:** cfg with comments/quotes/`setr`; the key never in the summary; oversize refused by `readBoundedFile`; `import cfx --from` through `importServiceFlow` with `fakeIO` asks nothing (`loginOnly`).
3. Remove `fivem` / `cfx` from `NOT_READY` (S2's `shared/readiness.ts`). If S2 is not merged yet, leave a note for integration.
4. Replace the stub test title `'FiveM / RedM … (not available yet)'` if any is left after the merge.
5. docs/accounts.md row: `import cfx --from server.cfg`; docs/fivem.md; CHANGELOG bullet.
6. **[PC]:** FXServer reachable on 30120/40120 from the PC; artifact signature; txAdmin.

#### S5b Perplexity / computer use, commit 867a4ab

**Done:**

- the kinds `perplexity`/`comet` (shared/host/guest);
- `PcEnv.env` + `userVariable` (HKCU via reg.exe, `parseRegValue`, `refuseInSelfTest`);
- the `.env` parser (`perplexityKeyFromText`);
- `catalogue-agents-web.ts` + resolvers, `comet-unpack.ts`, `guest/browser/{cdp,comet}.ts`;
- `AppEntry.signer` + `get-signature.ps1` + `apps/signature.ts` + `shared/apps/signer.ts`;
- addon packages under `sandbox/addons/*` (package-lock committed);
- `addon-mcp.ts` (Claude + Codex MCP registration);
- `codexConfigWithMcpLoginsInFile` + the boot step;
- `.credentials.json` in codex `loginFiles`;
- docs/agents-web.md, `agents-web.test.ts` (75 checks), docs/accounts.md row, CHANGELOG.

**Left:**

1. **Merge the Codex config work with S1.**
   - If S1 merged first: delete `codexConfigWithMcpLoginsInFile` and `codexMcpLoginsInFile` and rely on S1's `codexConfigOwned` (`codex.mcpLoginsInFile`); move P8's tests for it to `agent-settings.test.ts`.
   - If S5b merges first, S1 does that.
   - Merge order (§I) puts S1 before S5b.
2. **Signer.** Replace `src/shared/apps/signer.ts` with S2's `src/shared/signer.ts`. `AppEntry.signer` uses the `AppSigner` type from there. Delete P8's duplicate `get-signature.ps1` if S2 already added the same file; the files must be identical.
3. **Import from the PC.** The PC environment, then HKCU, then `.env` is implemented. Add a test that `fromPc` prefers `env` over `userVariable`, and that a quoted value is unquoted. Check `pcEnv()` is only called on the PC (`requireOnPc` in `serviceImport`).
4. **Menu coverage.** The new kinds and apps show on Accounts/Apps in the menu (`menu-screens.ts`: add sample rows); `npm test app`.
5. **Wording** (B5): the warnings from gamedev-platforms.md §5 on every surface (`warnings` in `SERVICE_SPECS`).
6. **[PC]:** Comet portable runs unregistered; the CDP cookie restore; Perplexity Computer MCP OAuth in Claude and Codex.

---

### Integration of Round 1 (owner: sonnet)

**Merge order** (each: merge into master, `npm run build`, commit regenerated `schemas/*.json`, `npm test` → ALL TESTS PASSED):

1. S0 (crash): smallest UI overlap, highest priority.
2. S2 (persistence; adds `shared/signer.ts`, `shared/readiness.ts`, `shared/io/disk.ts`).
3. S1 (agents; codex config).
4. S5a FiveM, then S5b Perplexity (apply S1/S2 reconciliation notes; remove `NOT_READY` entries).
5. S3 (VPN + agent commands).
6. S4 (kernel error action + text sweep last, because it touches the most `*.def.ts` text). After S4, convert S3's VPN fixes and `prepare.ts` errors to `failWith` + action, and apply the B5 card patch to `vpn.def.ts`.

**Expected conflicts:**

- `defaults.ts` / `config.example.json` / `core/schema/config.ts` (S0, S1, S2: different keys);
- `categories.def.ts` (S1 codex, S3 Beta label);
- `CHANGELOG.md`;
- `docs/configuration.md`;
- `defs.ts` / `registry.ts` / `menu/views.ts` (S1 agentEnv, S3 agentCommands: append both);
- `services.def.ts` / `services.run.ts` (S2 filter, S4 text, S5a/b);
- `sandbox.def.ts` (S0, S4);
- `selftest/index.ts` (suite list: keep all).

**Full verification:**

```
npm run build
npm test            # must print ALL TESTS PASSED (re-run once if a live suite flakes)
npm run lint
npm run format:check
MSYS_NO_PATHCONV=1 npm run web:shots -- <scratch>/shots /v/accounts   (+ --dark, --mobile) and /v/agents, /v/vpn
```

**Version:** features → minor. Set `package.json` `version` to **1.19.0** (`npm version minor --no-git-tag-version`, which updates package-lock). Set `native/csharp/{HostTools,HcsHost,StorageHelper}/AssemblyInfo.cs` to `AssemblyVersion("1.19.0.0")`, `AssemblyFileVersion("1.19.0.0")`, `AssemblyInformationalVersion("1.19.0")`. They currently say 1.18.0 while the package is 1.18.2: realign them now. Docs-only changes never bump.

Move CHANGELOG `## Unreleased` to `## 1.19.0`. Commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## ROUND 2 (parallel, after 1.19.0)

All four packages follow gamedev-platforms.md §2-§4 and §6, with the signatures P1 already stubbed. Each package:

- deletes its `NOT_READY` entries;
- replaces its stub test suite (`src/selftest/<area>.test.ts` currently `t.check(true, '…not available yet')`);
- adds menu-screen samples;
- follows B4 (no command hints) and B5 (card pattern).

### R2-P3 Unreal engines, Godot, game-dev apps (sonnet)

- **Files:** `src/guest/toolchains/engines/{unreal-engines,godot}.ts`, `src/host/pc-installs/{unreal,epic}.ts`, `src/host/launch/hints/engines.ts`, `src/shared/apps/catalogue-gamedev.ts`, `src/guest/apps/resolvers-gamedev.ts`, `docs/game-engines.md`, `src/selftest/engines.test.ts`.
- **Shared edits:** `guest/apps/app-installer.ts` (skip the `godot` app while the toolchain is on), `native/dotnet.ts` (`dotnet.templates`).
- **Unreal:** the launcher's default install location `tools\unreal\engines`; each boot writes `LauncherInstalled.dat` + the manifests (pure writer `launcherInstalled(engines): string`, tested); `UE-LocalDataCachePath` → `tools\unreal\ddc`; PC engines from `pcInstalls`; S2's `visualStudio:'autosdk'` sets `UE_SDKS_ROOT`.
- **Godot:** godot-builds zip + SHA512-SUMS pick (pure `pickGodotAsset(sums, version, dotnet)`), `_sc_` file next to the exe, templates, `godot` console exe on PATH, Android paths in `editor_settings-4.tres` once P6 lands (guarded).
- **Apps:** RenderDoc, Krita, Inkscape, Audacity, TrenchBroom, LDtk, Material Maker, GDevelop, Ren'Py, Tracy, Defold `bob.jar`. Each with checksum or `signer`.
- **Also:** the VS-on-data-disk research spike from S2 §4 **[PC]**.

### R2-P4 Unity (sonnet)

- **Files:** `src/guest/toolchains/engines/{unity,unity-release}.ts` (`findUnityRelease` exists unused, `unity-release.ts:20`), `src/guest/devtools/unity.ts`, `src/{host,guest}/accounts/kinds/unity.ts`, `src/host/pc-installs/unity.ts`, `docs/unity.md`, `src/selftest/unity.test.ts`.
- Release API with SRI; NSIS `/S /D=` into `tools\unity\<ver>` through `ensurePersisted`; modules (`android` uses P6's `ensureAndroidSdk` via the interface; `windows-il2cpp` goes through `visualStudioWanted`); `ProjectVersion.txt` parsing.
- `sbx-unity install|editors|build|license status/return`.
- **Unity sign-in:** `pc` = `%ProgramData%\Unity\Unity_lic.ulf` (explicit `PcEnv.programData`) **[PC: Hub licensing client location]**, `file`, `typed`, `sandbox`.
- **[PC]:** `.ulf` portability; Library LMDB on the mapped workspace.

### R2-P6 Android, Kotlin, MAUI, signing (sonnet)

- **Files:** `src/guest/toolchains/mobile/{android,android-repo}.ts` (`parseRepository`/`refusedPackage` exist unused), `languages/kotlin.ts`, `devtools/android.ts`, `{host,guest}/accounts/kinds/{keystore,play}.ts`, `hints/android.ts`, `catalogue-mobile.ts`, `resolvers-mobile.ts`, `docs/android.md`, `android.test.ts`.
- **Shared edit:** `languages/java.ts` `ensureJdk(major)`.
- Export exactly `ensureAndroidSdk` / `androidEnv` (gamedev-platforms.md §3).
- **Sources:** `keystore` `pc` = `PcEnv`-based debug.keystore path (add `userProfile` to `PcEnv`, read via an explicit path; never the HOME env in tests); `play` `file`.

### R2-P7 Flutter, Dart, React Native / Expo, iOS cloud (sonnet; start after P6 merges, or code against the interface and merge after P6)

- **Files:** `src/guest/toolchains/mobile/{flutter,dart,react-native}.ts`, `{host,guest}/accounts/kinds/{expo,appstore}.ts`, `hints/mobile.ts`, `docs/mobile.md`, `mobile.test.ts`.
- `releases_windows.json` pick + `.fvmrc`.
- **expo:** `pc` = `EXPO_TOKEN` from env then HKCU (reuse P8's `PcEnv.userVariable`); only offer `~/.expo/state.json` if EAS accepts it **[verify]**.
- **appstore:** `file` `.p8` + typed ids.

### R2-C Code cleanup (haiku; mechanical; start after P3-P7 have branched, merge last in round 2)

Unused exports (referenced by no other file; verified by scan on master). Delete them, or make them non-exported when used inside their own file:

| File:line                                    | Export                                                   |
| -------------------------------------------- | -------------------------------------------------------- |
| `src/app/features/data/data.def.ts:63`       | `DataEntryRow`                                           |
| `src/app/features/data/data.def.ts:64`       | `DataDisk`                                               |
| `src/app/features/defs.ts:199`               | `ViewById`                                               |
| `src/app/features/defs.ts:203`               | `definitionById`                                         |
| `src/app/features/sandbox/sandbox.def.ts:61` | `helperText`                                             |
| `src/app/kernel/errors.ts:8`                 | `ErrorKind` (type)                                       |
| `src/app/kernel/io.ts:10`                    | `QuestionChoice`                                         |
| `src/cli/commands/context.ts:119`            | `currentGuestDir`                                        |
| `src/cli/output/colors.ts:38`                | `shortenMiddle`                                          |
| `src/cli/output/colors.ts:54`                | `clearScreen`                                            |
| `src/cli/output/colors.ts:59`                | `pageSizeFor`                                            |
| `src/core/detect/toolchains.ts:81`           | `LicensedToolchain`                                      |
| `src/core/schema/web.ts:5`                   | `WEB_DEFAULT_PORT`                                       |
| `src/core/schema/web.ts:6`                   | `WEB_LAN_DEFAULT_PORT`                                   |
| `src/core/schema/web.ts:27`                  | `RemoteUser`                                             |
| `src/host/sandbox/wsb-cli.ts:162`            | `sandboxIp`                                              |
| `src/shared/accounts/payloads.ts:119`        | `AnyPayload`                                             |
| `src/shared/accounts/payloads.ts:150`        | `deliveredKinds`                                         |
| `src/guest/toolchains/steam/steamcmd.ts:18`  | `ensureSteamCmd` (check P2 meant to use it; else delete) |

The R2 packages own `unity-release.ts:20`, `fivem/artifacts.ts:11`, `android-repo.ts:13,18` and `android.ts:27`: they get used by P4/P5/P6, so not dead.

Run the scan again after round 2 (the node script below, kept in the PR description, not in the repo; or add `knip` as a dev dependency only if it runs on Node 22.0.0).

Unimported files:

- `src/cli/menu/settings/index.ts` (barrel nobody imports: remove, or make callers use it per the barrel rule; prefer removing, since siblings import directly);
- `src/cli/menu/settings/editor-actions.ts` (one constant `ADD`: inline it into `collections/collection-editor.ts`);
- `web/src/rpc/types.ts` (check whether `run()` is used; if not, delete).

Duplicated helper: `src/host/projects/registry.ts:208` `readBounded` → use `readSmallFile` (`core/util/fs.ts:33`; same semantics). Long term `readSmallFile` should use `readBoundedFile` (`shared/io/bounded.ts:12`) to close the size race; do it in this stream.

`fetchBounded` (`host/vpn/nordvpn.ts:16`) is moved by S4 to `shared/download/bounded-fetch.ts`: check that nothing else re-implements it (grep for `getReader()`).

Hard-rule spot checks:

- grep `spawn(`/`spawnSync(`/`execFile(` with a bare first argument (must be `SYSTEM.*` or absolute);
- PowerShell or C# inside TS strings;
- `process.env.HOME`/`USERPROFILE` reads in host code outside `pcEnv()`;
- empty `catch {}` without a comment (fix: add the reason).

Report findings as a table; fix the mechanical ones.

Dead-export scan used (read-only, run with node from the repo root): walk `src`, `web/src` and `scripts`, tokenise identifiers per file, and report `export function|const|class|let NAME` where NAME appears in no other file and only once in its own.

### Round 2 integration

- **Merge order:** P6 → P3 → P4 → P7 → R2-C.
- Check `shared/readiness.ts` `NOT_READY` is empty, then delete the file and its three uses.
- Version **1.20.0** (package + 3 AssemblyInfo). Same verification.

---

## ROUND 3 (last, after everything else): UI/UX simplification and wording (owner's words: "simpler but the same experience … distilling and simplifying the wording and the categories")

Same features and flows. Fewer categories, fewer levels, plain words. No interaction redesign. One renderer per surface (web-ui-standard.md).

### U0 Style guide + glossary (sonnet; first, a 1-day stream; output `docs/design/wording.md` + `src/shared/glossary.ts`)

**Rules**

- Labels ≤ 4 words, verb first for actions ("Sign in…", "Remove…"); `…` when it asks something.
- Hints: one word or a value. Descriptions: one sentence, ≤ 140 characters.
- Errors: what happened, then what to do (≤ 2 short sentences). Numbers with units. No "please", no exclamation marks.
- `fail` fixes name an action label, not a command (B4).

**Glossary** (one name per concept; banned words → the right word):

| Use                            | Not                                                                       |
| ------------------------------ | ------------------------------------------------------------------------- |
| sandbox                        | VM, box, guest (in UI text)                                               |
| project                        | workspace (except the setting `guestWorkspace`), repo                     |
| data folder                    | data set, data path, storage root (UI)                                    |
| sign-in (noun), Sign in (verb) | login, log in, logon, credentials (except "service credentials" for Nord) |
| Remove                         | delete, logout, log out, forget                                           |
| Share with sandboxes           | hand over, deliver, share token                                           |
| agent                          | harness (UI)                                                              |
| setting                        | config, option (UI)                                                       |
| this PC                        | host, your machine                                                        |
| app                            | add-on (for catalogue apps)                                               |
| toolchain                      | language, runtime (category name "Tools")                                 |

`src/shared/glossary.ts` exports `BANNED_UI_TERMS: readonly {re: RegExp, use: string}[]`. S4's `ui-text.test.ts` reads it.

### New category list (apply mechanically)

**Menu sections** (`src/cli/menu/shell.ts` `SECTION_LABELS`, 7 → 6):

| Old         | New                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------- |
| Agents      | **Start** (agents + "repeat last" + options)                                             |
| Sessions    | **Sessions**                                                                             |
| Sandbox     | **Sandbox** (status, projects, databases)                                                |
| Apps        | merged into **Setup**                                                                    |
| Settings    | **Setup** = Apps + Toolchains + Settings, the settings categories below                  |
| Accounts    | **Accounts** (Claude accounts, service sign-ins, GitHub, VPN sign-in)                    |
| Maintenance | **Maintenance** (Health, Data & storage, Logs & activity, Updates, Engine, Web & remote) |

Update `NAV_KEYS` `'1-6'`, `MENU_VIEWS` sections, and the menu memory migration (`cli/menu/memory.ts`: map stored section indexes old→new, or reset).

**Settings categories** (`categories.def.ts` `CATEGORIES`, 8 → 6):

| Old id (label)                   | New id (label)                        | Keys                                                                             |
| -------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| general                          | **general** (General)                 | defaultHarness, harness, guestWorkspace, readOnly, mappings, pcInstalls, scripts |
| agents                           | **agents** (Agents)                   | harnesses, codex, claudeProfile, resume, attach, agentCommands                   |
| machine                          | **machine** (Sandbox machine)         | sandbox, personalization                                                         |
| languages + databases + projects | **tools** (Tools & projects)          | toolchains, databases, projects, provisioning, hooks                             |
| network                          | **network** (Network & VPN)           | network, vpn                                                                     |
| security                         | **privacy** (Privacy & sharing)       | workspaceFilter, audit, secrets, github, accounts, downloads, storage, sharing   |
| (agents: web)                    | moved to **machine**? No: **general** | web                                                                              |

The self-test "every top-level key in a category" still applies.

**Web NAV** (`features/defs.ts` NAV, 4 groups → 3):

- **Work:** Start (agents), Sessions, Activity.
- **Sandbox:** Overview, Projects, Apps, Accounts, Settings (embeds VPN, GitHub).
- **Maintenance:** Health, Data & storage (data + storage as two tabs or two sections of one view: no new view, use `embeds`), Logs, Updates, Engine, Remote access.

### U1 Menu pass (sonnet)

For every screen in `src/selftest/menu-screens.ts` (Agents/Start, Sessions, Sandbox, Settings + each category, Accounts, Apps, Maintenance and each sub-view), at 100×30 and 80×24:

- Headings: one title line `Section › Page`. Status line: one line, facts `Label value · Label value`.
- Badges in the hint column follow B5. Key bar ≤ 6 keys, importance-ordered. Enter label = the primary verb.
- Ordering: the most-used first (Start: default agent first; Accounts: Claude accounts, then GitHub, VPN, services; Maintenance: Health first).
- Long lists (apps, settings, toolchains) keep `/` search; add a "Show all / Show on only" filter on Apps (an existing filter hint, `ViewDef.filters`).
- Confirmations: title = the question ("Remove the saved NordVPN sign-in?"), yes = the verb ("Remove").
- Empty states per the B5 spec.

**Before → after examples:**

| Screen      | Before                                                                                                                            | After                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Accounts    | Claude rows + a "Services: none shared or saved (sandbox account status)" line, then 8 service categories each with long warnings | "Claude" section (cards), "Sign-ins" section: one row per service (badge, primary), warnings in details |
| Settings    | 8 categories, "Agents & sessions" holding web/agent commands (Beta)                                                               | 6 categories as mapped; no "(Beta)"; VPN sign-in row under Network & VPN with "Sign in…"                |
| Maintenance | a long flat list                                                                                                                  | grouped: Health · Data & storage · Logs & activity · Updates · Engine · Web & remote                    |

**Text snapshots:** new `src/selftest/menu-snapshots.test.ts` renders key screens (Start, Accounts, Settings>General, Maintenance, VPN) at 100×30 through `renderScreens`. It compares with `src/selftest/fixtures/menu/*.txt`; regenerate with `npm test -- menu-snapshots --update` (add that flag handling in the suite: it writes the fixtures only when `SBX_UPDATE_SNAPSHOTS=1`).

### U2 Web pass (sonnet; within the one renderer; files only under `web/src/render`, `web/src/shell`, `web/src/app.css`, `web/src/theme.ts`)

**Audit and fix, for every page at once:**

- **Layout:** max content width 1100 px; page header = title + summary + page actions on one row.
- **Density:** cards in a 3/2/1 column grid; facts as compact tiles (2 lines); rows with 8 px padding.
- **Navigation:** the 3 NAV groups; current page highlighted; the CommandPalette (`shell/CommandPalette.tsx`) lists views and actions.
- **Forms:** `ActionForm` one column, labels above, help text under the field, primary button right.
- **Feedback:** one toast per operation (success: `text(output)`; error: message + fix + the S4 action button). Progress in the toast, not a modal.
- **Errors:** `ErrorState` with the action button.
- **Loading:** `PageSkeleton` matching the section shapes.
- **Inline toggles:** `InlineField` saves at once with an undo toast.
- **Settings:** `CategoryPage` 6 categories, search across all, the `?focus=` highlight (S4).

**Before/after per page** (screenshots light/dark/mobile with `npm run web:shots` for `/v/agents /v/sessions /v/sandbox /v/accounts /v/settings /v/apps /v/health /v/logs`; put the paths in the PR):

- Before: dense, inconsistent cards, Bootstrap-like spacing.
- After: the B5 card everywhere, one header style, no command text.

Never special-case a view id in `web/`.

### U3-U5 Wording sweep (haiku × 3, parallel, disjoint folders; each uses the glossary and keeps meaning)

| Stream | Folders                                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U3     | `src/core/schema/**` `.describe()` texts (these feed the menu, the web, JSON Schema and docs; regenerate schemas) + `categories.def.ts` labels          |
| U4     | `src/app/features/**` (`*.def.ts` view text, `*.run.ts` messages, `fail` texts) + `src/cli/commands/**` output and `cli/manifest.ts` `--help` summaries |
| U5     | `docs/**`, `README.md`, `CONTRIBUTING.md`; host/guest log lines the user sees (`src/guest/**` `log`/`warn` texts, `src/host/launch` notes)              |

Each runs `npm test -- ui-text,app,menu-snapshots` and updates the snapshots (U1 owns the snapshot fixtures: U3/U4 regenerate after U1 merges).

**Round 3 merge order:** U0 → U1 → U2 → U3 → U4 → U5. Version **1.21.0**. Docs-only commits after that: no bump.

---

## Real-PC checks to schedule (owner)

- `sandbox logs --crash` after the 21:31 crash: paste it to confirm S0.
- VS layout completes and the offline install time (S2).
- Unreal AutoSDK build without VS (S2).
- I/O priority effective inside Windows Sandbox (S0).
- NordVPN with real service credentials (S3).
- Agent commands: pwsh/PS 5.1 resolution, Windows Terminal, uninstall cleanup, update (S3).
- Codex: no "setup required" in the `.sandbox` log (S1).
- FXServer ports; Comet portable + CDP; Perplexity Computer MCP OAuth (S5).
- Unity `.ulf`, Android NDK long paths, Flutter desktop (R2).

### Critical Files for Implementation

- C:\Projects\AgentProjects\windows-sandbox\src\host\life\watchdog.ts
- C:\Projects\AgentProjects\windows-sandbox\src\guest\toolchains\native\visual-studio.ts
- C:\Projects\AgentProjects\windows-sandbox\src\guest\agents\agent-files.ts
- C:\Projects\AgentProjects\windows-sandbox\src\app\kernel\errors.ts
- C:\Projects\AgentProjects\windows-sandbox\src\host\agent-commands\reconcile.ts
