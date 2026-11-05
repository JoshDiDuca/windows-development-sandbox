# Unreal engines and Godot

Unreal: the engines on this PC come into the sandbox, the Epic Games Launcher keeps the engines it installs on the data
disk, and each project builds with the engine its `.uproject` names. Godot comes in a later version. Visual Studio and
DirectX for Unreal are in [toolchains](toolchains.md#unreal-engine); Visual Studio and its Windows SDK are installed once
and kept on the data disk ([what persists](toolchains.md#cc-and-visual-studio-what-persists)). Sign-ins for the
launcher are in [Accounts](accounts.md). Mixamo characters: [mixamo.md](mixamo.md).

## Unreal engines kept between sandboxes

Sign in to the Epic Games Launcher (Start menu) and install an engine there. Engines go to `tools\unreal\engines` on the
data disk (`toolchains.unreal.persistEngines`, on by default), 40-60 GB each, and are registered again every boot. The
launcher's own manifests (`.item` files) and its `LauncherInstalled.dat` entries are saved with them, so the launcher
knows the engines are installed. Installing needs about 60 GB free on the data disk; the page says so, loudly, when an
engine would land on the sandbox's own disk (lost when the sandbox closes).

An install the launcher has not finished is not an engine yet: it is left out until the launcher marks it complete.

## Engines from this PC

`pcInstalls.unrealEngines` (default `"auto"`: whenever the sandbox is set up for Unreal) maps the engines installed on
this PC into the sandbox, read-only, at `C:\PcInstalls\unreal\UE_5.4` (one folder per version). They come from the
launcher's `LauncherInstalled.dat` and the launcher's default folder (`Program Files\Epic Games\UE_*`). Nothing is
copied. A list limits it to some versions, `false` turns it off.

Source builds that Unreal registered on this PC (the `Builds` key in the registry) are not mapped by themselves: building
writes inside the engine folder (logs, intermediate files, the build tool), and a read-only engine would fail every
build. Register the folder to use one.

### Registered engine folders

`pcInstalls.unrealEngineFolders` is a list of engine folders of this PC (each holds `Engine\Build\Build.version`). They
are mapped writable at `C:\PcInstalls\unreal\dir-<name>`, for a source build or a copy of an engine you build plugins
into. Register one from the Unreal page ("Register an engine folder..." in the menu and the web UI), or with
`sandbox unreal add-engine <folder>`; `sandbox unreal forget-engine <folder>` takes it away again (nothing on the PC is
deleted). A folder that is a source build registered on this PC keeps the name this PC gave it, so a project that names
it still finds it. At most 8 folders. The registry is read with `reg.exe`, whose output is in the PC's code page: a
source build whose path has characters outside plain ASCII may not be listed.

## Which engine a project uses

Every project in the sandbox is looked at (its `.uproject`, in its folder or one folder down) and gets an engine:

- `"EngineAssociation": "5.4"` (a version): the installed engine of that version. A writable engine (a registered
  folder, or one the launcher installed in the sandbox) is preferred to a read-only one of this PC; the newest patch
  wins.
- a `{GUID}` or a name (a source build): the engine registered under that name. If this PC's source build is not mapped,
  the newest writable source build in the sandbox is used instead (an engine source next to your projects, or a
  registered folder), and the GUID is registered for it, so the `.uproject` works unchanged.
- no association: the newest engine.

If there is no match, the Unreal page says why and what to do. The same rule decides the engine that is on `PATH`.

## What is registered

So that Unreal's own tools find the engines as on a normal PC, every boot writes:

- the launcher's `LauncherInstalled.dat` (one entry per version, the preferred engine; your other entries are kept),
- `HKLM\SOFTWARE\EpicGames\Unreal Engine\<major.minor>` `InstalledDirectory` for each installed version,
- `HKCU\Software\Epic Games\Unreal Engine\Builds` for source builds (and the GUID of a project that names one),
- the `.uproject` file association (UnrealVersionSelector).

This is all inside the sandbox; nothing is registered on your PC.

## PATH and variables

The folders with `Build.bat`, `RunUAT.bat` and the other batch files of the project's engine come first on `PATH`. The
engine's `Binaries\Win64` (the editor, `UnrealEditor-Cmd.exe`) and the build tool's folder are added at the end, because
they hold many DLLs that other programs would otherwise load. `UE_ROOT` is the engine folder and `UE_ENGINE_DIR` its
`Engine` folder. For Unreal 5.8 and later, the editor's MCP server is added to Claude Code and Codex.

## The derived data cache

`toolchains.unreal.derivedDataCache` (default `"persisted"`) moves the engine's local derived data cache (compiled
shaders; 10-50 GB) to `tools\unreal\ddc` on the data disk via `UE-LocalDataCachePath`, so later sandboxes do not
rebuild it. `"local"` leaves Unreal's own place on the sandbox's disk (rebuilt every boot).

## Vault assets (Fab and Marketplace)

`pcInstalls.unrealAssets` (default `"auto"`) maps the launcher's vault cache of this PC (the packs you downloaded)
read-only at `C:\PcInstalls\unreal\Vault`, so what you download on your PC is there for the agents at once. The Unreal
page lists the packs.

## Crash debugging

The Windows debuggers (`cdb.exe`) are kept with the Windows SDK on the data disk. The Unreal page shows whether they are
there, and the agent guide tells agents to use `cdb` on crash dumps.

## The Unreal page

Menu: Sandbox, Unreal Engine. It is also a page in the web UI. It shows the engines in use, what each project builds
with and why, the launcher and the room left for engines, Visual Studio as UnrealBuildTool sees it, the derived data
cache, the engines of this PC (with "Register an engine folder..."), and the vault packs. On the command line:
`sandbox unreal` (or `sandbox unreal status`) prints it, `sandbox unreal launcher` opens the Epic Games Launcher in the
running sandbox, and `add-engine` and `forget-engine` are above.

## Godot

Comes in a later version.

## Game-development apps

[Apps and tools](toolchains.md#apps-and-tools) has Krita (painting), Inkscape (vector graphics), Audacity (sound) and RenderDoc (graphics debugging):
turn them on in Apps and they are installed in the sandbox.
