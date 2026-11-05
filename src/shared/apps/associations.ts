// Which apps open which game-asset files when you double-click them (per user, written to the registry each boot
// because the sandbox's registry is new every time). Pure: the guest writes the plan with set-registry-values.ps1.
import path from 'node:path';
import type { RegistryValue } from '../unreal/engines.js';

export const ASSOCIATIONS = {
  f3d: ['.fbx', '.glb', '.gltf', '.obj', '.stl', '.ply', '.3ds', '.usd', '.usdz'],
  nomacs: ['.tga', '.psd', '.dds', '.exr'],
} as const satisfies Record<string, readonly string[]>;

const NAMES: Record<keyof typeof ASSOCIATIONS, string> = { f3d: 'F3D', nomacs: 'nomacs' };

/** The registry values that make `appId` open its file types; no values for an app that opens none. */
export function associationPlan(appId: string, exe: string): RegistryValue[] {
  if (!Object.hasOwn(ASSOCIATIONS, appId)) return [];
  const id = appId as keyof typeof ASSOCIATIONS;
  if (!path.win32.isAbsolute(exe) || /["\r\n]/.test(exe)) throw new Error('not a program path: ' + exe);
  const classes = 'Software\\Classes';
  const type = classes + '\\Sandbox.' + id;
  const quoted = '"' + exe + '"';
  const v = (key: string, value: string): RegistryValue => ({ hive: 'HKCU', key, name: '', value });
  return [
    ...ASSOCIATIONS[id].map((ext) => v(classes + '\\' + ext, 'Sandbox.' + id)),
    v(type, NAMES[id] + ' file'),
    v(type + '\\DefaultIcon', quoted + ',0'),
    v(type + '\\shell\\open\\command', quoted + ' "%1"'),
  ];
}
