// The neutral description of a launch (what the engine layer turns into its own files), built from what the launch
// already worked out: settings, memory, folders and storage.
import { resolveClipboard } from '../../core/clipboard.js';
import type { Config, ResolvedMapping } from '../../core/types.js';
import { wsbText, type LaunchPlan } from '../engines/index.js';
import type { StorageAttachment } from '../storage/providers/index.js';
import { GUEST } from './wsb-file.js';

export interface LaunchPlanInput {
  readonly config: Config;
  readonly memoryMb: number;
  readonly mappings: readonly ResolvedMapping[];
  readonly launchPath: string;
  readonly storage: readonly StorageAttachment[];
}

export function buildLaunchPlan(input: LaunchPlanInput): LaunchPlan {
  const s = input.config.sandbox;
  const clip = resolveClipboard(s);
  return {
    launchPath: input.launchPath,
    memoryMb: input.memoryMb,
    cpuLimit: s.cpuLimit,
    networking: s.networking,
    devices: {
      gpu: s.vGpu,
      sharedClipboard: clip.sharedClipboard,
      audioInput: s.audioInput,
      videoInput: s.videoInput,
      printers: s.printerRedirection,
      protectedClient: clip.protectedClient,
    },
    mappings: input.mappings,
    logonCommand: GUEST.launch + '\\sandbox\\boot\\logon.cmd',
    storage: input.storage,
  };
}

/** The .wsb text for these settings (the Windows Sandbox engine's file, without writing it). */
export function buildWsb(config: Config, memoryMb: number, mappings: readonly ResolvedMapping[]): string {
  return wsbText(buildLaunchPlan({ config, memoryMb, mappings, launchPath: GUEST.launch, storage: [] }));
}
