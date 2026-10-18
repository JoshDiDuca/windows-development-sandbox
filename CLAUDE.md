# windows-development-sandbox: notes for agents

A CLI (`sandbox`, also `agent-sandbox`, `claude-sbx` ...) that starts a disposable Windows Sandbox for a project, with
or without an AI agent. You usually develop it INSIDE a sandbox it made: only this repo and `C:\AgentData` survive the
wipe, so put behaviour in code, never in this machine. Downloads for testing go in your scratchpad.
User docs: README.md and docs/. Contributor summary: CONTRIBUTING.md. Releases: docs/development.md#releases.

## Before you say it is done
- `npm run build` (tsc + esbuild bundle + schema generation). Commit changed `schemas/*.json`.
- `npm test` must print `ALL TESTS PASSED`: gate on that text, not the exit code. Live tests (ConPTY, daemon, git shim)
  can flake under load: run once more before calling a failure real. One suite: `npm test -- <suite>[,<suite>]`.
- `npm run lint` (ESLint, including the layer boundaries) and `npm run format:check` pass.
- New setting or command: docs updated; `config.example.json` equals `DEFAULTS` (the self-test checks it).

## Hard rules
- **Features are written once in `src/app`; surfaces only render.** An operation, query or view is defined in
  `src/app/features/<area>` (docs/design/shared-core.md); the CLI, the menu and the web UI draw its Page and run it
  through the registry, with no logic of their own. The web draws every Page with one renderer (no React per area;
  docs/design/web-ui-standard.md). The kernel and `*.def.ts` are pure (the web bundle imports them);
  `npm test app` fails when an operation is not reachable on every surface and declares no exemption.
- **Never on a real PC.** The self-test refuses to run outside a Windows Sandbox or GitHub Actions
  (`onThrowawayMachine`). Tests use only temp folders they create: never the real `~/.agent-sandbox`, registry, PATH,
  profile or global git config. Never read, set or override HOME / USERPROFILE (`$home` in PowerShell): use explicit paths.
- **The guest is hostile.** Host code never executes guest data, never follows links under the data folder
  (`assertNoLinks`), keeps its own state outside it, validates everything read from `run/` (zod), prints guest text
  through `safeText`, and reads workspace files with bounded effort (no unbounded regexes).
- **No secrets in files the guest keeps.** `session.json`, the launch folder and `<data>\run` never hold an API key, an
  agent `environment` value, a login or the VPN login: they go in `<data>\secrets\<id>.json` (`writeSecrets`), which the
  guest reads and deletes. Saved logins are sealed with `SecretStore`. Schema fields that hold secrets use `secret()`
  (printed as `***`).
- **A repo's `.sandbox-config.json` is untrusted.** It needs a hash approval and may only tighten protections
  (`NEVER_LOOSER` in `core/local-config/overrides.ts`). Never add storage, executables, secrets or host folders to
  `LocalOverrides`. Machine-wide protections are never loosened (`core/local-config/policy.ts`).
- **No side-effect imports across the boundary.** Host code and tests may import only these guest files:
  `git/decision`, `setup/git-rules`, `boot/project-env`, `audit/parse`, `sessions/cmdline`, `toolchains/catalogue`,
  `toolchains/tools/vscode-profile`, `governor/decide`, `governor/core` (`runtime/session.ts` reads session.json and
  `runtime/log.ts` creates the logs folder on import; inside a sandbox that file exists, so a bad import only fails on
  GitHub Actions — the `layout` suite catches it). Guest code imports from core only `core/types.ts`, `core/schema/**`,
  `core/detect/{toolchains,versions}.ts` and `core/util/errors.ts`. The `layout` suite checks this on the build output.
- **Never spawn programs by bare name**: `SYSTEM.*` or absolute paths (the cwd is often the workspace).
- **No PowerShell or C# inside TypeScript strings.** Scripts are `.ps1` files run by path with parameters (JSON via a
  temp file; `scriptArgs`), C# lives in `.cs` files.
- **C# 5 only** (the compiler that ships with Windows): csc helpers build with
  `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`; Add-Type files must load in powershell.exe 5.1.
- **Host Node may be 22.0.0** (CI tests it): no APIs or dependencies that need newer (commander 14, @inquirer/prompts 7).
- Inside a sandbox, commands that control it from outside (`launch`, `attach`, `exec`, `stop` ...) fail on purpose
  (`requireOnPc`); `sandbox launch/claude/attach` would try a nested sandbox. Test CLI behaviour with unit tests,
  `--help`, `config`, `data` and `doctor`. `db` runs `dist/runtime/db.js` directly.

## Layout
Feature folders, each with an `index.ts` barrel (re-exports only). Other folders import the barrel; inside a folder
import siblings directly, never your own barrel. Guest code imports files directly, except the `guest/toolchains`,
`guest/databases` and `guest/apps` barrels.

| Folder | What lives there |
| --- | --- |
| `src/app/` | The shared core (no printing, no terminal, no DOM). `kernel/` (pure: `define.ts` operations/queries/views, `view.ts` the Page model, `fields.ts` zod -> Fields, `io.ts` questions, `errors.ts`, `rpc.ts`), `features/<area>/` (`*.def.ts` pure definitions and view builders, `*.run.ts` the work over services and `io`), `features/defs.ts` (pure registry, the web's `NAV`), `registry.ts` (implementations, `createRpcHost`), `context.ts` (`implement`). |
| `src/cli/` | Only cli/ prints. `manifest.ts` defines every hand-written command, argument and option once (zod, `CommandName`) and adds the shared core's commands from their CLI hints (`operations/`); `args.ts` builds commander from it, `index.ts` dispatches an operation command through `operations/` and the rest through `commands/registry.ts` (`HANDLERS`). `output/` (colours, progress, `follow()`, table), `tui/` (screen toolkit), `menu/` (the interactive menu; `render-view.ts` and `io-menu.ts` draw and run the shared core's views), `services/` (data for commands and menu, no printing), `commands/` by feature. `commands/projects/here.ts` is the ONE way to find "the project this folder is in" (`locateHere`, `joinHere`). |
| `src/core/` | Pure or host-side basics: `schema/` (zod by area: `XxxSchema` constants, `Xxx` types; JSON Schemas in `schemas/` are generated), `config/` (`DEFAULTS`, loader, machine config), `local-config/` (`.sandbox-config.json`: overrides, trust, policy), `run/` (`resolveRun`), `detect/` (pure project detection), `util/` (`fail`, fs, paths, jsonc, process). |
| `src/shared/` | Host and guest: `channel/` (message schemas, `RunDir`, the one-shot `secrets.ts` file), `io/` (`JsonFile`, atomic writes, `safeRemove`), `download/` (`Downloader`, checksums, GitHub page fallback), `pty/` (ptyhost protocol and client), `paths/` (guest paths, project ids, host <-> guest folders), `network/`, `apps/`, `scripts.ts`, `system.ts` (`SYSTEM.*`). |
| `src/host/` | On the PC: `launch/` (`generateSandbox`, .wsb, mappings), `channel/` (`SandboxChannel`), `projects/`, `guard/` (`RepoGuard`), `profile/` (secrets stripping, Claude profile, accounts), `sandbox/` (platform, probe, window), `life/` (stop events, `SessionLedger`, keep-awake), `install/` + `update/` (managed install, updater), `secrets/` (`SecretStore`: DPAPI at rest; the one-shot secrets files), `vpn/` (login, NordVPN, `prepareVpn`), `sharing/` (other Windows users, folder ACLs), `migrate/`, `storage/`, `workspace-view/`, `network/`, `tools/`, `native.ts`. |
| `src/sync/` | History and claude-mem sync, the background `Watcher`. |
| `src/guest/` | In the sandbox, bundled by esbuild from `entries/` into `dist/runtime/*.js`: `boot/` (`Boot` steps), `daemon/` (sessions, provisioning, idle shutdown), `sessions/` (ptyhost, viewer), `agents/` (`AgentInstaller`), `toolchains/` (steps from `plan.ts`, one module per toolchain), `databases/` (`sbx-db`), `apps/`, `setup/`, `git/`, `network/`, `audit/`, `vpn/` (boot step: OpenVPN, kill switch, tunnel). |
| `sandbox/` | Copied into every launch folder: `boot/` (`logon.cmd` -> `trust.cmd` -> `bootstrap.ps1` -> `runtime\main.js`), `scripts/` (verb-noun `.ps1`), `csharp/` (csc helpers: `PtyHost.cs`, `GitShim.cs`, ...; Add-Type files). |
| `native/` | Shipped, runs on the PC: `csharp/HostTools/` (built on first use into `<storage>\bin`), `csharp/*.cs` Add-Type helpers, `scripts/` (PowerShell fallbacks and helpers). |
| `web/` | The web UI (React, Mantine, TanStack Query, xterm.js; bundled into `dist/web` by `scripts/bundle-web.mjs`): `rpc/` (typed client of the RPC socket), `render/` (Page and Fields as Mantine), `shell/`, `pages/`. Imports only `src/shared/web`, `src/app/kernel` and `src/app/features/defs`. |
| `scripts/` | `install.ps1` (the `irm \| iex` installer, PowerShell 5.1, keeps its inline C#), bundle, schemas, publishing. |
| `src/selftest/` | `npm test`: one suite per area (`<area>.test.ts`), helpers in `support/`. Live tests need Windows (csc + ConPTY). |

## Coding standard
- Classes for state with behaviour or a lifecycle (a store file, a channel, a scheduler, a screen); pure helpers stay
  module functions. Composition; inheritance only for abstract bases with template methods. Constructor parameters
  `private readonly`; no `public` keyword; alternate constructors are static factories.
- Exported module functions are `function` declarations with explicit return types; arrows for callbacks.
- `interface` for object shapes, `type` for unions, `readonly` on data and inputs, constant tables `as const` /
  `satisfies`. No `enum` or `namespace`.
- zod for every shape read from disk (`JsonFile` or `readValid`). lodash only in cli/, host/, sync/ and host-side core/.
- Errors the user can act on: `fail(message, fix)`. An empty `catch` says why in a comment. Messages are short, plain
  English, no jargon.
- Prettier, 120 columns. Comments: a short file header, one-line `/** */` where a name is not enough, no banners.
  `node:` prefix for built-ins, `import type` for types.
- C#: Allman braces, P/Invoke in a nested `NativeMethods` class with `SetLastError`, failures as `Win32Exception`, named
  constants, handles closed in `finally`; no interpolation, `?.`, `nameof` or expression bodies.
- PowerShell: `#Requires -Version 5.1`, `param()`, approved verbs, CRLF.

## Recipes
- **New setting or command:** `core/schema/` or `cli/manifest.ts` first (flags, menu and JSON Schema follow), then
  `DEFAULTS` + `config.example.json`, then docs.
- **New toolchain:** a module under `guest/toolchains/languages/`, a step in `toolchains/plan.ts`, schema + `DEFAULTS` +
  `config.example.json`, markers in `toolchains/catalogue.ts` / `core/detect` for `auto`, docs. Long work uses
  `execAsync` / async downloads so parallel steps keep going. Read the project through `projectWorkspace()`; with
  `duringSession()` never change machine-wide state that running sessions use.
- **Several projects in one sandbox:** the launch folder is the primary workspace. A project's guest path never depends
  on which project started the sandbox (git worktrees store absolute paths): inside a root it is
  `C:\Projects\<root>\<name>`, otherwise `C:\Workspace\<name>`, all decided in `shared/paths/projects.ts`. Code that
  assumed ONE workspace must take the project from `ProjectSpec` / the registry.
- **Databases on demand:** `sbx-db` (`guest/entries/db.ts` + `guest/databases/sbx-db.ts`) reads `session.json`:
  `databases` are this project's plans, `databaseCatalog` what it may start later. `--database <name>` adds plans at
  launch.

## Gotchas
- Mapped folders (this repo, `C:\AgentData`) refuse symlinks, junctions and rename-over, and SQLite WAL cannot map its
  shared memory there (keep databases on local disk).
  - Never `sed -i` here (it leaves `sedXXXXXX` files): use the Edit tool.
  - Moving a folder from the local disk into one fails silently; tools that unpack to %TEMP% and move (nvm) need a
    TEMP inside the target. Git Bash `rm -rf` can fail silently too: check the folder is gone.
- Backslash escapes get eaten in shell heredocs, `node -e` and template literals: write TypeScript with Edit/Write.
- SQL Server LocalDB and Docker cannot run in Windows Sandbox.
- Handled in code, keep it that way: postgres via `pg_ctl` (postgres.exe refuses admin), Volta shims are copies of
  `volta-shim.exe`, pnpm hoisted and Bun's cache on local disk, GitHub page fallback for the API rate limit, nvm's TEMP
  on the data disk, `.gitattributes` fixes line endings.
- Under an all-users install, `Set-Acl` on a storage folder re-propagates over the whole subtree (minutes): change
  only what differs and write a folder's own DACL without walking it (`native/csharp/FolderSecurity.cs`).

## CI and releases
- In `release.yml` / `ci.yml` a `pwsh` step ends with the exit code of its last native command: end with `exit 0`
  after commands that may return non-zero on purpose (git rev-parse, npm view ...).
- CI also builds on the official Node 22.0.0 zip (setup-node's 22.0.0 has a broken npm). Releases run no tests.
- Release: bump `version` in `package.json` and push to master; CI tags and publishes. The first npm publish is done
  once from the PC (`npm run publish:npm`).
