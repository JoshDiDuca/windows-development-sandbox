// Game-development apps for making a game's assets and finding its rendering bugs: Krita (painting, textures),
// Inkscape (vector art, UI), Audacity (sound), RenderDoc (frame capture and GPU debugging). Blender is in catalogue.ts.
// Entries of the apps catalogue, pure data like catalogue.ts (which lists them). GIMP has no portable download (only
// an Inno Setup installer) and Quixel Bridge lives inside the Epic Games Launcher / Fab: neither is here.
import type { AppEntry } from './catalogue.js';

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
];
