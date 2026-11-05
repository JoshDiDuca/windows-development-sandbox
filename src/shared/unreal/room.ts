// Where the Epic Games Launcher puts an engine, and whether there is room: engines go to the data disk only (never the
// sandbox's own disk, which holds 8-14 GB free and the paging file), and one needs 60 GB free there. Pure apart from
// the disk check it is given.
import { freeBytesAt, type StatFs } from '../io/disk.js';

const GB = 1024 ** 3;
/** What one engine takes while the launcher installs it (download and unpacked, 40-60 GB). */
export const ENGINE_NEED_BYTES = 60 * GB;

const gb = (bytes: number): string => (bytes / GB).toFixed(0) + ' GB';

export interface LauncherPlace {
  /** The launcher's install folder was set to the data disk. */
  readonly set: boolean;
  /** Why it could not be (the file could not be written), or that persistEngines is off. */
  readonly error?: string;
}

/**
 * The loud line for the boot summary and the Unreal page when an engine would not go to the data disk, or would not
 * fit there; null when all is well.
 */
export function enginePlaceProblem(
  place: LauncherPlace,
  enginesDir: string,
  statfs?: StatFs,
): { problem: string | null; freeBytes: number | null } {
  if (!place.set)
    return {
      problem:
        'ENGINES WOULD GO ON THE SANDBOX DISK: ' +
        (place.error ?? "the Epic Games Launcher's install folder could not be set") +
        '. Do not install an engine with the launcher in this sandbox (it would fill C: and be lost); install it on your PC instead (the next sandbox maps it read-only).',
      freeBytes: null,
    };
  const free = freeBytesAt(enginesDir, statfs);
  if (free !== null && free < ENGINE_NEED_BYTES)
    return {
      problem:
        'Only ' +
        gb(free) +
        ' free on the data disk (' +
        enginesDir +
        '); an engine from the Epic Games Launcher needs ' +
        gb(ENGINE_NEED_BYTES) +
        '. Free room on that disk first, or install the engine on your PC (the next sandbox maps it read-only).',
      freeBytes: free,
    };
  return { problem: null, freeBytes: free };
}
