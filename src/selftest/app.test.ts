// The shared core: the kernel (definitions checked in and out, Fields from zod, questions and their fake, errors across
// a surface, the RPC messages), parity (every operation and query reachable on the CLI, the menu and the web, or
// exempt with a reason), the reference views' pages, their CLI and menu renderings, and the settings feature run
// against a config file of its own.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { agentsPage, agentsView } from '../app/features/agents/index.js';
import { DEFINITIONS, NAV, navSections, navViews, QUERIES, VIEWS, viewById } from '../app/features/defs.js';
import { accountsPage, agentPage, listAccounts, type AgentAccounts } from '../app/features/accounts/index.js';
import { addProject, projectRoots, projectsPage } from '../app/features/projects/index.js';
import { cleanData, dataPage, showData } from '../app/features/data/index.js';
import {
  showStorage,
  storagePage,
  storageView,
  type ContainedStatus,
  type StorageShow,
} from '../app/features/storage/index.js';
import { insideSandbox, isSandboxRunning } from '../host/sandbox/index.js';
import { CRASH, listLogs, logsPage, tailLog } from '../app/features/logs/index.js';
import { DEFAULTS } from '../core/config/index.js';
import { sandboxPage, type SandboxStatus } from '../app/features/sandbox/index.js';
import { sessionsPage, type SessionRow, type SessionsList } from '../app/features/sessions/index.js';
import { APP_GROUPS, appsPage, listApps, type AppsList } from '../app/features/apps/index.js';
import { keepShownSecrets, settingsPage } from '../app/features/settings/index.js';
import { checkEngine, checkText, enginePage, type Leftovers } from '../app/features/engine/index.js';
import { runUpdate, updatesPage, type UpdatesStatus } from '../app/features/updates/index.js';
import { MenuOperations } from '../cli/menu/io-menu.js';
import type { AppContext } from '../app/context.js';
import {
  ago,
  bytesText,
  Cancelled,
  ClientMessageSchema,
  defineOperation,
  exemption,
  fakeIO,
  fieldOf,
  fieldProblem,
  FieldSchema,
  fieldsOf,
  fromWireError,
  humanize,
  implementer,
  invoke,
  pageActions,
  pageHasContent,
  ServerMessageSchema,
  SURFACE_NAMES,
  toWireError,
  valueText,
  type AnyDefinition,
  type Page,
  type SurfaceName,
  type AnyView,
} from '../app/kernel/index.js';
import { createRpcHost, IMPLEMENTATIONS, readQuery, runDefinition } from '../app/registry.js';
import { webPage } from '../app/features/web/index.js';
import { parseCli } from '../cli/args.js';
import { contextOrDefaults } from '../cli/commands/index.js';
import { COMMANDS, commandSpec } from '../cli/manifest.js';
import { menuView } from '../cli/menu/render-view.js';
import { MENU_VIEWS } from '../cli/menu/views.js';
import { cliIO, cliInput, commandSpecOf, definitionFor } from '../cli/operations/index.js';
import { pageLines } from '../cli/output/index.js';
import { secret } from '../core/schema/index.js';
import { UserError } from '../core/util/index.js';
import type { Suite } from './support/suite.js';

const NOW = Date.now();
const NPM_COMMAND = 'npm install -g windows-development-sandbox';

const running = (id: string, here: boolean): SessionRow => ({
  id,
  launchId: 'l1',
  harness: 'claude',
  cwd: 'C:\\Projects\\api',
  phase: 'running',
  message: 'running',
  updatedAt: new Date(NOW).toISOString(),
  startedAt: new Date(NOW - 5 * 60000).toISOString(),
  projectName: 'api',
  here,
  viewers: { viewers: 1, remote: 1 },
  canOpen: true,
});

const STATUS: SandboxStatus = {
  sandbox: {
    running: true,
    phase: 'ready',
    message: 'Ready',
    headless: true,
    startedAt: NOW - 3 * 3600000,
    daemon: 'pong (2 session(s) running)',
    account: 'work',
    syncWatcher: true,
  },
  here: { folder: 'C:\\Projects\\api', project: 'api', guest: 'C:\\Projects\\api' },
  roots: [{ host: 'C:\\Projects', guest: 'C:\\Projects' }],
  projects: [
    {
      name: 'api',
      host: 'C:\\Projects\\api',
      guest: 'C:\\Projects\\api',
      mechanism: 'launch',
      here: true,
      setup: { phase: 'ready', message: '' },
      databases: [{ database: 'postgres', port: 5432, state: 'running' }],
      sessions: [
        { id: 's1', harness: 'claude', viewers: '1 here, 0 in sandbox', started: new Date(NOW).toISOString() },
      ],
      repoGuard: [],
    },
  ],
  otherSessions: [],
  repoGuard: { guarded: 1, findings: ['hook: C:\\Projects\\api: .git/hooks/pre-commit'] },
};

/** The operations and queries a list of views can reach. */
function reached(views: readonly AnyView[]): Set<string> {
  return new Set(
    views.flatMap((v) => [
      ...v.operations.map((o) => o.id),
      ...Object.values(v.queries).map((q) => q.id),
      ...(v.pickers ?? []).map((q) => q.id),
    ]),
  );
}

/** Why a definition is not reachable on a surface ('' when it is). */
function gap(def: AnyDefinition, surface: SurfaceName, reach: Record<SurfaceName, Set<string>>): string {
  if (exemption(def, surface)?.trim()) return '';
  if (surface === 'cli') return def.cli ? '' : 'no CLI hint and no exemption';
  return reach[surface].has(def.id) ? '' : 'no ' + surface + ' view offers it and it declares no exemption';
}

export const appSuite: Suite = {
  name: 'app',
  title: 'shared core: kernel, parity of the three surfaces, reference views and their renderings, settings',
  run: async (t) => {
    t.section('definitions are checked going in and coming out');
    const implement = implementer<{ base: number }>();
    const add = defineOperation({
      id: 'test.add',
      title: 'Add',
      summary: 'adds',
      input: z.object({ n: z.number().int().describe('how many'), twice: z.boolean().default(false) }),
      output: z.object({ total: z.number() }),
      text: (o) => 'total ' + o.total,
    });
    const addRun = implement(add, (ctx, input) => ({ total: ctx.base + input.n * (input.twice ? 2 : 1) }));
    const io = fakeIO().io;
    t.equal(await invoke(addRun, { base: 1 }, { n: 2 }, io), { total: 3 }, 'defaults are filled in before run');
    await t.throws(() => invoke(addRun, { base: 1 }, { n: 'x' }, io), 'That does not work for add', 'a bad input');
    const broken = implement(add, () => ({ total: 'nope' }) as never);
    await t.throws(() => invoke(broken, { base: 0 }, { n: 1 }, io), 'expected number', 'an output that does not fit');

    t.section('questions, and the fake that answers them');
    const fake = fakeIO([true, 'too short', 'long enough']);
    const asked = await fake.io.confirm({ title: 'Sure?' });
    const typed = await fake.io.text({ title: 'Name', validate: (v) => (v.length > 9 ? true : 'Longer, please.') });
    fake.io.progress('working');
    fake.io.log('a line', 'muted');
    t.check(
      asked === true &&
        typed === 'long enough' &&
        fake.seen.questions.length === 3 &&
        fake.seen.questions[2].kind === 'text' &&
        'problem' in fake.seen.questions[2] &&
        fake.seen.questions[2].problem === 'Longer, please.' &&
        fake.seen.progress[0] === 'working' &&
        fake.seen.logs[0].tone === 'muted',
      'answers come in order, a typed answer is asked again with what was wrong, lines are recorded',
    );
    await t.throws(() => fakeIO().io.confirm({ title: 'Unplanned?' }), 'No answer for: Unplanned?', 'no answer left');

    t.section('errors cross a surface as message and fix');
    const user = toWireError(new UserError('It broke.', 'Do this.'));
    t.equal(user, { kind: 'user', message: 'It broke.', fix: 'Do this.' }, 'a UserError keeps its fix');
    t.equal(toWireError(new Cancelled()).kind, 'cancelled', 'a declined question is "cancelled"');
    t.equal(
      toWireError(new Error('C:\\secret')),
      { kind: 'bug', message: 'Something went wrong.' },
      'a bug says little',
    );
    t.equal(toWireError(z.number().safeParse('x').error).kind, 'invalid', 'a value that does not fit is "invalid"');
    const back = fromWireError(user);
    t.check(back instanceof UserError && back.fix === 'Do this.', 'and it becomes a UserError again on the other side');

    t.section('Fields from zod');
    const schema = z.object({
      on: z.boolean().default(true).describe('Switch it'),
      size: z.union([z.literal('auto'), z.number().int().min(1).max(64)]).describe('How big'),
      days: z.number().int().min(1).max(365).default(7),
      name: z.string().optional(),
      apiKey: secret(z.string()).default('hunter2'),
      cacheDir: z.string(),
      tags: z.array(z.string()),
      env: z.record(z.string(), secret(z.string())),
      mapping: z.object({ host: z.string(), readOnly: z.boolean().optional() }),
    });
    const fields = fieldsOf(schema);
    const kinds = Object.fromEntries(fields.map((f) => [f.name, f.kind]));
    t.equal(
      kinds,
      {
        on: 'boolean',
        size: 'enum',
        days: 'number',
        name: 'text',
        apiKey: 'secret',
        cacheDir: 'path',
        tags: 'list',
        env: 'map',
        mapping: 'object',
      },
      'every kind of value gets its kind of field',
    );
    const size = fields.find((f) => f.name === 'size')!;
    const days = fields.find((f) => f.name === 'days')!;
    const apiKey = fields.find((f) => f.name === 'apiKey')!;
    t.check(
      size.help === 'How big' &&
        size.choices?.[0]?.value === 'auto' &&
        size.open?.kind === 'number' &&
        days.range === '1 to 365' &&
        days.default === 7 &&
        days.optional &&
        apiKey.default === '***' &&
        fields.find((f) => f.name === 'cacheDir')?.pathKind === 'dir' &&
        fields.find((f) => f.name === 'mapping')?.fields?.length === 2 &&
        humanize('memoryMb') === 'Memory MB',
      'label, help, default, range, choices with a value of your own, folders, objects; a secret default never shows',
    );
    t.check(
      fields.every((f) => FieldSchema.safeParse(f).success) && FieldSchema.safeParse({ kind: 'x' }).success === false,
      'Fields are plain data that fits FieldSchema (what the browser receives)',
    );
    t.check(
      fieldProblem(days, 400) === 'Use 1 to 365.' &&
        fieldProblem(days, 3) === undefined &&
        fieldProblem(size, 'big') === undefined &&
        fieldProblem(fieldOf(z.enum(['a', 'b'])), 'c') === 'Choose one.' &&
        valueText('hunter2', apiKey).text === '***' &&
        valueText(true).text === 'On',
      'a Field checks a value as far as it can tell, and secrets read as ***',
    );

    t.section('the RPC messages');
    const good = [
      { t: 'call', id: 'c1', op: 'sessions.restart', input: { all: true } },
      { t: 'answer', id: 'c1', value: true },
      { t: 'subscribe', id: 's1', query: 'sandbox.status', input: {} },
      { t: 'unsubscribe', id: 's1' },
    ];
    const bad = [
      { t: 'call', id: 'c1', op: '../etc', input: {} },
      { t: 'call', id: 'with space', op: 'a.b', input: {} },
      { t: 'call', id: 'c1', op: 'a.b', input: {}, extra: 1 },
      { t: 'shell', id: 'c1' },
      'call',
    ];
    t.check(
      good.every((m) => ClientMessageSchema.safeParse(m).success) &&
        bad.every((m) => !ClientMessageSchema.safeParse(m).success) &&
        ServerMessageSchema.safeParse({ t: 'ask', id: 'c1', question: { kind: 'confirm', title: 'Go?' } }).success &&
        !ServerMessageSchema.safeParse({ t: 'ask', id: 'c1', question: { kind: 'shell', title: 'x' } }).success,
      'the browser may send only calls, answers and subscriptions of the right shape',
    );

    t.section('parity: every operation and query on every surface');
    const ids = DEFINITIONS.map((d) => d.id);
    const implemented = IMPLEMENTATIONS.map((i) => i.def.id);
    t.check(
      new Set(ids).size === ids.length &&
        ids.every((id) => implemented.includes(id)) &&
        implemented.every((id) => ids.includes(id)) &&
        IMPLEMENTATIONS.every((i) => DEFINITIONS.includes(i.def)),
      'every definition has exactly one implementation and every implementation is registered',
      ids.filter((id) => !implemented.includes(id)).join(', '),
    );
    const webViews = navViews(NAV).map((id) => viewById(id)!);
    const reach: Record<SurfaceName, Set<string>> = {
      cli: new Set(),
      menu: reached(MENU_VIEWS.map((m) => m.view)),
      web: reached(webViews),
    };
    const gaps = DEFINITIONS.flatMap((d) =>
      SURFACE_NAMES.map((s) => [d.id, s, gap(d, s, reach)] as const).filter(([, , why]) => why),
    ).map(([id, s, why]) => id + ' on ' + s + ': ' + why);
    t.equal(gaps, [], 'the parity list shows no gaps');
    t.check(
      VIEWS.every((v) => webViews.includes(v) || MENU_VIEWS.some((m) => m.view === v)) &&
        navSections(NAV).every((n) => n.view !== undefined || (n.children?.length ?? 0) > 0 || Boolean(n.elsewhere)),
      'every view is shown somewhere, and a web section without a view says where the area is',
    );
    const hinted = DEFINITIONS.filter((d) => d.cli);
    t.check(
      hinted.every((d) => {
        const names = [...(d.cli?.positional ?? []), ...Object.keys(d.cli?.flags ?? {})];
        const shape = (d.input as unknown as { shape?: Record<string, unknown> }).shape ?? {};
        return names.every((n) => n in shape);
      }) && hinted.filter((d) => !d.cli?.action).every((d) => commandSpecOf(d).name === d.cli?.name),
      'every CLI hint names fields of its input, and every command of its own has a group',
    );

    t.section('the commands keep their names and flags');
    const spec = (name: string): string =>
      JSON.stringify(
        commandSpec(name)?.options.map((o) => [o.flag, o.short ?? '', o.shownAs ?? '', o.type, o.description]),
      );
    t.check(
      ['status', 'sessions', 'restart', 'stop', 'show', 'hide'].every(
        (n) => COMMANDS.filter((c) => c.name === n).length === 1,
      ),
      'status, sessions, restart, stop, show and hide are commands (once each)',
    );
    t.equal(
      [spec('restart'), spec('stop'), spec('sessions')],
      [
        JSON.stringify([
          ['--harness', '', '--agent', 'string', 'only this agent'],
          ['--all', '', '', 'boolean', "every project's sessions, not only this folder's"],
        ]),
        JSON.stringify([['--yes', '-y', '', 'boolean', "do not ask when other projects' sessions would end"]]),
        JSON.stringify([['--wide', '', '', 'boolean', "also show each session's folder"]]),
      ],
      'with the flags and help they had',
    );
    const configChoices = commandSpec('config')?.args[0].choices;
    t.check(
      Array.isArray(configChoices) && ['get', 'set', 'reset', 'list'].every((a) => configChoices.includes(a)),
      'config get, set, reset and list are actions of config',
    );
    const restartLine = parseCli(['restart', '--agent', 'claude', '--all']);
    const setLine = parseCli(['config', 'set', 'sandbox.memoryMb', '8192']);
    t.equal(
      [cliInput(definitionFor('restart', [])!, restartLine), cliInput(definitionFor('config', ['set'])!, setLine)],
      [
        { harness: 'claude', all: true },
        { key: 'sandbox.memoryMb', value: '8192' },
      ],
      'a command line becomes the input (--agent and the old --harness, positional arguments after the action)',
    );
    t.check(
      definitionFor('config', ['show']) === undefined && definitionFor('config', []) === undefined,
      "config's own actions stay the command's",
    );

    t.section('the reference views');
    const statusPage = sandboxPage(STATUS);
    const stoppedPage = sandboxPage({ ...STATUS, sandbox: { ...STATUS.sandbox, running: false, phase: 'stopped' } });
    const limited = sandboxPage({
      ...STATUS,
      shared: { line: 'Running, started by bob (not shared)', limited: true, startedBy: 'bob' },
    });
    const ops = (page: Page): string[] => pageActions(page).flatMap((a) => (a.kind === 'operation' ? [a.op] : []));
    const hiddenPage = sandboxPage({ ...STATUS, sandbox: { ...STATUS.sandbox, headless: true } });
    const shownPage = sandboxPage({ ...STATUS, sandbox: { ...STATUS.sandbox, headless: false } });
    t.check(
      ops(hiddenPage).join() === 'sandbox.showWindow,sandbox.stop' &&
        ops(shownPage).join() === 'sandbox.hideWindow,sandbox.stop' &&
        pageActions(statusPage).some((a) => a.kind === 'operation' && a.op === 'sandbox.stop' && a.danger) &&
        ops(stoppedPage).length === 0 &&
        limited.sections.length === 0 &&
        limited.notice?.text === 'Running, started by bob (not shared)',
      "status: show or hide (whichever changes the window) and stop (marked dangerous) only while it runs; another user's unshared sandbox shows only whose it is",
    );
    const list: SessionsList = {
      sandboxRunning: true,
      defaultAgent: 'codex',
      wide: false,
      sessions: [running('old', false), { ...running('new', true), startedAt: new Date(NOW).toISOString() }],
    };
    const sessions = sessionsPage(list);
    const items = sessions.sections[0].items ?? [];
    t.check(
      items[0].id === 'new' &&
        items[0].primary?.kind === 'link' &&
        items[0].primary.target.kind === 'terminal' &&
        items[0].group === "This folder's project" &&
        ops(sessions).includes('sessions.restart') &&
        sessionsPage({ ...list, sessions: [] }).empty?.action?.kind === 'link',
      "sessions: this folder's project first, a running session opens its terminal, empty offers to start one",
    );
    for (const view of VIEWS as readonly AnyView[]) {
      const known = new Set(view.operations.map((o) => o.id));
      const sample = view.id === 'sandbox' ? statusPage : view.id === 'sessions' ? sessions : undefined;
      if (sample)
        t.check(
          ops(sample).every((op) => known.has(op)),
          view.id + ': the page offers only operations its view declares',
        );
    }

    t.section('agents');
    const agentsSample = agentsPage({
      folder: 'C:\\code\\api',
      defaultAgent: 'claude',
      agents: [
        { name: 'codex', ready: false, isDefault: false, removable: true },
        { name: 'claude', ready: true, isDefault: true, removable: false },
      ],
    });
    const agentItems = agentsSample.sections[0].items ?? [];
    const agentKeys = (id: string): string =>
      (agentItems.find((i) => i.id === id)?.actions ?? [])
        .flatMap((a) => (a.kind === 'operation' && a.key ? [a.key] : []))
        .join();
    t.check(
      agentItems.map((i) => i.id).join() === 'agent:claude,agent:codex,add' &&
        agentKeys('agent:claude') === '' &&
        agentKeys('agent:codex') === 'd,x' &&
        agentKeys('add') === '' &&
        agentItems[0].primary?.kind === 'link' &&
        ops(agentsSample).every((op) => agentsView.operations.some((o) => o.id === op)),
      "agents: the default first, Add last, d/x only where they apply; the page offers only its view's operations",
    );
    const agentIO = fakeIO().io;
    const noSandboxCtx = {} as unknown as AppContext;
    await t.throws(
      () => runDefinition('agents.start', noSandboxCtx, { agent: '../x' }, agentIO),
      'That does not work for start an agent',
      'agents.start refuses odd names',
    );
    await t.throws(
      () => runDefinition('agents.start', noSandboxCtx, { agent: 'claude' }, agentIO),
      'No Windows Sandbox is running.',
      'agents.start without a running sandbox says how to start one',
    );
    const agentsConfig = t.at('app-agents', 'config.json');
    t.write(agentsConfig, '{ "defaultHarness": "claude" }\n');
    const agentsCtx = { loaded: { configPath: agentsConfig } } as unknown as AppContext;
    await runDefinition('agents.add', agentsCtx, {}, fakeIO(['npm', 'mine', '@me/mine@latest', 'mine']).io);
    const before = fs.readFileSync(agentsConfig, 'utf8');
    await t.throws(
      () => runDefinition('agents.remove', agentsCtx, { name: 'mine' }, fakeIO([false]).io),
      'Nothing changed.',
      'agents.remove asks, and a no changes nothing',
    );
    t.check(fs.readFileSync(agentsConfig, 'utf8') === before, 'the config file is unchanged after a no');

    t.section('the CLI and the menu draw the same page');
    const sessionLines = pageLines(sessionsPage({ ...list, wide: true }));
    t.check(
      /^\s+ID\s+AGENT\s+PROJECT\s+STATE\s+ATTACHED\s+FOLDER\s+STARTED$/.test(sessionLines[0]) &&
        /^\*\s+new\s/.test(sessionLines[1]) &&
        sessionLines.includes('* = the project of this folder') &&
        !sessionLines.some((l) => l.includes('--wide')),
      'sessions on the command line: the table with the folder column (--wide), the marker and its note',
      sessionLines.join('\n'),
    );
    const statusLines = pageLines(statusPage);
    t.check(
      statusLines.some((l) => /^State\s+\S/.test(l)) &&
        statusLines.some((l) => /^Helper\s+responding, 2 sessions running$/.test(l)) &&
        statusLines.includes('* api  C:\\Projects\\api  ->  C:\\Projects\\api  (started from here)') &&
        statusLines.some((l) => l.startsWith('Repo guard  1 folder(s) guarded')),
      'status on the command line: facts as rows, projects with their details, the repo guard',
      statusLines.join('\n'),
    );
    t.equal(
      pageLines(sessionsPage({ ...list, sessions: [] })).at(-1),
      'No sessions. Start one with: sandbox claude',
      'an empty page prints its command-line text',
    );
    const menu = menuView(sessions);
    const chosen = menu.resolve({ kind: 'pick', value: 'new' });
    t.check(
      menu.items.length === 2 &&
        menu.actions.map((a) => a.key).join() === 'n,r,o,l' &&
        menu.enterLabel(undefined, 'new') === 'attach' &&
        chosen?.kind === 'action' &&
        chosen.action.kind === 'link' &&
        menu.resolve({ kind: 'action', key: 'l', value: undefined })?.kind === 'refresh',
      'sessions in the menu: rows, the n/r/o/l keys, Enter attaches',
    );
    const menuStatus = menuView(statusPage, { category: 'status', prefix: 'status:' });
    t.check(
      menuStatus.items.every((i) => i.category === 'status' && i.value.startsWith('status:')) &&
        menuStatus.actions.some((a) => a.key === 'x' && a.label === 'stop'),
      'a view inside one category of a page: rows in it, prefixed, with the keys of its actions',
    );

    t.section('settings, run against a config file');
    const configFile = t.writeJson(t.at('app-settings', 'config.json'), {
      storage: { root: t.dir('app-settings', 'storage') },
      harnesses: {
        planted: { npmPackage: 'p', npmBin: 'p', arguments: [], environment: { KEY: 'sk-planted-secret' } },
      },
    });
    const ctx = {
      loaded: { configPath: configFile },
      options: { workspace: t.dir('app-settings', 'project') },
      storageRoot: t.at('app-settings', 'storage'),
    } as unknown as AppContext;
    const quiet = fakeIO().io;
    const set = (await runDefinition('settings.set', ctx, { key: 'sandbox.memoryMb', value: '8192' }, quiet)) as {
      message: string;
    };
    const got = (await runDefinition('settings.get', ctx, { key: 'sandbox.memoryMb' }, quiet)) as { value: unknown };
    t.check(
      set.message === 'sandbox.memoryMb is 8192.' &&
        got.value === 8192 &&
        fs.readFileSync(configFile, 'utf8').includes('8192'),
      'set reads text like the command line, writes the file, and get reads it back',
      set.message,
    );
    await t.throws(
      () => runDefinition('settings.set', ctx, { key: 'sandbox.memoryMb', value: 'lots' }, quiet),
      'does not work for sandbox.memoryMb',
      'a value that does not fit is refused with what is allowed',
    );
    await t.throws(
      () => runDefinition('settings.set', ctx, { key: 'sandbox.memoryMbb', value: '1' }, quiet),
      'Did you mean sandbox.memoryMb',
      'a typo gets a suggestion',
    );
    const reset = (await runDefinition('settings.reset', ctx, { key: 'sandbox.memoryMb' }, quiet)) as {
      message: string;
    };
    t.check(
      reset.message.startsWith('sandbox.memoryMb is back to its default') &&
        !fs.readFileSync(configFile, 'utf8').includes('8192'),
      'reset removes the line',
    );

    t.section('the folder picker (files.browse)');
    const browseRoot = t.dir('app-browse');
    fs.mkdirSync(path.join(browseRoot, 'zeta'));
    fs.mkdirSync(path.join(browseRoot, 'Alpha'));
    fs.mkdirSync(path.join(browseRoot, '$Recycle.Bin'));
    fs.writeFileSync(path.join(browseRoot, 'notes.txt'), 'x');
    const folders = (await runDefinition('files.browse', ctx, { path: browseRoot }, quiet)) as {
      entries: { name: string; kind: string }[];
      parent: string | null;
    };
    t.equal(
      folders.entries.map((e) => e.name).join(),
      'Alpha,zeta',
      'a folder lists its folders by name, without files or $ system folders',
    );
    const withFiles = (await runDefinition('files.browse', ctx, { path: browseRoot, files: true }, quiet)) as {
      entries: { name: string; kind: string }[];
    };
    t.equal(
      withFiles.entries.map((e) => e.kind + ':' + e.name).join(),
      'dir:Alpha,dir:zeta,file:notes.txt',
      'with files: folders first, then files',
    );
    t.check(folders.parent === path.dirname(browseRoot), 'it names the folder above');
    await t.throws(
      () => runDefinition('files.browse', ctx, { path: 'relative\\folder' }, quiet),
      'is not a full path',
      'a path that is not a full path is refused',
    );
    const listed = await readQuery(
      QUERIES.find((q) => q.id === 'settings.list')!,
      ctx,
      { scope: 'user' },
    );
    const rows = (listed as { rows: { id: string; value: unknown; field: unknown }[] }).rows;
    const text = JSON.stringify(listed);
    t.check(
      rows.length > 50 &&
        !text.includes('sk-planted-secret') &&
        text.includes('***') &&
        !rows.some((r) => r.id === 'storage.root') &&
        rows.every((r) => FieldSchema.safeParse(r.field).success),
      'the rows: every setting with a Field, secrets as ***, the data folder through its own row',
    );
    const page = settingsPage(listed as Parameters<typeof settingsPage>[0]);
    const edit = page.sections.flatMap((s) => s.items ?? []).find((i) => i.id === 'sandbox.memoryMb')?.primary;
    t.check(
      page.sections.length >= 5 &&
        edit?.kind === 'operation' &&
        edit.op === 'settings.set' &&
        edit.fields?.[0]?.name === 'value' &&
        page.sections.some((s) => s.items?.some((i) => i.id === '@data-folder')),
      'the settings page: a section per category, each setting edited through its Field',
    );

    t.section('a secret shown as *** is never saved as ***');
    t.equal(
      keepShownSecrets({ API_KEY: 'sk-real', LOG: 'debug' }, { API_KEY: '***', LOG: 'info', NEW_KEY: '***' }),
      { API_KEY: 'sk-real', LOG: 'info', NEW_KEY: '***' },
      'a map edited in the web keeps the saved secret where *** came back, and takes the rest as typed',
    );

    t.section('settings export and import, run against a config file');
    const exportFile = t.at('app-settings', 'out.json');
    const exported = (await runDefinition('settings.export', ctx, { settingsFile: exportFile }, fakeIO().io)) as {
      leftOut: string[];
    };
    const written = fs.readFileSync(exportFile, 'utf8');
    t.check(
      !('storage' in (JSON.parse(written) as object)) &&
        !written.includes('sk-planted-secret') &&
        exported.leftOut.some((l) => l.startsWith('harnesses.planted') && l.includes('a secret, never shared')),
      'settings.export writes only what differs and says what it left out',
      exported.leftOut.join('; '),
    );
    await t.throws(
      () => runDefinition('settings.export', ctx, { settingsFile: exportFile }, fakeIO([false]).io),
      'Nothing changed.',
      'settings.export asks before replacing a file that is there',
    );
    await runDefinition('settings.export', ctx, { settingsFile: exportFile }, fakeIO([true]).io);
    t.check(fs.existsSync(exportFile), 'settings.export replaces the file when asked to');

    const shared = t.writeJson(t.at('app-settings', 'shared.json'), { sandbox: { memoryMb: 2048 } });
    const imported = fakeIO([true]);
    const done = (await runDefinition('settings.import', ctx, { settingsFile: shared }, imported.io)) as {
      message: string;
    };
    const got2048 = (await runDefinition('settings.get', ctx, { key: 'sandbox.memoryMb' }, quiet)) as {
      value: unknown;
    };
    t.check(
      done.message.startsWith('Imported 1 setting') &&
        imported.seen.logs.some((l) => l.text.startsWith('  sandbox.memoryMb: ') && l.text.endsWith('-> 2048')) &&
        imported.seen.questions[0]?.title === 'Change your settings like this?' &&
        got2048.value === 2048,
      'settings.import logs the diff, asks once, and applies',
      done.message,
    );
    const shared1024 = t.writeJson(t.at('app-settings', 'shared1024.json'), { sandbox: { memoryMb: 1024 } });
    const before1024 = fs.readFileSync(configFile, 'utf8');
    await t.throws(
      () => runDefinition('settings.import', ctx, { settingsFile: shared1024 }, fakeIO([false]).io),
      'Nothing was changed.',
      'settings.import with a no changes nothing',
    );
    t.check(fs.readFileSync(configFile, 'utf8') === before1024, 'a declined import leaves the file as it was');

    const own = settingsPage(listed as Parameters<typeof settingsPage>[0]);
    const theirs = settingsPage({ ...(listed as Parameters<typeof settingsPage>[0]), scope: 'project' });
    const pageOps = (p: Page): string[] => (p.actions ?? []).flatMap((a) => (a.kind === 'operation' ? [a.op] : []));
    t.check(
      pageOps(own).join() === 'settings.export,settings.import' &&
        (own.actions ?? []).every(
          (a) => a.kind === 'operation' && a.fields?.length === 1 && a.fields[0]?.kind === 'path',
        ) &&
        pageOps(theirs).length === 0,
      'the settings page offers export and import only for your own settings, each asking one file path',
    );
    t.section('apps, run against a config file');
    const appsConfig = t.writeJson(t.at('app-apps', 'config.json'), {
      storage: { root: t.dir('app-apps', 'storage') },
    });
    const appsCtx = {
      loaded: { configPath: appsConfig },
      options: { workspace: t.dir('app-apps', 'project') },
      storageRoot: t.at('app-apps', 'storage'),
      dataPath: t.dir('app-apps', 'data'),
    } as unknown as AppContext;
    await runDefinition('apps.toggle', appsCtx, { id: 'lazygit', on: true }, quiet);
    const onText = fs.readFileSync(appsConfig, 'utf8');
    await runDefinition('apps.toggle', appsCtx, { id: 'lazygit', on: false }, quiet);
    const offText = fs.readFileSync(appsConfig, 'utf8');
    t.check(
      onText.includes('"lazygit"') && !offText.includes('"lazygit"'),
      'apps: turning an app on writes apps.install, off removes it',
    );
    await t.throws(
      () => runDefinition('apps.toggle', appsCtx, { scope: 'project', id: 'vscode', on: false }, quiet),
      'is not an app this scope can change',
      'apps: a project cannot change VS Code',
    );
    const dataDir = t.dir('app-apps', 'data');
    fs.mkdirSync(path.join(dataDir, 'tools', 'apps', 'lazygit'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'tools', 'apps', 'lazygit', '.agent-sandbox-app'), 'lazygit');
    const appsList = (await readQuery(listApps, appsCtx, { scope: 'user' })) as AppsList;
    const lazygit = appsList.apps.find((a) => a.id === 'lazygit');
    t.check(
      lazygit?.installed === true && appsList.apps.every((a) => APP_GROUPS.some((g) => g.id === a.group)),
      'apps: the list marks downloaded apps installed, and every row sits in a group',
    );
    const hand: AppsList = {
      scope: 'user',
      file: 'config.json',
      exists: true,
      apps: [
        {
          id: 'lazygit',
          name: 'lazygit',
          about: 'Git in a terminal',
          group: 'tools',
          size: '5 MB',
          cli: true,
          mesa: false,
          fullGitOnly: false,
          installed: true,
          on: true,
        },
      ],
      custom: [],
      customValue: {},
      customField: { name: 'custom', key: ['apps', 'custom'], kind: 'map', label: 'Your own programs', optional: true },
    };
    const userPage = appsPage(hand);
    const projectPage = appsPage({ ...hand, scope: 'project' });
    const actionsOf = (page: Parameters<typeof pageActions>[0]): string[] =>
      pageActions(page).flatMap((a) => (a.kind === 'operation' ? [a.op] : []));
    t.check(
      userPage.sections.some((s) => s.id === 'tools') &&
        actionsOf(userPage).includes('apps.setCustom') &&
        actionsOf(userPage).includes('apps.request') &&
        !actionsOf(projectPage).includes('apps.setCustom') &&
        !actionsOf(projectPage).includes('apps.request'),
      'apps: the page has a category per group; your own programs and the request only in your own scope',
    );

    t.equal(ago(NOW - 90 * 60000, NOW), '2 h ago', 'times read the same on every surface');

    t.section('accounts, run against a temp folder');
    const accCtx = {
      loaded: { config: structuredClone(DEFAULTS), configPath: null, base: t.temp },
      options: { workspace: t.dir('app-acc', 'project') },
      storageRoot: t.dir('app-acc', 'storage'),
      dataPath: t.dir('app-acc', 'data'),
    } as unknown as AppContext;
    t.write(t.at('app-acc', 'data', 'state', 'codex', 'auth.json'), '{"token":"A"}');
    const saving = fakeIO(['bad name', 'main']);
    const saved = (await runDefinition('accounts.save', accCtx, { agent: 'codex' }, saving.io)) as { message: string };
    t.check(
      saving.seen.questions[0]?.kind === 'text' &&
        saving.seen.questions.length === 2 &&
        saved.message === 'Saved account "main".',
      'accounts: save asks a name when none is given, and refuses a bad one',
      saved.message,
    );
    const listed2 = (await readQuery(listAccounts, accCtx, { agent: 'codex' })) as {
      agents: { name: string; accounts: { name: string }[] }[];
    };
    t.check(
      listed2.agents[0].name === 'claude' &&
        listed2.agents.find((a) => a.name === 'codex')?.accounts[0]?.name === 'main' &&
        JSON.stringify(listAccounts.cli?.shapeJson?.(listed2)) ===
          JSON.stringify(listed2.agents.find((a) => a.name === 'codex')?.accounts),
      'accounts: list shows Claude first and the saved codex login; --json keeps the rows of the one agent',
    );
    await t.throws(
      () => runDefinition('accounts.remove', accCtx, { agent: 'codex', name: 'main' }, fakeIO([false]).io),
      'Nothing removed.',
      'accounts: remove asks first; no is Nothing removed.',
    );
    const removed = (await runDefinition(
      'accounts.remove',
      accCtx,
      { agent: 'codex', name: 'main' },
      fakeIO([true]).io,
    )) as { message: string };
    t.equal(removed.message, 'Removed account main.', 'accounts: yes removes the login');
    const codex: AgentAccounts = {
      name: 'codex',
      kept: true,
      canSavePc: true,
      accounts: [{ name: 'main', email: null, isDefault: false, isActive: false, savedAt: '2026-10-12T08:00:00Z' }],
    };
    const codexMenu = menuView(agentPage(codex), { category: 'codex', refresh: false });
    t.check(
      codexMenu.enterLabel('codex', 'codex:main') === 'use' &&
        ['s', 'p', 'd', 'r', 'x'].every((k) => codexMenu.actions.some((a) => a.key === k)) &&
        accountsPage({ agent: 'codex', agents: [codex] }).sections[0].cards === true,
      'accounts: the page offers use on Enter and d/r/x on a login; the codex agent is a card',
    );
    const useDef = definitionFor('account', ['use'])!;
    t.check(
      JSON.stringify(cliInput(useDef, parseCli(['account', 'use', 'work', '--no-restart']))) ===
        JSON.stringify({ name: 'work', noRestart: true }) &&
        !('noRestart' in cliInput(useDef, parseCli(['account', 'use', 'work']))),
      'a --no- flag reaches the input (and is absent without it)',
    );

    t.section('projects, run against a temp folder');
    const projCfg = t.at('app-projects', 'config.json');
    t.write(projCfg, '{}\n');
    const projCtx = {
      loaded: { config: structuredClone(DEFAULTS), configPath: projCfg, base: t.temp },
      options: { workspace: t.dir('app-projects', 'here') },
      storageRoot: t.dir('app-projects', 'storage'),
      packageRoot: t.dir('app-projects', 'package'),
      dataPath: t.dir('app-projects', 'data'),
    } as unknown as AppContext;
    const projQuiet = fakeIO().io;
    const rootDir = t.dir('app-projects', 'roots', 'code');
    const addedRoot = (await runDefinition(
      'projects.roots',
      projCtx,
      { change: 'add', rootFolder: rootDir },
      projQuiet,
    )) as { message: string };
    t.check(
      addedRoot.message.startsWith('Added the project root ' + rootDir + ':'),
      'projects roots add: the folder becomes a root and the message says so',
      addedRoot.message,
    );
    const rootAgain = (await runDefinition(
      'projects.roots',
      projCtx,
      { change: 'add', rootFolder: rootDir },
      projQuiet,
    )) as { message: string };
    t.equal(rootAgain.message, rootDir + ' is a root already.', 'projects roots add: a root twice is said, not added');
    await t.throws(
      () => runDefinition('projects.roots', projCtx, { change: 'remove', rootFolder: rootDir }, fakeIO([false]).io),
      'Nothing changed.',
      'projects roots remove asks first; a no changes nothing',
    );
    t.check(fs.readFileSync(projCfg, 'utf8').includes('roots'), 'the root is still in the settings file after a no');
    const removedRoot = (await runDefinition(
      'projects.roots',
      projCtx,
      { change: 'remove', rootFolder: rootDir },
      fakeIO([true]).io,
    )) as { message: string };
    t.check(
      removedRoot.message.startsWith('Removed the project root ' + rootDir),
      'projects roots remove: yes removes it',
      removedRoot.message,
    );
    await t.throws(
      () => runDefinition('projects.roots', projCtx, { change: 'add', rootFolder: 'C:\\' }, projQuiet),
      'A whole drive cannot be a project root',
      'a whole drive cannot be a project root',
    );
    const projectDir = t.dir('app-projects', 'api');
    const addedProject = (await runDefinition('projects.add', projCtx, { projectFolder: projectDir }, projQuiet)) as {
      message: string;
      next?: string;
    };
    t.check(
      addedProject.message === 'Added ' + projectDir + ' to your projects.' &&
        addedProject.next === 'Next: sandbox projects all on   (map every project at every start)' &&
        (addProject.text?.(addedProject as never) ?? '').endsWith(addedProject.next ?? '~'),
      'projects add: says it was added, and what to do next while all projects is off (on the command line too)',
      addedProject.message,
    );
    await t.throws(
      () => runDefinition('projects.remove', projCtx, { projectFolder: projectDir }, fakeIO([false]).io),
      'Nothing changed.',
      'projects remove: a no is Nothing changed and keeps the project',
    );
    const allOn = (await runDefinition('projects.all', projCtx, { state: 'on' }, projQuiet)) as { message: string };
    t.check(
      allOn.message.startsWith('Mapping all projects at every start is on. This changes what is mapped'),
      'projects all on: the setting is written and the next start is said',
      allOn.message,
    );
    await t.throws(
      () => runDefinition('projects.choose', projCtx, {}, fakeIO([undefined]).io),
      'Nothing changed.',
      'projects choose: backing out changes nothing',
    );
    const projectsSample = projectsPage({
      all: false,
      roots: ['C:\\Projects'],
      exclude: [],
      projects: [
        {
          folder: 'C:\\Projects\\api',
          here: true,
          known: true,
          root: 'C:\\Projects',
          excluded: false,
          mappedAtStart: true,
          running: 'api (root)',
        },
        {
          folder: 'F:\\Code\\scratch',
          here: false,
          known: true,
          root: null,
          excluded: true,
          mappedAtStart: false,
          running: null,
        },
      ],
    });
    const projMenu = menuView(projectsSample, { category: 'projects', refresh: false });
    t.check(
      ['@add-root', 'root:C:\\Projects', 'project:C:\\Projects\\api', 'project:F:\\Code\\scratch'].every((v) =>
        projMenu.items.some((i) => i.value === v),
      ) &&
        projMenu.actions.map((a) => a.key).join() === 'a,f,f' &&
        projMenu.actions
          .filter((a) => a.key === 'f')
          .map((a) => a.label)
          .join() === 'remove root,forget project' &&
        projMenu.enterLabel(undefined, '@add-root') === 'choose folder' &&
        projMenu.resolve({ kind: 'action', key: 'a', value: undefined })?.kind === 'action',
      'projects in the menu: the row values (@add-root, root:, project:) and the keys a, f (root), f (project)',
      projMenu.actions.map((a) => a.key + ':' + a.label).join(' '),
    );
    const projLines = pageLines(projectsSample);
    t.check(
      projLines.some((l) => /^All projects\s+off$/.test(l)) &&
        projLines.some((l) => /FOLDER\s+AT START\s+RUNNING SANDBOX/.test(l)) &&
        projLines.includes('* = this folder.  Choose with: sandbox projects choose'),
      'projects list on the command line: the facts, the table and its note',
      projLines.join('\n'),
    );
    const rootFieldDef = fieldsOf(projectRoots.input).find((f) => f.name === 'rootFolder');
    const folderFieldDef = fieldsOf(addProject.input).find((f) => f.name === 'projectFolder');
    t.check(
      rootFieldDef?.kind === 'path' &&
        rootFieldDef.pathKind === 'dir' &&
        folderFieldDef?.kind === 'path' &&
        folderFieldDef.pathKind === 'dir',
      'the folder fields of projects are folder pickers',
    );
    const commandChoices = commandSpec('projects')?.args[0]?.choices ?? [];
    t.check(
      ['list', 'choose', 'add', 'remove', 'include', 'exclude', 'all', 'roots'].every((a) =>
        commandChoices.includes(a),
      ) &&
        definitionFor('projects', ['roots'])?.id === 'projects.roots' &&
        definitionFor('projects', []) === undefined,
      'the commands keep their names: projects takes the eight actions; roots is its own definition',
    );

    t.section('data, run against temp folders');
    const stored = showData.output.parse({
      dataPath: 'C:\\AgentData',
      storageRoot: 'C:\\ProgramData\\AgentSandbox',
      totalBytes: 6.5e9,
      total: '6.5 GB',
      storageShare: '<- sandbox storage (6.5 GB of it)',
      areaTotals: { tools: '4.6 GB', state: '1.8 GB', host: '4.0 KB' },
      entries: [
        {
          area: 'tools',
          name: 'rust',
          path: 'C:\\AgentData\\tools\\rust',
          bytes: 4.6e9,
          size: '4.6 GB',
          target: 'tools/rust',
        },
        {
          area: 'state',
          name: 'state/claude',
          path: 'C:\\AgentData\\state\\claude',
          bytes: 1.8e9,
          size: '1.8 GB',
          target: 'state/claude',
        },
        {
          area: 'host',
          name: 'accounts',
          path: 'C:\\Users\\me\\AppData\\Local\\AgentSandbox\\accounts',
          bytes: 4096,
          size: '4.0 KB',
          target: null,
        },
      ],
      disks: [
        {
          drive: 'C:\\',
          totalBytes: 40e9,
          freeBytes: 22e9,
          usedBytes: 18e9,
          holdsStorage: true,
          used: '18 GB',
          usedPercent: 45,
          free: '22 GB',
          total: '40 GB',
        },
      ],
    });
    const dataSample = dataPage(stored);
    const dataSectionIds = dataSample.sections.map((s) => s.id);
    const dataOps = pageActions(dataSample);
    const keptSection = dataSample.sections.find((s) => s.id === 'kept');
    const keptItems = keptSection?.items ?? [];
    const accountsItem = keptItems.find((i) => i.label === 'accounts');
    t.check(
      dataSectionIds.join() === 'disks,kept' &&
        keptItems.map((i) => i.label).join() === 'rust,state/claude,accounts' &&
        keptSection?.summary === '6.5 GB in all' &&
        keptItems[0]?.primary?.kind === 'operation' &&
        keptItems[0].primary.op === 'data.clean' &&
        JSON.stringify(keptItems[0].primary.input) === '{"targets":["tools/rust"]}' &&
        accountsItem?.primary === undefined &&
        (keptSection?.actions ?? []).some((a) => a.kind === 'operation' && a.op === 'data.prune') &&
        dataOps.some((a) => a.kind === 'operation' && a.op === 'data.clean'),
      'data: disks, then one table of every kept folder (total in the summary); delete only where it may be deleted',
      dataSectionIds.join(),
    );
    const shaped = showData.cli!.shapeJson!(stored) as Record<string, unknown>;
    const shapedEntries = shaped.entries as Record<string, unknown>[];
    const shapedDisks = shaped.disks as Record<string, unknown>[];
    t.check(
      Object.keys(shaped).join() === 'dataPath,storageRoot,totalBytes,entries,disks' &&
        Object.keys(shapedEntries[0]).join() === 'area,name,path,bytes' &&
        Object.keys(shapedDisks[0]).join() === 'drive,totalBytes,freeBytes,usedBytes,holdsStorage',
      'data show --json keeps its old shape',
    );
    const dataLines = pageLines(dataSample);
    t.check(
      dataLines.some((l) => l.startsWith('Disks')) &&
        dataLines.some((l) => /^DRIVE\s+USED\s+FREE\s+SIZE/.test(l)) &&
        dataLines.some((l) => l.startsWith('What the sandbox keeps  6.5 GB in all')) &&
        dataLines.some((l) => /^KIND\s+NAME\s+SIZE\s+FOLDER/.test(l)) &&
        dataLines.some((l) => /^Toolchains\s+rust\s+4\.6 GB\s+C:\\AgentData\\tools\\rust/.test(l)) &&
        dataLines.some((l) => l.startsWith('Kept on this PC on purpose, not deleted here: accounts.')) &&
        dataLines.some((l) => l.startsWith('Persistent data for the sandbox: ')) &&
        dataLines.some((l) => l.startsWith('Free space with:')),
      'data on the command line: the disks table, the data folder line and the free space line',
      dataLines.join('\n'),
    );
    t.check(
      definitionFor('data', ['clean'])?.id === 'data.clean' &&
        definitionFor('data', ['show'])?.id === 'data.show' &&
        JSON.stringify(cliInput(definitionFor('data', ['clean'])!, parseCli(['data', 'clean', 'tools/go', 'logs']))) ===
          '{"targets":["tools/go","logs"]}' &&
        JSON.stringify(cliInput(cleanData, parseCli(['data', 'remove', 'logs']))) === '{"targets":["logs"]}' &&
        JSON.stringify(commandSpec('data')?.args[0].choices) === '["show","clean"]',
      'data clean and remove are actions; the targets are the rest of the line',
    );
    t.equal(
      cleanData.next?.({ message: 'x', freedBytes: 5 }),
      'sandbox data   (see what is left)',
      'data clean suggests what is left once something was freed',
    );
    const cleanOptions = commandSpec('clean')?.options ?? [];
    t.check(
      cleanOptions.map((o) => [o.flag, o.short ?? '', o.type, o.description]).join('|') ===
        '--days,,number,launch folders older than this many days|--yes,-y,boolean,do not ask before deleting' &&
        (cleanOptions.find((o) => o.flag === '--days') as { default?: unknown } | undefined)?.default === 7,
      'clean keeps --days <n> (7) and --yes',
    );

    const dataRoot = t.dir('app-data', 'data');
    const storageRoot = t.dir('app-data', 'storage');
    const logsFolder = t.dir('app-data', 'data', 'logs');
    t.write(path.join(logsFolder, 'old.log'), 'x'.repeat(100));
    const dataCtx = { dataPath: dataRoot, storageRoot } as unknown as AppContext;
    if (isSandboxRunning())
      await t.throws(
        () => runDefinition('data.clean', dataCtx, { targets: ['logs'] }, fakeIO([]).io),
        'A Windows Sandbox is running',
        'data clean refuses while a sandbox runs',
      );
    else {
      await t.throws(
        () => runDefinition('data.clean', dataCtx, { targets: ['logs'] }, fakeIO([false]).io),
        'Nothing removed.',
        'data clean: a no changes nothing',
      );
      t.check(fs.existsSync(path.join(logsFolder, 'old.log')), 'the logs are still there after a no');
      const gone = (await runDefinition('data.clean', dataCtx, { targets: ['logs'] }, fakeIO([true]).io)) as {
        message: string;
      };
      t.check(
        gone.message.startsWith('Removed logs and freed') && !fs.existsSync(logsFolder),
        'data clean: yes removes the logs',
        gone.message,
      );
    }
    const emptyCtx = {
      storageRoot: t.dir('app-data', 'empty-storage'),
      dataPath: t.dir('app-data', 'empty-data'),
    } as unknown as AppContext;
    t.equal(
      await runDefinition('data.prune', emptyCtx, {}, fakeIO([]).io),
      { message: 'Nothing to clean.', removed: false },
      'clean on an empty storage folder says so',
    );
    if (process.stdin.isTTY) t.skip('a question without a terminal (this run has a terminal)');
    else
      await t.throws(
        () =>
          cliIO(parseCli(['data'])).io.checklist({
            title: 'x',
            choices: [],
            noTerminal: { message: 'Which data should be cleaned?', fix: 'f' },
          }),
        'Which data should be cleaned?',
        'a question without a terminal fails with its own words',
      );
    t.section("the kernel's text blocks, view parameters and sizes");
    const textPage: Page = { title: 'Text', sections: [{ id: 'log', text: ['a', 'b'] }] };
    t.equal(pageLines(textPage), ['a', 'b'], 'a text block is shown as its lines, in order, on the command line');
    t.check(pageHasContent(textPage), 'a page whose only section is a text block has content');
    t.check(
      bytesText(1536) === '1.5 KB' && bytesText(0) === '0 B' && bytesText(5 * 1024 ** 3) === '5.0 GB',
      'bytesText says sizes the way humanBytes does',
      [bytesText(1536), bytesText(0), bytesText(5 * 1024 ** 3)].join(' | '),
    );

    t.section('updates: flags, input, the page');
    const flagsOf = (name: string): string =>
      JSON.stringify(commandSpec(name)?.options.map((o) => [o.flag, o.short ?? '', o.description]));
    t.check(
      flagsOf('update') ===
        JSON.stringify([
          ['--check', '', 'only look whether a newer version exists'],
          ['--rollback', '', 'go back to the version before the last update'],
          ['--auto', '', 'install new versions by themselves (for everyone on this PC: needs an admin terminal)'],
          ['--unattended', '', 'used by automatic updates: no questions, short output'],
          ['--feed', '', 'take the release from this folder (a feed.json and the package) instead of GitHub'],
          ['--yes', '-y', '(--rollback) do not ask first'],
        ]) &&
        flagsOf('migrate') ===
          JSON.stringify([
            ['--dry-run', '', 'only list what would change'],
            ['--restore', '', 'put back the files saved before an update (a folder under <storage>\\backups)'],
            ['--yes', '-y', '(--restore) do not ask first'],
          ]),
      'update and migrate keep their flags and help (--yes moved last)',
    );
    t.equal(
      cliInput(definitionFor('update', [])!, parseCli(['update', '--auto', 'on'])),
      { auto: 'on' },
      'update --auto on reaches the input',
    );
    t.check(parseCli(['resume', '--auto']).auto === true, 'resume --auto is still a switch');
    const brokenCfg = t.write(t.at('app-updates', 'config.json'), 'broken');
    const updOptions = { ...parseCli(['update']), config: brokenCfg };
    const updCtx = contextOrDefaults(t.dir('app-updates', 'package'), 'sandbox', updOptions);
    t.check(
      JSON.stringify(updCtx.loaded.config) === JSON.stringify(DEFAULTS),
      'update runs with a broken settings file (the built-in defaults)',
    );
    await t.throws(
      () =>
        runDefinition(
          'updates.update',
          { ...updCtx, options: { ...updCtx.options, feed: undefined } } as unknown as AppContext,
          { feed: 'C:\\x' },
          fakeIO().io,
        ),
      'works only on the command line.',
      '--feed from the web is refused before anything is installed',
    );
    const updPage = (status: UpdatesStatus, latest: string | null): Page => updatesPage(status, latest);
    const managed: UpdatesStatus = {
      managed: true,
      version: '1.4.3',
      scope: 'user',
      autoUpdate: true,
      autoOffText: null,
      previous: '1.4.2',
      failed: null,
      npmCommand: NPM_COMMAND,
      error: null,
      settings: { pending: ['2026-10-x: change'], error: null },
    };
    const onPage = updPage(managed, '1.5.0');
    const updIds = onPage.sections.flatMap((s) => (s.items ?? []).map((i) => i.id));
    const keys = menuView(onPage, { category: 'updates', refresh: false }).actions.map((a) => a.key);
    t.check(
      ['updates:version', 'updates:latest', 'updates:auto', 'updates:previous'].every((id) => updIds.includes(id)) &&
        keys.join() === 'c,u,a,r,s',
      'the updates page has its rows, and the keys c u a r s (with a pending migration)',
      keys.join(),
    );
    const npmPage = updPage(
      { ...managed, managed: false, previous: null, settings: { pending: [], error: null } },
      null,
    );
    t.check(
      menuView(npmPage, { category: 'updates', refresh: false }).actions.length === 0 &&
        npmPage.sections[0].items?.some((i) => i.id === 'updates:npm') === true,
      'an npm install shows how to update and offers no keys',
    );
    // The menu hands what an operation returned to its page once (the page keeps what a check found). A folder with no
    // install in it is not managed, so this checks nothing on this PC.
    const npmCtx = {
      packageRoot: t.dir('app-updates', 'npm-package'),
      options: {},
      loaded: { config: structuredClone(DEFAULTS), configPath: null, base: t.temp },
      storageRoot: t.dir('app-updates', 'storage'),
      dataPath: t.dir('app-updates', 'data'),
    } as unknown as AppContext;
    const handed: unknown[] = [];
    const menuSaid = await new MenuOperations({} as never, npmCtx).run(
      runUpdate,
      { check: false, rollback: false, unattended: false },
      [],
      undefined,
      (o) => handed.push(o),
    );
    t.check(
      handed.length === 1 &&
        (handed[0] as { latest: unknown }).latest === null &&
        (menuSaid ?? '').includes('npm install -g windows-development-sandbox'),
      'the menu hands an operation its output once, and shows its line',
    );

    t.section('logs, run against temp folders');
    const logsCfg = t.write(t.at('app-logs', 'config.json'), '{}\n');
    const logsCtx = {
      loaded: { config: structuredClone(DEFAULTS), configPath: logsCfg, base: t.temp },
      options: { workspace: t.dir('app-logs', 'here') },
      storageRoot: t.dir('app-logs', 'storage'),
      packageRoot: t.dir('app-logs', 'package'),
      dataPath: t.dir('app-logs', 'data'),
    } as unknown as AppContext;
    const logsDir = t.dir('app-logs', 'data', 'logs');
    const guestLog = t.write(
      path.join(logsDir, 'guest-a.log'),
      Array.from({ length: 300 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n',
    );
    const daemonLog = t.write(path.join(logsDir, 'daemon-b.log'), 'd\n');
    t.write(path.join(logsDir, 'notes.txt'), 'not a log\n');
    t.touch(guestLog, -60);
    t.touch(daemonLog);
    const logList = await readQuery(listLogs, logsCtx);
    t.check(
      logList.files.map((f) => f.name).join() === 'daemon-b.log,guest-a.log' &&
        logList.folder === logsDir &&
        !logList.crash,
      'logs.list lists only the log files, newest first, and says there is no crash report yet',
      logList.files.map((f) => f.name).join(),
    );
    const endOfLog = await readQuery(tailLog, logsCtx, { name: 'guest-a.log' });
    t.check(
      endOfLog.name === 'guest-a.log' &&
        endOfLog.file === guestLog &&
        endOfLog.text.startsWith('line 182\n') &&
        endOfLog.text.endsWith('line 300\n') &&
        endOfLog.text.split('\n').length === 120,
      'logs.tail shows the end of the log as the command always printed it (the last 120 pieces: 119 lines and the newline)',
      endOfLog.text.slice(0, 40),
    );
    fs.appendFileSync(guestLog, 'appended\n');
    const more = await readQuery(tailLog, logsCtx, { name: 'guest-a.log', from: endOfLog.next });
    t.equal(more.text, 'appended\n', 'logs.tail read on from next gives only the new text');
    await t.throws(
      () => readQuery(tailLog, logsCtx, { name: '..\\config.json' }),
      'There is no log called',
      'a log name from outside cannot become a path of its own (..\\config.json)',
    );
    await t.throws(
      () => readQuery(tailLog, logsCtx, { name: 'C:\\Windows\\win.ini' }),
      'There is no log called',
      'a log name from outside cannot become a path of its own (a drive path)',
    );
    await t.throws(
      () => readQuery(tailLog, logsCtx, { name: CRASH }),
      'No crash report yet',
      'the reserved crash name with no report fails with the words the command line always printed',
    );
    const noLogsCtx = { ...logsCtx, dataPath: t.dir('app-logs', 'empty') } as unknown as AppContext;
    const nothing = await readQuery(tailLog, noLogsCtx, {});
    t.check(
      nothing.file === '' && nothing.text === '' && (await readQuery(listLogs, noLogsCtx)).files.length === 0,
      'with no logs yet the tail is empty (the page says so; the command line fails with its words)',
    );
    const crashFile = t.write(
      path.join(logsCtx.storageRoot, 'logs', 'crashes', 'crash-20261014-101500.txt'),
      'Crash.\n',
    );
    const withCrash = await readQuery(listLogs, logsCtx);
    const crashTail = await readQuery(tailLog, logsCtx, { name: CRASH });
    t.check(
      withCrash.crash && crashTail.file === crashFile && crashTail.text === 'Crash.\n' && crashTail.next === 0,
      'logs.tail with the reserved name reads the last crash report, whole',
      crashTail.file,
    );
    const logsPageNow = logsPage(withCrash, endOfLog);
    const itemIds = logsPageNow.sections[0].items?.map((i) => i.id) ?? [];
    t.check(
      itemIds.join() === 'log:daemon-b.log,log:guest-a.log,log:' + CRASH &&
        logsPageNow.sections[0].items?.find((i) => i.id === 'log:guest-a.log')?.badges?.[0]?.text === 'showing' &&
        logsPageNow.sections[0].items?.find((i) => i.id === 'log:daemon-b.log')?.badges === undefined &&
        logsPageNow.sections[1]?.text?.length === 119,
      'the logs page: one row per log, the shown one badged, the crash report last, the end of the log as text',
      itemIds.join(),
    );
    const logsMenuNow = menuView(logsPage(withCrash), { category: 'logs', refresh: false });
    t.check(
      logsMenuNow.actions.map((a) => a.key).join() === 'f' &&
        logsMenuNow.enterLabel('logs', 'log:guest-a.log') === 'show' &&
        logsMenuNow.resolve({ kind: 'action', key: 'f', value: undefined })?.kind === 'action',
      'the logs menu: the key f (follow in the terminal) and Enter shows',
      logsMenuNow.actions.map((a) => a.key).join(),
    );

    t.section('storage');
    t.check(
      definitionFor('storage', ['contained', 'on'])?.id === 'storage.containedOn' &&
        definitionFor('storage', ['contained', 'status'])?.id === 'storage.containedStatus' &&
        definitionFor('storage', ['move'])?.id === 'storage.move',
      'storage contained on and off are two-word actions, storage move is one word',
    );
    const movedInput = cliInput(
      definitionFor('storage', ['move'])!,
      parseCli(['storage', 'move', 'D:\\x', '--keep-old']),
    );
    t.check(
      JSON.stringify(movedInput) === JSON.stringify({ folder: 'D:\\x', keepOld: true }),
      'storage move reads its folder and --keep-old as its input',
      JSON.stringify(movedInput),
    );
    const storageActions = commandSpec('storage')?.args[0]?.choices;
    t.check(
      Array.isArray(storageActions) && storageActions.join() === 'show,move,use,contained',
      'storage keeps its actions as the first argument choices',
      String(storageActions),
    );
    const shownStorage: StorageShow = {
      root: 'D:\\AgentSandbox',
      exists: true,
      holdsData: true,
      measured: { bytes: 2048, files: 3, partial: false },
      size: '2 KB',
      defaultRoot: 'C:\\ProgramData\\AgentSandbox',
      defaultInUse: false,
      otherFoldersWithData: ['C:\\ProgramData\\AgentSandbox'],
    };
    const shapedStorage = showStorage.cli?.shapeJson?.(shownStorage) as Record<string, unknown>;
    t.check(
      Object.keys(shapedStorage).sort().join() === 'bytes,defaultRoot,exists,files,otherFoldersWithData,partial,root',
      'storage show --json keeps its old shape',
      Object.keys(shapedStorage).join(),
    );
    t.check(
      showStorage.text?.(shownStorage).startsWith('Your saved data is in: D:\\AgentSandbox\n  2 KB\n') === true,
      'storage show prints its lines as before',
    );
    if (insideSandbox())
      await t.throws(
        () =>
          runDefinition(
            'storage.move',
            { storageRoot: 'D:\\x' } as unknown as AppContext,
            { folder: 'D:\\x' },
            fakeIO([]).io,
          ),
        'has nothing to control',
        'storage refuses inside the sandbox',
      );
    else t.skip('storage refuses inside the sandbox (this PC is not a sandbox)');
    const yesIO = cliIO(parseCli(['storage', 'contained', 'off', '--yes'])).io;
    t.check(
      (await yesIO.confirm({ title: 'Delete the image file now?', skipWithYes: true })) === false,
      'with --yes the image file is kept (the question is skipped)',
    );
    const shownContained: ContainedStatus = {
      setting: 'off',
      maxGb: 60,
      available: true,
      reasons: [],
      fixes: [],
      image: 'D:\\AgentSandbox\\contained\\agent.vhdx',
      imageExists: false,
      imageBytes: null,
      mountFolder: 'D:\\AgentSandbox\\mount',
      recordedMounted: false,
      holders: 0,
      mountedNow: null,
    };
    const storagePageNow = storagePage(shownStorage, shownContained);
    const folderSection = storagePageNow.sections[0];
    const folderOps = (folderSection?.actions ?? []).map((a) => (a.kind === 'operation' ? a.op : a.kind));
    const containedActions = storagePageNow.sections[1]?.actions ?? [];
    t.check(
      folderOps.join() === 'storage.move,storage.use' &&
        (folderSection?.facts ?? []).map((f) => f.label).join() ===
          'Folder,Size,Default folder,Other folder with data' &&
        containedActions.length === 1 &&
        containedActions[0].kind === 'operation' &&
        containedActions[0].op === 'storage.containedOn',
      'the storage page: the data folder row changes it, and contained storage offers to turn it on while it is off',
    );
    t.check(
      pageActions(storagePageNow).every(
        (a) => a.kind !== 'operation' || storageView.operations.some((o) => o.id === a.op),
      ),
      'the storage page offers only operations its view declares',
    );

    t.section('engine: the page, the check text, the exit code');
    // Hand-made reports: this suite never runs the real checks (sc, whoami) that a Windows sandbox could not pass.
    const caps = {
      desktop: true,
      gpu: true,
      clipboard: true,
      audio: true,
      video: true,
      printers: true,
      liveFolderAdd: true,
      attachedDisks: false,
      multipleInstances: true,
      hvsocket: false,
    };
    const missingHcs = {
      id: 'hcs' as const,
      inUse: false,
      capabilities: caps,
      check: {
        available: false,
        reasons: ['computecore.dll is missing'],
        fixes: ['Enable-WindowsOptionalFeature -Online -FeatureName Containers -All'],
      },
    };
    const readyHcs = { ...missingHcs, check: { available: true, reasons: [], fixes: [] } };
    const enginesNow = {
      engine: 'windows-sandbox' as const,
      engines: [{ ...missingHcs, id: 'windows-sandbox' as const, inUse: true, check: readyHcs.check }, missingHcs],
    };
    const enginePageNow = enginePage(enginesNow);
    const engineLines = pageLines(enginePageNow);
    t.check(
      engineLines[0] === 'Engine in use: windows-sandbox  (setting: sandbox.engine)' &&
        engineLines.includes('  Fix: Enable-WindowsOptionalFeature -Online -FeatureName Containers -All') &&
        pageActions(enginePageNow).length === 0,
      'engine page: the engine in use first, a card per engine, reasons and fixes, nothing to run',
      engineLines.slice(0, 4).join(' | '),
    );
    const unavailable = checkText({ ...missingHcs });
    t.check(
      unavailable.includes('hcs cannot be used on this PC yet:') &&
        unavailable.includes('  1. computecore.dll is missing') &&
        unavailable.includes('     To fix: Enable-WindowsOptionalFeature') &&
        unavailable.includes('Nothing was changed.'),
      'engine check text: the old words, numbered, with the fixes',
      unavailable,
    );
    t.check(
      checkText(readyHcs).includes('hcs can be used on this PC.') && checkText(readyHcs).includes('HCS is in alpha'),
      'engine check text: an available hcs says it is in alpha',
    );
    t.check(
      checkEngine.cli?.exitCode?.(missingHcs) === 1 && checkEngine.cli?.exitCode?.(readyHcs) === 0,
      'a CLI hint sets the exit code: engine check exits 1 when the engine cannot be used, 0 when it can',
    );
    t.check(
      definitionFor('engine', ['check'])?.id === 'engine.check' &&
        definitionFor('engine', []) === undefined &&
        ['show', 'check', 'leftovers', 'clean'].every((a) => commandSpec('engine')?.args[0]?.choices?.includes(a)),
      'engine, check, leftovers and clean are the actions of the engine command; a bare engine is not an action',
    );
    const left: Leftovers = {
      available: true,
      message: '2 HCS systems of ours left running.',
      systems: [
        { id: 'agent-sandbox-1', kind: 'VirtualMachine', state: 'Running', since: '2026-01-01T10:00:00Z' },
        { id: 'agent-sandbox-1-c', kind: 'Container', state: 'Running', since: null },
      ],
    };
    const leftPage = enginePage(enginesNow, left);
    t.check(
      ops(leftPage).join() === 'engine.clean' &&
        pageActions(leftPage).some((a) => a.kind === 'operation' && a.danger) &&
        pageLines(leftPage).some((l) => l.includes('agent-sandbox-1-c')) &&
        ops(enginePage(enginesNow, { ...left, systems: [] })).length === 0 &&
        menuView(leftPage).actions.some((a) => a.key === 'x') &&
        definitionFor('engine', ['leftovers'])?.id === 'engine.leftovers' &&
        definitionFor('engine', ['clean'])?.id === 'engine.clean',
      'the engine page offers the (dangerous) clean action only when HCS systems of ours are left running',
    );

    t.section('web: CLI and menu only, never runnable from a browser');
    const webDefs = DEFINITIONS.filter((d) => d.id.startsWith('web.'));
    const webCtx = { storageRoot: t.dir('app-web') } as unknown as AppContext;
    const webHost = createRpcHost(webCtx);
    t.check(
      webDefs.length === 4 &&
        webDefs.every((d) => exemption(d, 'web') === 'the page is the web UI') &&
        webDefs.every((d) => webHost.kind(d.id) === undefined),
      'every web definition is exempt from the web with its reason, and the RPC host refuses them all',
      webDefs.map((d) => d.id).join(),
    );
    const webOff = webPage({ running: false, port: null, address: null });
    const webOn = webPage({ running: true, port: 47800, address: 'http://127.0.0.1:47800/' });
    const opsOf = (page: Page): string =>
      pageActions(page)
        .flatMap((a) => (a.kind === 'operation' ? [a.op] : []))
        .join();
    t.check(
      opsOf(webOff) === 'web.start,web.open' && opsOf(webOn) === 'web.open,web.stop',
      'the web page offers start and open when stopped, open and stop when running',
      opsOf(webOff) + ' | ' + opsOf(webOn),
    );
    const webLines = pageLines(webOn);
    t.check(
      webLines.some((l) => l.includes('Address') && l.includes('http://127.0.0.1:47800/')) &&
        !webLines.some((l) => l.includes('#k=')),
      'the web page shows the address without the login token',
      webLines.join(' / '),
    );
    t.check(
      menuView(webOn, { prefix: 'web:', refresh: false })
        .actions.map((a) => a.key)
        .join() === 'o,x',
      'the Web UI category keys: o opens and x stops when running',
    );
    t.check(
      definitionFor('web', ['open'])?.id === 'web.open' &&
        definitionFor('web', ['status'])?.id === 'web.status' &&
        definitionFor('web', []) === undefined &&
        (commandSpec('web')?.args[0]?.choices as readonly string[] | undefined)?.join() === 'start,stop,status,open',
      'the web actions are actions of the web command; sandbox web with no action is not one of them',
    );
  },
};
