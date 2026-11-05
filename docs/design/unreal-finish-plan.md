# Unreal finish plan (Opus review and plan, 2026-11-04)

Workers: Package A = Sonnet (worktree wsbx-wt/unreal), Package B = Haiku (worktree wsbx-wt/mixamo).
Owner rules: no command text in menu or web pages; no sbx-* wrapper commands; Opus plans, Sonnet/Haiku build.

REVIEW of feat/unreal-engines (29289ed..45c5c19, worktree C:\Projects\AgentProjects\wsbx-wt\unreal). Read-only: I built nothing and changed no files. I did not message aebac6bff3e19ab94, as you told me. The only thing I ran was the VS probe, writing to my scratchpad. Its result: exit 0, setupError "", instance C:\AgentData\tools\visualstudio\persist\Community 17.14.37827.9, MSVC 14.44.35207 with cl/link, SDK 10.0.22621.0 complete, cdb present under persist\WindowsKits10\Debuggers\x64.

The following look correct: the registry keys (HKLM\SOFTWARE\EpicGames\Unreal Engine\<x.y> InstalledDirectory and HKCU\Software\Epic Games\Unreal Engine\Builds, written through the 64-bit view), the LauncherInstalled.dat shape and merge, the .item save/restore, the GameUserSettings.ini encoding handling, the bounded reads, the injection guards, C# 5 / PS 5.1 compliance, CRLF on the .ps1 files, and no host paths in session.json.

== FINDINGS (ranked) ==
F1 HIGH: src/host/pc-installs/unreal.ts:88-102. Source builds from the PC's Builds key are mapped READ-ONLY. On a non-installed engine, UBT and the editor write inside the engine: Engine\Programs\UnrealBuildTool\Log.txt, Engine\Intermediate\Build (rules assemblies), the UBT rebuild from Build.bat, and Engine\Saved. So every agent build against such an engine fails.
  Fix: stop auto-mapping Builds-key source builds in findUnrealInstalls. Export a `pcSourceBuilds(files)` helper and use it in lookAtPc (unreal.run.ts) to list them with the note "(source build: register its folder to use it)" and the page action "Register an engine folder..." (NEVER a command in page text). In findEngineFolders, take `files: Pick<UnrealPcFiles,'read'|'builds'>` and set `buildId` from the regValues(files.builds) entry whose folder equals the registered folder (case-insensitive, normalized). Then a writable registered folder keeps the PC's GUID. unrealFolders.find and lookAtPc pass unrealPcFiles(pc).

F2 HIGH: src/shared/unreal/engines.ts:273-278 (chooseEngine). A project whose EngineAssociation is the PC's GUID gets "not here", so there is no engine on PATH. The source build sits in a project root (origin 'project') or on the data disk, and those get stableBuildId(dir), not the PC GUID. This is the common setup of an engine source next to projects.
  Fix: when kind==='build' finds no id match, fall back to the newest WRITABLE source build. Add `readonly alias?: string` (the association id) to EngineChoice and reason 'the project names the source build <id> (registered on your PC); using the source build at <dir>'. Change `registryPlan(engines, aliases: readonly {id:string;dir:string}[] = [])` to also write HKCU Builds <id> = dir. Pass the alias from setupUnrealEngines into registerEngines (new 4th parameter). The .uproject then works unchanged in UnrealVersionSelector and the editor.

F3 MEDIUM: src/guest/toolchains/engines/unreal-engines.ts:98 (launcherEntries). LauncherInstalled.dat gets one entry per installed engine, so there can be several UE_5.4 entries. UE's DesktopPlatform keeps the LAST one per AppName (TMap Add), and the order is findEngines order. A writable pc-folder copy is listed before the read-only PC engine, so the editor and UnrealVersionSelector pick the read-only one, while chooseEngine and registryPlan pick the writable one. registryPlan also ignores patch on ties, which chooseEngine does not.
  Fix: in engines.ts add an exported pure `preferredInstalled(engines): UnrealEngine[]`: one per majorMinor, sorted by preference then compareVersions desc, the same rule as chooseEngine. Use it in registryPlan. Move launcherEntries' logic into a pure shared `launcherEntriesFor(engines, saved, pcItems)` in launcher-files.ts that emits only preferredInstalled. The guest wrapper just calls it, so host tests can import it.

F4 MEDIUM: src/app/features/unreal/unreal.run.ts:43 (readStatus). The host reads the guest-written tools\unreal\status.json without assertNoLinks, against the hard rule.
  Fix: `const file = path.join(ctx.dataPath,'tools','unreal',UNREAL_STATUS_FILE); try { assertNoLinks(ctx.dataPath, file); } catch { return null; /* a link under the data folder: never followed */ }`, then readValid. Import from core/util.

F5 MEDIUM: engines.ts findEngines plus unreal-engines.ts:80 (launcherDirs). Any tools\unreal\engines\<x> folder holding Build.version counts as an engine, including a launcher install still in progress. The daemon's captureLauncherEngines registers it, and "newest" picks it, so builds fail.
  Fix: in launcher-files.ts ItemSchema add `bIsIncompleteInstall: z.boolean().optional()`. Add exported `incompleteDirs(...manifestDirs: string[]): Set<string>` (lower-case normalized InstallLocation of manifests with bIsIncompleteInstall true). In sandboxEngines, drop engines whose dir is in incompleteDirs(launcherManifestsDir(programData), SAVED_MANIFESTS).

F6 LOW: unreal-engines.ts:171 prepends Engine\Binaries\Win64, a DLL-heavy folder, to PATH, so every program the agent runs may load the engine's DLLs (tbb, dxcompiler...).
  Fix: prepend only ...\Engine\Build\BatchFiles and env.append the Win64 and UnrealBuildTool dirs.

F7 LOW: src/shared/unreal/engines.ts:113 BUILD_ID rejects registered names with other characters (e.g. "UE5 Main (CL1)"). engineAt then drops the host buildId and parseEngineAssociation returns 'none', so it is a mismatch again.
  Fix: allow `/^[^\x00-\x1f"\\/]{1,64}$/` with trimmed ends for both. The registry value names go through the JSON plan, so this is safe.

F8 LOW: src/shared/unreal/vs-check.ts:59 does not check InstanceState.Local, which UBT checks.
  Fix: add `state: z.number().int().min(0)` to VsSetupReportSchema and require `(i.state & 1) === 1` in `usable`. Add state: 4294967295 to the golden report in engines.test.ts:513.

F9 LOW: src/guest/setup/addon-mcp.ts:59. The Unreal editor MCP is written for Claude Code only; writeCodexAddonMcpServers(on) never gets it. Fix: include the unrealMcp server in what Codex gets.

F10 LOW: sandbox/csharp/VsSetup.cs:131-160. The COM objects are never released (the style rule wants handles closed in finally). Fix: Marshal.ReleaseComObject on each instance, the enum and setup in finally blocks.

F11 LOW: unreal.ts:152 decodes reg.exe output as utf8, but reg.exe writes the OEM code page, so non-ASCII Builds paths are silently skipped. Optional fix: `reg export HKCU\...\Builds <tmp>.reg /y` (UTF-16LE) and parse that. Otherwise document the limitation.

F12 LOW (in package B's file): src/shared/unreal/guide.ts:41 and the commands line say UnrealEditor.exe / UnrealEditor-Cmd.exe. On UE4 engines these are UE4Editor.exe / UE4Editor-Cmd.exe. Fix: choose the name by engine.version.major.

To verify live (a unit test can't settle these):
- V1: the sandbox's launcher, when started, may rewrite LauncherInstalled.dat from its own .item manifests, dropping PC engine entries, or try to update or verify read-only PC engines. After opening it, check that the UE_x entries for C:\PcInstalls are still there and that the editor still finds "5.4".
- V2: the DDC and Zen data on the mapped data disk (derivedDataCache 'persisted' is the default). Mapped folders refuse rename-over and some memory-mapped files, so a -nullrhi cook may fail. If it does, default the Zen data to local disk.

Missing tests: VsSetup.cs compiling with SYSTEM.csc() /target:library (pattern at agent-paths.test.ts:292), plus a live run of get-vs-setup.ps1 that only asserts VsSetupReportSchema parses. F1, F2, F3, F5 and F8 have no tests.

== PACKAGE A: "Unreal finish" (wsbx-wt\unreal, feat/unreal-engines) ==
Owns: src/host/pc-installs/unreal.ts, src/app/features/unreal/unreal.run.ts, src/shared/unreal/{engines,launcher-files,vs-check}.ts, src/guest/toolchains/engines/unreal-engines.ts, src/guest/setup/addon-mcp.ts, sandbox/csharp/VsSetup.cs, src/selftest/engines.test.ts, docs/game-engines.md, docs/configuration.md, docs/commands.md, CHANGELOG.md, package.json.
Must NOT touch: src/shared/unreal/guide.ts, src/shared/unreal/index.ts, src/guest/boot/guide.ts, src/selftest/index.ts, src/selftest/support/engine-golden.ts, src/guest/setup/browser-gpu.ts, docs/README.md. Import new shared functions in guest and host via the existing barrel only if they are already exported. If a new export is needed in src/shared/unreal/index.ts, make it the ONE line added to that file and tell the merger, or import the file directly from tests.
Steps:
1. Fix F1-F11 exactly as above, in this order: F3 (preferredInstalled + launcherEntriesFor) -> F2 -> F5 -> F1 -> F4 -> F8 -> F7 -> F6 -> F9 -> F10 -> F11 (optional).
2. Add a section "every route on real disk" to engines.test.ts, using t.dir/t.write temp trees (already used at :100-147):
   <t>\PcInstalls\unreal\UE_5.4\Engine\Build\Build.version(5.4.4)+InstalledBuild.txt   mapped {id:'UE_5.4'}
   <t>\PcInstalls\unreal\dir-UE54Copy\... (5.4.1, installed)   mapped {writable:true}
   <t>\tools\unreal\engines\UE_5.5\... (5.5.0, installed) + <t>\Manifests\A1.item {"InstallLocation":"<that dir>","bIsIncompleteInstall":false,"InstallSize":1}
   <t>\tools\unreal\engines\UE_5.6\... (5.6.0) + <t>\Manifests\B2.item {...,"bIsIncompleteInstall":true}
   <t>\Projects\Work\UnrealEngine\Engine\Build\Build.version(5.5.1)   (source, no InstalledBuild.txt)
   <t>\Projects\Work\MyGame\MyGame.uproject {"EngineAssociation":"{11111111-2222-3333-4444-555555555555}"}
   <t>\Projects\Work\OldGame\OldGame.uproject {"EngineAssociation":"5.4"}
   Asserts:
   - The engine list (incomplete filter applied) has no UE_5.6.
   - OldGame -> dir-UE54Copy.
   - MyGame -> Projects\Work\UnrealEngine, with alias = the GUID.
   - registryPlan(engines,[alias]) holds HKCU Builds {1111...} = UnrealEngine dir, and HKLM 5.4 InstalledDirectory = dir-UE54Copy.
   - launcherEntriesFor gives exactly one UE_5.4 entry (dir-UE54Copy).
   - mergeLauncherInstalled into a fixture with a Fortnite entry keeps Fortnite.
   - saveItems then restoreItems round-trips A1.item into a fresh Manifests folder.
   - setLauncherInstallLocation on a UTF-16LE (FF FE) GameUserSettings.ini keeps the BOM and the other sections.
   Host route, UnrealPcFiles from the temp tree:
   - launcherInstalled lists <t>\PC\Epic Games\UE_5.4.
   - builds = "\r\nHKEY_CURRENT_USER\\Software\\Epic Games\\Unreal Engine\\Builds\r\n    {1111...}    REG_SZ    <t>\\PC\\src\\UnrealEngine\r\n".
   - defaultRoot <t>\PC\Epic Games also holds UE_5.3.
   - findUnrealInstalls gives UE_5.4 and UE_5.3 and NO source build.
   - findEngineFolders([<t>\PC\src\UnrealEngine]) gives writable:true, buildId '{1111...}'.
   readStatus: a junction at <t>\data\tools\unreal (fs.symlinkSync(target, link, 'junction'), as in accounts.test.ts:129) means the overview reads no status.
   vsVerdict: state 0 is not usable.
   Compile: spawnSync(SYSTEM.csc(), ['/nologo','/target:library','/out:'+<t>\VsSetup.dll, <packageRoot>\sandbox\csharp\VsSetup.cs]) has status 0.
   Live probe (Windows only): spawnSync(SYSTEM.powershell(), ['-NoProfile','-ExecutionPolicy','Bypass','-File', <packageRoot>\sandbox\scripts\get-vs-setup.ps1,'-ResultFile', <t>\vs.json]) has status 0, and VsSetupReportSchema.safeParse(JSON) succeeds.
3. VS probe run by hand: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Projects\AgentProjects\wsbx-wt\unreal\sandbox\scripts\get-vs-setup.ps1 -ResultFile <scratchpad>\vs.json`. Expected: exit 0, and JSON with setupError "", instances[0].installationPath "C:\\AgentData\\tools\\visualstudio\\persist\\Community", installationVersion "17.14.37827.9", state 4294967295, isComplete true, packages including Microsoft.VisualStudio.Component.VC.Tools.x86.x64 / Component.Unreal, toolchains [{version "14.44.35207", cl true, link true}], kitsRoots HKLM (64-bit) and (32-bit) = ...\persist\WindowsKits10\, sdks [{10.0.22621.0, windowsH, kernel32, ucrt all true}].
   Verdict after `npm run build`: `node --input-type=module -e "const m=await import('file:///C:/Projects/AgentProjects/wsbx-wt/unreal/dist/shared/unreal/vs-check.js');const fs=await import('node:fs');console.log(m.vsVerdict(m.VsSetupReportSchema.parse(JSON.parse(fs.readFileSync(process.argv[1],'utf8')))))" <scratchpad>/vs.json`. Expected: ok:true, text "Visual Studio 17.14.37827.9 at ...Community, MSVC 14.44.35207, Windows SDK 10.0.22621.0 at ...".
4. Docs, docs/game-engines.md: replace the "Coming in a later version" stub (lines 1-5) and fill the existing Unreal sections. Cover:
   - the PC's engines (pcInstalls.unrealEngines "auto": read-only at C:\PcInstalls\unreal\UE_x.y; source builds are not auto-mapped, add them with `sandbox unreal add-engine`);
   - registered folders (writable, dir-<name>);
   - the launcher on the data disk (tools\unreal\engines, 60 GB free needed, saved .item/entries);
   - which engine a project uses (EngineAssociation version / GUID / newest; writable before read-only; GUID fallback to the source build);
   - what is registered (LauncherInstalled.dat, HKLM InstalledDirectory, HKCU Builds, .uproject association);
   - PATH and UE_ROOT/UE_ENGINE_DIR;
   - the DDC (UE-LocalDataCachePath, tools\unreal\ddc);
   - vault assets (C:\PcInstalls\unreal\Vault, read-only);
   - crash debugging (cdb);
   - the Unreal page (menu Sandbox > Unreal Engine, web, `sandbox unreal [status|add-engine|forget-engine|launcher]`);
   - apps (Krita, Inkscape, Audacity, RenderDoc);
   - one link line: "Mixamo characters: [mixamo.md](mixamo.md)".
   docs/configuration.md:388-395: update the pcInstalls table (unrealEngines 'auto'|bool|list, unrealEngineFolders, unrealAssets). docs/commands.md: a `sandbox unreal` section.
5. CHANGELOG.md: add "## 1.26.0" with the bullet "- **Unreal Engine for agents.** This PC's engines come into the sandbox read-only and registered (LauncherInstalled.dat, registry, .uproject association); engines the Epic Games Launcher installs in a sandbox go to the data disk and come back every boot; each project builds with the engine its .uproject names, with Build.bat, RunUAT.bat, the editor and cdb on PATH and the derived data cache kept; your Fab/Marketplace downloads are there read-only; new Unreal page (`sandbox unreal`, menu, web); apps Krita, Inkscape, Audacity, RenderDoc." Set package.json version to 1.26.0.
6. Verify: `npm run build` (commit the changed schemas/*.json); `npm test -- engines,layout,app`; then `npm test` and gate on the text "ALL TESTS PASSED" (re-run once if a live suite flakes); `npm run lint`; `npm run format:check`. Commit on the branch, do not push.
Acceptance: every step passes, the F1-F11 tests are in place, and the docs are filled.

== PACKAGE B: "Mixamo" (wsbx-wt\mixamo, feat/mixamo at 45c5c19, clean) ==
Owns: NEW src/shared/browser-policy.ts, src/guest/setup/browser-gpu.ts, NEW src/shared/unreal/mixamo.ts, src/shared/unreal/guide.ts, src/guest/boot/guide.ts, NEW sandbox/templates/unreal/import_mixamo.py (optional), src/selftest/support/engine-golden.ts (only if the template is added), NEW src/selftest/mixamo.test.ts, src/selftest/index.ts, NEW docs/mixamo.md, docs/README.md. It touches no file of A. No CHANGELOG or version change: put the bullet text in its report for the merger: "- **Downloads to the data disk; Mixamo for Unreal.** Edge and Chrome save downloads to C:\AgentData\downloads (kept between sandboxes); the guide tells agents how to bring Mixamo characters and animations into Unreal."
Steps:
1. src/shared/browser-policy.ts (pure, no imports beyond node:path):
   `export interface BrowserPolicy { readonly key: string; readonly name: string; readonly type: 'REG_DWORD'|'REG_SZ'; readonly data: string }`
   `export const BROWSER_POLICY_KEYS = ['HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge','HKLM\\SOFTWARE\\Policies\\Google\\Chrome'] as const;`
   `export function browserPolicies(o: { readonly downloads: string | null }): BrowserPolicy[]`. For each key it returns HardwareAccelerationModeEnabled REG_DWORD '0' (today's behaviour) and, when downloads is set, DefaultDownloadDirectory REG_SZ <downloads>. It throws Error('not a folder') unless path.win32.isAbsolute and there are no ["\r\n%] characters.
   Policy choice: DefaultDownloadDirectory, the policy name in both Edge and Chrome. It sets the default and leaves Playwright's CDP download path and the user's choice alone. If the owner wants the folder forced, use DownloadDirectory, with the same type and keys.
2. browser-gpu.ts: in keepBrowsersOffGpu, `const downloads = path.join(dataDir,'downloads'); mkdirp(downloads);` then, for each plan entry, `exec(SYSTEM.reg(), ['add', p.key, '/v', p.name, '/t', p.type, '/d', p.data, '/f'], {stdio:'ignore'})`. Log 'Browsers draw without the GPU and download to ' + downloads. Update the file header.
3. src/shared/unreal/mixamo.ts: `export function mixamoGuideLines(o: { readonly downloads: string; readonly script: string | null }): string[]` returns exactly:
   "- Mixamo (rigged characters and animations, free with an Adobe sign-in): the user downloads them in this sandbox's browser from https://www.mixamo.com; downloads land in `<downloads>` (kept between sandboxes). Ask for the character as FBX Binary (.fbx), T-pose, With Skin; each animation as FBX Binary, Without Skin, 30 fps, In Place for walk and run loops."
   "- Mixamo into Unreal: import the character first (Skeletal Mesh, Import Uniform Scale 1.0; `mixamorig:Hips` is the root, so there is no root motion), then each animation with Skeleton = that character's skeleton. To use the UE5 mannequin's animations, retarget with an IK Rig per skeleton and an IK Retargeter. Licence: use them in the game; never ship or share the raw FBX files."
   plus, when script is set: "- Mixamo import script: `UnrealEditor-Cmd.exe \"<Project>.uproject\" -run=pythonscript -script=\"<script> --fbx <file.fbx> --dest /Game/Characters/<Name> [--skeleton /Game/Characters/<Name>/<Name>_Skeleton]\" -unattended -nullrhi -nosplash` (needs the Python Editor Script Plugin on in the .uproject)."
4. guide.ts (shared/unreal): add an optional third parameter `extras: { readonly mixamo?: { downloads: string; script: string | null } } = {}`. When status.engines.length > 0 and extras.mixamo is set, push ...mixamoGuideLines(extras.mixamo) after the commands and logs lines. The default is off, so A's guide asserts don't change. Also F12: pick the editor exe name by engine.version.major (>=5 'UnrealEditor', else 'UE4Editor') in the engine line and the tests command. src/guest/boot/guide.ts unrealLines passes `{ mixamo: { downloads: path.join(dataDir,'downloads'), script: <template path or null> } }`. The template path is path.join(sandboxScriptsDir(), 'templates', 'unreal', 'import_mixamo.py') if that file exists (same helper as src/guest/toolchains/fivem/scaffold.ts:21).
5. Optional template sandbox/templates/unreal/import_mixamo.py. Use argparse with --fbx (required), --dest (required) and --skeleton. Run `unreal.SystemLibrary.execute_console_command(None, 'Interchange.FeatureFlags.Import.FBX 0')` so FbxImportUI options apply. Set up unreal.FbxImportUI: import_mesh = not anim, import_as_skeletal = True, import_animations = anim, import_materials / import_textures / create_physics_asset = not anim, mesh_type_to_import = FBXIT_ANIMATION or FBXIT_SKELETAL_MESH, and skeleton = unreal.load_asset(--skeleton), failing when it is None. Then unreal.AssetImportTask with filename, destination_path, automated, replace_existing and save all True, options = ui. Call unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task]), fail when task.imported_object_paths is empty, and unreal.log each path. Entry: main(sys.argv[1:]).
   Ship it ONLY if verified on a real engine: a temp .uproject {"FileVersion":3,"EngineAssociation":"<x.y>","Plugins":[{"Name":"PythonScriptPlugin","Enabled":true}]} plus any skinned FBX, run with the command in step 3, exit 0 and "imported /Game/..." in the log. With no engine on this machine, do not add the file or the script line, and report "template not verified".
   If added, add 'sandbox/templates/unreal/import_mixamo.py' to engine-golden.ts in sorted position.
6. src/selftest/mixamo.test.ts (suite 'mixamo', registered in src/selftest/index.ts):
   - browserPolicies({downloads:'C:\\AgentData\\downloads'}) deep-equals the 4 entries; {downloads:null} gives 2; 'C:\\a"b' and 'downloads' throw.
   - unrealGuideLines(status with one engine, projects, {mixamo:{downloads:'C:\\AgentData\\downloads',script:null}}) includes both Mixamo lines and no script line; with a script, it includes the script line; without extras, there are no Mixamo lines; with status.engines = [], there are no Mixamo lines.
   - A UE4 engine (major 4) gives 'UE4Editor-Cmd.exe' in the commands line.
7. docs/mixamo.md: Downloads folder (C:\AgentData\downloads, why, how to clear); Getting characters and animations from Mixamo (the settings above); Importing into Unreal (by hand, the script if shipped); Retargeting to the UE5 mannequin; Licence. Link it from docs/README.md.
8. Verify: `npm run build`; `npm test -- mixamo,layout`; then `npm test` and gate on "ALL TESTS PASSED"; `npm run lint`; `npm run format:check`. Commit on feat/mixamo, do not push.
Acceptance: the policies are written every boot (check `reg query HKLM\SOFTWARE\Policies\Microsoft\Edge /v DefaultDownloadDirectory` in a test sandbox); the guide shows the Mixamo lines only when an Unreal engine is set up; the tests pass; the template is either verified or absent.

Merge order: A first, then B. The only shared text is the CHANGELOG bullet, which the merger adds from B's report.
