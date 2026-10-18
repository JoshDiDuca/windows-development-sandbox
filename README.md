<div align="center">

# Windows Development Sandbox

**A throwaway Windows machine for every project, with or without an AI agent.**

[![Release](https://img.shields.io/github/v/release/JoshDiDuca/windows-development-sandbox?label=release)](https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest)
[![npm](https://img.shields.io/npm/v/windows-development-sandbox?logo=npm&label=npm)](https://www.npmjs.com/package/windows-development-sandbox)
[![CI](https://github.com/JoshDiDuca/windows-development-sandbox/actions/workflows/ci.yml/badge.svg)](https://github.com/JoshDiDuca/windows-development-sandbox/actions/workflows/ci.yml)
![Windows 10/11 Pro, Enterprise, Education](https://img.shields.io/badge/Windows-10%20%7C%2011%20Pro-0078D4)
![MIT](https://img.shields.io/badge/license-MIT-green)

</div>

Run it in a project folder and you get a clean [Windows Sandbox](https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-overview)
where that folder is the workspace, the tools and databases the project needs install themselves, and nothing else
on your PC is reachable. Close it and it's gone. Your project, tools, databases and logins are kept for next time.

## Install

```powershell
irm https://github.com/JoshDiDuca/windows-development-sandbox/releases/latest/download/install.ps1 | iex
```

It checks your PC, offers to turn on Windows Sandbox, and asks **1) Just me** or **2) Everyone on this PC** (needs
admin). It brings its own private copy of Node.js; nothing else is installed system-wide, and no Start menu shortcut
unless you ask for one. `sandbox update` installs newer versions (and can do it by itself), even while a sandbox runs:
the sandbox keeps its version until it restarts. A version that fails to start is rolled back automatically, and
`sandbox update --rollback` goes back one by hand.

Needs Windows 10/11 **Pro, Enterprise or Education**. Have Node.js 20+? `npm install -g windows-development-sandbox`
works too. [Scopes, options (`-Version`, `-StartMenuShortcut` ...), upgrading, uninstall](docs/install.md)

## Use

```powershell
cd C:\code\my-app

sandbox            # the menu: agents, sessions, apps, every setting, diagnostics ...
sandbox claude     # Claude Code in a sandbox for this folder (or: claude-sandbox)
sandbox claude -t  # ... in this terminal (Ctrl+] detaches, the session keeps running)
sandbox start      # just the sandbox, no agent
sandbox opencode   # any supported agent by name
sandbox web open   # (Beta) the web UI in your browser, signed in
```

The first start downloads what the project needs (a few minutes, once). After that, starts take seconds.

> `claude-sbx`, `codex-sbx`, `gemini-sbx` and `agent-sandbox` are the old command names. They still work for now; use
> `sandbox <agent>` / `claude-sandbox` and `sandbox` instead.

## What you get

|  |  |
|---|---|
| **Safe by default** | The agent sees only your project folder. Credentials are stripped before anything is copied in, your LAN is blocked, and nothing the sandbox writes can run on your PC. |
| **Languages** | Node, Python, Rust, C/C++ (GCC or MSVC), .NET (incl. .NET Framework targeting), Go, Java, Ruby, PHP, Deno, Bun, PowerShell 7, with pnpm, yarn, Volta, uv, pyenv, Maven, Gradle, Composer, gh ... |
| **Apps and tools** | VS Code (set up for your languages, with their extensions) and Windows Terminal, plus 60 optional apps and tools by category: DBeaver, pgAdmin, Bruno, Godot, Blender, kubectl, jq, ripgrep ... and programs of your own. Agent add-ons too: rtk (fewer tokens for command output), claude-mem, REA. Playwright works out of the box with Edge |
| **Databases** | PostgreSQL, MySQL, MongoDB, Redis and DynamoDB Local with a web UI, started when the project uses them, or any time with `--database` / `sandbox db` |
| **Agents** | Claude Code, Codex, Gemini, opencode, Qwen, Crush, Copilot, Kilo, Amp, Cline, Continue, Kimi, Aider, DeepSeek agents |
| **Smart** | Detects what the project needs from its files, respects version files, installs in parallel and reuses everything |
| **Several projects** | `sandbox claude` from another project joins the running sandbox: its own folder, tools, versions, databases and environment, set up on demand. Start several agents at once (`--session claude@A --session codex@B`, or the menu) and attach to any of them from any terminal |
| **Picks up where you left off** | After a crash or a restart, `sandbox resume` reopens the last sessions; `sandbox restart` restarts the agents in place and they continue their conversation |
| **Leaves nothing behind** | When an agent's session ends, everything it started ends with it, background servers included. The web UI's server stops when no browser uses it, and nothing of this tool keeps running on your PC once the sandbox is closed |
| **GitHub, safely** | Give sandboxes a fine-grained GitHub token you made for them (`sandbox github login`, `github.shareToken`): `gh` and `git push` work inside, and the token never lands in the sandbox's files |
| **Feels like home** | Your desktop look, Claude settings, MCP servers and conversation history come along; history syncs back. Logins you save (`sandbox account`) are kept encrypted for your Windows user |

## Built for heavy workloads

The sandbox behaves like a well-run PC of its own size: under load it slows down, it does not fail, and it never takes
your PC down with it. Nothing needs setting up.

- **Sized to what your PC can hold.** The sandbox gets only the memory your PC can keep in RAM for it, with room kept
  for your PC itself (and more with vGPU on).
- **Builds within a budget.** Agents see the processors and memory they may really use, and every session gets a
  matching number of build jobs and links, written to `run\budget.json` for agents to plan with.
- **Graduated throttling.** As memory fills, a governor in the sandbox turns one dial in steps: build programs get
  lower CPU and memory priority, then a smaller share of the CPU, then compilers take turns while the waiting ones move
  to the paging file. Builds get slower; nothing is stopped or killed, and agents, shells and Windows are never touched.
- **Your PC has a say.** A watchdog on your PC watches its memory, CPU and disks and asks the sandbox to ease off, at
  once and all the way when your PC is nearly out of memory.
- **A last resort that only protects.** Only at the very edge of the sandbox's own memory limit, where Windows inside
  it would otherwise start failing, is a build refused memory so that the sandbox stays up.
- **Answers after the fact.** `sandbox doctor` checks your paging file, and `sandbox logs --crash` explains a past
  freeze or crash: the gap, blue screens, hardware and memory events, and whether vGPU was on.

Details and settings: [troubleshooting](docs/troubleshooting.md#the-sandbox-closes-under-heavy-load) and
[configuration](docs/configuration.md#cpu-ram-and-gpu).

## Commands

| Command | |
|---|---|
| `sandbox` | the menu, a full-screen app with a left navigation: start agents, attach to sessions, pick apps, edit every setting (yours and the project's), all commands, with search |
| `sandbox <agent>`, `claude-sandbox` | start an agent; `-t` for this terminal, `--headless` for no window |
| `sandbox start` | the sandbox without an agent |
| `sandbox attach` / `sessions` / `status` | work with a running sandbox (this folder's project first) |
| `sandbox restart` / `resume` | restart the agents in place; reopen the last sessions |
| `sandbox projects` | the projects a sandbox can open without a restart: roots, `all`, exclude |
| `sandbox db [start\|stop <name>]` | list, start or stop databases (`sbx-db` inside) |
| `sandbox exec -- <cmd>` | run a command inside |
| `sandbox config get\|set\|reset\|list` | read and change any setting from the command line (`export` / `import` to share them) |
| `sandbox account` | save, switch and rename agent logins |
| `sandbox github` / `vpn` | the GitHub token for sandboxes; the VPN login and status |
| `sandbox web` | (Beta) the web UI: start, stop, status, open |
| `sandbox stop` / `hide` / `show` | shut down, hide or show the window |
| `sandbox data` / `storage` | what's stored and how big, freeing space, moving the data folder |
| `sandbox setup` / `doctor` / `repair` | check this PC, see what will be installed, fix common problems |
| `sandbox engine` | the engines and what each can do on this PC; `engine clean` stops HCS systems left running |
| `sandbox logs [-f] [--crash]` | the sandbox log, or the report of the last crash |
| `sandbox update [--rollback]` / `--version` | update (or go back one version); the installed version |

All commands and options: [docs/commands.md](docs/commands.md)

## Beta and alpha features

These are off until you turn them on, and one setting turns each off again. Windows Sandbox stays the default and
keeps every feature it has.

| Feature | Status | |
|---|---|---|
| **Web UI** (`sandbox web`, `web.enabled`) | Beta | Agents, sessions with live terminals, the sandbox's status, apps, accounts and every setting in your browser, with search (Ctrl+K) and a folder picker; on this PC only (loopback, signed in with a token). `web.openOnLaunch` opens it with every sandbox. [web-ui.md](docs/web-ui.md) |
| **Agent commands** (`sandbox agent-commands on`) | Beta | Typing `claude`, `codex` ... in any folder starts it in a hidden sandbox and attaches your terminal |
| **Contained storage** (`sandbox storage contained on`) | Beta | Tools, logins and logs in one disk image per data set, mounted only while a sandbox runs. One admin prompt per launch. [engines](docs/design/engines.md) |
| **VPN** (`sandbox vpn`, `vpn.enabled`) | Alpha | The sandbox's traffic through NordVPN, your own OpenVPN profile or a WireGuard config, with a kill switch that is checked with a real connection. The first real try fixed the install and the kill switch; a tunnel carrying traffic is not confirmed yet: read [vpn.md](docs/vpn.md) first |
| **HCS engine** (`sandbox.engine: hcs`, `sandbox engine`) | Alpha | Headless agents in a Hyper-V isolated Server Core container. `sandbox engine check hcs` shows what your PC lacks; starting it is not enabled yet. Its create, start and stop steps pass on GitHub's Windows Server 2022 and 2025 runners |

## Known gaps

- Adding a folder to a RUNNING sandbox needs Windows 11 24H2+ with the updated Windows Sandbox (`wsb share`,
  untested). On older Windows, folders inside a project root open at once and anything else offers a restart.
  [Details, and how to get `wsb`](docs/projects.md#adding-folders-to-a-running-sandbox-wsb-share). A way for older
  Windows through HCS is designed and waiting for a test on a real PC ([design](docs/design/hcs-live-folders.md)).
- Windows Sandbox runs one sandbox at a time per PC; every project and agent shares it.
- What is planned next: [roadmap](docs/roadmap.md).

## Documentation

All docs, with one line each: [docs/README.md](docs/README.md). The main ones:

- [Install](docs/install.md): requirements, other ways to install, upgrading, rolling back
- [Commands](docs/commands.md): every command and option, the menu, sessions and attaching
- [Tools and databases](docs/toolchains.md): languages, package managers, databases, agents, what is tested
- [Configuration](docs/configuration.md): settings, project files, paths, accounts, hooks
- [Several projects](docs/projects.md): project roots, adding a project to a running sandbox, what each agent can see
- [Security](docs/security.md): how your PC is protected, secrets, git access
- [Web UI](docs/web-ui.md) (Beta) and [VPN](docs/vpn.md) (Alpha)
- [Troubleshooting](docs/troubleshooting.md): common problems, freezes and crash reports
- [Changelog](CHANGELOG.md) and [roadmap](docs/roadmap.md): what shipped, what is next
- [Development](docs/development.md): building, testing, releasing (code layout in [CLAUDE.md](CLAUDE.md))
