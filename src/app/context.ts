// What every run function gets: the program's context (settings, storage folder, data folder, the parsed command
// line), the same object the commands and services use. implement() is bound to it here once.
import type { Context } from '../cli/commands/context.js';
import type { TypedConfirm } from '../cli/commands/shared-use.js';
import { loadConfig } from '../core/config/index.js';
import { implementer, type OperationIO } from './kernel/index.js';

export type AppContext = Context;

/** Attaches a run function to a definition: `implement(def, async (ctx, input, io) => output)`. */
export const implement = implementer<AppContext>();

/**
 * Reads the settings again after an operation, so a long-lived context (the menu, the web server) shows what it saved.
 * A file that cannot be read keeps the settings the context had: the settings page reports the problem.
 */
export function reloadSettings(ctx: AppContext): void {
  try {
    ctx.loaded = loadConfig(ctx.loaded.configPath ?? ctx.options.config);
  } catch {
    // Broken settings file: keep what is loaded.
  }
}

/** Another user's sandbox asks for their name to be typed: through `io`, so every surface can ask it. */
export function typedConfirm(io: OperationIO): TypedConfirm {
  return (prompt, expected) =>
    io.confirm({
      title: prompt,
      typed: expected,
      danger: true,
      noTerminal: { message: prompt + ' It was not stopped.', fix: 'In a script, add --yes to do it anyway.' },
    });
}
