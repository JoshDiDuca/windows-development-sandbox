// The one line that tells an agent how to render previews of meshes and textures for the owner (pure).

/** Null unless F3D or ImageMagick is installed; `installed` holds app ids. */
export function previewGuideLine(installed: readonly string[]): string | null {
  if (!installed.includes('f3d') && !installed.includes('imagemagick')) return null;
  return (
    'asset previews: `f3d "<mesh>" --output="<pkg>\\previews\\<name>.png" --resolution=1024,768 --up=+Y` per mesh ' +
    '(--up=+Z for Unreal-space files), `magick montage "<pkg>\\source\\**\\*.png" -thumbnail 256x256 -geometry +4+4 ' +
    '-label %f "<pkg>\\previews\\textures.png"` for textures (convert TGA/PSD/DDS/EXR to PNG first with magick); ' +
    "leave them in the package's previews\\ folder for the owner to look at before import"
  );
}
