# Tools and databases

Everything installs once into persistent storage (`C:\AgentData` inside) and is reused by every later sandbox.

Only what the project needs gets installed. Every language defaults to **auto**, which your PC decides at launch from
the project's files in the workspace and one folder down (`go.mod`, `*.csproj`, `*.py` ...). A folder that isn't a
project yet gets the languages your PC has. The launch output lists each toolchain and why. `true` / `false` in the
config always win.

## Languages

✅ means tested on real projects. Everything else is installed for real in a sandbox and checked with a small project.

| | | Version from |
|---|---|---|
| **Node** ✅ | nvm, npm, pnpm and yarn via corepack, **Volta** when the project pins it | `.nvmrc`, `.node-version`, `package.json` volta, your PC |
| **Python** ✅ | CPython 3 + pip, Python 2.7 (`python2`), uv, pyenv-win when your PC uses pyenv | `.python-version` |
| **Rust** ✅ | rustup, cargo: the msvc host when MSVC is on (like most PCs), else GNU; `rust.crates` prebuilt via cargo-binstall | `rust-toolchain.toml` |
| **C / C++** ✅ | MinGW-w64 GCC, CMake, Ninja, premake5, win_flex/bison | |
| MSVC | `cl`, `link` and the Windows SDK, portable (~1-2 GB once); `vcvars64.bat` and `vswhere` work. Needs `toolchains.msvc.acceptLicense` | `*.vcxproj`, `CMakePresets.json`, scripts calling vcvars/vswhere, Rust when your PC uses MSVC |
| **C# / .NET** ✅ | .NET SDK, workloads, global tools, .NET Framework reference assemblies (net48, net472 ...) | `global.json` |
| Go | go.dev, `GOTOOLCHAIN=auto` | `go.mod` |
| Java | Temurin JDK, Maven, Gradle | `.java-version`, `.sdkmanrc` |
| Ruby | RubyInstaller, gems | `.ruby-version` |
| PHP | PHP with common extensions, Composer | `.php-version` |
| Deno | single binary | |
| Bun | single binary; `bun` on PATH (claude-mem needs it) | auto: when the project has `bun.lock`, `bun.lockb` or `bunfig.toml`, or claude-mem sync is on for the claude agent |
| uv | uv, the Python package manager (`uv tool install`; claude-mem's search index needs it) | auto: when the project has `uv.lock`, a `[tool.uv]` pyproject.toml, `toolchains.python.tools`, or an agent installed with uv, or claude-mem sync is on for the claude agent |
| PowerShell 7 | portable `pwsh` (`powershell` stays 5.1), a Windows Terminal profile | `#Requires -Version 7` or `pwsh ...` in a `.ps1` |
| CLI tools (`toolchains.cli`) | `gh` (only with git access `full`; `auto` = a `.github` folder), `zstd` (off unless `true`), `openssl` (on: a small `openssl.exe` launcher for Git for Windows' own, so programs that start it without a shell, like Rust's `Command::new("openssl")`, find it) | |
| VS Code | portable, `code .`; settings and extensions are kept | auto: when VS Code is installed on this PC |
| Mesa 3D (opt-in) | software OpenGL 4.5, and with `mesa.vulkan` software Vulkan 1.4 (lavapipe) | |

Global packages per ecosystem can be listed in the config (`npm`, `uv tool`, `go install`, `gem`, `cargo install`,
`dotnet tool`, rustup components). Installs that persist on their own: `npm i -g`, `pip`, `cargo install`,
`dotnet tool -g`, `uv tool`, `go install`, `gem install`. Real installers (MSI, winget) need a hook script.

### MSVC

Microsoft's compiler is installed without its installer, from the same packages Visual Studio uses (each one checked
against Microsoft's SHA-256). It takes about two minutes the first time and is reused afterwards. Using it is governed
by the [Visual Studio licence terms](https://visualstudio.microsoft.com/license-terms/), so it is only installed with
`toolchains.msvc.acceptLicense: true`. `msvcVersion` and `sdkVersion` pin versions (default: the newest).

### Rust builds

`rust.host` is the Rust target: `auto` (default) uses `x86_64-pc-windows-msvc` when MSVC is on and `-gnu` (MinGW)
otherwise. `rust.crates` lists cargo binaries to install; they are downloaded prebuilt (cargo-binstall) when the crate
publishes a Windows build, else compiled once.

`rust.targetDir` keeps the sandbox's builds apart from your PC's: `"separate"` (default) builds into
`target\sandbox` of each checkout (git worktrees of several agents each get their own, wherever cargo is run from),
`"shared"` uses cargo's normal `target`, `"local"` uses the sandbox's own disk (fast, lost on close). A
`CARGO_TARGET_DIR` you set yourself always wins. sccache keeps its cache in `C:\AgentData\cache\sccache` unless the
project sets `SCCACHE_DIR`.

The first time, `C:\AgentData\tools\rust\cargo\config.toml` gets Windows-friendly defaults: a quarter of the CPUs
as build jobs (2 to 8, within the sandbox's build budget: several agents often build at once, and the memory
governor slows them down when memory runs short) and, for the GNU host, `debug =
"line-tables-only"` (full debug info made test executables bigger than the 2 GB Windows allows). It is never
overwritten; edit it freely.

Git in the sandbox uses `core.autocrlf=input`: checkouts made inside keep the repo's line endings (LF), and a checkout
from your PC still shows as unchanged. `py` (`py -3`, `py -2`, `py -3.12`) runs the sandbox's Python.

### Graphics

| | |
|---|---|
| `sandbox.vGpu: true` | the PC's GPU through Direct3D 12 (`WGPU_BACKEND=dx12`) |
| `mesa.enabled` | OpenGL 4.5 on the CPU: copy `opengl32.dll` + `libgallium_wgl.dll` from `%MESA_DIR%` next to the program |
| `mesa.vulkan` | Vulkan 1.4 on the CPU, for every program (`WGPU_BACKEND=vulkan`); `vulkaninfo` is on PATH |

### Mapped folders

The workspace and `C:\AgentData` are folders shared from your PC, and Windows Sandbox allows no symlinks or junctions
in them. The sandbox sets pnpm to a flat `node_modules`, keeps Bun's cache on its own disk and turns off Gradle's
file watching. npm workspaces with `file:` links, Deno's `node_modules` mode and Bun lockfile saves still cannot work
there; use a folder on `C:\` outside them.

## Databases

Each database starts only when the project needs it. That's found from compose images, dependencies in every
ecosystem (pg, psycopg, Npgsql, mongoose, ioredis, AWS DynamoDB SDKs ...), Prisma and ORM config, CloudFormation /
SAM / Terraform tables, connection strings and `.env` templates. A project with only an ORM gets the database your PC
has installed. The launch output says what was found and why. Data is kept; servers listen on localhost only.

Start any of them yourself: `--database postgres` (repeatable) at launch, `sbx-db start redis` in a terminal inside,
or `sandbox db start redis` from your PC. `sbx-db` / `sandbox db` alone lists what runs; `stop <name>` stops one.

| | Connect with |
|---|---|
| **PostgreSQL** | `postgres://postgres@localhost:5432/postgres`, no password; psql and pg_dump on PATH |
| **MySQL** (MariaDB) | `mysql://root@127.0.0.1:3306`, no password |
| **MongoDB** | `mongodb://127.0.0.1:27017`, mongosh on PATH |
| **Redis** | `redis://127.0.0.1:6379` |
| **DynamoDB Local** | `http://localhost:8000`; web UI (dynamodb-admin) at <http://localhost:8001>; AWS SDKs connect automatically |

Not possible inside Windows Sandbox: **SQL Server** (LocalDB cannot start there) and **Docker** (no nested
virtualization). Compose projects use the databases above.

## Agents

| | |
|---|---|
| **Claude Code** ✅ | copied from your PC, or installed |
| Codex, Gemini | supported |
| opencode, Qwen Code, Crush, GitHub Copilot CLI, Kilo Code, Amp, Cline, Continue, Kimi, Aider | untested, each from its official package |
| Reasonix, CodeWhale (`deepseek`) | untested; community agents for DeepSeek, which has no official CLI |

Every configured agent is a command in every terminal tab (`claude`, `codex` ...): installed ones start, the others install on first use (`sbx-agent list` shows which). Codex keeps its SQLite databases on the sandbox's own disk (`harnesses.codex.localState`): they are restored at start and saved when its sessions end, so they survive between sandboxes.

### PATH

One planner decides the machine PATH: ordered, no duplicates (case, trailing slash), no missing folders, no pinned Node version (`nvm use` moves the `C:
vm
odejs` link instead). Every new PowerShell, PowerShell 7, cmd and Git Bash starts with the current machine and user PATH, whatever started it (an all-users profile, cmd's AutoRun and a Git `profile.d` file call `pathsync.exe`), Explorer and Windows Terminal are told when it changes, and agent sessions and `sandbox exec` get the machine PATH folders added since the sandbox started.

Add your own under `harnesses` in the config, with `npmPackage` / `npmBin`, `uvPackage` / `uvBin` or `hostExecutable`.

## Apps and tools

Optional desktop apps and command-line tools, chosen in the menu (**Apps**: by category, searchable, with
sizes and what is installed already) or in `apps.install`:

| Category | Apps |
| --- | --- |
| Editors | Notepad++, Sublime Text, Neovim (VS Code: see [VS Code](#vs-code) above) |
| Database clients | DBeaver, pgAdmin 4, HeidiSQL, DB Browser for SQLite, MongoDB Compass, Redis Insight, DbGate, Beekeeper Studio, dynamodb-admin |
| API clients | Bruno, Insomnia |
| Git | SourceGit, GitHub Desktop and Jujutsu `jj` (both need git access `full`: they push without the sandbox's git guard), lazygit |
| Utilities | 7-Zip, WinMerge, Everything, Sysinternals Suite, ImHex (Windows Terminal is on by default) |
| Browsers | Chrome for Testing, Firefox |
| Game development | Godot, Blender, LÖVE, Defold, Pixelorama, Tiled (Mesa is added for OpenGL without a GPU) |
| Cloud and Kubernetes | kubectl, Helm, k9s, Terraform, Azure CLI, Google Cloud CLI, AWS CLI |
| Diagrams and docs | draw.io, Pandoc |
| Network and HTTP | mitmproxy, xh, grpcurl, k6 |
| Command-line tools | jq, yq, ripgrep, fd, bat, fzf, delta, just, hyperfine, watchexec, protoc, Ninja, FFmpeg, SQLite tools, ShellCheck, Gitleaks, ast-grep (structural code search), rust-analyzer (Rust language server; add the `rust-src` component for the standard library) |

Each is downloaded once into `C:\AgentData\tools\apps` and kept. Nothing is installed with an installer: archives are
unpacked, installers opened with 7-Zip and MSIs extracted, so it all survives the sandbox closing. Programs get a
desktop and **Start > Sandbox apps** shortcut; command-line tools are on PATH. Downloads are checked against the
checksum the publisher gives (GitHub releases, and most vendors); the Visual C++ runtime is installed first.

**Your own programs** (`apps.custom`, or **c** in the Apps screen): a GitHub repository and a pattern for the release
file, or an https link, plus the program to start (and whether it is a command-line tool). They install the same way.

```jsonc
"apps": {
  "install": ["dbeaver", "bruno", "jq", "ripgrep"],
  "custom": { "mytool": { "name": "My Tool", "github": "me/mytool", "asset": "windows-x64\\.zip$", "exe": "mytool.exe", "cli": true } }
}
```

### VS Code

VS Code (on when VS Code is installed on this PC, `toolchains.vscode.enabled` `"auto"`) is set up for the sandbox: it points at the sandbox's own JDK (with the right Java version),
Python, Go, C/C++ compiler (MSVC or MinGW), CMake, .NET, PHP, Ruby, Deno, Git, and has PowerShell 7 and Git Bash
terminals. It installs the extensions for the languages and databases the project uses (Java pack, Python, Go,
rust-analyzer, C/C++, C#, ESLint, Prettier, SQLTools ...), the ones the project recommends in
`.vscode/extensions.json`, and any in `toolchains.vscode.extensions`. Only missing extensions are downloaded, in the
background (`logs\vscode-extensions.log`). Your own VS Code settings are kept; `toolchains.vscode.setup: false` turns
this off.

## Also in the sandbox

- Windows Terminal (new tabs open in the project folder), your desktop look (theme, accent, taskbar, wallpaper,
  regional settings)
- Agent sessions run in Microsoft's current pseudo console (downloaded once; `provisioning.conpty`), so the screen
  stays clean when you resize and the mouse wheel scrolls back through the output
- Git for Windows with Git Bash, your name and email only
- Your Claude settings, CLAUDE.md, commands, agents, skills, plugins and MCP servers, with credentials stripped
- Conversation history and claude-mem, synced both ways
- For games: Mesa, or `sandbox.vGpu: true` for the GPU; audio; game data from a mapped folder
