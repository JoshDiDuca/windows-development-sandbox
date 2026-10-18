// Plain-words warnings about settings that can take the whole PC down, shown at launch, by doctor and in crash reports.

import type { Config } from '../../core/types.js';
import type { LoadProfile } from '../../shared/memory/index.js';

/** The stricter load profile applies whenever vGPU is on, from any source. */
export function loadProfileOf(config: Config): LoadProfile {
  return config.sandbox.vGpu ? 'gentle' : 'normal';
}

/** Where vGpu being on comes from, for the sentence below: your own settings, or a project file you allowed. */
export function vgpuSource(yourSettingOn: boolean): string {
  return yourSettingOn ? 'your settings' : "this project's .sandbox-config.json, which you allowed";
}

/** The vGPU warning (pure). `source` is vgpuSource(...) or "your settings". */
export function vgpuWarning(source: string): string {
  return (
    'vGPU is on (from ' +
    source +
    "): the sandbox uses this PC's graphics card. With some graphics drivers, heavy use can freeze the whole PC. " +
    'Turn it off unless a program in the sandbox needs the GPU (the mesa toolchain gives software OpenGL without it).'
  );
}

/** The launch note that goes with the vGPU warning: what the tool does about it by itself. */
export const GENTLE_NOTE = 'vGPU is on: the sandbox runs gentler so this PC stays responsive.';
