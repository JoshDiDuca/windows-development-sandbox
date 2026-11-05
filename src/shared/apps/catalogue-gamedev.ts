// Game-development apps for making a game's assets and finding its rendering bugs: Krita (painting, textures),
// Inkscape (vector art, UI), Audacity (sound), RenderDoc (frame capture and GPU debugging), F3D, ImageMagick and nomacs
// (looking at models and textures before import). Blender is in catalogue.ts.
// Entries of the apps catalogue, pure data like catalogue.ts (which lists them). GIMP has no portable download (only
// an Inno Setup installer) and Quixel Bridge lives inside the Epic Games Launcher / Fab: neither is here.
import type { AppEntry } from './catalogue.js';

/** Pinned packages, installed from the lock files in sandbox\addons\<id> (renewing them: docs/toolchains.md). */
export const UNITY_MCP_VERSION = '10.3.0';
export const OPENUPM_CLI_VERSION = '4.5.3';

export const GAMEDEV_APPS: readonly AppEntry[] = [
  {
    id: 'krita',
    name: 'Krita',
    category: 'gamedev',
    about:
      'Painting and texture editor (PSD, layers, brushes), checked against the SHA-256 download.kde.org publishes.',
    size: '450 MB',
    source: { resolve: 'krita' },
    exe: 'krita.exe',
    needs: ['mesa'],
  },
  {
    id: 'inkscape',
    name: 'Inkscape',
    category: 'gamedev',
    about: 'Vector graphics for UI, icons and 2D art (SVG), checked against the SHA-256 inkscape.org publishes.',
    size: '400 MB',
    source: { resolve: 'inkscape' },
    exe: 'inkscape.exe',
    needs: ['7zip'],
  },
  {
    id: 'audacity',
    name: 'Audacity',
    category: 'gamedev',
    about: 'Records and edits sound effects and music (WAV, OGG, FLAC).',
    size: '80 MB',
    source: { github: 'audacity/audacity', asset: '^audacity-win-[\\d.]+-(?:64bit\\.zip|x86_64\\.7z)$' },
    exe: 'Audacity.exe',
    needs: ['7zip'],
  },
  {
    id: 'renderdoc',
    name: 'RenderDoc',
    category: 'gamedev',
    about:
      "Captures a frame of a game (Unreal's -d3d12/-vulkan builds) to inspect every draw call, texture and shader. Needs the sandbox's GPU (vGPU) for live captures.",
    size: '70 MB',
    source: { resolve: 'renderdoc' },
    exe: 'qrenderdoc.exe',
  },
  {
    id: 'f3d',
    name: 'F3D',
    category: 'gamedev',
    about: 'Fast 3D viewer (FBX, glTF/GLB, OBJ, STL, PLY, 3DS, USD); renders still previews from the command line.',
    size: '100 MB',
    source: { github: 'f3d-app/f3d', asset: '^F3D-[\\d.]+-Windows-x86_64\\.zip$' },
    exe: 'f3d.exe',
    needs: ['mesa'],
  },
  {
    id: 'imagemagick',
    name: 'ImageMagick',
    category: 'gamedev',
    about: 'Converts and thumbnails textures (TGA, PSD, DDS, EXR, HDR) and builds contact sheets (magick montage).',
    size: '150 MB',
    source: { github: 'ImageMagick/ImageMagick', asset: '^ImageMagick-[\\d.]+-\\d+-portable-Q16-HDRI-x64\\.7z$' },
    exe: 'magick.exe',
    cli: true,
    needs: ['7zip'],
  },
  {
    id: 'nomacs',
    name: 'nomacs',
    category: 'gamedev',
    about: 'Image viewer for textures (TGA, PSD, DDS, EXR).',
    size: '60 MB',
    source: { github: 'nomacs/nomacs', asset: '^nomacs-portable-win\\.zip$' },
    exe: 'nomacs.exe',
  },
  {
    id: 'unity-mcp',
    name: 'MCP for Unity',
    category: 'agents',
    about:
      'Lets Claude Code and Codex work in an open Unity editor (CoplayDev/unity-mcp 10.3.0, MIT; Unity 2021.3 to 6.x). Your project needs its package (Unity page: Add the editor bridge). Telemetry is off.',
    size: '60 MB',
    source: { locked: 'uv', package: 'mcpforunityserver', version: UNITY_MCP_VERSION },
    exe: 'mcp-for-unity.exe',
    service: true,
    mcp: {
      name: 'sbx-unity-mcp',
      program: true,
      args: ['--transport', 'stdio'],
      env: { DISABLE_TELEMETRY: '1', UNITY_MCP_DISABLE_TELEMETRY: '1', MCP_DISABLE_TELEMETRY: '1' },
      codex: true,
    },
    plugsInto: 'Claude Code and Codex as the MCP server sbx-unity-mcp',
    userOnly: true,
  },
  {
    id: 'openupm-cli',
    name: 'openupm-cli',
    category: 'gamedev',
    about: 'Adds OpenUPM packages to Unity projects from the command line (openupm 4.5.3, BSD-3-Clause).',
    size: '15 MB',
    source: { locked: 'npm', package: 'openupm-cli', version: OPENUPM_CLI_VERSION },
    exe: 'openupm.cmd',
  },
];
