// Which definition a parsed command line runs, and its input: positional arguments and flags mapped to input fields by
// the definition's CLI hint (zod then checks them like any other input).
import { DEFINITIONS } from '../../app/features/defs.js';
import type { AnyDefinition } from '../../app/kernel/index.js';
import { fail } from '../../core/util/index.js';
import type { CliOptions } from '../args.js';
import { inputField } from './spec.js';

/** The words of an action: `contained on` is two words, each one a positional argument. */
function actionWords(action: string): string[] {
  return action.split(' ');
}

/** Whether the positionals start with every word of the action (`contained`, `on`). */
function startsWithAction(action: string, positionals: readonly string[]): boolean {
  return actionWords(action).every((word, i) => positionals[i] === word);
}

/** The definition a command runs: its own command, or an action of a hand-written one (`config get`, `storage use`). */
export function definitionFor(command: string, positionals: readonly string[]): AnyDefinition | undefined {
  return DEFINITIONS.find(
    (d) => d.cli?.name === command && (d.cli.action === undefined || startsWithAction(d.cli.action, positionals)),
  );
}

/** commander's attribute name for a long flag: --keep-old -> keepOld. */
function attribute(flag: string): string {
  return flag.replace(/^--/, '').replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase());
}

/**
 * What a flag gave: --no-<flag> is stored by commander as <flag>: false, and the input field it sets is true then.
 */
function flagValue(raw: Readonly<Record<string, unknown>>, flag: string): unknown {
  if (flag.startsWith('--no-')) {
    const positive = attribute('--' + flag.slice('--no-'.length));
    return raw[positive] === false ? true : undefined;
  }
  return raw[attribute(flag)];
}

/** The input a command line gives a definition (fields not on the line are left to the schema's defaults). */
export function cliInput(def: AnyDefinition, options: CliOptions): Record<string, unknown> {
  const hint = def.cli;
  if (!hint) return {};
  const positionals = hint.action ? options.positionals.slice(actionWords(hint.action).length) : options.positionals;
  const names = hint.positional ?? [];
  const missing = names.slice(positionals.length).filter((name) => !inputField(def, name).optional);
  if (missing.length)
    fail(
      'Missing ' + missing.join(' and ') + '.',
      'Usage: sandbox ' + [hint.name, hint.action, ...names.map((n) => '<' + n + '>')].filter(Boolean).join(' '),
    );
  const input: Record<string, unknown> = {};
  names.forEach((name, i) => {
    // A list takes the rest of the line (`data clean tools/go logs`); only the last positional may be one.
    if (inputField(def, name).kind === 'list') {
      if (i !== names.length - 1) throw new Error(def.id + ': only the last positional may be a list');
      input[name] = positionals.slice(i);
    } else if (positionals[i] !== undefined) input[name] = positionals[i];
  });
  for (const [name, flag] of Object.entries(hint.flags ?? {})) {
    if (!flag) continue;
    const value =
      (flag.shownAs ? flagValue(options.raw, flag.shownAs) : undefined) ?? flagValue(options.raw, flag.flag);
    if (value !== undefined) input[name] = value;
  }
  return input;
}
