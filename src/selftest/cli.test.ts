// The command manifest, the argument parser, the interactive menu helpers and the settings screen. One definition
// (cli/manifest.ts) drives both the flags and the menu.
import fs from 'node:fs';
import path from 'node:path';
import { buildProgram, friendlyError, parseCli } from '../cli/args.js';
import { askRequired } from '../core/prompt.js';
import { COMMANDS } from '../cli/manifest.js';
import { commandLine, readHistory, recordHistory } from '../cli/history.js';
import { splitArgs } from '../cli/args.js';
import { optionProblem } from '../cli/menu/index.js';
import { cleanTargetOf, type DataEntry } from '../cli/services/index.js';
import { ago, colorEnabled, shorten } from '../cli/output/index.js';
import { versionText } from '../cli/version.js';
import { hoistConfig, withoutConfig } from '../cli/argv.js';
import { closest, validNodeSpec, validPythonSpec } from '../cli/validate.js';
import { CATEGORIES, editConfigText, SETTINGS_ELSEWHERE } from '../app/features/settings/index.js';
import { SchemaNode } from '../app/kernel/index.js';
import { Frame, ListScreen, Text, TextScreen, type Key } from '../cli/tui/index.js';
import { ConfigSchema, LocalOverridesSchema } from '../core/schema/index.js';
import type { Suite } from './support/suite.js';

export const cliSuite: Suite = {
  name: 'cli',
  title: 'command manifest, argument parser, menu helpers, settings screen',
  run: async (t) => {
    t.section('manifest and parser');
    const program = buildProgram(() => undefined);
    const visible = COMMANDS.filter((c) => !c.hidden).map((c) => c.name);
    t.equal(
      visible.filter((name) => !program.commands.some((c) => c.name() === name)),
      [],
      'every manifest command exists in the parser',
    );
    const packageJson = JSON.parse(fs.readFileSync(path.join(t.packageRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    t.check(
      program.version() === packageJson.version &&
        program.commands.find((c) => c.name() === 'launch')!.options.some((o) => o.long === '--terminal'),
      '--version is the package version and manifest options exist in the parser',
    );

    t.check(
      versionText(['--version'], t.packageRoot)?.startsWith(packageJson.version + ' (') === true &&
        versionText(['-v'], t.packageRoot)?.includes(t.packageRoot) === true &&
        versionText(['--version', '--short'], t.packageRoot) === packageJson.version &&
        versionText(['status'], t.packageRoot) === null &&
        versionText(['--short'], t.packageRoot) === null &&
        versionText(['--version', 'x'], t.packageRoot) === null,
      '--version says where it runs from; --version --short is the plain number the updater compares',
    );

    const start = parseCli(['start', '--headless']);
    const clean = parseCli(['data', 'clean', 'tools/go', 'logs', '--yes']);
    t.equal(
      [
        [start.command, start.noAgent, start.headless],
        [clean.command, clean.positionals, clean.yes],
        parseCli(['start', '--database', 'postgres,redis', '--database', 'mongodb']).databases,
        parseCli(['launch', '--harness', 'opencode', '--', '--continue']).passthrough,
      ],
      [
        ['launch', true, true],
        ['data', ['clean', 'tools/go', 'logs'], true],
        ['postgres', 'redis', 'mongodb'],
        ['--continue'],
      ],
      '`start` is launch without an agent; positionals, repeated lists and arguments after -- parse',
    );

    t.section('parser: agent wrappers (claude-sbx ...) and agent-sandbox');
    const wrapped = parseCli(['--terminal', '--continue', '--headless', '--node', '20', '--', '--terminal'], true);
    t.equal(
      [wrapped.command, wrapped.terminal, wrapped.headless, wrapped.node, wrapped.passthrough],
      ['launch', true, true, '20', ['--continue', '--terminal']],
      'claude-sbx: sandbox flags are consumed, everything else goes to the agent',
    );
    await t.throws(
      () => parseCli(['status', '--bogus']),
      'unknown option',
      'agent-sandbox: unknown options are errors',
    );
    const agentFlags = parseCli(
      ['--model', 'opus', '-p', 'fix it', '--json', '-f', 'x', '--timeout', '5', '--resume', 'abc'],
      true,
    );
    t.check(
      agentFlags.passthrough.join('|') === '--model|opus|-p|fix it|--json|-f|x|--timeout|5|--resume|abc' &&
        !agentFlags.json &&
        !agentFlags.follow &&
        agentFlags.timeout === 600,
      'claude-sbx: any flag that is not a launch option goes to the agent in order and sets no agent-sandbox option',
    );
    const reserved = parseCli(['--sbx-terminal', '--terminal', '--sbx-node=18'], true);
    t.equal(
      [reserved.terminal, reserved.node, reserved.passthrough],
      [true, '18', []],
      '--sbx-<option> always means agent-sandbox',
    );
    await t.throws(
      () => parseCli(['--sbx-nope'], true),
      'Unknown option: --sbx-nope',
      'an unknown --sbx-<option> is an error',
    );

    t.section('menu helpers');
    t.check(
      splitArgs('--model "big one" -c \'x y\'').join('|') === '--model|big one|-c|x y' &&
        commandLine(['exec', 'echo', 'a b']) === 'sandbox exec echo "a b"',
      'menu: arguments split like a shell and command lines are quoted',
    );
    const optionOf = (flag: string) => COMMANDS.flatMap((cmd) => cmd.options).find((o) => o.flag === flag)!;
    t.check(
      optionProblem(optionOf('--node'), 'abc') !== undefined &&
        optionProblem(optionOf('--node'), '22') === undefined &&
        optionProblem(optionOf('--workspace'), path.join(t.packageRoot, 'no-such-folder-here')) !== undefined &&
        optionProblem(optionOf('--workspace'), t.packageRoot) === undefined &&
        optionProblem(optionOf('--days'), '0') !== undefined,
      'menu: bad Node versions, missing folders and numbers below the minimum are rejected while typing',
    );
    const rowOf = (area: DataEntry['area'], name: string): DataEntry => ({ area, name, path: 'x', bytes: 1 });
    t.equal(
      [
        cleanTargetOf(rowOf('tools', 'go')),
        cleanTargetOf(rowOf('host', 'launches')),
        cleanTargetOf(rowOf('host', 'accounts')),
        cleanTargetOf(rowOf('tools', '(files in tools)')),
      ],
      ['tools/go', 'launches', null, null],
      'data menu: removable rows become targets; accounts and loose files are never offered',
    );

    t.section('--config placement, history, validation, text helpers');
    t.equal(
      [
        hoistConfig(['--config', 'a.json', 'status', '--json']),
        hoistConfig(['--config=a.json']),
        withoutConfig(['status', '--config', 'a.json', '--json']),
      ],
      [
        ['status', '--config', 'a.json', '--json'],
        ['menu', '--config', 'a.json'],
        ['status', '--json'],
      ],
      '--config is moved behind the command, alone it opens the menu, and history drops it',
    );
    recordHistory(['launch', '--harness', 'claude']);
    recordHistory(['status']);
    recordHistory(['launch', '--harness', 'claude']);
    recordHistory(['menu']);
    t.equal(
      readHistory().map((h) => h.argv.join(' ')),
      ['launch --harness claude', 'status'],
      'history: newest first, no duplicates, the menu itself is not recorded',
    );
    t.check(
      validNodeSpec('22') &&
        validNodeSpec('lts/*') &&
        !validNodeSpec('abc') &&
        validPythonSpec('3.12') &&
        !validPythonSpec('2.7') &&
        closest('cluade', ['claude', 'codex']) === 'claude' &&
        closest('zzzzzz', ['claude']) === undefined,
      'validation: version syntax and did-you-mean for agent names',
    );
    t.check(
      colorEnabled({}, true) &&
        !colorEnabled({}, false) &&
        !colorEnabled({ NO_COLOR: '1' }, true) &&
        colorEnabled({ FORCE_COLOR: '1' }, false) &&
        !colorEnabled({ FORCE_COLOR: '0' }, true),
      'colours: on for a terminal, off for a pipe or NO_COLOR, FORCE_COLOR overrides',
    );
    t.equal(
      [shorten('abcdefghij', 6), ago(0, 10 * 60 * 1000), ago(0, 5000)],
      ['abcde…', '10 min ago', 'just now'],
      'text helpers: shorten and relative time',
    );

    t.section('settings screen');
    const original = '{\n  // my notes stay\n  "sandbox": { "headless": true }\n}\n';
    const set = editConfigText(original, ['attach', 'auto'], true);
    const nested = 'text' in set ? editConfigText(set.text, ['databases', 'postgres', 'port'], 6543) : set;
    const reset = 'text' in nested ? editConfigText(nested.text, ['sandbox', 'headless'], undefined) : nested;
    const resetText = 'text' in reset ? reset.text : '';
    t.check(
      resetText.includes('// my notes stay') &&
        resetText.includes('"auto": true') &&
        resetText.includes('"port": 6543') &&
        !resetText.includes('headless'),
      "settings screen: changes keep the file's comments, add new and nested keys, and reset removes a key",
      resetText,
    );
    const invalid = editConfigText(original, ['sandbox', 'memoryMb'], 12);
    const projectBad = editConfigText('{}', ['storage', 'root'], 'C:\\x', 'project');
    t.check(
      'problems' in invalid && invalid.problems.join().includes('memoryMb') && 'problems' in projectBad,
      'settings screen: invalid values are not saved; a project file cannot set storage',
      JSON.stringify(invalid),
    );

    // Every setting must be reachable in the settings screen, in a category, with an editor that fits it.
    const userSchema = new SchemaNode(ConfigSchema);
    const projectSchema = new SchemaNode(LocalOverridesSchema);
    const userLeaves = userSchema.leaves();
    const uncategorised = [...userSchema.children(), ...projectSchema.children()]
      .map(([name]) => name)
      .filter((name) => !CATEGORIES.some((c) => c.keys.includes(name)) && !SETTINGS_ELSEWHERE.includes(name));
    t.equal(
      uncategorised,
      [],
      'settings screen: every top-level setting belongs to a category (or to the Apps section)',
    );
    t.equal(
      userLeaves.filter((l) => l.node.editor === 'json').map((l) => l.key.join('.')),
      [],
      'settings screen: no setting falls back to typing JSON',
    );
    const harness = userSchema.child('harnesses')!.element!;
    t.check(
      String(harness.check(harness.initial())).includes('npmPackage') &&
        harness.check({ ...(harness.initial() as object), npmPackage: 'my-cli', npmBin: 'my-cli' }) === true,
      'settings screen: a new agent says what it still needs, and is valid once it has it',
    );

    t.section('screens');
    const fit = Text.fit('\x1b[31mred text\x1b[0m', 5);
    t.equal(
      [Text.width(fit), Text.strip(fit), Text.width('日本')],
      [5, 'red …', 4],
      'a coloured label is cut to the width without breaking its colour; wide characters take two columns',
    );
    const key = (name: string, text = ''): Key => ({ name, text, ctrl: false, meta: false, shift: false });
    const screen = new ListScreen<string>({
      path: ['T'],
      items: [
        { value: 'a', label: 'Alpha', category: 'x' },
        { value: 'b', label: 'Beta', category: 'y', description: 'second' },
      ],
      categories: [
        { id: 'x', label: 'X' },
        { id: 'y', label: 'Y' },
      ],
    });
    screen.handle(key('left'));
    screen.handle(key('down'));
    screen.handle(key('right'));
    t.equal(
      screen.handle(key('return')),
      { done: { kind: 'pick', value: 'b' } },
      'list screen: arrows switch category, Enter picks',
    );
    t.equal(
      Frame.render(screen.render({ width: 60, height: Frame.bodyHeight(20) }), 60, 20).length,
      20,
      'a frame fills the terminal height exactly',
    );
    const multi = new ListScreen<string>({
      path: ['T'],
      multi: true,
      items: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B', checked: true },
      ],
    });
    multi.handle(key('space'));
    t.equal(
      multi.handle(key('return')),
      { done: { kind: 'multi', values: ['a', 'b'] } },
      'list screen: space ticks several',
    );
    const typed = new TextScreen({ path: ['T'], label: 'Port', validate: (v) => (Number(v) > 0 ? true : 'a number') });
    typed.handle(key('x', 'x'));
    const refused = typed.handle(key('return'));
    typed.handle(key('backspace'));
    typed.handle(key('8', '8'));
    t.equal(
      [refused, typed.handle(key('return'))],
      [undefined, { done: '8' }],
      'text field: an invalid value is not accepted, a valid one is',
    );

    t.section('command line: grouped help, did you mean, choices, --agent, required questions');
    const rootHelp = buildProgram(() => undefined).helpInformation();
    const headings = ['Agents:', 'Sessions:', 'Projects & accounts:', 'Data:', 'Web:', 'Health:', 'Advanced:'];
    const at = headings.map((h) => rootHelp.indexOf('\n' + h + '\n'));
    t.check(
      at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1])),
      'root help: the command groups come in the order Agents, Sessions, Projects & accounts, Data, Web, Health, Advanced',
    );
    t.check(
      !/^\s+(self-test|host-claude)\b/m.test(rootHelp) &&
        !buildProgram(() => undefined)
          .commands.find((c) => c.name() === 'status')!
          .helpInformation()
          .includes('--config'),
      'self-test and host-claude are hidden, and --config is not in a command help',
    );
    t.check(
      friendlyError("error: unknown command 'statu'\n(Did you mean status?)\n").includes(
        'Did you mean: sandbox status?',
      ) && closest('cluade', ['claude', 'codex', 'status']) === 'claude',
      'an unknown command says "Did you mean: sandbox status?"; a mistyped agent finds the closest',
    );
    await t.throws(
      () => parseCli(['data', 'bogus']),
      'Allowed choices are show, clean',
      'a typo in an action lists the valid ones',
    );
    t.check(
      parseCli(['data', 'info']).positionals[0] === 'info',
      'an old spelling that is not listed is still accepted',
    );
    t.equal(
      [
        parseCli(['launch', '--agent', 'codex']).harness,
        parseCli(['launch', '--harness', 'codex']).harness,
        parseCli(['restart', '--agent', 'claude']).harness,
        parseCli(['account', 'list', '--agent', 'codex']).accountAgent,
        parseCli(['--agent', 'reviewer', '-p', 'hi'], true).passthrough,
      ],
      ['codex', 'codex', 'claude', 'codex', ['--agent', 'reviewer', '-p', 'hi']],
      '--agent names the agent (--harness still works); sandbox claude leaves --agent to Claude',
    );
    if (!process.stdin.isTTY)
      await t.throws(
        () => askRequired('Delete it?'),
        'Add --yes to answer yes.',
        'a required question with no terminal fails and names --yes',
      );
  },
};
