# Asset preview plan (package C, Opus review 2026-11-04)

Goal: the owner can look at meshes and textures (FBX, glTF, OBJ, TGA, PSD, DDS, EXR ...) in the sandbox before they go
into a game, by double-click, and agents can render preview images into a package's `previews\` folder.
Apps live in `C:\AgentData\tools\apps` (data disk, kept between sandboxes, not on C:).

Owner rules: no command text in menu or web pages; no sbx-* wrapper commands; never touch other projects
(zombie-survival-game, zs-*, mw2-agent ...).

## Files it owns
- `src/shared/apps/catalogue-gamedev.ts`, new `src/shared/apps/associations.ts`, new `src/shared/apps/preview.ts`,
  `src/shared/apps/index.ts`
- `src/guest/apps/after-install.ts`, `src/guest/apps/app-installer.ts`
- `src/selftest/toolchains.test.ts`, `schemas/*.json` (regenerated)
- `docs/game-engines.md`: one new section.
- Reuses `sandbox/scripts/set-registry-values.ps1` unchanged.

FIRST check `fileAssociationPlan` in `src/shared/unreal/engines.ts` (or wherever it lives): if a file-association plan
already exists, reuse or generalise it instead of writing a second one (move it to `shared/apps/associations.ts` and
re-export from the old place if that keeps callers simple).

## Steps
1. Add to `GAMEDEV_APPS` (GitHub sources: the release digest is the checksum):
   ```
   { id:'f3d', name:'F3D', category:'gamedev', about:'Fast 3D viewer (FBX, glTF/GLB, OBJ, STL, PLY, 3DS, USD); renders still previews from the command line.', size:'100 MB', source: gh('f3d-app/f3d','^F3D-[\\d.]+-Windows-x86_64\\.zip$'), exe:'f3d.exe', needs:['mesa'] }
   { id:'imagemagick', name:'ImageMagick', category:'gamedev', about:'Converts and thumbnails textures (TGA, PSD, DDS, EXR, HDR) and builds contact sheets (magick montage).', size:'150 MB', source: gh('ImageMagick/ImageMagick','^ImageMagick-[\\d.]+-\\d+-portable-Q16-HDRI-x64\\.7z$'), exe:'magick.exe', cli:true, needs:['7zip'] }
   { id:'nomacs', name:'nomacs', category:'gamedev', about:'Image viewer for textures.', size:'60 MB', source: gh('nomacs/nomacs','^nomacs-portable-win\\.zip$'), exe:'nomacs.exe' }
   ```
   Match the real shape of existing entries (field names may differ; copy a neighbour). Verified 2026-11-04: F3D v4.0.1
   `F3D-4.0.1-Windows-x86_64.zip`; ImageMagick 7.1.2-35 `ImageMagick-7.1.2-35-portable-Q16-HDRI-x64.7z`; nomacs 3.22.4
   `nomacs-portable-win.zip`. Re-check the asset names against the GitHub releases API before relying on them.
   Check in this sandbox (download into the scratchpad, untrusted folder): `f3d --help` has `--output`, `--resolution`,
   `--no-background`, `--up`; `f3d sample.glb --output=p.png --resolution=1024,768` writes a PNG with Mesa DLLs next
   to f3d.exe; `magick x.dds p.png`, `magick x.exr p.png`, `magick x.psd[0] p.png` work. Where nomacs fails on an
   extension, map it to Krita (in the catalogue) or to nothing.
2. `associations.ts` (pure): `ASSOCIATIONS = { f3d: ['.fbx','.glb','.gltf','.obj','.stl','.ply','.3ds','.usd','.usdz'], nomacs: ['.tga','.psd','.dds','.exr','.hdr'] } as const`
   (adjusted by step 1). `associationPlan(appId, exe)` -> `{hive:'HKCU';key;name;value}[]`: throws when exe is not
   absolute or holds `"` or a newline; per extension `Software\Classes\<ext>` default `Sandbox.<appId>`,
   `Software\Classes\Sandbox.<appId>` default `<App name> file`, `...\DefaultIcon` `"<exe>",0`,
   `...\shell\open\command` `"<exe>" "%1"`; unknown apps give `[]`.
3. `after-install.ts`: `const plan = associationPlan(entry.id, exe); if (plan.length) await runScriptWithJsonAsync('set-registry-values.ps1','PlanFile',{ values: plan }).catch(e => warn(...))`
   (use the real helper names; runs every boot like afterInstall).
4. `preview.ts` (pure): `previewGuideLine(installed)` null unless f3d or imagemagick is installed, else one line:
   ``asset previews: `f3d "<mesh>" --output="<pkg>\previews\<name>.png" --resolution=1024,768 --up=+Y` per mesh (--up=+Z for Unreal-space files), `magick montage "<pkg>\source\**\*.png" -thumbnail 256x256 -geometry +4+4 -label %f "<pkg>\previews\textures.png"` for textures (convert TGA/PSD/DDS/EXR to PNG first with magick); leave them in the package's previews\ folder for the owner to look at before import``.
   In `app-installer.ts` after the `apps:` summary line push it to the summary (check whether `installed` holds ids or
   names). Export through `src/shared/apps/index.ts`.
5. Docs: `## Looking at assets before import` in `docs/game-engines.md`: turning the apps on (Apps page or
   `.sandbox-config.json` apps), double-click meshes/textures, software OpenGL when vGPU is off, the agent preview
   commands, the `<package>\previews\` convention.
6. Tests in `toolchains.test.ts`: the three entries exist; regexes match the verified names and reject
   `F3D-4.0.1-Windows-x86_64.exe` and a `-raytracing.zip`; `associationPlan('f3d','C:\\x\\f3d.exe')` maps `.fbx` to
   `Sandbox.f3d` with command `"C:\x\f3d.exe" "%1"`; relative or quoted exe throws; unknown id `[]`;
   `previewGuideLine([])` null, `previewGuideLine(['f3d'])` contains `--output=`.
7. Verify: `npm run build` (commit `schemas/*.json`), `npm test -- toolchains,layout,app`, full `npm test` (gate on
   `ALL TESTS PASSED`, rerun once on a live flake), `npm run lint`, `npm run format:check`. Do not bump the version or
   edit CHANGELOG; hand the CHANGELOG bullet text to the merger.
