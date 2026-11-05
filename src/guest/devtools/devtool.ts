// One `sbx-<name>` helper for terminals and the agent (sbx-steam, sbx-fivem, sbx-android): runtime\tool.js
// runs it with the rest of the command line. Boot writes the .cmd shims for the toolchains that are on.
export type DevToolName = 'steam' | 'fivem' | 'android';

export interface DevTool {
  readonly name: DevToolName;
  /** One line for its usage and the agent's guide. */
  readonly summary: string;
  run(args: readonly string[]): Promise<number>;
}

/** What a helper whose commands are not written yet does. */
export function notAvailableYet(name: DevToolName): Promise<number> {
  console.error('sbx-' + name + ': not available yet.');
  return Promise.resolve(1);
}
