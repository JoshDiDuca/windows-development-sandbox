// The guide's Mixamo lines (free rigged characters and animations, downloaded in the sandbox's browser) and how
// to bring them into Unreal. Pure: the guide adds them when an Unreal engine is set up (guide.ts).

/** The Mixamo lines: where downloads land, the export settings, the import, and the licence. */
export function mixamoGuideLines(o: { readonly downloads: string; readonly script: string | null }): string[] {
  const lines = [
    "- Mixamo (rigged characters and animations, free with an Adobe sign-in): the user downloads them in this sandbox's browser from https://www.mixamo.com; downloads land in `" +
      o.downloads +
      '` (kept between sandboxes). Ask for the character as FBX Binary (.fbx), T-pose, With Skin; each animation as FBX Binary, Without Skin, 30 fps, In Place for walk and run loops.',
    "- Mixamo into Unreal: import the character first (Skeletal Mesh, Import Uniform Scale 1.0; `mixamorig:Hips` is the root, so there is no root motion), then each animation with Skeleton = that character's skeleton. To use the UE5 mannequin's animations, retarget with an IK Rig per skeleton and an IK Retargeter. Licence: use them in the game; never ship or share the raw FBX files.",
  ];
  if (o.script)
    lines.push(
      '- Mixamo import script: `UnrealEditor-Cmd.exe "<Project>.uproject" -run=pythonscript -script="' +
        o.script +
        ' --fbx <file.fbx> --dest /Game/Characters/<Name> [--skeleton /Game/Characters/<Name>/<Name>_Skeleton]" -unattended -nullrhi -nosplash` (needs the Python Editor Script Plugin on in the .uproject).',
    );
  return lines;
}
