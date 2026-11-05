# Mixamo and the downloads folder

## The downloads folder

Edge and Chrome in the sandbox save downloads to `C:\AgentData\downloads`. That folder is on the data disk, so files
you download are still there in the next sandbox. The sandbox sets it as the browsers' default folder at every start;
you can still pick another folder in a browser's own save dialog. To clear it, delete files from that folder.

## Getting characters and animations from Mixamo

[Mixamo](https://www.mixamo.com) gives rigged characters and animations for free with an Adobe sign-in. Sign in with
the sandbox's browser and download with these settings:

- Character: FBX Binary (.fbx), T-pose, With Skin.
- Each animation: FBX Binary, Without Skin, 30 fps. Choose In Place for walk and run loops.

## Importing into Unreal

When an Unreal engine is set up, the sandbox guide tells the agent about this too. By hand:

1. Import the character first, as a Skeletal Mesh with Import Uniform Scale 1.0. `mixamorig:Hips` is the root, so
   there is no root motion.
2. Import each animation with Skeleton set to that character's skeleton.

An import script is not shipped yet: it needs a test on a real engine.

## Using the UE5 mannequin's animations

Retarget: make an IK Rig for each skeleton (the Mixamo one and the mannequin), then an IK Retargeter between them.

## Licence

Use Mixamo content in your game. Never ship or share the raw FBX files.
