// Runs a definition as a command: its input from the command line, its questions on the terminal, and its output as
// --json, as the definition's one-line text, or as the page of the view that shows it. A declined question prints
// "Nothing changed." and exits 1, as the commands always have. An operation that opens a session's terminal (a new
// shell) attaches this terminal to it afterwards.
import { VIEWS } from '../../app/features/defs.js';
import { runDefinition } from '../../app/registry.js';
import { Cancelled, type AnyDefinition, type AnyView } from '../../app/kernel/index.js';
import type { Context } from '../commands/context.js';
import type { Handler } from '../commands/registry.js';
import { nextStep, printJson, printPage } from '../output/index.js';
import { cliInput, definitionFor } from './input.js';
import { cliIO } from './io-cli.js';

/** The view that shows only this query (its page is the command's text output). */
function viewOf(def: AnyDefinition): { view: AnyView; name: string } | undefined {
  for (const view of VIEWS as readonly AnyView[]) {
    const entries = Object.entries(view.queries);
    if (entries.length === 1 && entries[0][1] === def) return { view, name: entries[0][0] };
  }
  return undefined;
}

/** Prints what a definition returned, the way its command shows it. */
function printOutput(def: AnyDefinition, output: unknown, input: Record<string, unknown>): void {
  if (def.text) {
    const text = def.text(output);
    if (text) console.log(text);
    const next = def.next?.(output);
    if (next) nextStep(next);
    return;
  }
  const shown = viewOf(def);
  if (shown) printPage(shown.view.build({ [shown.name]: output }, input as never));
  else console.log(JSON.stringify(output, null, 2));
}

/** Attaches this terminal to the session an operation opened (in a script: says how to). */
async function attachOpened(ctx: Context, session: string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    nextStep('sandbox attach ' + session);
    return 0;
  }
  // Loaded when needed: attach reaches the launch commands, which reach this handler (no import cycle).
  const { attach } = await import('../commands/sessions/attach.js');
  return attach({ ...ctx, options: { ...ctx.options, positionals: [session] } });
}

/** The command for a definition. */
export function definitionHandler(def: AnyDefinition): Handler {
  return async (ctx) => {
    const input = cliInput(def, ctx.options);
    const { io, close } = cliIO(ctx.options);
    try {
      const output = await runDefinition(def.id, ctx, input, io);
      close();
      const code = def.cli?.exitCode?.(output) ?? 0;
      if (def.cli?.json && ctx.options.json) {
        printJson(ctx, def.cli.shapeJson ? def.cli.shapeJson(output) : output);
        return code;
      }
      printOutput(def, output, def.input.parse(input) as Record<string, unknown>);
      const opened = def.kind === 'operation' ? def.opens?.(output) : undefined;
      if (opened?.kind === 'terminal') return attachOpened(ctx, opened.session);
      return code;
    } catch (e) {
      close();
      if (!(e instanceof Cancelled)) throw e;
      console.log(e.message);
      return 1;
    }
  };
}

/** The command a parsed command line runs when it is one of the shared core's, else undefined. */
export function operationHandler(command: string, positionals: readonly string[]): Handler | undefined {
  const def = definitionFor(command, positionals);
  return def ? definitionHandler(def) : undefined;
}
