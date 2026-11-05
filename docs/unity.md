# Unity

Unity projects build and test in the sandbox with the editor version each project asks for. Editors come from this PC
(read-only) or from the data disk, where they are kept between sandboxes. The Unity CLI, its MCP server and its skills
are set up for Claude Code and Codex. Your Unity licence and sign-in are in [Accounts](accounts.md). The settings are in
[toolchains](toolchains.md#game-modding-and-mobile-toolchains) and [configuration](configuration.md#unity).

## Installing an editor

A project names its editor in `ProjectSettings/ProjectVersion.txt`. Unity is set up for a project when that file is
there (`toolchains.unity.enabled` is `"auto"` by default) or when you turn it on. It needs
`toolchains.unity.acceptLicense: true`: you accept the Unity terms of service, and nothing is set up without it, not
even an editor from this PC.

Each sandbox looks for that exact version, in this order:

1. this PC's editor, read-only, when it has every module in `toolchains.unity.modules`;
2. the data disk's copy, when one is there;
3. otherwise the data disk gets the version: it is installed once, with the modules, then kept.

An editor on the data disk is `tools\unity\editors\<version>`, 8-13 GB each. The first install downloads several GB and
can run in the background after the agent starts, as Visual Studio's does; a saved editor is back in seconds. Older
editors are removed, least recently used first, beyond `keepVersions` (default 2, up to 20).

Exact versions only. Opening a project in another Unity version upgrades its files, so each project opens with the
version its own `ProjectVersion.txt` names, never a near one. `toolchains.unity.version` set to a version (instead of
`"project"`, the default) is only for folders without a `ProjectVersion.txt`, such as a new project.

## Editors from this PC

`pcInstalls.unityEditors` (default `"auto"`: all of them whenever the sandbox is set up for Unity) maps the editors that
Unity Hub installed on this PC, read-only, at `C:\PcInstalls\unity\<version>`. Nothing is copied and nothing lands on
the sandbox's disk. `true` maps every one, `false` none, or a list such as `["6000.0.32f1"]` limits it. The sandbox
never adds modules to this PC's editor: a module it lacks comes from the data disk copy instead.

## Modules

Set the modules you need in `toolchains.unity.modules`. Each is added to the data disk's editor when it is missing.

| Module           | What it adds                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `android`        | Android build support, 4-5 GB (also the Android SDK)                                                 |
| `webgl`          | WebGL build support, 1.5 GB                                                                          |
| `windows-il2cpp` | IL2CPP builds. It needs Visual Studio's C++ Build Tools, under `toolchains.msvc.acceptLicense: true` |
| `ios`            | The Xcode project export only. iOS builds need a Mac                                                 |

```json
{
  "toolchains": {
    "unity": { "enabled": true, "acceptLicense": true, "modules": ["webgl", "windows-il2cpp"] },
    "msvc": { "acceptLicense": true }
  }
}
```

## Unity Hub

`toolchains.unity.hub` (default off) installs Unity Hub on the data disk (`tools\unity\hub`). Use it to sign in to Unity
Personal by hand or to install editors yourself. The agents do not need it. `sandbox unity hub` opens it in the running
sandbox. Turning the setting on in a running sandbox installs Hub at the next start.

## Your licence

Unity Personal is free, and it needs a licence like any editor.

- **Personal:** sign in once in a sandbox with `sandbox unity sign-in` (or the Unity page's sign-in button). The licence
  the sandbox makes comes back to your PC and is kept in Accounts, so the next sandboxes start licensed. Each boot
  places it and checks it. If Unity refuses it in a sandbox, the Unity page says so: sign in again.
- **Plus or Pro:** save the Unity ID email and password with its serial (`sandbox account login unity`, or the Accounts
  page). The serial is activated in each sandbox once an editor exists, and handed back when the sandbox stops cleanly.
  If a sandbox closes abruptly, the seat may stay taken until you remove it at id.unity.com (My Seats).
- **A licence file from this PC:** `sandbox account import unity` takes Unity's `Unity_lic.ulf` (from
  `C:\ProgramData\Unity`) or the named-user entitlement (from `%LOCALAPPDATA%\Unity\licenses`). `--from <file>` names
  one instead. Unity ties a licence file to the computer, so a sandbox may refuse one taken from this PC. Then sign in
  inside the sandbox, or type the Unity ID.

A Unity sign-in works in one sandbox at a time. The rules for sharing it are in [accounts](accounts.md#sharing).

## Asset Store

There are two sources of Asset Store packages.

- **This PC's downloads:** `pcInstalls.unityAssets` (default `"auto"`) maps the Asset Store folder of this PC read-only
  at `C:\PcInstalls\unity\AssetStore`. A package you download on your PC is there for the agents at once. The Unity page
  lists the packages by publisher, category and name.
- **Downloads made in the sandbox:** `toolchains.unity.assetCache` decides where Unity keeps them.

| `assetCache`            | Where downloads made in the sandbox go                                                |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `"persisted"` (default) | `tools\unity\asset-store` on the data disk, kept between sandboxes                    |
| `"pc"`                  | this PC's downloads, read-only: download new packages on your PC                      |
| `"local"`               | Unity's own place on the sandbox's disk, lost when the sandbox closes                 |

Agents import a package into a project with the editor closed, in batch mode (see [building from the command
line](#building-from-the-command-line)).

## Unity CLI, MCP and skills

The Unity CLI (`unity`) is on PATH in every sandbox that uses Unity. It is pinned to `toolchains.unity.cliVersion`
(default `1.0.0-beta.16`, or `"latest"`), checked against the SHA-256 Unity publishes, and it never updates itself.
Setup turns off its update check and its analytics.

- **MCP server:** `toolchains.unity.mcp` (default on) registers the CLI as the MCP server `sbx-unity` in Claude Code and
  Codex. Unity's read-only tools are always there. The open editor's tools need the Unity Pipeline package in the
  project (Unity 6 and later). Nothing in your project changes for this.
- **Skills:** `toolchains.unity.agentSkills` (default on) syncs Unity's skills for Claude Code and Codex, from
  Unity-Technologies/skills at the commit the CLI pins. They are synced every boot.

The agents' guide in the sandbox names the editor each project opens with and the batch commands to use.

## The editor bridge

Batch mode builds, tests and imports without a running editor. To drive a running editor (scenes, GameObjects, play
mode), a project needs an editor bridge package. Nothing adds one by itself.

- **Add it when you ask:** on the Unity page ("Add the editor bridge") or with `sandbox unity add-bridge <project>
  [--bridge pipeline|coplay]`. It asks first, and changes only the project's `Packages/manifest.json`. `sandbox unity
  remove-bridge <project>` takes it out again.
- **Pipeline** (`com.unity.pipeline`), for Unity 6 and later: `unity command` and `unity eval` drive the open editor,
  and the MCP server `sbx-unity` can use its tools.
- **Coplay** (MCP for Unity, `com.coplaydev.unity-mcp`), for older versions: the MCP server `sbx-unity-mcp`, from the
  [MCP for Unity app](#mcp-for-unity-and-openupm-cli).

Without `--bridge`, a Unity 6 project gets Pipeline and an older one gets Coplay. Pipeline is refused for an older
project.

## MCP for Unity and openupm-cli

Both are in [Apps](toolchains.md#apps-and-tools). Turn them on there, or list them under `apps.install`.

- **MCP for Unity** (`unity-mcp`, under Agent add-ons): CoplayDev/unity-mcp 10.3.0 (MIT), for Unity 2021.3 to 6.x. It
  runs as the MCP server `sbx-unity-mcp` in Claude Code and Codex, and its project needs the Coplay bridge (above).
  Telemetry is off. Only your own settings can turn it on: a project's `.sandbox-config.json` cannot.
- **openupm-cli** (`openupm-cli`, under Game development): adds OpenUPM packages to a project from the command line,
  `openupm` 4.5.3 (BSD-3-Clause), on PATH.

## The Unity page

Menu: Sandbox, Unity. It is also a page in the web UI. On the command line `sandbox unity` (or `sandbox unity status`)
prints the same, and `--json` gives it as data. The page shows:

- the editors the sandbox has, and which one each project opens with and why;
- this PC's editors and Asset Store downloads;
- the licence and sign-in, and Unity Hub;
- each project's editor bridge, with buttons to add or remove it;
- the Unity CLI, the MCP server and the skills;
- the settings, each with a link to change it.

| Command                                                          | What it does                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| `sandbox unity [status] [--json]`                                | the page as text or data                                             |
| `sandbox unity sign-in`                                          | sign in to Unity in the running sandbox                              |
| `sandbox unity hub`                                              | open Unity Hub in the running sandbox (needs `toolchains.unity.hub`) |
| `sandbox unity add-bridge <project> [--bridge pipeline\|coplay]` | add the editor bridge to a project (asks first)                      |
| `sandbox unity remove-bridge <project>`                          | take the editor bridge out of a project (asks first)                 |

## Building from the command line

Agents and you can build, test and import without opening the editor. The paths are in the sandbox's guide, which names
the editor each project opens with.

- Build or run a method in batch mode: `"<editor>\Editor\Unity.exe" -batchmode -nographics -quit -projectPath
  "<project>" -executeMethod <Class.Method> -logFile -`
- Run tests (leave out `-quit`): `-runTests -testPlatform EditMode -testResults <file>`.
- Import a package into a project (editor closed): `-importPackage "<file>"`, with the same `-projectPath`.
- The Unity CLI has `unity build`, `unity test` and `unity open <project>` (which opens it signed in). Run
  `unity --help` for the rest.

Do not open a project in another Unity version without asking: it upgrades the project's files.

## iOS builds

The `ios` module exports an Xcode project only. The sandbox is Windows, so the build itself needs a Mac: export the
project in the sandbox and build it on a Mac.

## Known limits

Two things are not checked on a real run yet:

- That Unity's `Library` database (LMDB) works on a project folder that is mapped from your PC.
- The CLI flags. They were taken from Unity's documentation, not from a live run.
