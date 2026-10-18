// The shared core: the kernel (definitions checked in and out, Fields from zod, questions and their fake, errors across
// a surface, the RPC messages), parity (every operation and query reachable on the CLI, the menu and the web, or
// exempt with a reason), the reference views' pages, their CLI and menu renderings, and the settings feature run
// against a config file of its own.
import fs from 'node:fs';
import { z } from 'zod';
import { DEFINITIONS, NAV, QUERIES, VIEWS, viewById } from '../app/features/defs.js';
import { engineLeftoversPage, type Leftovers } from '../app/features/engine/index.js';
import { sandboxPage, type SandboxStatus } from '../app/features/sandbox/index.js';
import { sessionsPage, type SessionRow, type SessionsList } from '../app/features/sessions/index.js';
import { settingsPage } from '../app/features/settings/index.js';
import type { AppContext } from '../app/context.js';
import {
  ago,
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
  ServerMessageSchema,
  SURFACE_NAMES,
  toWireError,
  valueText,
  type AnyDefinition,
  type Page,
  type SurfaceName,
  type AnyView,
} from '../app/kernel/index.js';
import { IMPLEMENTATIONS, readQuery, runDefinition } from '../app/registry.js';
import { parseCli } from '../cli/args.js';
import { COMMANDS, commandSpec } from '../cli/manifest.js';
import { menuView } from '../cli/menu/render-view.js';
import { MENU_VIEWS } from '../cli/menu/views.js';
import { cliInput, commandSpecOf, definitionFor } from '../cli/operations/index.js';
import { pageLines } from '../cli/output/index.js';
import { secret } from '../core/schema/index.js';
import { UserError } from '../core/util/index.js';
import type { Suite } from './support/suite.js';

const NOW = Date.now();

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
    views.flatMap((v) => [...v.operations.map((o) => o.id), ...Object.values(v.queries).map((q) => q.id)]),
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
    const webViews = NAV.flatMap((n) => (n.view ? [viewById(n.view)!] : []));
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
        NAV.every((n) => n.view !== undefined || Boolean(n.elsewhere)),
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
    t.check(
      ops(statusPage).join() === 'sandbox.showWindow,sandbox.hideWindow,sandbox.stop' &&
        pageActions(statusPage).some((a) => a.kind === 'operation' && a.op === 'sandbox.stop' && a.danger) &&
        ops(stoppedPage).length === 0 &&
        limited.sections.length === 0 &&
        limited.notice?.text === 'Running, started by bob (not shared)',
      "status: the window and stop (marked dangerous) only while it runs; another user's unshared sandbox shows only whose it is",
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
      statusLines.some((l) => /^Running\s+yes$/.test(l)) &&
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
        menu.actions.map((a) => a.key).join() === 'r,o,l' &&
        menu.enterLabel(undefined, 'new') === 'attach' &&
        chosen?.kind === 'action' &&
        chosen.action.kind === 'link' &&
        menu.resolve({ kind: 'action', key: 'l', value: undefined })?.kind === 'refresh',
      'sessions in the menu: rows, the r/o/l keys, Enter attaches',
    );
    const menuStatus = menuView(statusPage, { category: 'status', prefix: 'status:' });
    t.check(
      menuStatus.items.every((i) => i.category === 'status' && i.value.startsWith('status:')) &&
        menuStatus.actions.some((a) => a.key === 'x' && a.label === 'stop'),
      'a view inside one category of a page: rows in it, prefixed, with the keys of its actions',
    );

    t.section('engine: HCS systems left running');
    const left: Leftovers = {
      available: true,
      message: '2 HCS systems of ours left running.',
      systems: [
        { id: 'agent-sandbox-1', kind: 'VirtualMachine', state: 'Running', since: '2026-01-01T10:00:00Z' },
        { id: 'agent-sandbox-1-c', kind: 'Container', state: 'Running', since: null },
      ],
    };
    const leftPage = engineLeftoversPage(left);
    const leftMenu = menuView(leftPage);
    const nonePage = engineLeftoversPage({
      available: false,
      message: 'The Host Compute Service is not on this PC.',
      systems: [],
    });
    t.check(
      ops(leftPage).join() === 'engine.clean' &&
        pageActions(leftPage).some((a) => a.kind === 'operation' && a.danger) &&
        leftMenu.items.length === 2 &&
        leftMenu.actions.some((a) => a.key === 'x') &&
        pageLines(leftPage).some((l) => l.includes('agent-sandbox-1-c')) &&
        ops(nonePage).length === 0 &&
        pageLines(nonePage).at(-1) === 'The Host Compute Service is not on this PC.',
      'the leftovers page lists each system with the (dangerous) clean action; with none it only says why',
      pageLines(nonePage).join('\n'),
    );
    t.check(
      definitionFor('engine', ['leftovers'])?.id === 'engine.leftovers' &&
        definitionFor('engine', ['clean'])?.id === 'engine.clean' &&
        definitionFor('engine', []) === undefined &&
        MENU_VIEWS.some((m) => m.view.id === 'engine') &&
        NAV.some((n) => n.view === 'engine'),
      'leftovers and clean are actions of `sandbox engine`, shown in the menu (Maintenance) and the web',
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
    t.equal(ago(NOW - 90 * 60000, NOW), '2 h ago', 'times read the same on every surface');
  },
};
