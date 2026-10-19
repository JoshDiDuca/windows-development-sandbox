// Command-line parsing with commander. parseCli() only parses (no side effects), so it is easy to test; cli/index.ts
// dispatches the result. sandbox claude & co parse as `launch`: every option launch does not own goes to the agent, in
// order.
import path from 'node:path';
import { Argument, Command, InvalidArgumentError, Option } from 'commander';
import { fail } from '../core/util/index.js';
import { c } from './output/index.js';
import { insideSandbox } from '../host/sandbox/index.js';
import { COMMANDS, type ArgSpec, type OptionSpec } from './manifest.js';
import { packageVersion } from '../core/package-info.js';

export interface CliOptions {
  command: string;
  positionals: string[];
  passthrough: string[];
  /** The options as commander parsed them, by attribute name (operation commands build their input from these). */
  raw: Readonly<Record<string, unknown>>;
  config?: string;
  workspace?: string;
  harness?: string;
  account?: string;
  node?: string;
  python?: string;
  scripts: string[];
  databases: string[];
  headless?: boolean;
  terminal: boolean;
  newSession: boolean;
  noAgent: boolean;
  trustConfig: boolean;
  noLocalConfig: boolean;
  personal: boolean;
  fromHost: boolean;
  /** account --agent: whose login (default claude). */
  accountAgent?: string;
  /** account rename --to: the new name. */
  accountTo?: string;
  noRestart: boolean;
  follow: boolean;
  crash: boolean;
  json: boolean;
  yes: boolean;
  /** sessions --wide: also the folder column. */
  wide: boolean;
  /** storage move: keep the old folder (copy instead of rename). */
  keepOld: boolean;
  /** config export: keep folders and files of this PC in the file. */
  withPaths: boolean;
  timeout: number;
  days: number;
  /** restart: every session, not only this folder's project's. */
  all: boolean;
  /** launch --session <agent>@<folder> (repeatable): several sessions at once, folders made absolute. */
  sessions: SessionWant[];
  /** migrate --dry-run, and --restore <backup folder>. */
  dryRun: boolean;
  /** doctor --fix: repair what it finds without asking. */
  fix: boolean;
  restore?: string;
  /** resume --auto: called by the background watcher after a crash. */
  auto: boolean;
  /** update: --check (only look), --rollback, --unattended (no questions), --feed <folder>, --auto on|off. */
  check: boolean;
  rollback: boolean;
  unattended: boolean;
  feed?: string;
  autoUpdate?: 'on' | 'off';
}

/** One session to start: an agent in a folder, with arguments of its own (after the ones given after --). */
export interface SessionWant {
  harness: string;
  folder: string;
  args?: string[];
}

/** Splits a command line like a shell: "quoted words" and 'quoted words' stay together. */
export function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/**
 * `<agent>@<folder>` (the folder may contain '@': only the first one splits), `<agent>` alone = the current folder,
 * and `|<arguments>` for that session's agent only ('|' cannot be in a Windows path). Folders become absolute against
 * `cwd`. Pure; validate.ts checks that the agent and folder exist.
 */
export function parseSessionWant(input: string, cwd: string = process.cwd()): SessionWant {
  const bar = input.indexOf('|');
  const text = bar < 0 ? input : input.slice(0, bar);
  const args = bar < 0 ? [] : splitArgs(input.slice(bar + 1));
  const at = text.indexOf('@');
  const harness = (at < 0 ? text : text.slice(0, at)).trim();
  const folder = at < 0 ? '' : text.slice(at + 1).trim();
  if (!harness)
    fail(
      '--session "' + text + '" names no agent.',
      'Use --session <agent>@<folder>, e.g. --session claude@C:\\code\\api (the folder defaults to this one).',
    );
  return { harness, folder: path.resolve(cwd, folder || '.'), ...(args.length ? { args } : {}) };
}

/** Reserved spelling for our launch options that can never clash with an agent's flags: --sbx-terminal, ... */
const SBX_PREFIX = '--sbx-';

function positiveNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('expected a positive number');
  return n;
}
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Commands in --help, group by group, in this order (a command not listed comes last in its group). */
const HELP_ORDER = [
  ['Agents', ['launch', 'start', 'resume', 'restart', 'stop', 'host']],
  ['Sessions', ['sessions', 'attach', 'status', 'exec', 'show', 'hide', 'db']],
  ['Projects & accounts', ['projects', 'account']],
  ['Data', ['data', 'storage', 'clean', 'sync']],
  ['Web', ['web']],
  ['Health', ['setup', 'doctor', 'repair', 'logs', 'audit', 'update', 'migrate', 'config']],
  ['Advanced', ['generate', 'agent-commands', 'vpn', 'github']],
] as const satisfies readonly (readonly [string, readonly string[]])[];

/** The commands in the order --help lists them. */
function helpOrdered(): typeof COMMANDS {
  const flat = HELP_ORDER.flatMap(([, names]) => names as readonly string[]);
  const rank = (name: string): number => {
    const i = flat.indexOf(name);
    return i < 0 ? flat.length : i;
  };
  return [...COMMANDS].sort((x, y) => rank(x.name) - rank(y.name));
}

/** The options of one manifest entry: the visible one, and a hidden old spelling when `shownAs` renames it. */
function toOptions(o: OptionSpec, wrapper: boolean): Option[] {
  const shown = o.shownAs && !wrapper ? o.shownAs : o.flag;
  const placeholder = o.type === 'boolean' ? '' : ' <' + (o.value ?? 'value') + '>';
  const make = (flag: string): Option => {
    const option = new Option((o.short ? o.short + ', ' : '') + flag + placeholder, o.description);
    if (o.type === 'number') option.argParser(positiveNumber);
    if (o.type === 'list') option.argParser(collect);
    if (o.default !== undefined) option.default(o.default);
    if (o.group) option.helpGroup(o.group + ':');
    return option;
  };
  const visible = make(shown);
  return shown === o.flag ? [visible] : [visible, make(o.flag).hideHelp()];
}

/** A positional argument; fixed choices are checked by the parser and listed in --help. */
function toArgument(arg: ArgSpec): Argument {
  const name = (arg.required ? '<' : '[') + arg.name + (arg.variadic ? '...' : '') + (arg.required ? '>' : ']');
  const argument = new Argument(name, arg.description);
  if (Array.isArray(arg.choices)) {
    argument.choices(arg.choices);
    const aliases = arg.aliases ?? [];
    const check = argument.parseArg;
    if (aliases.length && check)
      argument.argParser((value: string, previous: unknown) =>
        aliases.includes(value) ? value : check(value, previous),
      );
  }
  return argument;
}

/** "Unknown command" with the suggestion in our words; other commander errors only lose the lower-case start. */
export function friendlyError(text: string): string {
  const m = /^error: unknown command '(.*)'\n\(Did you mean (.*)\?\)\n?$/.exec(text);
  if (m) {
    const names = m[2].replace(/^one of /, '').split(', ');
    return 'Unknown command "' + m[1] + '". Did you mean: ' + names.map((n) => 'sandbox ' + n).join(' or ') + '?\n';
  }
  return text.replace(/^error: /, '').replace(/^./, (ch) => ch.toUpperCase());
}

function rootHelp(): string {
  const lines = [
    '',
    'Start an agent by name: sandbox claude, sandbox codex ... (the same as sandbox launch --agent <name>).',
    'Put --config <file> before or after the command to use another settings file.',
  ];
  if (insideSandbox())
    lines.push(
      'You are inside a sandbox: launch, resume, attach, restart, stop, exec, show, hide, storage and web control it from your PC and do not work here.',
    );
  lines.push(
    '',
    'Examples:',
    '  sandbox                       the menu',
    '  sandbox claude -t             start Claude and attach this terminal',
    '  sandbox data clean logs       delete the saved logs',
    '  sandbox exec -- npm test      run a command in the running sandbox',
  );
  return lines.join('\n');
}

/**
 * Every command, its options and help text, from manifest.ts. Actions only record what was parsed. `wrapper` = the
 * sandbox <agent> spelling: --agent stays the agent's own flag there (Claude has one), only --harness is ours.
 */
export function buildProgram(record: (name: string, cmd: Command) => void, wrapper = false): Command {
  const program = new Command('sandbox')
    .description(
      'A disposable Windows Sandbox for development, with or without an AI agent, for the folder you are in. Run it with no arguments for the menu.',
    )
    .version(packageVersion(), '-v, --version', 'show the version')
    .enablePositionalOptions()
    .showHelpAfterError('  Fix:  run the command with --help to see how to use it.')
    .configureOutput({ outputError: (text, write) => write(c.red('Error: ') + friendlyError(text)) })
    .addHelpText('after', rootHelp)
    .exitOverride();
  for (const spec of helpOrdered()) {
    const cmd = program
      .command(spec.name, { hidden: spec.hidden })
      .description(spec.summary)
      .helpGroup(spec.group + ':')
      .addOption(new Option('--config <file>', 'config file (default: ~/.agent-sandbox/config.json)').hideHelp());
    for (const option of spec.options) for (const o of toOptions(option, wrapper)) cmd.addOption(o);
    if (spec.json) cmd.option('--json', 'machine-readable output');
    for (const arg of spec.args) cmd.addArgument(toArgument(arg));
    if (spec.passthrough === 'agent')
      cmd.argument('[agentArgs...]', 'passed to the agent').allowUnknownOption().allowExcessArguments();
    if (spec.passthrough === 'command') cmd.passThroughOptions();
    if (spec.examples?.length)
      cmd.addHelpText('after', '\nExamples:\n' + spec.examples.map((l) => '  ' + l).join('\n'));
    cmd.action((...args: unknown[]) => record(spec.name, args[args.length - 1] as Command));
  }
  return program;
}

/** Turns `--sbx-<option>` into `--<option>` (only for options launch knows; anything else is an error). */
function expandReserved(argv: string[], known: Set<string>): string[] {
  const end = argv.indexOf('--');
  return argv.map((token, i) => {
    if ((end !== -1 && i > end) || !token.startsWith(SBX_PREFIX)) return token;
    const [flag, value] = token.split(/=(.*)/s);
    const option = '--' + flag.slice(SBX_PREFIX.length);
    if (!known.has(option))
      fail(
        'Unknown option: ' + flag,
        'Reserved --sbx- options: ' + [...known].map((o) => o.replace('--', SBX_PREFIX)).join(', '),
      );
    return value === undefined ? option : option + '=' + value;
  });
}

/** Parses argv into the command name and options. Throws commander errors for unknown commands/options. */
export function parseCli(argv: string[], wrapper = false): CliOptions {
  let parsed: { name: string; cmd: Command } | null = null;
  const program = buildProgram((name, cmd) => {
    parsed = { name, cmd };
  }, wrapper);
  const launchFlags = new Set(
    program.commands
      .find((c) => c.name() === 'launch')!
      .options.map((o) => o.long!)
      .filter(Boolean),
  );
  const args = expandReserved(wrapper ? ['launch', ...argv] : argv, launchFlags);
  program.parse(args, { from: 'user' });
  if (!parsed) return { ...defaults(), command: '' };
  const { name, cmd } = parsed as { name: string; cmd: Command };
  const o = { ...program.opts(), ...cmd.opts() } as Record<string, unknown>;
  const forAgent = ['launch', 'start', 'generate', 'host-claude', 'host'].includes(name);
  // Commander keeps our `--` separator among the operands when unknown options are allowed; it is ours, not the
  // agent's.
  const separator = forAgent ? cmd.args.indexOf('--') : -1;
  const operands = separator === -1 ? cmd.args : [...cmd.args.slice(0, separator), ...cmd.args.slice(separator + 1)];
  return {
    ...defaults(),
    // `start` is launch without an agent.
    command: name === 'start' ? 'launch' : name,
    positionals: forAgent || name === 'exec' ? [] : operands,
    passthrough: forAgent || name === 'exec' ? operands : [],
    raw: o,
    config: o.config as string | undefined,
    workspace: o.workspace as string | undefined,
    harness:
      (o.harness as string | undefined) ?? (name !== 'account' && typeof o.agent === 'string' ? o.agent : undefined),
    account: o.account as string | undefined,
    node: o.node as string | undefined,
    python: o.python as string | undefined,
    scripts: (o.script as string[] | undefined) ?? [],
    databases: ((o.database as string[] | undefined) ?? [])
      .flatMap((d) => d.split(','))
      .map((d) => d.trim())
      .filter(Boolean),
    headless: o.window ? false : o.headless ? true : undefined,
    terminal: Boolean(o.terminal),
    newSession: Boolean(o.new),
    noAgent: o.agent === false || name === 'start',
    trustConfig: Boolean(o.trustConfig),
    noLocalConfig: o.localConfig === false,
    personal: Boolean(o.personal),
    fromHost: Boolean(o.fromHost),
    accountAgent: name === 'account' && typeof o.agent === 'string' ? o.agent : undefined,
    accountTo: name === 'account' && typeof o.to === 'string' ? o.to : undefined,
    noRestart: o.restart === false,
    follow: Boolean(o.follow),
    crash: Boolean(o.crash),
    json: Boolean(o.json),
    yes: Boolean(o.yes),
    wide: Boolean(o.wide),
    keepOld: Boolean(o.keepOld),
    withPaths: Boolean(o.withPaths),
    all: Boolean(o.all),
    // launch --session is repeatable (a list); `audit --session <id>` is one id, which its definition reads.
    sessions: (Array.isArray(o.session) ? (o.session as string[]) : []).map((s) => parseSessionWant(s)),
    timeout: (o.timeout as number | undefined) ?? 600,
    days: (o.days as number | undefined) ?? 7,
    dryRun: Boolean(o.dryRun),
    fix: Boolean(o.fix),
    auto: o.auto === true,
    restore: o.restore as string | undefined,
    check: Boolean(o.check),
    rollback: Boolean(o.rollback),
    unattended: Boolean(o.unattended),
    feed: o.feed as string | undefined,
    autoUpdate: updateAuto(o.auto),
  };
}

/** `update --auto on|off` (the same flag is a switch for resume): anything else is refused. */
function updateAuto(value: unknown): 'on' | 'off' | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === 'on' || value === 'off') return value;
  return fail('--auto needs on or off.', 'Use sandbox update --auto on, or --auto off.');
}

function defaults(): CliOptions {
  return {
    command: '',
    positionals: [],
    passthrough: [],
    raw: {},
    scripts: [],
    databases: [],
    terminal: false,
    newSession: false,
    noAgent: false,
    trustConfig: false,
    noLocalConfig: false,
    personal: false,
    fromHost: false,
    noRestart: false,
    follow: false,
    crash: false,
    dryRun: false,
    fix: false,
    auto: false,
    check: false,
    rollback: false,
    unattended: false,
    json: false,
    yes: false,
    wide: false,
    keepOld: false,
    withPaths: false,
    all: false,
    sessions: [],
    timeout: 600,
    days: 7,
  };
}
