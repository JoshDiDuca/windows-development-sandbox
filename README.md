<div align="center">

# Windows Development Sandbox

**A throwaway Windows machine for every project, with or without an AI agent.**

[![Release](https://img.shields.io/github/v/release/JoshDiDuca/windows-development-sandbox?label=release)](https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest)
[![npm](https://img.shields.io/npm/v/windows-development-sandbox?logo=npm&label=npm)](https://www.npmjs.com/package/windows-development-sandbox)
[![CI](https://github.com/JoshDiDuca/windows-development-sandbox/actions/workflows/ci.yml/badge.svg)](https://github.com/JoshDiDuca/windows-development-sandbox/actions/workflows/ci.yml)
![Windows 10/11 Pro, Enterprise, Education](https://img.shields.io/badge/Windows-10%20%7C%2011%20Pro-0078D4)
![MIT](https://img.shields.io/badge/license-MIT-green)

</div>

Run it in a project folder to get a clean
[Windows Sandbox](https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-overview).
The folder is the workspace, the tools and databases it needs install themselves, and the rest of your PC is out of
reach. Close it and it is gone. Your project, tools, databases and logins are kept for next time.

## Install

```powershell
irm https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/install.ps1 | iex
```

The installer checks your PC, offers to turn on Windows Sandbox, and asks **1) Just me** or **2) Everyone on this PC**
(needs admin). It brings its own copy of Node.js and installs nothing else system-wide. It adds no Start menu shortcut
unless you ask.

- `sandbox update` installs a newer version, and can do it by itself. A running sandbox keeps its version until it
  restarts.
- A new version that fails to start is rolled back for you. `sandbox update --rollback` goes back one version by hand.

Needs Windows 10/11 **Pro, Enterprise or Education**. With Node.js 20+, `npm install -g windows-development-sandbox`
works too. More: [install options, upgrading, uninstall](docs/install.md).

## Use

```powershell
cd C:\code\my-app

sandbox            # the menu: agents, sessions, apps, settings, health ...
sandbox claude     # Claude Code in a sandbox for this folder
sandbox claude -t  # ... in this terminal (Ctrl+] detaches; the session keeps running)
sandbox start      # the sandbox, no agent
sandbox opencode   # any supported agent by name
sandbox web open   # (Beta) the web UI in your browser, signed in
```

The first start downloads what the project needs (a few minutes, once). Later starts take seconds.

> The command is `sandbox` (also `windows-development-sandbox`). Older versions also installed `agent-sandbox`,
> `claude-sbx`, `codex-sbx`, `gemini-sbx` and a few more; the installer and updater remove those. Use `sandbox <agent>`
> (for example `sandbox claude`) instead.

## What you get

|                           |                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Safe by default**       | The agent sees only your project folder. Credentials are stripped before anything is copied in, your LAN is blocked, and nothing the sandbox writes can run on your PC.                                                                                                                                                                                       |
| **Languages**             | Node, Python, Rust, C/C++ (GCC or MSVC), .NET (with .NET Framework targeting), Go, Java, Ruby, PHP, Deno, Bun, PowerShell 7, Unreal Engine tools. Also pnpm, yarn, Volta, uv, pyenv, Maven, Gradle, Composer, gh ...                                                                                                                                          |
| **Apps and tools**        | VS Code (set up for your languages) and Windows Terminal, plus about 80 optional apps by category: DBeaver, pgAdmin, Bruno, Godot, Blender, Ghidra, kubectl, jq, ripgrep ... and your own programs. Agent add-ons: rtk and Headroom (fewer tokens), ccusage, Playwright and Context7 MCP servers, claude-mem, REA. Playwright works with Edge out of the box. |
| **Databases**             | PostgreSQL, MySQL, MongoDB, Redis and DynamoDB Local (with a web UI). They start when the project uses them, or any time with `--database` or `sandbox db`.                                                                                                                                                                                                   |
| **Agents**                | Claude Code, Codex, Gemini, opencode, Qwen, Crush, Copilot, Kilo, Amp, Cline, Continue, Kimi, Aider and two DeepSeek agents.                                                                                                                                                                                                                                  |
| **Smart setup**           | Finds what the project needs from its files, follows its version files, installs in parallel and reuses everything.                                                                                                                                                                                                                                           |
| **Several projects**      | `sandbox claude` from another project joins the running sandbox, with that project's own folder, tools, versions, databases and environment. Start several agents at once (`--session claude@A --session codex@B`, or the menu) and attach to any of them from any terminal.                                                                                  |
| **Pick up again**         | After a crash or restart, `sandbox resume` reopens the last sessions. `sandbox restart` restarts the agents in place, and they continue their conversations.                                                                                                                                                                                                  |
| **Leaves nothing behind** | When an agent's session ends, everything it started ends too, background servers included. Nothing of this tool keeps running on your PC once the sandbox is closed.                                                                                                                                                                                          |
| **Agent commands**        | Turn them on (menu: Agents, or `sandbox agent-commands on`) and typing `claude`, `codex` ... in any folder starts that agent in a hidden sandbox and attaches your terminal. |
| **GitHub, safely**        | Give sandboxes a fine-grained GitHub token made just for them (`sandbox github login`, `github.shareToken`). `gh` and `git push` then work inside, and the token is never written to the sandbox's files.                                                                                                                                                     |
| **Feels like home**       | Your desktop look, Claude settings, MCP servers and conversation history come along, and history syncs back. Saved logins (`sandbox account`) are encrypted for your Windows user.                                                                                                                                                                            |

## Built for heavy workloads

Under load the sandbox slows down instead of failing, and it never takes your PC down with it. Nothing needs setting
up.

- **Sized to fit.** The sandbox gets only the memory your PC can keep in RAM for it, with room left for your PC.
- **A build budget.** Agents see the CPUs and memory they may really use. Each session gets a matching number of build
  jobs, written to `run\budget.json` for agents to plan with.
- **Slows down in steps.** As memory fills, build programs get lower priority, then less CPU, then compilers take
  turns. Builds get slower, but nothing is killed, and agents, shells and Windows are never touched.
- **Your PC has a say.** A watchdog on your PC asks the sandbox to ease off when your PC runs short of memory, CPU or
  disk.
- **A last resort.** Only at the very edge of the sandbox's memory limit is a build refused memory, so the sandbox
  stays up.
- **Answers afterwards.** `sandbox doctor` checks your paging file. `sandbox logs --crash` explains a past freeze or
  crash.

Details: [heavy load](docs/troubleshooting.md#the-sandbox-closes-under-heavy-load) and
[CPU, RAM and GPU settings](docs/configuration.md#cpu-ram-and-gpu).

## Commands

| Command                                  |                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `sandbox`                                | the menu: start agents, attach to sessions, pick apps, change any setting, search |
| `sandbox <agent>`                        | start an agent; `-t` for this terminal, `--headless` for no window                |
| `sandbox start`                          | the sandbox without an agent                                                      |
| `sandbox attach` / `sessions` / `status` | work with a running sandbox (this folder's project first)                         |
| `sandbox shell` / `close <id>`           | open PowerShell or cmd in a project as a session; end a session                   |
| `sandbox restart` / `resume`             | restart the agents in place; reopen the last sessions                             |
| `sandbox projects`                       | which projects a sandbox can open without a restart                               |
| `sandbox db [start\|stop <name>]`        | list, start or stop databases (`sbx-db` inside)                                   |
| `sandbox exec -- <cmd>`                  | run a command inside                                                              |
| `sandbox config get\|set\|reset\|list`   | read and change settings (`export` / `import` to share them)                      |
| `sandbox account`                        | save, switch and rename agent logins and Claude API keys                          |
| `sandbox github` / `vpn`                 | the GitHub token for sandboxes; the VPN login and status                          |
| `sandbox web`                            | (Beta) the web UI: start, stop, status, open                                      |
| `sandbox stop` / `hide` / `show`         | shut down; hide or show the window                                                |
| `sandbox data` / `storage`               | what is stored and how big; free space; move the data folder                      |
| `sandbox setup` / `doctor` / `repair`    | check this PC, see what will be installed, fix common problems                    |
| `sandbox engine`                         | (Alpha) the engines and what each can do on this PC                               |
| `sandbox logs [-f] [--crash]`            | the sandbox log, or the report of the last crash                                  |
| `sandbox update [--rollback]`            | update, or go back one version (`--version` shows the installed one)              |

Every command and option: [docs/commands.md](docs/commands.md).

## Beta and alpha features

These are off until you turn them on, and one setting turns each off again. Windows Sandbox stays the default engine
and keeps all its features.

| Feature                                                | Status | What it does                                                                                                                                                                                                    |
| ------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web UI** (`sandbox web`, `web.enabled`)              | Beta   | Agents, live terminals, status, apps, accounts and settings in your browser, with search (Ctrl+K). This PC only, signed in with a token; devices on your network if you allow them. [web-ui.md](docs/web-ui.md) |
| **Contained storage** (`sandbox storage contained on`) | Beta   | Tools, logins and logs in one disk image, mounted only while a sandbox runs. One admin prompt per launch. [Details](docs/configuration.md#contained-storage-beta)                                               |
| **VPN** (`sandbox vpn`, `vpn.enabled`)                 | Alpha  | The sandbox's traffic through NordVPN, your own OpenVPN profile or a WireGuard config, with a kill switch. A tunnel carrying traffic is not confirmed yet: read [vpn.md](docs/vpn.md) first.                    |
| **HCS engine** (`sandbox.engine: hcs`)                 | Alpha  | Headless agents in a Hyper-V isolated Server Core container. `sandbox engine check hcs` shows what your PC lacks. Starting it is not enabled yet.                                                               |

## Known gaps

- Adding a folder to a **running** sandbox needs Windows 11 24H2+ with the updated Windows Sandbox (`wsb share`,
  untested). On older Windows, folders inside a project root open at once, and anything else offers a restart.
  [Details](docs/projects.md#adding-a-project-to-a-running-sandbox).
- Windows Sandbox runs one sandbox per PC. Every project and agent shares it.
- What is planned next: [roadmap](docs/roadmap.md).

## Documentation

All docs, one line each: [docs/README.md](docs/README.md). The main ones:

- [Install](docs/install.md): requirements, other ways to install, updating, uninstalling
- [Commands](docs/commands.md): every command and option, the menu, sessions
- [Tools and databases](docs/toolchains.md): languages, apps, databases, agents
- [Configuration](docs/configuration.md): settings, project files, paths, accounts, hooks
- [Several projects](docs/projects.md): project roots, joining a running sandbox, what each agent can see
- [Security](docs/security.md): how your PC is protected, secrets, git access
- [Web UI](docs/web-ui.md) (Beta) and [VPN](docs/vpn.md) (Alpha)
- [Troubleshooting](docs/troubleshooting.md): common problems, heavy load, crash reports
- [Changelog](CHANGELOG.md) and [roadmap](docs/roadmap.md)
- [Development](docs/development.md): building, testing, releasing (code layout in [CLAUDE.md](CLAUDE.md))
