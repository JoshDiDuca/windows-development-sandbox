// The menu's pure parts: the navigation on the left and the key bar at every width, the shell's keys, the dialog
// box, the Draft of unsaved changes, and the sections' lists. With MENU_SCREENS_OUT set it also writes every screen as
// text there, for review.
import fs from 'node:fs';
import { CATEGORIES, ConfigFile, SETTINGS_ELSEWHERE } from '../app/features/settings/index.js';
import { Draft } from '../cli/menu/settings/draft.js';
import { z } from 'zod';
import { addedAgents, agentNameProblem, commandFromPackage, newAgent } from '../app/features/agents/index.js';
import { APP_GROUPS, appRows, REQUEST_APP, requestAppUrl } from '../app/features/apps/index.js';
import { appsCategories, appsItems } from '../cli/menu/pages/apps-page.js';
import { readMenuView, saveMenuView } from '../cli/menu/memory.js';
import path from 'node:path';
import { argPathKind, optionLabel, optionPathKind, plainDescription } from '../cli/menu/command-fields.js';
import { CommandForm } from '../cli/menu/command-form.js';
import { COMMANDS, commandSpec } from '../cli/manifest.js';
import { accountsOptions } from '../cli/menu/pages/accounts-page.js';
import {
  agentCategories,
  agentsHaveStagedChanges,
  agentsOptions,
  hostAgentsToShow,
  startArgv,
  type AgentsModel,
} from '../cli/menu/pages/agents-page.js';
import { ListPage, type Outcome } from '../cli/menu/pages/list-page.js';
import { sandboxOptions } from '../cli/menu/pages/sandbox-page.js';
import { sessionsOptions } from '../cli/menu/pages/sessions-page.js';
import { fakeIO, pathKindOf, SchemaNode, type OperationIO } from '../app/kernel/index.js';
import type { AppContext } from '../app/context.js';
import { runDefinition } from '../app/registry.js';
import { numberProblem, ValueEditor } from '../cli/menu/settings/value-editor.js';
import { APP_CATEGORIES } from '../shared/apps/index.js';
import { settingsOf, settingsOptions } from '../cli/menu/pages/settings-page.js';
import { SECTION_LABELS, Shell, type Page, type ShellExit } from '../cli/menu/shell.js';
import { DEFAULTS } from '../core/config/index.js';
import { HarnessSchema } from '../core/schema/index.js';
import { profileLinkPairs } from '../shared/paths/index.js';
import { AccountsService, parseDatabaseList } from '../cli/services/index.js';
import {
  App,
  dialogBox,
  Frame,
  KeyBar,
  ListScreen,
  overlayBox,
  SideNav,
  Text,
  type Category,
  type FrameParts,
  type Key,
  type KeyHint,
  type ListItem,
  type ListOptions,
  type ListResult,
  type NavState,
  type PathPickerOptions,
  type Step,
  type TextOptions,
} from '../cli/tui/index.js';
import { renderScreens, SIZES } from './menu-screens.js';
import type { Suite } from './support/suite.js';

const WIDTHS = [120, 80, 40];

export const menuSuite: Suite = {
  name: 'menu',
  title: 'menu tabs, key bar, dialogs and unsaved changes',
  run: async (t) => {
    t.section('key bar');
    const hints: KeyHint[] = [
      ['ctrl+s', 'save (2)', 0],
      ['↵', 'edit', 1],
      ['r', 'reset', 2],
      ['tab', 'scope', 3],
      ['↑↓', 'move', 5],
      ['/', 'search', 6],
      ['esc', 'quit', 0],
    ];
    const bar = (width: number): string => Text.strip(KeyBar.render(hints, width));
    t.check(
      WIDTHS.every((w) => Text.width(bar(w)) <= w && bar(w).includes('quit') && bar(w).includes('save (2)')) &&
        !bar(60).includes('search') &&
        bar(60).includes('edit') &&
        bar(200).includes('search'),
      'the key bar fits, keeps save and the way out, and drops the least important keys first',
    );

    t.section('navigation on the left');
    const navState = (active: number, focused: boolean, dimmed = false): NavState => ({
      sections: SECTION_LABELS.map((label, i) => ({
        label,
        marked: label === 'Settings',
        categories:
          i === active
            ? ['General', 'Languages & tools', 'Network'].map((l, c) => ({ label: l, current: c === 1 }))
            : [],
      })),
      active,
      focused,
      dimmed,
    });
    const navOdd: string[] = [];
    for (const width of [40, 79, 80, 120, 200])
      for (const height of [8, 18, 54])
        for (const focused of [true, false]) {
          const lines = SideNav.render(navState(4, focused), width, height);
          if (lines.length !== height || lines.some((l) => Text.width(l) !== SideNav.width(width)))
            navOdd.push(width + 'x' + height);
          if (!lines.some((l) => Text.strip(l).includes(width < 80 ? '●' : 'Languages')))
            navOdd.push('hidden ' + width + 'x' + height);
        }
    t.equal(navOdd, [], 'the navigation has the width and height asked for, and always shows the open category');
    const wide = SideNav.render(navState(4, true), 100, 20).map((l) => Text.strip(l).trimEnd());
    const slim = SideNav.render(navState(4, true), 60, 20).map((l) => Text.strip(l).trimEnd());
    t.check(
      wide[0].includes('1 Agents') &&
        wide[4].startsWith('▾5 Settings') &&
        wide[4].endsWith('✎') &&
        wide[5].includes('├ General') &&
        wide[6].includes('› Languages & tools') &&
        wide[7].includes('└ Network') &&
        wide[8].includes('6 Accounts'),
      'wide: the sections are numbered, the open one is a tree, the open category has a marker, unsaved sections a mark',
      wide.slice(0, 9).join('|'),
    );
    t.check(
      !slim.join('').includes('Agents') && slim[0].includes('1') && slim[4].startsWith('▾5') && slim[6].includes('●'),
      'narrow (under 80 columns): numbers only; the open section keeps dots for its categories',
      slim.slice(0, 9).join('|'),
    );
    const bodyOdd: string[] = [];
    for (const size of [
      { width: 80, height: 24 },
      { width: 200, height: 60 },
    ]) {
      const nav = navState(4, true);
      const row = 'x'.repeat(Frame.bodyWidth(size.width, nav) - 1);
      const body = Array.from({ length: Frame.bodyHeight(size.height) }, () => row);
      const rows = Frame.render({ path: ['Settings'], body, keys: [['esc', 'quit', 0]], nav }, size.width, size.height);
      if (rows.length !== size.height || rows.some((r) => Text.width(r) > size.width - 1))
        bodyOdd.push(size.width + 'x' + size.height);
    }
    t.equal(bodyOdd, [], 'the frame fits the navigation, its divider and the body in the terminal');

    t.section('navigation keys (Shell)');
    const press = (name: string, text = ''): Key => ({ name, text, ctrl: false, meta: false, shift: false });
    class FakePage implements Page {
      readonly stages = false;
      capturing = false;
      category: string | undefined;
      search = '';
      focusList = true;
      constructor(
        readonly label: string,
        private readonly ids: string[],
      ) {
        this.category = ids[0];
      }
      categories(): Category[] {
        return this.ids.map((id) => ({ id, label: id }));
      }
      selectCategory(id: string): Promise<void> {
        this.category = id;
        return Promise.resolve();
      }
      restoreSearch(text: string): void {
        this.search = text;
      }
      setFocus(list: boolean): void {
        this.focusList = list;
      }
      open(): Promise<void> {
        return Promise.resolve();
      }
      render(): FrameParts {
        return { path: [], body: [], keys: [['↵', 'open']] };
      }
      handle(k: Key): Step<ShellExit> {
        return k.name === 'escape' || k.name === 'left' ? { done: { kind: 'quit' } } : undefined;
      }
    }
    const pages = [new FakePage('One', ['a', 'b']), new FakePage('Two', []), new FakePage('Three', ['c', 'd'])];
    const shell = new Shell(new App(), pages, new Draft());
    await shell.handle(press('escape'));
    const toNav = shell.focused;
    await shell.handle(press('down'));
    const inOne = pages[0].category;
    await shell.handle(press('down'));
    const onTwo = [shell.page.label, shell.nav().sections[1].categories.length];
    await shell.handle(press('down'));
    const onThree = [shell.page.label, pages[2].category];
    await shell.handle(press('up'));
    await shell.handle(press('up'));
    const backInOne = [shell.page.label, pages[0].category];
    await shell.handle(press('right'));
    const toList = [shell.focused, pages[0].focusList];
    await shell.handle(press('left'));
    await shell.handle(press('3', '3'));
    pages[2].capturing = true;
    await shell.handle(press('1', '1'));
    t.equal(
      [toNav, inOne, onTwo, onThree, backInOne, toList, shell.page.label, shell.focused],
      ['nav', 'b', ['Two', 0], ['Three', 'c'], ['One', 'b'], ['list', true], 'Three', 'nav'],
      'Esc/Left in the list go to the navigation; Up/Down walk categories then sections; Right returns; digits jump',
    );
    const keys = shell.render({ width: 100, height: 20 }).keys.map((k) => k[0] + ' ' + k[1]);
    t.check(
      keys.includes('→ open') && keys.includes('1-7 jump'),
      'the key bar shows the navigation keys while it has the keyboard',
      keys.join(', '),
    );
    const leave = await shell.handle(press('escape'));
    t.check(leave !== undefined && leave.done.kind === 'quit', 'Esc in the navigation quits');
    await shell.restore({ section: 2, screens: { Three: { category: 'd', search: 'abc' }, One: { category: 'b' } } });
    t.equal(
      [shell.page.label, pages[2].category, pages[2].search, shell.view()],
      [
        'Three',
        'd',
        'abc',
        { section: 2, screens: { Three: { category: 'd', search: 'abc' }, One: { category: 'b' } } },
      ],
      'the menu can be put back on the section, category and search it was left on (other sections keep theirs)',
    );
    await shell.openTab(0);
    t.equal([pages[0].category, pages[0].search], ['b', ''], 'a section opened later goes back to its own category');

    t.section('menu memory file');
    const labels = ['Agents', 'Sessions', 'Sandbox'];
    const memDir = t.dir('menu-memory');
    const view = { section: 2, screens: { Sessions: { category: 'x', search: 'foo' }, Gone: { category: 'y' } } };
    saveMenuView(view, labels, memDir);
    t.equal(
      readMenuView(labels, memDir),
      { section: 2, screens: { Sessions: { category: 'x', search: 'foo' } } },
      'the last section, category and search are saved and read back (a section that is gone is dropped)',
    );
    t.equal(
      readMenuView(['Agents', 'Sessions'], memDir)?.section,
      0,
      'a remembered section that no longer exists falls back to the first (Agents)',
    );
    fs.writeFileSync(path.join(memDir, 'menu-state.json'), '{"section": 5, "screens": "no"}');
    t.equal(readMenuView(labels, memDir), undefined, 'an invalid state file is ignored');
    fs.writeFileSync(path.join(memDir, 'menu-state.json'), 'not json');
    t.equal(readMenuView(labels, memDir), undefined, 'a file that is not JSON is ignored');

    t.section('request an app');
    const issue = new URL(requestAppUrl());
    t.check(
      issue.origin === 'https://github.com' &&
        issue.pathname.endsWith('/issues/new') &&
        (issue.searchParams.get('title') ?? '').startsWith('App request') &&
        (issue.searchParams.get('body') ?? '').includes('App name'),
      'the request-an-app address is a GitHub new-issue page with a title and a body template',
      requestAppUrl(),
    );

    t.section('list categories driven from outside');
    const catItems = (id: string, n: number): ListItem<string>[] =>
      Array.from({ length: n }, (_, i) => ({ value: id + i, label: id + ' item ' + i, category: id }));
    const catList: ListOptions<string> = {
      path: [],
      categories: [
        { id: 'x', label: 'Ex' },
        { id: 'y', label: 'Why' },
      ],
      items: [...catItems('x', 2), ...catItems('y', 3)],
    };
    const external = new ListScreen({ ...catList, categoryNav: 'external' });
    const own = new ListScreen(catList);
    const drawn = (l: ListScreen<string>): string => Text.strip(l.render({ width: 100, height: 20 }).body.join('\n'));
    external.setCategory('y');
    const left = external.handle(press('left'));
    t.check(
      external.currentCategory === 'y' &&
        drawn(external).includes('y item 2') &&
        !drawn(external).includes('x item 0') &&
        !drawn(external).includes('Why') &&
        drawn(own).includes('Why') &&
        left !== undefined &&
        left.done.kind === 'back',
      'with external navigation the list shows no sidebar, switches category on request and hands Left back',
    );

    t.section('settings categories');
    const settingsFile = ConfigFile.user(t.at('settings', 'config.json'));
    const projectFile = ConfigFile.project(t.dir('settings', 'project'));
    const listed = CATEGORIES.flatMap((c) => c.keys);
    const topLevel = [...settingsFile.schema.children(), ...projectFile.schema.children()].map(([name]) => name);
    t.check(
      CATEGORIES.length <= 8 &&
        topLevel.every((name) => listed.includes(name) || SETTINGS_ELSEWHERE.includes(name)) &&
        listed.length === new Set(listed).size,
      'settings are in at most 8 categories; each top-level setting is in exactly one, or covered by the Apps section',
    );
    const placed = settingsOf(settingsFile);
    t.check(
      CATEGORIES.every((c) => placed.some((s) => s.category === c.id)) &&
        settingsFile.schema
          .leaves()
          .every((l) => SETTINGS_ELSEWHERE.includes(l.key[0]) || placed.some((s) => s.key[0] === l.key[0])),
      'every category has settings, and every setting that is not an app choice appears in a list',
    );
    const row = { value: '@data-folder', label: 'Data folder', category: 'general' };
    const files = { user: settingsFile, project: projectFile };
    t.check(
      settingsOptions(files, 'user', new Draft(), [row]).items.some((i) => i.value === row.value) &&
        !settingsOptions(files, 'project', new Draft(), [row]).items.some((i) => i.value === row.value),
      "the Data folder row is in your own settings, not in a project's",
    );

    t.section('agents');
    const agentsModel: AgentsModel = {
      folder: 'C:\\code\\api',
      defaultAgent: 'codex',
      agents: [
        { name: 'claude', ready: true },
        { name: 'codex', ready: false },
      ],
      last: ['launch'],
      attach: false,
      window: 'config',
      hostAgents: [],
    };
    const agentList = agentsOptions(agentsModel, 'C:\\code\\api');
    t.equal(
      [
        agentList.items.filter((i) => i.category === 'start').map((i) => i.value),
        agentList.categories?.map((c) => c.id),
      ],
      [
        ['repeat', 'agent:codex', 'agent:claude', 'add'],
        ['start', 'options'],
      ],
      'Agents: Repeat last, the default agent first, the others, then Add an agent; no "On this PC" while it is empty',
    );
    t.check(
      agentList.items
        .filter((i) => i.category === 'options')
        .map((i) => i.value)
        .join() === 'opt:attach,opt:window,opt:folder,more,several,noagent' &&
        agentsOptions({ ...agentsModel, hostAgents: ['claude'] }).items.some((i) => i.value === 'host:claude') &&
        agentCategories({ ...agentsModel, hostAgents: ['claude'] }).some((c) => c.id === 'host'),
      'Agents > Options holds the start options and the other ways to start; "On this PC" appears with entries',
    );
    t.equal(
      [
        agentNameProblem('my-agent', ['claude']),
        agentNameProblem('Claude', ['claude']),
        agentNameProblem('bad name', []),
        agentNameProblem(' ', []),
        commandFromPackage('@scope/my-cli@latest'),
        commandFromPackage('aider-chat'),
      ],
      [
        true,
        'Claude is an agent already.',
        'Use letters, numbers, - and _ only.',
        'Type a name.',
        'my-cli',
        'aider-chat',
      ],
      'a new agent name is checked (letters, no duplicates); the command is guessed from the package',
    );
    const agentFile = ConfigFile.user(t.at('agents', 'config.json'));
    t.write(agentFile.file, '{\n  // mine\n  "defaultHarness": "claude"\n}\n');
    const agentCtx = { loaded: { configPath: agentFile.file } } as unknown as AppContext;
    const added = (await runDefinition(
      'agents.add',
      agentCtx,
      {},
      fakeIO(['npm', 'my-agent', '@me/my-agent@latest', 'my-agent']).io,
    )) as { name: string; message: string };
    const saved = agentFile.userConfig().harnesses['my-agent'];
    t.check(
      added.name === 'my-agent' &&
        added.message === 'Added my-agent.' &&
        saved?.npmPackage === '@me/my-agent@latest' &&
        saved.npmBin === 'my-agent' &&
        agentFile.text().includes('// mine') &&
        Boolean(agentFile.userConfig().harnesses.claude),
      'Add an agent writes it to your config file (comments and the built-in agents stay)',
      agentFile.text(),
    );
    const stagedAgents = new Draft();
    stagedAgents.stage(agentFile, ['harnesses'], {
      ...(agentFile.valueInFile(['harnesses']) as object),
      other: newAgent('uv', 'tool', 'tool'),
    });
    t.check(
      agentsHaveStagedChanges(agentFile, stagedAgents) && !agentsHaveStagedChanges(agentFile, new Draft()),
      'with unsaved changes to the agents, the menu asks to save them first (the agent operations wait)',
    );

    t.section('list keys follow the highlighted entry');
    const keyList = new ListScreen<string>({
      path: [],
      items: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      actions: [{ key: 'x', label: 'remove', applies: (v) => v === 'b' }],
      enterLabel: (_c, v) => (v === 'a' ? '' : 'go'),
    });
    const barOf = (l: ListScreen<string>): string[] => l.render({ width: 100, height: 20 }).keys.map((k) => k[1]);
    const onA = barOf(keyList);
    const pressedOnA = keyList.handle(press('x', 'x'));
    keyList.handle(press('down'));
    const onB = barOf(keyList);
    const pressedOnB = keyList.handle(press('x', 'x'));
    t.check(
      !onA.includes('remove') &&
        !onA.includes('go') &&
        pressedOnA === undefined &&
        onB.includes('remove') &&
        onB.includes('go') &&
        pressedOnB !== undefined &&
        pressedOnB.done.kind === 'action',
      'a key (and Enter) shows in the key bar, and works, only while an entry it applies to is highlighted',
    );
    const long = new ListScreen<string>({
      path: [],
      items: Array.from({ length: 40 }, (_, i) => ({ value: 'v' + i, label: 'item ' + i })),
    });
    const longBody = Text.strip(long.render({ width: 100, height: 14 }).body.join('\n'));
    t.check(longBody.includes('more') && longBody.includes('/ search'), 'a long list says how to search');
    class OpenOn extends ListPage<string> {
      readonly label = 'Open';
      protected load(): Promise<void> {
        return Promise.resolve();
      }
      protected options(): ListOptions<string> {
        return {
          path: [],
          items: [
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
          ],
        };
      }
      protected act(): Promise<Outcome<string>> {
        return Promise.resolve({});
      }
      protected override initialFocus(): string {
        return 'b';
      }
    }
    const openOn = new OpenOn(new App());
    await openOn.open();
    const marked = openOn
      .render({ width: 100, height: 12 })
      .body.map((l) => Text.strip(l))
      .find((l) => l.includes('›'));
    t.check(marked?.includes('Beta') === true, 'a section opens with the cursor on the entry it asks for');
    class Broken extends ListPage<string> {
      readonly label = 'Broken';
      protected load(): Promise<void> {
        return Promise.resolve();
      }
      protected options(): ListOptions<string> {
        return { path: [], items: [{ value: 'a', label: 'Alpha' }] };
      }
      protected act(): Promise<Outcome<string>> {
        return Promise.reject(new Error('the action broke'));
      }
    }
    const broken = new Broken(new App());
    await broken.open();
    let survived = true;
    try {
      await broken.handle(press('return'));
    } catch {
      survived = false;
    }
    const brokenFrame = broken.render({ width: 100, height: 12 });
    const brokenScreen = Text.strip([...brokenFrame.body, brokenFrame.notice ?? ''].join('\n'));
    t.check(
      survived && brokenScreen.includes('the action broke'),
      'an action that fails shows its problem in the menu instead of closing it',
      brokenScreen,
    );

    t.section('proper inputs');
    const user2 = ConfigFile.user(t.at('inputs', 'config.json'));
    const leaf = (...key: string[]): SchemaNode => {
      let node: SchemaNode | undefined = user2.schema;
      for (const k of key) node = node?.child(k);
      if (!node) throw new Error('no setting ' + key.join('.'));
      return node;
    };
    const port = new SchemaNode(z.number().int().min(1024).max(65535));
    t.equal(
      [
        port.rangeText(),
        numberProblem(port, '5000'),
        numberProblem(port, '80'),
        numberProblem(port, 'abc'),
        numberProblem(port, '1.5'),
        new SchemaNode(z.number().int().positive()).rangeText(),
        new SchemaNode(z.number().int().min(2048)).rangeText(),
      ],
      [
        '1024 to 65535',
        true,
        'Use 1024 to 65535.',
        'Enter a number.',
        'Enter a whole number.',
        'more than 0',
        'at least 2048',
      ],
      'a number is checked against the schema limits, with the range in the message',
    );
    interface Script {
      text?: (string | undefined)[];
      path?: (string | undefined)[];
      choose?: unknown[];
      list?: ListResult<string>[];
    }
    const fake = (
      script: Script,
    ): {
      app: App;
      text: TextOptions[];
      path: PathPickerOptions[];
      choose: { current: unknown; values: unknown[] }[];
      list: ListOptions<string>[];
    } => {
      const seen = {
        text: [] as TextOptions[],
        path: [] as PathPickerOptions[],
        choose: [] as { current: unknown; values: unknown[] }[],
        list: [] as ListOptions<string>[],
      };
      const app = {
        text: (o: TextOptions) => {
          seen.text.push(o);
          return Promise.resolve(script.text?.shift());
        },
        pickPath: (o: PathPickerOptions) => {
          seen.path.push(o);
          return Promise.resolve(script.path?.shift());
        },
        choose: (_p: string[], _i: string, choices: { value: unknown }[], current: unknown) => {
          seen.choose.push({ current, values: choices.map((c) => c.value) });
          return Promise.resolve(script.choose?.shift());
        },
        list: (o: ListOptions<string>) => {
          seen.list.push(o);
          return Promise.resolve(script.list?.shift() ?? { kind: 'back' as const });
        },
      } as unknown as App;
      return { app, ...seen };
    };
    const flipped = await new ValueEditor(fake({}).app).edit(
      ['S'],
      ['sandbox', 'headless'],
      leaf('sandbox', 'headless'),
      false,
    );
    const choiceNode = user2.schema.leaves().find((l) => l.node.editor === 'choice');
    const choiceFake = fake({ choose: [choiceNode?.node.choiceValues[0]] });
    const chosenValue = choiceNode
      ? await new ValueEditor(choiceFake.app).edit(
          ['S'],
          choiceNode.key,
          choiceNode.node,
          choiceNode.node.choiceValues[1],
        )
      : undefined;
    t.check(
      flipped?.value === true &&
        choiceNode !== undefined &&
        chosenValue?.value === choiceNode.node.choiceValues[0] &&
        choiceFake.choose[0].current === choiceNode.node.choiceValues[1] &&
        choiceFake.choose[0].values.length === choiceNode.node.choiceValues.length,
      'an on/off setting flips; a choice setting offers its values with the current one marked',
    );
    const days = leaf('audit', 'days');
    const numberFake = fake({ text: ['30'] });
    const typedDays = await new ValueEditor(numberFake.app).edit(['S'], ['audit', 'days'], days, 7);
    const numberOptions = numberFake.text[0];
    t.check(
      typedDays?.value === 30 &&
        numberOptions.accept?.test('7') === true &&
        numberOptions.accept?.test('a') === false &&
        numberOptions.hint?.includes('1 to 30') === true &&
        numberOptions.validate?.('40') === 'Use 1 to 30.' &&
        numberOptions.validate?.('30') === true &&
        numberOptions.initial === '7',
      'a number setting takes digits only, shows its range, and refuses a value outside it as you type',
    );
    t.equal(
      [
        pathKindOf(['storage', 'root']),
        pathKindOf(['projects', 'roots']),
        pathKindOf(['mappings', 'host']),
        pathKindOf(['claudeProfile', 'hostDir']),
        pathKindOf(['claudeProfile', 'globalStateFile']),
        pathKindOf(['sandbox', 'headless']),
        pathKindOf(['defaultHarness']),
      ],
      ['dir', 'dir', 'dir', 'dir', 'file', undefined, undefined],
      'folder and file settings are told apart from the rest',
    );
    const folderFake = fake({ path: ['C:\\Users\\me\\.claude'] });
    const folderValue = await new ValueEditor(folderFake.app).edit(
      ['S'],
      ['claudeProfile', 'hostDir'],
      leaf('claudeProfile', 'hostDir'),
      'auto',
    );
    const fileFake = fake({ path: ['C:\\Users\\me\\.claude.json'] });
    await new ValueEditor(fileFake.app).edit(
      ['S'],
      ['claudeProfile', 'globalStateFile'],
      leaf('claudeProfile', 'globalStateFile'),
      'auto',
    );
    t.check(
      folderValue?.value === 'C:\\Users\\me\\.claude' &&
        folderFake.path[0].files === false &&
        folderFake.path[0].literals?.includes('auto') === true &&
        folderFake.text.length === 0 &&
        fileFake.path[0].files === true,
      'a folder setting opens the path picker (a file setting a file picker); "auto" can still be typed',
    );
    const roots = leaf('projects', 'roots');
    const listFake = fake({
      path: ['C:\\Code', 'D:\\More'],
      list: [
        { kind: 'pick', value: '@add' },
        { kind: 'pick', value: '@add' },
        { kind: 'action', key: 'd', value: '0' },
        { kind: 'back' },
      ],
    });
    const rootsValue = await new ValueEditor(listFake.app).edit(['S'], ['projects', 'roots'], roots, []);
    const keysOf = (o: ListOptions<string>, id: string): string[] =>
      (typeof o.actions === 'function' ? o.actions(undefined) : (o.actions ?? []))
        .filter((a) => !a.applies || a.applies(id))
        .map((a) => a.key);
    t.check(
      JSON.stringify(rootsValue?.value) === '["D:\\\\More"]' &&
        listFake.path.length === 2 &&
        listFake.path.every((p) => p.files === false) &&
        keysOf(listFake.list[0], '@add').length === 0 &&
        keysOf(listFake.list[2], '0').join() === 'd,u,j',
      'a folder list adds with the path picker and removes entries; reorder keys only appear on an entry',
    );
    const plainList = user2.schema.leaves().find((l) => l.node.editor === 'string-list' && !pathKindOf(l.key));
    const moved = plainList
      ? await new ValueEditor(
          fake({
            list: [
              { kind: 'action', key: 'j', value: '0' },
              { kind: 'action', key: 'd', value: '2' },
              { kind: 'back' },
            ],
          }).app,
        ).edit(['S'], plainList.key, plainList.node, ['a', 'b', 'c'])
      : undefined;
    t.equal(moved?.value, ['b', 'a'], 'list items move down and are removed (a, b, c: a down, then c removed)');
    const envNode = user2.schema.leaves().find((l) => l.node.editor === 'string-map');
    const envValue = envNode
      ? await new ValueEditor(
          fake({ text: ['FOO', 'bar'], list: [{ kind: 'pick', value: '@add' }, { kind: 'back' }] }).app,
        ).edit(['S'], envNode.key, envNode.node, {})
      : undefined;
    t.equal(envValue?.value, { FOO: 'bar' }, 'a name-to-value setting is edited as names and values');

    const mappingFake = fake({
      path: ['C:\\data'],
      list: [{ kind: 'pick', value: '@add' }, { kind: 'pick', value: 'host' }, { kind: 'back' }, { kind: 'back' }],
    });
    const mapped = await new ValueEditor(mappingFake.app).edit(['S'], ['mappings'], leaf('mappings'), []);
    t.check(
      JSON.stringify(mapped?.value) === '[{"host":"C:\\\\data","readOnly":false}]' &&
        mappingFake.path.length === 1 &&
        mappingFake.path[0].files === false,
      'a field of a form inside a list (a mapped folder) is picked in the path picker too',
      JSON.stringify(mapped),
    );

    t.section('command forms');
    const formCtx = {
      storageRoot: t.dir('forms', 'storage'),
      dataPath: t.dir('forms', 'data'),
      loaded: { config: structuredClone(DEFAULTS), configPath: null, base: t.temp },
    } as unknown as ConstructorParameters<typeof CommandForm>[1];
    const account = commandSpec('account')!;
    const renameFake = fake({ list: [{ kind: 'pick', value: 'arg:action' }, { kind: 'back' }], choose: ['rename'] });
    await new CommandForm(renameFake.app, formCtx, account).run();
    const renameItems = renameFake.list[1].items;
    t.check(
      renameItems.some((i) => i.label === 'New name' && i.description === 'The new name') &&
        !renameItems.some((i) => i.label === 'From host') &&
        renameItems.every((i) => !i.label.startsWith('-') && !(i.description ?? '').startsWith('(')),
      'a form filtered by action drops the "(rename)" prefix and the other actions\' options; no flag is a label',
    );
    t.check(
      COMMANDS.every((c) => c.options.every((o) => !optionLabel(o).startsWith('-') && optionLabel(o).length > 2)) &&
        plainDescription('(rename) the new name', ['rename', 'save']) === 'The new name' &&
        plainDescription('(claude) use your profile', ['rename']) === 'For claude: use your profile' &&
        plainDescription('stop here', []) === 'Stop here',
      'every option has a plain label, and action prefixes read as plain descriptions',
    );
    const launch = commandSpec('launch')!;
    const workspaceFake = fake({
      list: [{ kind: 'pick', value: 'opt:--workspace' }, { kind: 'back' }],
      path: ['C:\\work'],
    });
    await new CommandForm(workspaceFake.app, formCtx, launch).run();
    t.check(
      workspaceFake.path.length === 1 &&
        workspaceFake.path[0].files === false &&
        workspaceFake.text.length === 0 &&
        (workspaceFake.list[1].items.find((i) => i.value === 'opt:--workspace')?.hint ?? '').includes('C:\\work'),
      'a folder option (--workspace) is picked in the path picker',
    );
    const timeoutFake = fake({ list: [{ kind: 'pick', value: 'opt:--timeout' }, { kind: 'back' }], text: ['30'] });
    await new CommandForm(timeoutFake.app, formCtx, commandSpec('exec')!).run();
    const timeoutText = timeoutFake.text[0];
    t.check(
      timeoutText.accept?.test('x') === false &&
        timeoutText.accept?.test('3') === true &&
        timeoutText.hint?.includes('Default: 600') === true &&
        typeof timeoutText.validate?.('0') === 'string',
      'a number option takes digits only and shows its default',
    );
    const storageFake = fake({
      list: [{ kind: 'pick', value: 'arg:action' }, { kind: 'pick', value: 'arg:folder' }, { kind: 'back' }],
      choose: ['move'],
      path: ['D:\\Data'],
    });
    await new CommandForm(storageFake.app, formCtx, commandSpec('storage')!).run();
    t.check(
      storageFake.path.length === 1 &&
        (storageFake.list[2].items.find((i) => i.value === 'arg:folder')?.hint ?? '').includes('D:\\Data'),
      'storage move takes its folder from the path picker',
    );
    const projectsFake = fake({
      list: [{ kind: 'pick', value: 'arg:action' }, { kind: 'pick', value: 'arg:value' }, { kind: 'back' }],
      choose: ['all', 'on'],
    });
    await new CommandForm(projectsFake.app, formCtx, commandSpec('projects')!).run();
    t.check(
      JSON.stringify(projectsFake.choose[1].values.slice(0, 2)) === '["on","off"]' &&
        argPathKind({ name: 'folder', description: '', required: false }, 'storage', 'move') === 'dir' &&
        optionPathKind({ flag: '--workspace', type: 'string', value: 'dir', description: '' }) === 'dir' &&
        optionPathKind({ flag: '--script', type: 'list', value: 'file', description: '' }) === 'file' &&
        optionPathKind({ flag: '--harness', type: 'string', value: 'name', description: '' }) === undefined,
      'choices and paths are told apart: on/off for projects all, folders and files for the rest',
    );

    t.section('agents: make default and remove');
    const actionModel: AgentsModel = {
      folder: 'C:\\code\\api',
      defaultAgent: 'claude',
      agents: [
        { name: 'claude', ready: true },
        { name: 'codex', ready: false },
        { name: 'mine', ready: false },
      ],
      last: undefined,
      attach: false,
      window: 'config',
      hostAgents: [],
      removable: addedAgents(['claude', 'codex', 'mine']),
    };
    const actionList = agentsOptions(actionModel, 'C:\\code\\api');
    const keyFor = (key: string, id: string): boolean =>
      (typeof actionList.actions === 'function' ? actionList.actions('start') : [])
        .find((a) => a.key === key)
        ?.applies?.(id) ?? false;
    t.check(
      JSON.stringify(actionModel.removable) === '["mine"]' &&
        keyFor('d', 'agent:codex') &&
        !keyFor('d', 'agent:claude') &&
        !keyFor('d', 'add') &&
        keyFor('x', 'agent:mine') &&
        !keyFor('x', 'agent:codex') &&
        typeof actionList.actions === 'function' &&
        actionList.actions('start').length === 2 &&
        actionList.actions('options').length === 0,
      'Make default shows on any other agent, Remove only on one you added; neither on built-in agents or other rows',
    );
    const agentsFile = ConfigFile.user(t.at('agents-actions', 'config.json'));
    t.write(agentsFile.file, '{\n  // mine\n  "defaultHarness": "claude"\n}\n');
    const agentsCtx = { loaded: { configPath: agentsFile.file } } as unknown as AppContext;
    const quiet = (answers: Parameters<typeof fakeIO>[0] = []): OperationIO => fakeIO(answers).io;
    await runDefinition('agents.add', agentsCtx, {}, quiet(['npm', 'mine', '@me/mine@latest', 'mine']));
    await runDefinition('agents.makeDefault', agentsCtx, { name: 'mine' }, quiet());
    const becameDefault = agentsFile.userConfig().defaultHarness;
    await t.throws(
      () => runDefinition('agents.remove', agentsCtx, { name: 'mine' }, quiet([true])),
      'default agent',
      'the default agent is not removed',
    );
    await runDefinition('agents.makeDefault', agentsCtx, { name: 'codex' }, quiet());
    await runDefinition('agents.remove', agentsCtx, { name: 'mine' }, quiet([true]));
    await t.throws(
      () => runDefinition('agents.remove', agentsCtx, { name: 'claude' }, quiet([true])),
      'built in',
      'a built-in agent is not removed',
    );
    t.check(
      becameDefault === 'mine' &&
        agentsFile.userConfig().defaultHarness === 'codex' &&
        !agentsFile.text().includes('mine"') &&
        agentsFile.text().includes('// mine') &&
        Boolean(agentsFile.userConfig().harnesses.claude),
      'Make default and Remove change your config file (comments stay; the built-in agents stay)',
      agentsFile.text(),
    );

    t.section('empty states offer the next step');
    const sessionsEmpty = sessionsOptions({ sandboxRunning: true, sessions: [], defaultAgent: 'codex' });
    const enter = sessionsEmpty.enterLabel;
    t.check(
      sessionsEmpty.items.length === 1 &&
        sessionsEmpty.items[0].label === 'Start codex' &&
        typeof enter === 'function' &&
        enter(undefined, sessionsEmpty.items[0].value) === 'start',
      'with no session, Sessions offers to start the default agent (Enter)',
    );
    const stoppedSandbox = {
      report: { sandbox: { running: false }, repoGuard: { guarded: 0, findings: [] }, projects: [], otherSessions: [] },
      projects: { all: false, roots: [], exclude: [], projects: [] },
      databases: null,
      defaultAgent: 'claude',
    } as unknown as Parameters<typeof sandboxOptions>[0];
    const stoppedItems = sandboxOptions(stoppedSandbox).items;
    t.check(
      stoppedItems.some((i) => i.value === 'act:start' && i.category === 'status') &&
        stoppedItems.some((i) => i.value === 'act:start' && i.category === 'databases') &&
        stoppedItems.some((i) => i.value === '@add-root') &&
        !stoppedItems.some((i) => i.value === 'act:stop'),
      'with no sandbox running, Sandbox offers to start one (Status and Databases) instead of dead rows',
    );
    const noLogins = accountsOptions({
      agent: 'claude',
      agents: [{ name: 'claude', kept: true, canSavePc: true, accounts: [] }],
    });
    t.equal(
      noLogins.items.map((i) => i.value),
      ['@save-sandbox', '@save-pc'],
      'with no saved login, Accounts offers to save the sandbox login or this PC login (Enter)',
    );

    t.section('apps in a few groups');
    const groupIds = appsCategories(user2).map((c) => c.id);
    const appItems = appsItems(user2, t.dir('apps-groups'), new Draft()).filter((i) => i.value !== REQUEST_APP);
    t.check(
      groupIds.length <= 7 &&
        appsCategories(ConfigFile.project(t.dir('apps-groups', 'project'))).length <= 6 &&
        APP_GROUPS.every((g) => appItems.some((i) => i.category === g.id)) &&
        appItems.every((i) => groupIds.includes(i.category ?? '')) &&
        appItems.length === appRows(user2, t.dir('apps-groups')).length &&
        APP_CATEGORIES.every((c) => APP_GROUPS.some((g) => (g.members as readonly string[]).includes(c.id))),
      'the apps are in at most 7 groups (with your own programs); every catalogue category belongs to one and every app is listed',
      groupIds.join(),
    );

    t.section('dialog box');
    const box = dialogBox({ title: 'Unsaved changes', lines: ['You have 2 unsaved changes.'], buttons: 'Save' }, 61);
    const base = Array.from({ length: 12 }, () => 'x'.repeat(60));
    const over = overlayBox(base, box, 61);
    t.check(
      new Set(box.map((l) => Text.width(l))).size === 1 &&
        over.length === base.length &&
        over.some((l) => Text.strip(l).includes('Unsaved changes')) &&
        over.every((l) => Text.width(l) <= 60),
      'the dialog box has equal rows and overlays the screen without changing its size',
    );

    t.section('unsaved changes (Draft)');
    const file = ConfigFile.user(t.at('draft', 'config.json'));
    t.write(file.file, '{\n  // keep this comment\n  "defaultHarness": "claude"\n}\n');
    const draft = new Draft();
    draft.stage(file, ['defaultHarness'], 'codex');
    draft.stage(file, ['agentCommands', 'enabled'], true);
    const staged = [draft.count(), draft.value(file, ['defaultHarness'])];
    draft.stage(file, ['defaultHarness'], 'claude');
    const restaged = draft.count();
    draft.unstage(file, ['agentCommands', 'enabled']);
    t.equal(
      [staged, restaged, draft.count()],
      [[2, 'codex'], 1, 0],
      'staged changes are counted; staging what the file already says, or undoing, drops the change',
    );
    draft.stage(file, ['defaultHarness'], 'codex');
    draft.stage(file, ['sandbox', 'headless'], false);
    const result = draft.apply();
    const text = fs.readFileSync(file.file, 'utf8');
    t.check(
      result.problems.length === 0 &&
        result.files.length === 1 &&
        draft.count() === 0 &&
        text.includes('// keep this comment') &&
        text.includes('"codex"'),
      'apply writes the file once, keeps its comments and leaves nothing unsaved',
      JSON.stringify(result.problems),
    );
    draft.stage(file, ['defaultHarness'], 42);
    t.check(draft.apply().problems.length > 0 && draft.count() === 1, 'an invalid change is refused and stays staged');
    draft.discard();

    t.section('section pages');
    t.equal(
      startArgv(
        {
          folder: 'C:\\code\\api',
          defaultAgent: 'claude',
          agents: [],
          last: undefined,
          attach: true,
          window: 'hide',
          hostAgents: [],
        },
        'codex',
        'C:\\code\\other',
      ),
      ['launch', '--harness', 'codex', '--terminal', '--headless', '--workspace', 'C:\\code\\api'],
      'the Agents section builds the same command line the form would',
    );
    t.equal(
      [
        hostAgentsToShow(false, [{ harness: 'claude' }]),
        hostAgentsToShow(true, [{ harness: 'claude' }, { harness: 'codex' }]),
      ],
      [[], ['claude', 'codex']],
      'not-sandboxed entries show only while agent commands are on',
    );
    t.equal(
      parseDatabaseList(
        'postgres  running  port 5432  PostgreSQL 18\nredis     stopped  port 6379  Redis\nnoise\n',
      ).map((d) => [d.name, d.running, d.port]),
      [
        ['postgres', true, 5432],
        ['redis', false, 6379],
      ],
      'the database list reads sbx-db output and ignores other lines',
    );

    t.section('accounts for every agent');
    const service = new AccountsService({
      storageRoot: t.dir('acc', 'storage'),
      dataPath: t.dir('acc', 'data'),
      loaded: { config: structuredClone(DEFAULTS), configPath: null, base: t.temp },
    });
    const agents = service.agents();
    t.check(
      agents[0].name === 'claude' && agents.some((a) => a.name === 'qwen' && a.kept && !a.canSavePc),
      'Claude is listed first; an agent with only a profile folder cannot be saved from this PC',
    );
    const qwenCreds = t.at('acc', 'data', 'state', 'qwen', 'profile', '.qwen', 'oauth_creds.json');
    t.write(qwenCreds, '{"token":"Q"}');
    service.save('q', false, 'qwen');
    t.write(qwenCreds, '{"token":"Q2"}');
    service.activate('q', 'qwen');
    t.equal(fs.readFileSync(qwenCreds, 'utf8'), '{"token":"Q"}', 'login files below profile/ are saved and restored');
    t.equal(
      profileLinkPairs('qwen', ['.qwen', '.config/x', '.QWEN'], 'C:\\Users\\u', 'C:\\AgentData\\state'),
      [
        { link: 'C:\\Users\\u\\.qwen', target: 'C:\\AgentData\\state\\qwen\\profile\\.qwen' },
        { link: 'C:\\Users\\u\\.config\\x', target: 'C:\\AgentData\\state\\qwen\\profile\\.config\\x' },
      ],
      'the profile links: one pair per folder, below state\\<agent>\\profile, without repeats',
    );
    const home = (profileDirs: string[]): boolean =>
      HarnessSchema.safeParse({
        npmPackage: 'x',
        npmBin: 'x',
        arguments: [],
        environment: {},
        home: { env: {}, loginFiles: [], profileDirs },
      }).success;
    t.check(
      home(['.qwen', '.local/share/opencode']) &&
        !home(['..\\x']) &&
        !home(['C:\\x']) &&
        !home(['a/../b']) &&
        !home(Array.from({ length: 9 }, (_, i) => 'd' + i)),
      'profile folders: relative paths only (no "..", no drive), at most 8',
    );
    const codexAuth = t.at('acc', 'data', 'state', 'codex', 'auth.json');
    t.write(codexAuth, '{"token":"A"}');
    service.save('main', false, 'codex');
    t.write(codexAuth, '{"token":"B"}');
    service.save('other', false, 'codex');
    t.write(codexAuth, '{"token":"B2"}');
    service.activate('main', 'codex');
    const swapped = fs.readFileSync(codexAuth, 'utf8');
    service.activate('other', 'codex');
    t.equal(
      [swapped, fs.readFileSync(codexAuth, 'utf8')],
      ['{"token":"A"}', '{"token":"B2"}'],
      'using a login puts its files into the sandbox state; the outgoing login is saved back first (tokens rotate)',
    );
    service.rename('other', 'second', 'codex');
    service.setDefault('second', 'codex');
    t.equal(
      service.list('codex').map((a) => [a.name, a.isDefault, a.isActive]),
      [
        ['main', false, false],
        ['second', true, true],
      ],
      'rename keeps the default and active marks',
    );
    await t.throws(() => service.save('x', false, 'nobody'), 'Unknown agent', 'an unknown agent: refused');
    await t.throws(() => service.save('bad name', false, 'codex'), 'Invalid account name', 'bad names are refused');

    t.section('every screen');
    const screens = renderScreens(t.dir('screens'));
    const blocks = screens.split('\n=== ').slice(1);
    const overflow = blocks.filter((block) => {
      const [head, ...rows] = block.trimEnd().split('\n');
      const size = /\((\d+)x(\d+)\)/.exec(head);
      return !size || rows.length !== Number(size[2]) || rows.some((l) => Text.width(l) > Number(size[1]) - 1);
    });
    t.equal(
      overflow.map((b) => b.slice(0, b.indexOf('\n'))),
      [],
      'every screen is exactly as tall as the terminal and never wider, at 200x60, 100x30, 80x24 and 60x20',
    );
    t.check(
      SIZES.length === 4 &&
        screens.includes('=== 7 Maintenance · health (80x24) ===') &&
        screens.includes('unsaved: 2') &&
        screens.includes('Save'),
      'all screens render at both sizes; the settings screen shows its unsaved count and the leave dialog offers Save',
    );
    const out = process.env.MENU_SCREENS_OUT;
    if (out) fs.writeFileSync(out, screens, 'utf8');
  },
};
