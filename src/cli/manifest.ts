// Every command, defined once: name, group, arguments and options with their types. args.ts builds the commander
// parser from it and menu.ts builds the interactive menu from it, so a command added here works both ways. Commands of
// the shared core (status, sessions, stop ... and actions such as config get) come from their definitions' CLI hints
// (cli/operations/spec.ts); this list shrinks as areas move into src/app.
import { z } from 'zod';
// The file rather than the barrel: the barrel's handlers need the registry, which needs the commands.
import { withOperationCommands } from './operations/spec.js';

const ChoicesSchema = z
  .union([z.array(z.string()), z.enum(['harnesses', 'accounts', 'sessions'])])
  .describe('Fixed values, or a list the menu fills in at run time.');

export const OptionSpecSchema = z.strictObject({
  flag: z
    .string()
    .regex(/^--[a-z][a-z0-9-]*$/)
    .describe('Long flag, e.g. --terminal.'),
  short: z
    .string()
    .regex(/^-[a-zA-Z]$/)
    .optional(),
  type: z.enum(['boolean', 'string', 'number', 'list']).describe('list = repeatable string option.'),
  value: z.string().optional().describe('Placeholder shown in help, e.g. name for --account <name>.'),
  description: z.string(),
  /** Plain words for the menu form (the flag is shown when there is none). */
  label: z.string().optional(),
  default: z.union([z.string(), z.number()]).optional(),
  choices: ChoicesSchema.optional(),
  /** Advanced options are only asked in the menu after "Show advanced options". */
  advanced: z.boolean().optional(),
  /** Only asked in the menu when the command's first argument has this value (account save: --from-host). */
  when: z.string().optional(),
  /** Never offered in the menu (dangerous shortcuts such as --yes); typing it on the command line still works. */
  noMenu: z.boolean().optional(),
  /** Heading for this option in the command's --help (launch: Session, Folder ...). */
  group: z.string().optional(),
  /** The name shown in --help; `flag` stays accepted as a hidden alias (--agent shown, --harness still works). */
  shownAs: z
    .string()
    .regex(/^--[a-z][a-z0-9-]*$/)
    .optional(),
});

export const ArgSpecSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  required: z.boolean(),
  variadic: z.boolean().optional(),
  choices: ChoicesSchema.optional(),
  /** Spellings accepted besides `choices` but not listed (old names). */
  aliases: z.array(z.string()).optional(),
  /** Only asked in the menu when the command's first argument has this value, or one of these (data clean: targets). */
  when: z.union([z.string(), z.array(z.string())]).optional(),
});

/** Is an argument or option with this `when` asked, given the first argument's answer? */
export function askedWhen(when: string | string[] | undefined, first: string): boolean {
  return when === undefined || (Array.isArray(when) ? when.includes(first) : when === first);
}

export const GroupSchema = z.enum(['Agents', 'Sessions', 'Projects & accounts', 'Data', 'Web', 'Health', 'Advanced']);

export const CommandSpecSchema = z.strictObject({
  name: z.string(),
  summary: z.string(),
  group: GroupSchema,
  args: z.array(ArgSpecSchema),
  options: z.array(OptionSpecSchema),
  /** Unknown options and extra arguments are passed on to the agent (launch) or the program (exec). */
  passthrough: z.enum(['agent', 'command']).optional(),
  json: z.boolean().optional(),
  /** Takes over the terminal or ends the session: the menu does not come back afterwards. */
  interactive: z.boolean().optional(),
  hidden: z.boolean().optional(),
  /** Command lines shown in an Examples block at the end of the command's --help. */
  examples: z.array(z.string()).optional(),
});

export type OptionSpec = z.output<typeof OptionSpecSchema>;
export type ArgSpec = z.output<typeof ArgSpecSchema>;
export type CommandSpec = z.output<typeof CommandSpecSchema>;

function bool(flag: string, description: string, extra: Partial<OptionSpec> = {}): OptionSpec {
  return {
    flag,
    type: 'boolean',
    description,
    ...extra,
  };
}
function text(flag: string, value: string, description: string, extra: Partial<OptionSpec> = {}): OptionSpec {
  return {
    flag,
    type: 'string',
    value,
    description,
    ...extra,
  };
}

/** Plain words for the start form's options (the command line keeps the flags). */
const LABELS: Readonly<Record<string, string>> = {
  '--harness': 'Agent',
  '--account': 'Claude account',
  '--terminal': 'Attach this terminal',
  '--headless': 'Hide the sandbox window',
  '--window': 'Show the sandbox window',
  '--new': 'Always start a new session',
  '--workspace': 'Folder',
  '--node': 'Node version',
  '--python': 'Python version',
  '--database': 'Databases to start',
  '--script': 'Scripts to run first',
  '--trust-config': "Approve the folder's config",
  '--no-local-config': "Ignore the folder's config",
  '--no-agent': 'Start no agent',
};
function labelled(options: OptionSpec[]): OptionSpec[] {
  return options.map((o) => (LABELS[o.flag] ? { ...o, label: LABELS[o.flag] } : o));
}

const SESSION = 'Session';
const FOLDER = 'Folder';
const VERSIONS = 'Versions & services';
const TRUST = 'Trust';

const SANDBOX_OPTIONS: OptionSpec[] = labelled([
  bool('--terminal', "attach this terminal (reuses this folder's session if nobody is watching it)", {
    short: '-t',
    group: SESSION,
  }),
  bool('--headless', 'hide the sandbox window (sandbox show brings it back)', { group: SESSION }),
  bool('--new', 'always start a new session, even if this folder has an unattached one', { group: SESSION }),
  text('--workspace', 'dir', 'use this folder instead of the current one', { group: FOLDER }),
  text('--node', 'version', "Node version (default: your project's .nvmrc or this PC's version)", {
    advanced: true,
    group: VERSIONS,
  }),
  text('--python', 'version', "Python 3 version (default: your project's .python-version or your settings)", {
    advanced: true,
    group: VERSIONS,
  }),
  {
    flag: '--database',
    type: 'list',
    value: 'name',
    description: 'also start this database (postgres, mysql, mongodb, redis, dynamodb; repeatable)',
    choices: ['postgres', 'mysql', 'mongodb', 'redis', 'dynamodb'],
    advanced: true,
    group: VERSIONS,
  },
  {
    flag: '--script',
    type: 'list',
    value: 'file',
    description: 'run this .ps1/.mjs/.cmd inside the sandbox first (repeatable)',
    advanced: true,
    group: VERSIONS,
  },
  bool('--window', 'show the sandbox window even if your settings say headless', { advanced: true, group: SESSION }),
  bool('--trust-config', "approve the folder's .sandbox-config.json without asking", { advanced: true, group: TRUST }),
  bool('--no-local-config', "ignore the folder's .sandbox-config.json", { advanced: true, group: TRUST }),
  bool('--yes', 'restart the sandbox without asking if this folder needs it', { noMenu: true, group: TRUST }),
]);
const AGENT_OPTIONS: OptionSpec[] = labelled([
  text('--harness', 'name', 'agent to run', { choices: 'harnesses', shownAs: '--agent', group: SESSION }),
  {
    flag: '--session',
    type: 'list',
    value: 'agent@folder',
    description: 'start several sessions at once (repeatable; see the examples below; -t attaches the first)',
    noMenu: true,
    group: SESSION,
  },
  text('--account', 'name', 'Claude account for this sandbox', { choices: 'accounts', group: SESSION }),
  ...SANDBOX_OPTIONS,
  bool('--no-agent', 'set up the sandbox but do not start an agent', { advanced: true, group: SESSION }),
]);
const json = true;

/** A spec as written below (`as const` makes every array readonly). */
type Frozen<T> = T extends readonly (infer U)[]
  ? readonly Frozen<U>[]
  : T extends object
    ? { readonly [K in keyof T]: Frozen<T[K]> }
    : T;

const COMMAND_LIST = [
  {
    name: 'launch',
    summary: 'start the sandbox and an agent (or another session in the running sandbox)',
    group: 'Agents',
    args: [],
    options: AGENT_OPTIONS,
    passthrough: 'agent',
    interactive: true,
    examples: [
      'sandbox claude -t                  start Claude here and attach this terminal',
      'sandbox launch --agent codex       start Codex in the current folder',
      'sandbox launch --session claude@C:\\code\\api --session "codex@C:\\code\\web|--model o3"',
      "                                   two sessions at once (after | = that agent's own arguments)",
    ],
  },
  {
    name: 'start',
    summary: 'start a sandbox with no agent (tools and databases only)',
    group: 'Agents',
    args: [],
    options: SANDBOX_OPTIONS.filter((o) => o.flag !== '--new'),
    interactive: true,
  },
  {
    name: 'generate',
    summary: 'show what a start would do, without starting anything',
    group: 'Advanced',
    args: [],
    options: AGENT_OPTIONS,
    passthrough: 'agent',
  },
  {
    name: 'attach',
    summary: 'show a running session in this terminal (Ctrl+] detaches)',
    group: 'Sessions',
    args: [{ name: 'id', description: 'session (default: the newest)', required: false, choices: 'sessions' }],
    options: [],
    interactive: true,
  },
  {
    name: 'resume',
    summary: 'reopen the sessions from the last sandbox',
    group: 'Agents',
    args: [],
    options: [
      bool('--auto', 'used by the background sync after a crash: no questions', { noMenu: true, advanced: true }),
    ],
  },
  {
    name: 'db',
    summary: 'list, start or stop databases in the running sandbox',
    group: 'Sessions',
    args: [
      { name: 'action', description: 'list, start or stop', required: false, choices: ['list', 'start', 'stop'] },
      {
        name: 'name',
        description: 'postgres, mysql, mongodb, redis or dynamodb',
        required: false,
        choices: ['postgres', 'mysql', 'mongodb', 'redis', 'dynamodb'],
      },
    ],
    options: [],
  },
  {
    name: 'exec',
    summary: 'run a command inside the sandbox and print its output',
    group: 'Sessions',
    examples: [
      'sandbox exec -- npm test            run a command in the running sandbox',
      'sandbox exec --json -- node -v      the result as JSON',
    ],
    args: [{ name: 'command', description: 'command and its arguments', required: true, variadic: true }],
    options: [
      {
        flag: '--timeout',
        type: 'number',
        value: 'seconds',
        description: 'give up after this many seconds',
        default: 600,
      },
      text('--workspace', 'dir', 'folder (inside the mapped workspace) to run in'),
    ],
    passthrough: 'command',
    json,
  },
  {
    name: 'projects',
    summary: 'the projects a sandbox can open without a restart: list, choose, roots, all/exclude',
    group: 'Projects & accounts',
    json,
    examples: [
      'sandbox projects                   list your projects',
      'sandbox projects add .             remember this folder',
      'sandbox projects roots add C:\\code   share every project in C:\\code',
    ],
    args: [
      {
        name: 'action',
        description: 'list, choose, add, remove, include, exclude, all, roots',
        required: false,
        choices: ['list', 'choose', 'add', 'remove', 'include', 'exclude', 'all', 'roots'],
      },
      {
        name: 'value',
        description: 'a folder (add, remove, include, exclude), on/off (all), or list/add/remove (roots)',
        required: false,
        when: ['add', 'remove', 'include', 'exclude', 'all', 'roots'],
      },
      { name: 'folder', description: '(roots add/remove) the folder', required: false, when: 'roots' },
    ],
    options: [bool('--yes', 'do not ask before removing', { short: '-y', when: 'remove', noMenu: true })],
  },
  {
    name: 'account',
    summary: 'Claude logins: list, save, use, set the default, remove',
    group: 'Projects & accounts',
    examples: [
      'sandbox account save work          save the login you signed in with inside the sandbox',
      'sandbox account use work           the sandbox uses it (running sessions restart)',
    ],
    args: [
      {
        name: 'action',
        description: 'what to do',
        required: false,
        choices: ['list', 'save', 'use', 'default', 'rename', 'remove'],
      },
      { name: 'name', description: 'account name', required: false, choices: 'accounts' },
    ],
    options: [
      text('--to', 'name', '(rename) the new name', { when: 'rename', label: 'New name' }),
      text('--agent', 'name', 'whose login: an agent that keeps one (default: claude)', {
        choices: 'harnesses',
        label: 'Agent',
      }),
      bool('--from-host', "(save) save this PC's login instead of the sandbox's", { when: 'save' }),
      bool('--no-restart', '(use) do not restart running sessions', { when: 'use' }),
      bool('--yes', '(remove) do not ask first', { short: '-y', when: 'remove', noMenu: true }),
    ],
    json,
  },
  {
    name: 'data',
    summary: 'show what is kept between sandboxes (tools, databases, logins, logs), or delete some of it',
    group: 'Data',
    args: [
      {
        name: 'action',
        description: 'show or clean',
        required: false,
        choices: ['show', 'clean'],
        aliases: ['info', 'list', 'remove'],
      },
      {
        name: 'targets',
        description: 'what to clean, e.g. tools/go databases logs',
        required: false,
        variadic: true,
        when: 'clean',
      },
    ],
    options: [bool('--yes', 'do not ask before deleting', { short: '-y', noMenu: true })],
    json,
    examples: [
      'sandbox data clean                 pick what to delete from a list',
      'sandbox data clean logs tools/go   delete these',
    ],
  },
  {
    name: 'storage',
    summary:
      'where your saved data lives: show it, move it to another folder, switch folders, or (beta) keep it in a disk image',
    group: 'Data',
    examples: [
      'sandbox storage                    where the data is',
      'sandbox storage move D:\\sandbox-data   move it (asks first)',
      'sandbox storage contained status   (beta) the disk image for tools, state and logs',
      'sandbox storage contained on       (beta) keep them in a disk image (asks first)',
    ],
    args: [
      {
        name: 'action',
        description: 'show, move, use or contained',
        required: false,
        choices: ['show', 'move', 'use', 'contained'],
      },
      {
        name: 'folder',
        description: 'the folder to move to, or to use; for contained: on, off or status',
        required: false,
        when: ['move', 'use', 'contained'],
      },
    ],
    options: [
      bool('--yes', 'do not ask before moving or switching', { short: '-y', noMenu: true }),
      bool('--keep-old', 'copy instead of moving: the old folder stays (needs room for both)', { when: 'move' }),
    ],
    json,
  },
  {
    name: 'engine',
    summary: '(beta) what runs your sandbox (Windows Sandbox or HCS) and what each engine can do on this PC',
    group: 'Health',
    examples: [
      'sandbox engine                  the engine in use and what each can do',
      'sandbox engine check hcs        what this PC lacks for the HCS engine, and the commands that would fix it',
      'sandbox engine leftovers        HCS systems a crashed command left running',
      'sandbox engine clean            stop them (memory is freed; nothing is deleted)',
    ],
    args: [
      { name: 'action', description: 'show, check, leftovers or clean', required: false, choices: ['show', 'check'] },
      {
        name: 'engine',
        description: 'the engine to check',
        required: false,
        choices: ['windows-sandbox', 'hcs'],
        when: 'check',
      },
    ],
    options: [bool('--yes', '(clean) do not ask before stopping', { short: '-y', when: 'clean', noMenu: true })],
    json,
  },
  { name: 'sync', summary: 'copy conversation history back to this PC now', group: 'Data', args: [], options: [] },
  {
    name: 'audit',
    summary:
      'what happened in your sandboxes: programs started, files changed, sessions, repo guard (turn it on: sandbox config set audit.enabled true)',
    group: 'Health',
    json,
    args: [],
    options: [
      { flag: '--days', type: 'number', value: 'n', description: 'the last n days (default: today)', default: 1 },
      text('--kind', 'kind', 'only proc, file, session or guard events', {
        choices: ['proc', 'file', 'session', 'guard'],
      }),
      text('--grep', 'text', 'only events containing this text'),
    ],
  },
  {
    name: 'logs',
    summary: 'print the newest sandbox log',
    group: 'Health',
    args: [],
    options: [
      bool('--follow', 'keep printing new lines', { short: '-f' }),
      bool('--crash', 'print the report of the last crash (what Windows logged, this PC and the sandbox memory)'),
    ],
  },
  {
    name: 'setup',
    summary: 'check this PC can run Windows Sandbox and offer to turn it on',
    group: 'Health',
    args: [],
    options: [],
  },
  {
    name: 'doctor',
    summary: 'check this PC, the install, your settings and the sandbox, and offer to fix what it finds',
    group: 'Health',
    args: [],
    options: [
      text('--harness', 'name', 'agent to check', { choices: 'harnesses', shownAs: '--agent' }),
      bool('--fix', 'fix what can be fixed without asking', { noMenu: true }),
    ],
    json: true,
  },
  {
    name: 'repair',
    summary: 'find and fix problems (install, data folder, settings, stale state, half-installed tools)',
    group: 'Health',
    args: [],
    options: [bool('--yes', 'do not ask before fixing', { short: '-y', noMenu: true })],
    json: true,
  },
  {
    name: 'self-test',
    summary: 'run the built-in tests',
    group: 'Health',
    hidden: true,
    args: [
      {
        name: 'suite',
        description: 'run only these test suites, e.g. config live-daemon (default: all)',
        required: false,
        variadic: true,
      },
    ],
    options: [],
  },
  {
    name: 'config',
    summary: "show or create your settings file, or check a project's .sandbox-config.json",
    group: 'Health',
    args: [
      {
        name: 'action',
        description: 'what to do',
        required: false,
        choices: ['show', 'path', 'init', 'schema', 'check', 'get', 'set', 'export', 'import'],
        aliases: ['summary'],
      },
      {
        name: 'key',
        description: '(get, set, reset) the setting, e.g. sandbox.memoryMb; (export, import) the .json file',
        required: false,
        when: ['get', 'set', 'export', 'import'],
      },
      { name: 'value', description: '(set) the new value', required: false, when: 'set' },
    ],
    options: [
      text('--workspace', 'dir', '(check) the project folder; default: the current one'),
      bool('--with-paths', '(export) keep folders and files of this PC in the file', { when: 'export' }),
      bool('--yes', '(import) do not ask before changing your settings', { short: '-y', when: 'import', noMenu: true }),
    ],
    examples: [
      'sandbox config set sandbox.memoryMb 8192',
      'sandbox config get sandbox.memoryMb',
      'sandbox config reset sandbox.memoryMb',
      'sandbox config list',
      'sandbox config export team-settings.json',
      'sandbox config import team-settings.json',
    ],
  },
  {
    name: 'agent-commands',
    summary: '(Beta) make claude, codex ... on this PC start in a hidden sandbox and attach',
    group: 'Advanced',
    args: [{ name: 'action', description: 'on, off or status', required: false, choices: ['status', 'on', 'off'] }],
    options: [],
  },
  {
    name: 'vpn',
    summary: 'the VPN for the sandbox: save your login, see whether it is on (NordVPN first)',
    group: 'Advanced',
    args: [
      {
        name: 'action',
        description: 'status, login or logout',
        required: false,
        choices: ['status', 'login', 'logout'],
      },
    ],
    options: [],
    json: true,
    examples: ['sandbox vpn login', 'sandbox vpn status'],
  },
  {
    name: 'host-claude',
    summary: 'run Claude on this PC, NOT sandboxed, with its own profile (same as: sandbox host claude)',
    group: 'Agents',
    args: [],
    options: [bool('--personal', 'use your normal Claude profile')],
    passthrough: 'agent',
    interactive: true,
    hidden: true,
  },
  {
    name: 'host',
    summary: 'run an agent on this PC, NOT sandboxed (sandbox host <agent> -- <arguments>)',
    group: 'Agents',
    args: [{ name: 'agent', description: 'the agent to run here', required: true, choices: 'harnesses' }],
    options: [bool('--personal', '(claude) use your normal Claude profile')],
    passthrough: 'agent',
    interactive: true,
  },
  {
    name: 'menu',
    summary: 'the interactive menu (what `sandbox` opens with no arguments)',
    group: 'Advanced',
    args: [],
    options: [],
    hidden: true,
    interactive: true,
  },
  {
    name: 'web',
    summary: '(beta) your sandbox sessions in a browser on this PC: start, stop, status or open',
    group: 'Web',
    examples: ['sandbox web open               start the web UI and open it in your browser'],
    args: [
      {
        name: 'action',
        description: 'start the server, stop it, show whether it runs, or open it in your browser',
        required: false,
        choices: ['start', 'stop', 'status', 'open'],
      },
    ],
    options: [],
    json,
  },
  { name: '_watch', summary: 'background history sync', group: 'Data', args: [], options: [], hidden: true },
  {
    name: '_web',
    summary: 'the web UI server (started by sandbox web start)',
    group: 'Web',
    args: [],
    options: [],
    hidden: true,
  },
] as const satisfies readonly Frozen<CommandSpec>[];

/** The hand-written commands (the shared core's own commands are not in this union). */
export type CommandName = (typeof COMMAND_LIST)[number]['name'];

export const COMMANDS: CommandSpec[] = z
  .array(CommandSpecSchema)
  .parse(withOperationCommands(z.array(CommandSpecSchema).parse(COMMAND_LIST)));

export function commandSpec(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}
