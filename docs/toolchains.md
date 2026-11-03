# Tools and databases

Everything installs once into persistent storage (`C:\AgentData` inside) and is reused by every later sandbox.

Only what the project needs is installed. Every language defaults to **auto**: at launch your PC looks at the
project's files, in the workspace and one folder down (`go.mod`, `*.csproj`, `*.py` ...). A folder that is not a
project yet gets the languages your PC has. The launch output lists each toolchain and why. `true` or `false` in your
settings always win.

## Languages

✅ means tested on real projects. The others are installed for real in a sandbox and checked with a small project.

|                              |                                                                                                                                                                                                                                  | Version from                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Node** ✅                  | nvm, npm, pnpm and yarn through corepack, **Volta** when the project pins it. **Playwright** works with Edge, which every sandbox has (`channel: 'msedge'`); browsers that `npx playwright install` downloads are kept           | `.nvmrc`, `.node-version`, `package.json` volta, your PC                                                                               |
| **Python** ✅                | CPython 3 and pip, Python 2.7 (`python2`), uv, pyenv-win when your PC uses pyenv. `py` (`py -3`, `py -2`, `py -3.12`) runs the sandbox's Python                                                                                  | `.python-version`                                                                                                                      |
| **Rust** ✅                  | rustup and cargo: the MSVC host when MSVC is on, else GNU; `rust.crates` prebuilt through cargo-binstall ([Rust builds](#rust-builds))                                                                                           | `rust-toolchain.toml`                                                                                                                  |
| **C / C++** ✅               | MinGW-w64 GCC, CMake, Ninja, premake5, win_flex/bison                                                                                                                                                                            |                                                                                                                                        |
| MSVC                         | `cl`, `link` and the Windows SDK, portable (about 1-2 GB, once); `vcvars64.bat` and `vswhere` work. Needs `toolchains.msvc.acceptLicense` ([MSVC](#msvc))                                                                        | `*.vcxproj`, `CMakePresets.json`, scripts that call vcvars/vswhere, Rust when your PC uses MSVC                                        |
| Unreal                       | Visual Studio Community 2022 with the C++ game workload, and the DirectX runtime. Needs `toolchains.unreal.acceptLicense` ([Unreal Engine](#unreal-engine))                                                                      | `*.uproject`, `*.uplugin`                                                                                                              |
| **C# / .NET** ✅             | .NET SDK, workloads, global tools, .NET Framework reference assemblies (net48, net472 ...)                                                                                                                                       | `global.json`                                                                                                                          |
| Go                           | from go.dev, `GOTOOLCHAIN=auto`                                                                                                                                                                                                  | `go.mod`                                                                                                                               |
| Java                         | Temurin JDK, Maven, Gradle                                                                                                                                                                                                       | `.java-version`, `.sdkmanrc`                                                                                                           |
| Ruby                         | RubyInstaller, gems                                                                                                                                                                                                              | `.ruby-version`                                                                                                                        |
| PHP                          | PHP with common extensions, Composer                                                                                                                                                                                             | `.php-version`                                                                                                                         |
| Deno                         | single binary                                                                                                                                                                                                                    |                                                                                                                                        |
| Bun                          | single binary, `bun` on PATH                                                                                                                                                                                                     | auto: `bun.lock`, `bun.lockb` or `bunfig.toml`, or claude-mem sync on for Claude                                                       |
| uv                           | the Python package manager (`uv tool install`)                                                                                                                                                                                   | auto: `uv.lock`, a `[tool.uv]` pyproject.toml, `toolchains.python.tools`, an agent installed with uv, or claude-mem sync on for Claude |
| PowerShell 7                 | portable `pwsh` (`powershell` stays 5.1), with a Windows Terminal profile                                                                                                                                                        | `#Requires -Version 7` or `pwsh ...` in a `.ps1`                                                                                       |
| CLI tools (`toolchains.cli`) | `gh` (only with git access `full`; `auto` = the project has a `.github` folder), `zstd` (off unless `true`), `openssl` (a small `openssl.exe` that starts Git for Windows' own, so programs that run it without a shell find it) |                                                                                                                                        |
| VS Code                      | portable, `code .`; settings and extensions are kept ([VS Code](#vs-code))                                                                                                                                                       | auto: when VS Code is installed on this PC                                                                                             |
| Mesa 3D (opt-in)             | software OpenGL 4.5, and with `mesa.vulkan` software Vulkan 1.4 (lavapipe) ([graphics](#graphics))                                                                                                                               |                                                                                                                                        |

Global packages for each ecosystem can be listed in your settings (`npm`, `uv tool`, `go install`, `gem`,
`cargo install`, `dotnet tool`, rustup components). These installs persist on their own: `npm i -g`, `pip`,
`cargo install`, `dotnet tool -g`, `uv tool`, `go install`, `gem install`. Real installers (MSI, winget) need a
[hook](configuration.md#hooks).

Git in the sandbox uses `core.autocrlf=input`: checkouts made inside keep the repo's line endings (LF), and a checkout
from your PC still shows as unchanged.

### MSVC

Microsoft's compiler is installed without its installer, from the same packages Visual Studio uses, each checked
against Microsoft's SHA-256. It takes about two minutes the first time. Its use is governed by the
[Visual Studio licence terms](https://visualstudio.microsoft.com/license-terms/), so it is installed only with
`toolchains.msvc.acceptLicense: true`. `msvcVersion` and `sdkVersion` pin versions (default: the newest).

### Unreal Engine

`toolchains.unreal` sets a sandbox up for Unreal Engine 5. It installs Visual Studio Community 2022 with the "Game
development with C++" workload, MSVC v143, a Windows 11 SDK, the C++ profiling tools, the .NET Framework 4.6.2 and 4.8
targeting packs, Visual Studio's Unreal support, the Epic Games Launcher, and the June 2010 DirectX End-User Runtime.

```json
{ "toolchains": { "unreal": { "enabled": true, "acceptLicense": true } }, "sandbox": { "vGpu": true } }
```

- Unreal's build tool finds Visual Studio through its installer, so the portable MSVC is not enough. With `unreal` on,
  the portable MSVC is left out and Rust builds with Visual Studio's MSVC.
- Visual Studio is a real installer, so it runs at every boot and takes about 7 GB of the sandbox's disk (about 40 GB,
  shared with the paging file and every build). It is installed only when 20 GB are free; otherwise boot says so and
  skips it.
- Visual Studio installs in the background: the agent starts first, and Visual Studio (with Unreal, and Rust when it
  builds with the MSVC host) finishes some minutes later, at a lower priority. A project that needs it in the meantime
  is told that it is still installing. With a VPN or `network.allowOnly` it installs before the agent starts, because
  their firewall would cut its downloads.
- `keepInstallFiles` (default on) saves an offline copy of its install files in `tools\visualstudio` once (about 10 GB,
  only when 15 GB are free). Later boots then install without downloading; otherwise each boot downloads 5-8 GB. The
  installers run only when Microsoft's signature on them checks out.
- `acceptLicense: true` is required: Visual Studio Community and the DirectX runtime come under Microsoft's licence
  terms. `components` adds more Visual Studio workload or component IDs.
- The engine itself is not installed. Sign in to the Epic Games Launcher (Start menu) and install it there, or build it
  from Epic's source on GitHub. For the GPU, turn on `sandbox.vGpu`.
- Your Epic Games Launcher sign-in can be kept between sandboxes: turn on `accounts.epic.share` and sign in once (or
  take your PC's with `sandbox account import epic`). See [accounts](accounts.md).
- `persistEngines` and `derivedDataCache` (both on by default) are for engines the launcher installs and Unreal's
  shader cache, kept in `tools\unreal`; engines on your PC can be mapped read-only with `pcInstalls.unrealEngines`. They
  come in a later version ([game engines](game-engines.md)).
- Visual Studio is shared with the other toolchains that need it (Flutter's Windows desktop builds and Unity's
  `windows-il2cpp` module get its Build Tools, under `toolchains.msvc.acceptLicense`): one install serves them all.

#### C/C++ and Visual Studio: what persists

| What          | Kept between sandboxes                                             |
| ------------- | ------------------------------------------------------------------ |
| MinGW         | kept                                                               |
| MSVC portable | kept                                                               |
| VS layout     | kept (the offline copy of the install files, `tools\visualstudio`) |
| VS install    | redone from the layout at boot, no download (about 10-20 minutes)  |
| autosdk       | kept                                                               |

- The layout is made with the installer's scratch folder on the same disk. If the installer still crashes (exit
  `0xE0434352`), the layout is built on the sandbox's own disk (12 GB free needed), copied over, and the scratch copy is
  deleted. A failure is explained in the log, and the installer's log is copied to
  `C:\AgentData\logs\vs-layout-<date>.log`.
- `toolchains.unreal.visualStudio: "autosdk"` (experimental, default `"full"`) skips Visual Studio: UnrealBuildTool finds
  the portable MSVC through an AutoSDK tree (`tools\unreal\autosdk`, copies, made once and kept). The editor's Visual
  Studio integration is not available. It needs `toolchains.msvc`, turned on for you under Unreal's licence acceptance.

### Game, modding and mobile toolchains

These settings are in place; the installs come in a later version. Each is `"auto"` by default, and the licensed ones
(Unity, the FiveM server, the Android SDK) install only once you set their `acceptLicense`. A project file can never
accept a licence for you.

|                            | What it sets up                                                | Found from                                                |
| -------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| Unity ([unity](unity.md))  | the editor version the project asks for, modules, Unity Hub    | `ProjectSettings/ProjectVersion.txt`                      |
| Godot ([engines](game-engines.md)) | Godot (and its .NET build), export templates           | `project.godot`                                           |
| Steam ([steam](steam.md))  | SteamCMD and `sbx-steam`, the Steam client when asked          | `steam_appid.txt`, `steam_api64.dll`, `steam_api.dll`     |
| FiveM / RedM ([fivem](fivem.md)) | the FXServer with txAdmin and `sbx-fivem`                | `fxmanifest.lua`, `__resource.lua`                        |
| Android ([android](android.md)) | the SDK and a JDK (no emulator), `sbx-android`            | Gradle's `com.android`, `AndroidManifest.xml`, Flutter, React Native |
| Flutter, Dart, React Native ([mobile](mobile.md)) | the SDKs, `eas-cli`                     | `pubspec.yaml`, `package.json` with `react-native` / `expo` |
| Kotlin                     | `kotlinc` (`toolchains.java.kotlin`, off by default)           | `*.kt` turns Java on                                      |

Flutter and React Native bring the Android SDK, and the Android SDK brings a JDK. Sign-ins these tools use (Steam,
Unity, a FiveM server key, signing keys) are in [accounts](accounts.md). `pcInstalls` maps games, engines and editors
installed on your PC read-only into sandboxes ([configuration](configuration.md#installs-on-this-pc)).

### Rust builds

- **`rust.host`:** `auto` (default) uses `x86_64-pc-windows-msvc` when MSVC (or Unreal) is on, and `-gnu` (MinGW)
  otherwise.
- **`rust.crates`:** cargo binaries to install. They are downloaded prebuilt (cargo-binstall) when the crate publishes a
  Windows build, else compiled once.
- **`rust.targetDir`:** keeps the sandbox's builds apart from your PC's. `"auto"` (default) builds on the sandbox's
  own disk when C: has 25 GB free at boot (fast, and it spares your PC's disk), else like `"separate"`, with a
  warning that builds then write through the mapped workspace. `"separate"` builds into
  `target\sandbox` of each checkout, so each agent's git worktree gets its own; `"shared"` uses cargo's normal `target`;
  `"local"` uses the sandbox's own disk (fast, lost on close). A `CARGO_TARGET_DIR` you set always wins.
- **`rust.linker`, `rust.linkSlots`:** on the GNU host, `"lld"` (default, far less memory than GNU ld) or `"gnu"`, and
  how many programs may link at once in the whole sandbox (`"auto"` = one per 6 GB of the sandbox's memory, 1 to 4).
  When this PC is under load the memory governor also lets only one linker run at a time.
- sccache keeps its cache in `C:\AgentData\cache\sccache` unless the project sets `SCCACHE_DIR`.

The first time, `C:\AgentData\tools\rust\cargo\config.toml` gets Windows-friendly defaults: a quarter of the CPUs as
build jobs (2 to 8, within the sandbox's build budget) and, for the GNU host, `debug = "line-tables-only"` (full debug
info made test programs bigger than the 2 GB Windows allows). It is never overwritten, so edit it freely.

### Graphics

|                      |                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `sandbox.vGpu: true` | your PC's GPU through Direct3D 12 (`WGPU_BACKEND=dx12`)                                                   |
| `mesa.enabled`       | OpenGL 4.5 on the CPU: copy `opengl32.dll` and `libgallium_wgl.dll` from `%MESA_DIR%` next to the program |
| `mesa.vulkan`        | Vulkan 1.4 on the CPU, for every program (`WGPU_BACKEND=vulkan`); `vulkaninfo` is on PATH                 |

### Mapped folders

The workspace and `C:\AgentData` are folders shared from your PC, and Windows Sandbox allows no symlinks or junctions
in them. So the sandbox sets pnpm to a flat `node_modules`, keeps Bun's cache on its own disk and turns off Gradle's
file watching. npm workspaces with `file:` links, Deno's `node_modules` mode and saving Bun's lockfile still fail
there: use a folder on `C:\` outside them.

### PATH

One planner sets the machine PATH: in order, without duplicates or missing folders, and with no fixed Node version
(`nvm use` moves the `C:\nvm\nodejs` link instead). Every new PowerShell, cmd or Git Bash starts with the current
machine and user PATH, whatever started it. Agent sessions and `sandbox exec` also get folders added to the machine PATH
since the sandbox started.

Python and Rust that are already installed in `C:\AgentData\tools` (`python\python-<version>`, `rust\cargo`) are on
PATH for every project and terminal in the sandbox, even one whose own files did not turn them on (they go last, so a
project's own toolchains still win). Nothing is installed or changed for that: a project that wants a version, or a
toolchain that is not installed yet, still gets it from its own settings and detection. A `python` or `python.cmd`
file you put in `C:\AgentData\tools\bin` as a workaround is no longer needed and can be deleted.

Git's `usr\bin` (coreutils) is last on PATH, after MSVC's folder, and its `link.exe` is renamed to
`link-coreutils.exe` in the sandbox's copy of Git. Otherwise `link` was the coreutils program, which made MSVC Rust
builds fail with os error 1392.

## Databases

Each database starts only when the project needs it. That is found from compose images, dependencies in every ecosystem
(pg, psycopg, Npgsql, mongoose, ioredis, the AWS DynamoDB SDKs ...), Prisma and ORM config, CloudFormation / SAM /
Terraform tables, connection strings and `.env` templates. A project with only an ORM gets the database your PC has
installed. The launch output says what was found and why. Data is kept, and servers listen on localhost only.

Start one yourself with `--database postgres` at launch, `sbx-db start redis` inside, or `sandbox db start redis` from
your PC. `sbx-db` or `sandbox db` alone lists what runs; `stop <name>` stops one.

|                     | Connect with                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| **PostgreSQL**      | `postgres://postgres@localhost:5432/postgres`, no password; psql and pg_dump on PATH                        |
| **MySQL** (MariaDB) | `mysql://root@127.0.0.1:3306`, no password                                                                  |
| **MongoDB**         | `mongodb://127.0.0.1:27017`, mongosh on PATH                                                                |
| **Redis**           | `redis://127.0.0.1:6379`                                                                                    |
| **DynamoDB Local**  | `http://localhost:8000`; web UI (dynamodb-admin) at <http://localhost:8001>; AWS SDKs connect by themselves |

Not possible in Windows Sandbox: **SQL Server** (LocalDB cannot start there) and **Docker** (no nested
virtualization). Compose projects use the databases above.

## Agents

|                                                                                              |                                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Claude Code** ✅                                                                           | copied from your PC, or installed                                  |
| Codex, Gemini                                                                                | supported                                                          |
| opencode, Qwen Code, Crush, GitHub Copilot CLI, Kilo Code, Amp, Cline, Continue, Kimi, Aider | untested, each from its official package                           |
| Reasonix, CodeWhale (`deepseek`)                                                             | untested; community agents for DeepSeek, which has no official CLI |

Every configured agent is a command in every terminal tab (`claude`, `codex` ...). Installed ones start; the others
install on first use (`sbx-agent list` shows which). Add your own under `harnesses` in your settings
([agent settings](configuration.md#agent-settings)).

## Apps and tools

Optional desktop apps and command-line tools. Pick them in the menu (**Apps**: by category, searchable, with sizes) or
list them in `apps.install`:

| Category             | Apps                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent add-ons        | rtk, Headroom, ccusage, Playwright MCP, Context7 MCP, claude-mem, REA ([details](#agent-add-ons)); Perplexity MCP, Perplexity Computer MCP, Comet MCP, Chrome DevTools MCP, Browser Use MCP ([agents-web.md](agents-web.md)) |
| Editors              | Notepad++, Sublime Text, Neovim ([VS Code](#vs-code) is its own setting)                                                                                                                                     |
| Database clients     | DBeaver, pgAdmin 4, HeidiSQL, DB Browser for SQLite, MongoDB Compass, Redis Insight, DbGate, Beekeeper Studio, dynamodb-admin                                                                                |
| API clients          | Bruno, Insomnia                                                                                                                                                                                              |
| Git                  | SourceGit, lazygit, GitHub Desktop and Jujutsu `jj` (these two need git access `full`: they push past the sandbox's git guard)                                                                               |
| Utilities            | 7-Zip, WinMerge, Everything, Sysinternals Suite, ImHex (Windows Terminal is on by default)                                                                                                                   |
| Browsers             | Chrome for Testing, Firefox, Comet (Perplexity's agentic browser, [agents-web.md](agents-web.md))                                                                                                           |
| Game development     | Godot, Blender, LÖVE, Defold, Pixelorama, Tiled (Mesa is added for OpenGL without a GPU)                                                                                                                     |
| Reverse engineering  | Ghidra, x64dbg, ILSpy, dnSpyEx, Detect It Easy, PE-bear, Cutter, radare2, JADX, System Informer (for programs you are allowed to analyse)                                                                    |
| Cloud and Kubernetes | kubectl, Helm, k9s, Terraform, Azure CLI, Google Cloud CLI, AWS CLI                                                                                                                                          |
| Diagrams and docs    | draw.io, Pandoc                                                                                                                                                                                              |
| Network and HTTP     | mitmproxy, xh, grpcurl, k6                                                                                                                                                                                   |
| Command-line tools   | jq, yq, ripgrep, fd, bat, fzf, delta, just, hyperfine, watchexec, protoc, Ninja, FFmpeg, SQLite tools, ShellCheck, Gitleaks, ast-grep, rust-analyzer (add the `rust-src` component for the standard library) |

Each is downloaded once into `C:\AgentData\tools\apps` and kept. Nothing runs an installer: archives are unpacked,
installers are opened with 7-Zip and MSIs are extracted, so everything survives the sandbox closing. Programs get a
desktop and **Start > Sandbox apps** shortcut; command-line tools go on PATH. Downloads are checked against the checksum
the publisher gives (GitHub releases and most vendors).

**Your own programs** (`apps.custom`, or **c** in the Apps screen): a GitHub repository and a pattern for the release
file, or an https link, plus the program to start (and whether it is a command-line tool). They install the same way.

```jsonc
"apps": {
  "install": ["dbeaver", "bruno", "jq", "ripgrep"],
  "custom": { "mytool": { "name": "My Tool", "github": "me/mytool", "asset": "windows-x64\\.zip$", "exe": "mytool.exe", "cli": true } }
}
```

### Agent add-ons

Things that plug into the agents, in the **Agent add-ons** category of Apps. All are off by default except claude-mem.
rtk, Headroom, ccusage and the two MCP servers can be turned on only in your own settings, never by a project's
`.sandbox-config.json`.

- **rtk** ([rtk-ai/rtk](https://github.com/rtk-ai/rtk), `"rtk"`) shortens what shell commands print (git, tests,
  builds, `ls`, `grep` ...) before the agent reads it, so a session uses fewer tokens. A pinned release (rtk 1.0.1, the
  Apache-2.0 `rtk-oss` Windows build, SHA-256 checked) goes on PATH. For Claude Code it adds rtk's hook to the
  sandbox's managed settings (`C:\Program Files\ClaudeCode\managed-settings.json`, rewritten every boot); your own
  Claude settings are not changed. Other agents are told in their sandbox guide to put `rtk` in front of shell commands.
  Claude's own Read, Grep and Glob tools do not go through it.
- **Headroom** ([headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom), Apache-2.0, `"headroom"`)
  compresses what Claude Code sends to the model (tool output, logs, files, older turns). It is a proxy that **sits in
  Claude Code's API path**, so it sees your prompts and Claude Code's login or API key. The sandbox keeps it tight:
  - It runs only inside the sandbox on `127.0.0.1:8787`, and forwards only to `https://api.anthropic.com`.
  - It runs offline (`HEADROOM_OFFLINE=1`, telemetry off): no telemetry, update checks or model downloads. Its
    environment has none of the agents' keys, and its log (`C:\AgentData\logs\headroom.log`) hides keys and tokens.
  - Claude Code is pointed at it (`ANTHROPIC_BASE_URL` in the managed settings) only once the proxy answers at boot. If
    your agent environment sets `ANTHROPIC_BASE_URL` itself, Headroom is left out. If the proxy stops during a session,
    Claude Code cannot reach the API until the next sandbox or until you turn Headroom off.
  - It installs pinned: headroom-ai 0.41.0 with its `proxy` extra, with uv into a Python 3.13 venv in
    `C:\AgentData\tools\apps\headroom`. `sandbox\addons\headroom\requirements.txt` lists every package (95) at one
    version with its SHA-256, and uv installs with `--require-hashes`, wheels only (about 150 MB the first time). It
    works with Claude Code only.
- **ccusage** ([ryoppippi/ccusage](https://github.com/ryoppippi/ccusage), MIT, `"ccusage"`) reports token use and cost
  by day, month or session from the agents' logs: `ccusage daily`. It fetches current prices unless you add
  `--offline`.
- **Playwright MCP** ([microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp), Apache-2.0,
  `"playwright-mcp"`) lets Claude Code drive Microsoft Edge as the MCP server `sbx-playwright`.
- **Context7 MCP** ([upstash/context7](https://github.com/upstash/context7), MIT, `"context7"`) gives Claude Code
  current library docs as the MCP server `sbx-context7`. Library names and questions go to Upstash's context7.com.
- **claude-mem** is the `claudeProfile.syncClaudeMem` setting (on by default): it brings the database of the claude-mem
  plugin on your PC into the sandbox. The switch in Apps changes that setting.
- **REA** (Reverse Engineer Anything) installs from npm. Run `rea setup` once to add its MCP server to Claude Code and
  Codex.
- **Perplexity, Comet and browser-driving MCP servers** (Perplexity MCP, Perplexity Computer MCP, Comet MCP, Chrome
  DevTools MCP, Browser Use MCP) are in [agents-web.md](agents-web.md). They go into Codex's `config.toml` too.

ccusage 20.0.36, Playwright MCP 0.0.83, Context7 MCP 4.4.2 and the npm servers in [agents-web.md](agents-web.md)
install with `npm ci --ignore-scripts` from the
`package-lock.json` in `sandbox\addons\<id>`, which checks every package against its sha512. The MCP servers are added
to the sandbox's own Claude Code (user scope, names starting `sbx-`) every boot while on, and removed when off. Your own
MCP servers are left alone.

**Updating a pinned add-on** (for contributors): change its version in `src/shared/apps/catalogue.ts` and renew its lock
file. For npm: the version in `package.json`, then `npm install --package-lock-only --ignore-scripts`. For Headroom: the
version in `requirements.in`, then the `uv pip compile` command at the top of `requirements.txt`.

### VS Code

VS Code (`toolchains.vscode.enabled: "auto"`: on when VS Code is installed on this PC) is set up for the sandbox:

- It points at the sandbox's own JDK (with the right Java version), Python, Go, C/C++ compiler (MSVC or MinGW), CMake,
  .NET, PHP, Ruby, Deno and Git, and has PowerShell 7 and Git Bash terminals.
- It installs the extensions for the languages and databases the project uses (Java, Python, Go, rust-analyzer, C/C++,
  C#, ESLint, Prettier, SQLTools ...), the ones in the project's `.vscode/extensions.json`, and any in
  `toolchains.vscode.extensions`. Only missing ones are downloaded, in the background (`logs\vscode-extensions.log`).
- Your own VS Code settings are kept. `toolchains.vscode.setup: false` turns this off.

## Also in the sandbox

- Windows Terminal (new tabs open in the project folder) and your desktop look (theme, accent, taskbar, wallpaper,
  regional settings)
- Agent sessions in Microsoft's current pseudo console (downloaded once; `provisioning.conpty`), so the screen stays
  clean when you resize and the mouse wheel scrolls back
- Git for Windows with Git Bash, with only your name and email
- Your Claude settings, CLAUDE.md, commands, agents, skills, plugins and MCP servers, with credentials stripped
- Conversation history and claude-mem, synced both ways ([what comes back](security.md#coming-back))
- For games: Mesa, or `sandbox.vGpu: true` for the GPU; audio; game data from a mapped folder; Unreal Engine tools
