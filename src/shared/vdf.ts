// Valve's KeyValues text format (.vdf: libraryfolders.vdf, appmanifest_*.acf, config.vdf, app_build and
// workshop_item scripts), parsed with hard limits on size, depth and keys (the files may come from a sandbox or a
// repo). Pure. Not available yet: parses nothing.

export type VdfValue = string | VdfObject;
export interface VdfObject {
  readonly [key: string]: VdfValue;
}

export interface VdfLimits {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxKeys?: number;
}

/** The root object of a .vdf text, or null when it is not one (or breaks a limit). */
export function parseVdf(_text: string, _limits: VdfLimits = {}): VdfObject | null {
  return null;
}
