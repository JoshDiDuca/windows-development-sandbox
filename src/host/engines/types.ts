// What every sandbox engine shares: the neutral description of a launch (LaunchPlan) and what an engine reports.
import type { Config, ResolvedMapping } from '../../core/types.js';
import type { StorageAttachment } from '../storage/providers/index.js';

export type EngineId = Config['sandbox']['engine'];

export interface EngineCapabilities {
  readonly desktop: boolean;
  readonly textClipboard: boolean;
  readonly gpu: boolean;
  readonly clipboard: boolean;
  readonly audio: boolean;
  readonly video: boolean;
  readonly printers: boolean;
  /** Folders can be added to a running sandbox. */
  readonly liveFolderAdd: boolean;
  readonly attachedDisks: boolean;
  readonly multipleInstances: boolean;
  readonly hvsocket: boolean;
}

export interface EngineCheck {
  readonly available: boolean;
  readonly reasons: readonly string[];
  readonly fixes: readonly string[];
}

export interface LaunchDevices {
  readonly gpu: boolean;
  /** Windows Sandbox's own clipboard (ClipboardRedirection): only for sandbox.clipboard "shared". */
  readonly sharedClipboard: boolean;
  readonly audioInput: boolean;
  readonly videoInput: boolean;
  readonly printers: boolean;
  /** As the sandbox really starts: off for the shared clipboard. */
  readonly protectedClient: boolean;
}

/** One launch, whatever runs it. Pure data: nothing in it is engine-specific. */
export interface LaunchPlan {
  /** The launch folder: where an engine writes its own files. */
  readonly launchPath: string;
  readonly memoryMb: number;
  /** Percent of this PC's CPU, or 'none'. The guest applies it; an engine may use it as a hint. */
  readonly cpuLimit: 'none' | number;
  readonly networking: boolean;
  readonly devices: LaunchDevices;
  /** Every folder shared in, in order (the folder attachments of `storage` are among them). */
  readonly mappings: readonly ResolvedMapping[];
  /** The command the guest runs at logon. */
  readonly logonCommand: string;
  readonly storage: readonly StorageAttachment[];
}

/** What an engine made of a LaunchPlan: files to write and the one to start from. Callers do not look inside. */
export interface EnginePlan {
  readonly engine: EngineId;
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly entry: string;
}

export interface RunningSandbox {
  readonly id: string;
  readonly engine: EngineId;
  readonly started: number;
}
