// Which Visual Studio this sandbox needs, from every toolchain that needs one: Unreal (Community with the C++ game
// workload, or with toolchains.unreal.visualStudio = "buildtools" the Build Tools' C++ parts), Flutter's Windows
// desktop builds and Unity's Windows IL2CPP builds (the Build Tools' C++ parts). Pure: no runtime, so the self-test
// loads it. Community holds everything the Build Tools would add, so one install serves all of them.
import type { Toolchains } from '../../../core/types.js';

/**
 * What Epic lists for Unreal Engine 5 with Visual Studio 2022: the game workload, MSVC v143, a Windows SDK of
 * 10.0.22621 or newer, the C++ profiling tools, the .NET Framework targeting packs some engine tools build against,
 * Visual Studio's Unreal support and the Unreal Engine installer (the Epic Games Launcher).
 */
export const UNREAL_COMPONENTS = [
  'Microsoft.VisualStudio.Workload.NativeGame',
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  'Microsoft.VisualStudio.Component.Windows11SDK.22621',
  'Microsoft.VisualStudio.Component.VC.DiagnosticTools',
  'Microsoft.Net.Component.4.6.2.TargetingPack',
  'Microsoft.Net.Component.4.8.SDK',
  'Component.Unreal.Ide',
  'Component.Unreal',
] as const;

/** The Build Tools' C++ desktop parts: MSVC v143 and a Windows 11 SDK (Flutter desktop, Unity IL2CPP). */
export const BUILD_TOOLS_COMPONENTS = [
  'Microsoft.VisualStudio.Workload.VCTools',
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  'Microsoft.VisualStudio.Component.Windows11SDK.22621',
] as const;

/**
 * Unreal on the Build Tools: what UnrealBuildTool needs (it finds them through the Setup API like Visual Studio):
 * MSVC v143, the Windows SDK and the .NET Framework parts its tools build against. No IDE and no debugger.
 */
export const UNREAL_BUILD_TOOLS_COMPONENTS = [
  ...BUILD_TOOLS_COMPONENTS,
  'Microsoft.Net.Component.4.6.2.TargetingPack',
  'Microsoft.Net.Component.4.8.SDK',
] as const;

export interface VsRequest {
  readonly product: 'community' | 'buildtools';
  readonly components: readonly string[];
  /** Who asks for it (for messages): unreal, flutter, unity. */
  readonly for: readonly string[];
  /** The licence setting that must be on (toolchains.unreal.acceptLicense or toolchains.msvc.acceptLicense). */
  readonly licence: string;
  readonly accepted: boolean;
}

/** Whether a toolchain is on (the host resolved "auto"; a session file that still says "auto" counts as off). */
const isOn = (setting: boolean | 'auto'): boolean => setting === true;

export function visualStudioWanted(
  t: Toolchains,
  on: (setting: boolean | 'auto', name: string) => boolean = isOn,
): VsRequest | null {
  const unreal = on(t.unreal.enabled, 'unreal');
  const flutter = on(t.flutter.enabled, 'flutter') && t.flutter.windowsDesktop;
  const unity = on(t.unity.enabled, 'unity') && t.unity.modules.includes('windows-il2cpp');
  const users = [...(unreal ? ['unreal'] : []), ...(flutter ? ['flutter'] : []), ...(unity ? ['unity'] : [])];
  if (!users.length) return null;
  if (unreal) {
    const full = t.unreal.visualStudio === 'full';
    return {
      product: full ? 'community' : 'buildtools',
      components: [...new Set([...(full ? UNREAL_COMPONENTS : UNREAL_BUILD_TOOLS_COMPONENTS), ...t.unreal.components])],
      for: users,
      licence: 'toolchains.unreal.acceptLicense',
      accepted: t.unreal.acceptLicense,
    };
  }
  return {
    product: 'buildtools',
    components: [...BUILD_TOOLS_COMPONENTS],
    for: users,
    licence: 'toolchains.msvc.acceptLicense',
    accepted: t.msvc.acceptLicense,
  };
}

/** The Visual Studio installer's exit code in plain words (it is a uint32: -1 and 4294967295 are the same). */
export function vsExitText(code: number): string {
  const c = code >>> 0;
  switch (c) {
    case 0:
      return 'installed';
    case 3010:
      return 'done; a restart would finish it (not needed here)';
    case 1602:
      return 'cancelled';
    case 5007:
      return 'the installer refused to run (blocked by Windows, for example a restart waiting)';
    case 8006:
      return 'Visual Studio is running and must be closed first';
    case 0xe0434352:
      return '0xE0434352: the Visual Studio installer crashed';
    default:
      return 'the installer failed with exit ' + c + ' (0x' + c.toString(16).toUpperCase() + ')';
  }
}
