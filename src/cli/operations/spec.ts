// The command line of the shared core's definitions: each definition with a CLI hint becomes a manifest command (its
// options and arguments read from the input schema, their help from .describe()), or an action of an existing command
// (`config get`). manifest.ts adds these to the hand-written commands, so --help, the parser and the menu's command
// list treat them like any other command.
import { DEFINITIONS } from '../../app/features/defs.js';
import { fieldOf, SchemaNode, type AnyDefinition, type CliFlag, type Field } from '../../app/kernel/index.js';
import type { ArgSpec, CommandSpec, OptionSpec } from '../manifest.js';

/** The definitions that are a command of their own. */
export function commandDefinitions(): AnyDefinition[] {
  return DEFINITIONS.filter((d) => d.cli && !d.cli.action);
}

/** The definitions that are an action of a hand-written command. */
export function actionDefinitions(): AnyDefinition[] {
  return DEFINITIONS.filter((d) => d.cli?.action);
}

/** The Field of one input field of a definition. */
export function inputField(def: AnyDefinition, name: string): Field {
  const node = new SchemaNode(def.input).child(name);
  if (!node) throw new Error(def.id + ': the CLI hint names "' + name + '", which is not in its input');
  return fieldOf(node, [name]);
}

const OPTION_TYPES: Readonly<Partial<Record<Field['kind'], OptionSpec['type']>>> = {
  boolean: 'boolean',
  number: 'number',
  list: 'list',
};

function stringChoices(field: Field): string[] | undefined {
  const values = field.choices?.map((c) => c.value).filter((v): v is string => typeof v === 'string');
  return values?.length ? values : undefined;
}

function optionSpec(def: AnyDefinition, name: string, flag: CliFlag): OptionSpec {
  const field = inputField(def, name);
  const type = OPTION_TYPES[field.kind] ?? 'string';
  const choices = flag.choices ? (typeof flag.choices === 'string' ? flag.choices : [...flag.choices]) : undefined;
  const fixed = choices ?? stringChoices(field);
  const fallback = field.default;
  return {
    flag: flag.flag,
    type,
    description: field.help ?? '',
    ...(flag.short ? { short: flag.short } : {}),
    ...(flag.shownAs ? { shownAs: flag.shownAs } : {}),
    ...(type === 'boolean' ? {} : { value: flag.value ?? name }),
    ...(flag.label ? { label: flag.label } : {}),
    ...(fixed ? { choices: fixed } : {}),
    ...(type !== 'boolean' && (typeof fallback === 'string' || typeof fallback === 'number')
      ? { default: fallback }
      : {}),
    ...(flag.noMenu ? { noMenu: true } : {}),
    ...(flag.advanced ? { advanced: true } : {}),
  };
}

function argSpec(def: AnyDefinition, name: string): ArgSpec {
  const field = inputField(def, name);
  const choices = stringChoices(field);
  return {
    name,
    description: field.help ?? '',
    required: !field.optional,
    ...(choices ? { choices } : {}),
    ...(field.kind === 'list' ? { variadic: true } : {}),
  };
}

/** The manifest command of a definition that is a command of its own. */
export function commandSpecOf(def: AnyDefinition): CommandSpec {
  const hint = def.cli;
  if (!hint?.group) throw new Error(def.id + ': a CLI command of its own needs a group');
  return {
    name: hint.name,
    summary: hint.summary ?? def.summary,
    group: hint.group,
    args: (hint.positional ?? []).map((name) => argSpec(def, name)),
    options: [
      ...Object.entries(hint.flags ?? {}).flatMap(([name, flag]) => (flag ? [optionSpec(def, name, flag)] : [])),
      ...(hint.yes
        ? [{ flag: '--yes', short: '-y', type: 'boolean' as const, description: hint.yes, noMenu: true }]
        : []),
    ],
    ...(hint.json ? { json: true } : {}),
    ...(hint.examples ? { examples: [...hint.examples] } : {}),
  };
}

/** The first word of an action: `contained` for `contained on`. */
function firstWord(action: string): string {
  return action.split(' ')[0];
}

/**
 * A hand-written command with the actions the definitions add (`config reset`): the action is one of the first
 * argument's choices, each later argument is asked for it in the menu's command form, and --json is offered when an
 * action prints JSON.
 */
export function withActions(spec: CommandSpec, defs: readonly AnyDefinition[] = actionDefinitions()): CommandSpec {
  const mine = defs.filter((d) => d.cli?.name === spec.name);
  if (!mine.length || !spec.args.length) return spec;
  const [first, ...rest] = spec.args;
  // A two-word action (`contained on`) is listed by its first word: the argument's choice is that word.
  const actions = mine.map((d) => firstWord(d.cli!.action!));
  const choices = Array.isArray(first.choices) ? [...new Set([...first.choices, ...actions])] : first.choices;
  const asked = (arg: ArgSpec, position: number): ArgSpec => {
    const users = mine.filter((d) => (d.cli?.positional?.length ?? 0) > position).map((d) => firstWord(d.cli!.action!));
    if (!users.length || arg.when === undefined) return arg;
    const when = Array.isArray(arg.when) ? arg.when : [arg.when];
    return { ...arg, when: [...new Set([...when, ...users])] };
  };
  const json = spec.json || mine.some((d) => d.cli?.json) ? { json: true } : {};
  return { ...spec, ...json, args: [{ ...first, choices }, ...rest.map(asked)] };
}

/** Every command the definitions add, and the hand-written ones with their added actions. */
export function withOperationCommands(handWritten: readonly CommandSpec[]): CommandSpec[] {
  return [...handWritten.map((spec) => withActions(spec)), ...commandDefinitions().map(commandSpecOf)];
}
