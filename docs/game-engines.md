# Unreal engines and Godot

Coming in a later version. Today: Unreal's Visual Studio and DirectX ([toolchains](toolchains.md#unreal-engine)). Visual Studio
and its Windows SDK are installed once and kept on the data disk; later boots put them back in seconds
([what persists](toolchains.md#cc-and-visual-studio-what-persists)). Sign-ins for it are in [Accounts](accounts.md).

## Unreal engines kept between sandboxes

## Engines from this PC

## The derived data cache

## Godot

## Godot with .NET

## Export templates

## Game-development apps

## Looking at assets before import

Turn on F3D (models), nomacs (textures) and ImageMagick (conversion and contact sheets) on the Apps page, or list
`f3d`, `nomacs` and `imagemagick` under `apps` in `.sandbox-config.json`. They are kept on the data disk with the other
apps, so they are downloaded once.

- Double-click a model (FBX, glTF/GLB, OBJ, STL, PLY, 3DS, USD) to open it in F3D, or a texture (TGA, PSD, DDS, EXR)
  to open it in nomacs. The file types are set again on every boot. HDR files are not opened by nomacs: ImageMagick
  converts them to PNG.
- F3D draws with OpenGL. When the sandbox has no GPU (vGPU off) the sandbox puts its software OpenGL (Mesa) next to
  F3D, so it works, only slower.
- An agent that has F3D or ImageMagick is told how to render a still of each model and a contact sheet of the
  textures. Models are drawn Y-up by default; files made in Unreal's space need Z-up.
- Previews go in the package's `previews\` folder (for example `Packages\<slug>\previews\`), next to its `source\`
  files, so you can look at them before anything is imported into the game.
