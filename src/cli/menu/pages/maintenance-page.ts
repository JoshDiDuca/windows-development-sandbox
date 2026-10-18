// Section 7: keeping things in shape. Updates (the program and your saved settings), Data & storage (the data folder,
// what is stored, clean-up), Health (doctor, repair and this PC's setup together), the logs, and the less common
// commands. Each is a category on the left and loads when you open it.
import _ from 'lodash';
import type { DiskUsage } from '../../../core/disk.js';
import { humanBytes } from '../../../core/disk.js';
import { userDir } from '../../../core/config/index.js';
import { errMsg, fail } from '../../../core/util/index.js';
import type { Context } from '../../commands/context.js';
import { cleanTargetOf, type DataEntry } from '../../commands/data/collect.js';
import type { RepairResult, RepairStatus } from '../../commands/repair/types.js';
import { commandSpec, type CommandSpec } from '../../manifest.js';
import { ago } from '../../output/index.js';
import {
  DataService,
  HealthService,
  LogsService,
  MigrateService,
  NPM_UPDATE_COMMAND,
  UpdateService,
  type LogFile,
  type SetupReport,
  type UpdateStatus,
} from '../../services/index.js';
import { describeResult } from '../../commands/maintenance/update.js';
import {
  Text,
  Theme,
  type App,
  type ListAction,
  type ListItem,
  type ListOptions,
  type ListResult,
} from '../../tui/index.js';
import { engineLeftovers, engineLeftoversPage, type Leftovers } from '../../../app/features/engine/index.js';
import { readQuery } from '../../../app/registry.js';
import { CommandForm } from '../command-form.js';
import { DataFolderFlow, dataFolderRow } from '../data-folder.js';
import { MenuOperations } from '../io-menu.js';
import { menuView, type MenuView } from '../render-view.js';
import { ListPage, type Outcome } from './list-page.js';

export interface MaintenanceModel {
  /** The data folder row (where the sandbox keeps its data). */
  readonly dataFolder: { label: string; hint: string; description: string };
  /** Null until measured (measuring a big data folder takes a while). */
  readonly data: { entries: DataEntry[]; disks: DiskUsage[]; total: number } | null;
  readonly logs: readonly LogFile[];
  readonly doctor: readonly (readonly string[])[] | null;
  readonly repair: readonly RepairResult[] | null;
  readonly setup: SetupReport | { error: string } | null;
  /** The changes still to make to your saved settings (or why they cannot be read). */
  readonly settings: { readonly pending: readonly string[] } | { readonly error: string };
  /** The program's own updates: what is installed and what an update did. */
  readonly updates: UpdateStatus | { readonly error: string };
  /** A newer version found by "Check now" (null: not looked yet, or none). */
  readonly latest: string | null;
  /** The commands listed under "More commands". */
  readonly more: readonly { name: string; summary: string }[];
  /** HCS systems left running; null until looked at (looking runs Windows tools, so it waits for Enter). */
  readonly engine?: Leftovers | null;
}

const CATEGORIES = [
  {
    id: 'updates',
    label: 'Updates',
    description: 'Which version is installed, installing a newer one, and bringing your saved settings up to date.',
  },
  {
    id: 'data',
    label: 'Data & storage',
    description: 'Where the sandbox keeps its data, what is stored, and deleting parts of it.',
  },
  {
    id: 'health',
    label: 'Health',
    description: 'Checks this PC and your settings, repairs problems, and sets up Windows Sandbox.',
  },
  { id: 'logs', label: 'Logs', description: "The sandbox's own logs." },
  {
    id: 'engine',
    label: 'Engine',
    description: 'HCS systems a crashed command left running (they hold memory), and stopping them.',
  },
  { id: 'more', label: 'More commands', description: 'Less common commands.' },
];

const MORE_COMMANDS = ['sync', 'audit', 'config', 'generate', 'exec', 'agent-commands'];

/** Plain names for the commands under More commands. */
const MORE_LABELS: Readonly<Record<string, string>> = {
  sync: 'Copy history back now',
  audit: 'What happened in the sandbox',
  config: 'Your settings file',
  generate: 'Preview a start',
  exec: 'Run a command in the sandbox',
  'agent-commands': 'Agent commands (Beta)',
};

const REPAIR_LABEL: Record<RepairStatus, [string, (t: string) => string]> = {
  ok: ['OK', Theme.ok],
  fixed: ['FIXED', Theme.accent],
  'needs-you': ['NEEDS YOU', Theme.error],
  warn: ['WARNING', Theme.warn],
  skipped: ['SKIPPED', Theme.muted],
};

const AREA_LABEL: Record<DataEntry['area'], string> = {
  tools: 'Toolchains',
  databases: 'Databases',
  state: 'Agent state',
  logs: 'Logs',
  data: 'Other',
  host: 'On this PC',
};

/** The engine category: the leftovers page's rows (prefixed), or null until they were looked up. */
function engineView(m: MaintenanceModel): MenuView | null {
  return m.engine
    ? menuView(engineLeftoversPage(m.engine), { category: 'engine', prefix: 'engine:', refresh: false })
    : null;
}

function engineItems(m: MaintenanceModel): ListItem<string>[] {
  return (
    engineView(m)?.items ?? [
      {
        value: 'engine:load',
        label: 'Look for HCS systems left running',
        category: 'engine',
        section: 'HCS',
        description: 'Asks Windows which HCS systems of ours are running. It only runs when you ask.',
      },
    ]
  );
}

function dataItems(m: MaintenanceModel): ListItem<string>[] {
  const folder: ListItem<string> = { value: 'data:folder', category: 'data', section: 'Data folder', ...m.dataFolder };
  const clean: ListItem<string> = {
    value: 'data:clean',
    label: 'Clean up…',
    category: 'data',
    section: 'Clean up',
    description: 'Delete caches, old sandboxes and other leftovers (the clean command, with its options).',
  };
  if (!m.data)
    return [
      folder,
      {
        value: 'data:measure',
        label: 'Measure what is stored',
        category: 'data',
        section: 'Stored data',
        description: 'Adds up the size of every folder. A big data folder takes a minute or more.',
      },
      clean,
    ];
  return [
    folder,
    ...m.data.disks.map((d) => ({
      value: 'disk:' + d.drive,
      label: d.drive,
      category: 'data',
      section: 'Disks',
      hint: humanBytes(d.usedBytes) + ' used · ' + humanBytes(d.freeBytes) + ' free of ' + humanBytes(d.totalBytes),
      description: d.holdsStorage ? 'The sandbox keeps its files on this drive.' : undefined,
    })),
    ...m.data.entries.map((e, i) => ({
      value: 'entry:' + i,
      label: e.name,
      category: 'data',
      section: AREA_LABEL[e.area],
      hint: humanBytes(e.bytes),
      description: cleanTargetOf(e) ? 'x deletes it.' : 'Kept on this PC on purpose; it is not deleted here.',
      details: [Theme.muted('Folder  ') + e.path],
    })),
    clean,
  ];
}

function updateItems(m: MaintenanceModel): ListItem<string>[] {
  const row = (
    id: string,
    label: string,
    hint: string,
    description?: string,
    details?: string[],
  ): ListItem<string> => ({
    value: 'updates:' + id,
    label,
    category: 'updates',
    section: 'This program',
    hint,
    description,
    details,
  });
  if ('error' in m.updates) return [row('error', m.updates.error, '')];
  const u = m.updates;
  if (!u.managed)
    return [
      row('version', 'Version', u.version, 'Installed with npm, so npm updates it: ' + NPM_UPDATE_COMMAND),
      row('npm', 'Update', Theme.muted('with npm'), 'Run ' + NPM_UPDATE_COMMAND + ' in a terminal.'),
    ];
  const scope = u.scope === 'machine' ? 'for everyone on this PC' : 'for you';
  const rows = [
    row('version', 'Version', u.version, 'Installed ' + scope + '.'),
    row(
      'latest',
      'Newest version',
      m.latest ? Theme.warn(m.latest) : Theme.muted('not looked yet'),
      m.latest ? 'Enter installs it.' : 'Enter looks on GitHub for a newer version.',
    ),
    row(
      'auto',
      'Automatic updates',
      u.autoUpdate ? Theme.ok('on') : Theme.muted('off'),
      'Enter switches them. ' +
        (u.scope === 'machine'
          ? 'For everyone: needs an admin terminal.'
          : 'A new version installs when no sandbox runs.'),
    ),
  ];
  if (u.autoOffText)
    rows.push(row('autooff', 'Automatic updates turned off', Theme.warn('off'), u.autoOffText, [u.autoOffText]));
  if (u.state.previous) rows.push(row('previous', 'Previous version', u.state.previous, 'Enter goes back to it.'));
  if (u.state.failed)
    rows.push(
      row('failed', 'Last failed update', Theme.error(u.state.failed.version), u.state.failed.reason, [
        u.state.failed.reason,
        'It is not tried again until a newer version is released.',
      ]),
    );
  return rows;
}

/** The list for the maintenance tab. Pure. */
export function maintenanceOptions(m: MaintenanceModel): ListOptions<string> {
  const logs: ListItem<string>[] = m.logs.map((f) => ({
    value: 'log:' + f.name,
    label: f.name,
    category: 'logs',
    hint: humanBytes(f.bytes) + '  ' + ago(f.modified),
    description: 'Enter shows the end of this log in the terminal.',
  }));
  // The checks take seconds (programs are run), so they are not made while you move through the categories.
  const check: ListItem<string>[] =
    m.doctor === null && m.setup === null
      ? [
          {
            value: 'health:check',
            label: 'Check this PC',
            category: 'health',
            section: 'Doctor',
            description:
              'Looks at this PC: Windows features, the install, the folders and the sandbox. It takes a few seconds, so it only runs when you ask.',
          },
        ]
      : [];
  const doctor: ListItem<string>[] = (m.doctor ?? []).map(([name, detail], i) => ({
    value: 'doctor:' + i,
    label: name,
    category: 'health',
    section: 'Doctor',
    hint: Text.truncate(detail, 50),
    details: [detail],
  }));
  const repair: ListItem<string>[] = m.repair
    ? m.repair.map((r, i) => {
        const [text, paint] = REPAIR_LABEL[r.status];
        return {
          value: 'repair:' + i,
          label: r.name,
          category: 'health',
          section: 'Repair',
          hint: paint(text),
          description: r.detail,
        };
      })
    : [
        {
          value: 'repair:run',
          label: 'Run the checks and fix what can be fixed',
          category: 'health',
          section: 'Repair',
          description:
            'Checks the install, data folder, settings and sandbox, lists what it would change, and asks before it fixes anything.',
        },
      ];
  const setup: ListItem<string>[] =
    m.setup === null
      ? []
      : 'error' in m.setup
        ? [{ value: 'setup:error', label: m.setup.error, category: 'health', section: 'Set up this PC' }]
        : m.setup.checks.map((c, i) => ({
            value: 'setup:' + i,
            label: c.name,
            category: 'health',
            section: 'Set up this PC',
            hint:
              c.status === 'ok'
                ? Theme.ok('OK')
                : c.status === 'warn'
                  ? Theme.warn('WARNING')
                  : Theme.error('ACTION NEEDED'),
            description: c.detail,
          }));
  const settings: ListItem<string>[] =
    'error' in m.settings
      ? [{ value: 'settings:error', label: m.settings.error, category: 'updates', section: 'Saved settings' }]
      : m.settings.pending.length
        ? m.settings.pending.map((line, i) => ({
            value: 'settings:' + i,
            label: line.split(':')[0],
            category: 'updates',
            section: 'Saved settings',
            hint: Theme.warn('to update'),
            description: 'Enter updates your saved settings (a backup is kept first).',
            details: [line],
          }))
        : [
            {
              value: 'settings:none',
              label: 'Up to date',
              category: 'updates',
              section: 'Saved settings',
              hint: Theme.ok('OK'),
              description: 'Nothing to update.',
            },
          ];
  const updates = updateItems(m);
  const more: ListItem<string>[] = m.more.map((c) => ({
    value: 'more:' + c.name,
    label: MORE_LABELS[c.name] ?? Text.humanize(c.name),
    category: 'more',
    description: c.summary.replace(/^./, (x) => x.toUpperCase()) + '.',
  }));
  return {
    path: [],
    categories: CATEGORIES,
    items: [
      ...updates,
      ...settings,
      ...dataItems(m),
      ...check,
      ...doctor,
      ...repair,
      ...setup,
      ...logs,
      ...engineItems(m),
      ...more,
    ],
    empty: 'Nothing here yet.',
    actions: maintenanceActions(m),
    enterLabel: (_category, id) => enterLabel(id ?? '', m),
  };
}

/** What Enter does on a row ("" = the row only shows information). */
function enterLabel(id: string, m: MaintenanceModel): string {
  if (id === 'data:folder') return 'change';
  if (id === 'data:measure') return 'measure';
  if (id === 'data:clean') return 'choose what';
  if (id === 'repair:run') return 'check and fix';
  if (id === 'health:check') return 'check';
  if (id === 'engine:load') return 'look';
  if (id.startsWith('engine:')) return engineView(m)?.enterLabel('engine', id) ?? '';
  if (id === 'updates:latest') return m.latest ? 'install' : 'look';
  if (id === 'updates:auto') return 'switch';
  if (id === 'updates:previous') return 'go back';
  if (id.startsWith('settings:') && id !== 'settings:none' && id !== 'settings:error') return 'update';
  if (id.startsWith('log:')) return 'show';
  if (id.startsWith('more:')) return 'open';
  return '';
}

function maintenanceActions(m: MaintenanceModel): (category: string | undefined) => ListAction<string>[] {
  return (category) => {
    switch (category) {
      case 'data': {
        const deletable = new Set((m.data?.entries ?? []).flatMap((e, i) => (cleanTargetOf(e) ? ['entry:' + i] : [])));
        return [
          { key: 'm', label: 'measure again' },
          { key: 'x', label: 'delete', applies: (id) => deletable.has(id) },
        ];
      }
      case 'logs':
        return [{ key: 'f', label: 'follow in the terminal' }];
      case 'engine':
        return [{ key: 'l', label: m.engine ? 'look again' : 'look' }, ...(engineView(m)?.actions ?? [])];
      case 'health': {
        const canEnable = m.setup !== null && !('error' in m.setup) && m.setup.canEnable;
        return [
          { key: 'f', label: 'check and fix' },
          { key: 'l', label: m.doctor ? 'check again' : 'check' },
          ...(canEnable ? [{ key: 'e', label: 'turn on Windows Sandbox' }] : []),
        ];
      }
      case 'updates': {
        const managed = !('error' in m.updates) && m.updates.managed;
        const previous = !('error' in m.updates) && Boolean(m.updates.state.previous);
        return [
          ...(managed
            ? [
                { key: 'c', label: 'check now' },
                { key: 'u', label: 'update now' },
                { key: 'a', label: 'automatic on/off', applies: (id: string) => id === 'updates:auto' },
                ...(previous
                  ? [{ key: 'r', label: 'roll back', applies: (id: string) => id === 'updates:previous' }]
                  : []),
              ]
            : []),
          ...('pending' in m.settings && m.settings.pending.length
            ? [
                {
                  key: 's',
                  label: 'update saved settings',
                  applies: (id: string) => id.startsWith('settings:') && id !== 'settings:none',
                },
              ]
            : []),
        ];
      }
      default:
        return [];
    }
  };
}

export class MaintenancePage extends ListPage<string> {
  readonly label = 'Maintenance';
  private data: MaintenanceModel['data'] = null;
  private logs: LogFile[] = [];
  private doctorRows: string[][] | null = null;
  private repairRows: RepairResult[] | null = null;
  private setupReport: MaintenanceModel['setup'] = null;
  private settings: MaintenanceModel['settings'] = { pending: [] };
  private readonly migrate: MigrateService;
  private readonly health: HealthService;
  private readonly dataService: DataService;
  private readonly updateService: UpdateService;
  private latest: string | null = null;
  private engine: Leftovers | null = null;
  private readonly operations: MenuOperations;

  constructor(
    app: App,
    private readonly ctx: Context,
  ) {
    super(app);
    this.operations = new MenuOperations(app, ctx);
    this.updateService = UpdateService.forPackage(ctx.packageRoot, undefined, { userDir: userDir() });
    this.health = new HealthService(ctx);
    this.migrate = new MigrateService({
      storageRoot: ctx.storageRoot,
      userDir: userDir(),
      configPath: ctx.loaded.configPath,
    });
    this.dataService = new DataService(ctx);
  }

  private model(): MaintenanceModel {
    return {
      dataFolder: dataFolderRow(this.ctx),
      data: this.data,
      logs: this.logs,
      doctor: this.doctorRows,
      repair: this.repairRows,
      setup: this.setupReport,
      settings: this.settings,
      updates: this.updateStatus(),
      latest: this.latest,
      engine: this.engine,
      more: MORE_COMMANDS.flatMap((name) => {
        const spec = commandSpec(name);
        return spec ? [{ name, summary: spec.summary }] : [];
      }),
    };
  }

  protected load(): Promise<void> {
    try {
      this.logs = new LogsService(this.ctx).files();
    } catch {
      this.logs = [];
    }
    this.readSettings();
    return Promise.resolve();
  }

  protected options(): ListOptions<string> {
    return maintenanceOptions(this.model());
  }

  private readSettings(): void {
    try {
      this.settings = { pending: this.migrate.plan() };
    } catch (e) {
      this.settings = { error: errMsg(e) };
    }
  }

  private updateStatus(): MaintenanceModel['updates'] {
    try {
      return this.updateService.status();
    } catch (e) {
      return { error: errMsg(e) };
    }
  }

  /** The Updates category: look, install, go back, switch automatic updates. */
  private async updates(key: string | undefined): Promise<Outcome<string>> {
    const service = this.updateService;
    if (!service.managed)
      return { notice: Theme.muted('Installed with npm: update it with ' + NPM_UPDATE_COMMAND + '.') };
    if (key === 'a') {
      const on = !service.status().autoUpdate;
      this.busy(on ? 'Turning automatic updates on…' : 'Turning automatic updates off…');
      service.setAuto(on);
      return { notice: Theme.ok(Theme.glyph.ok + ' Automatic updates are ' + (on ? 'on.' : 'off.')) };
    }
    if (key === 'r') {
      const target = service.status().state.previous;
      if (!target) return { notice: Theme.muted('There is no earlier version to go back to.') };
      if (
        !(await this.app.ask(
          'Go back to version ' + target + '?',
          ['Takes effect the next time you start it.'],
          'Go back',
        ))
      )
        return {};
      return { notice: Theme.ok(Theme.glyph.ok + ' Went back to version ' + service.rollback() + '.') };
    }
    if (key === 'c') {
      this.busy('Looking for a newer version…');
      const found = await service.check();
      this.latest = found.available && found.latest ? found.latest.version : null;
      return {
        notice: this.latest
          ? Theme.warn('Version ' + this.latest + ' is available.')
          : Theme.ok(Theme.glyph.ok + ' You have the newest version.'),
      };
    }
    if (key !== 'u') return {};
    this.busy('Installing the newest version…');
    const done = describeResult(await service.run(), false);
    this.latest = null;
    return {
      notice:
        done.code === 0 ? Theme.ok(Theme.glyph.ok + ' ' + done.line) : Theme.error(Theme.glyph.cross + ' ' + done.line),
    };
  }

  private async updateSettings(): Promise<Outcome<string>> {
    if (!('pending' in this.settings) || !this.settings.pending.length)
      return { notice: Theme.muted('Your saved settings are up to date.') };
    this.busy('Updating your saved settings…');
    const notes: string[] = [];
    const result = await this.migrate.run((line) => notes.push(line));
    this.readSettings();
    return {
      notice: result.postponed.length
        ? Theme.warn('Waiting until no sandbox runs: ' + result.postponed.join(', ') + '.')
        : Theme.ok(Theme.glyph.ok + ' Saved settings updated.'),
    };
  }

  private async loadDoctor(): Promise<void> {
    this.busy('Checking this PC…');
    try {
      this.doctorRows = this.health.doctor();
    } catch (e) {
      this.doctorRows = [['Doctor', errMsg(e)]];
    }
  }

  private loadSetup(): Promise<void> {
    this.busy('Looking at this PC…');
    try {
      this.health.assertWindows();
      this.setupReport = this.health.setupReport();
    } catch (e) {
      this.setupReport = { error: errMsg(e) };
    }
    return Promise.resolve();
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    const id = result.kind === 'pick' || result.kind === 'action' ? result.value : undefined;
    const key = result.kind === 'action' ? result.key : undefined;
    try {
      if (key === 'm' || id === 'data:measure') return this.measure();
      if (id === 'data:folder' && result.kind === 'pick') {
        const exit = await new DataFolderFlow(this.app, this.ctx).run();
        return exit ? { exit } : { reload: true };
      }
      if (id === 'data:clean' && result.kind === 'pick') {
        const argv = await new CommandForm(this.app, this.ctx, commandSpec('clean') as CommandSpec).run();
        return argv ? { exit: { kind: 'run', argv } } : {};
      }
      if (key === 'x') return await this.remove(id);
      if (key === 'f' && this.category === 'logs') return { exit: { kind: 'run', argv: ['logs', '--follow'] } };
      if (id?.startsWith('log:') && result.kind === 'pick') {
        const file = this.logs.find((l) => l.name === id.slice(4));
        return file ? { exit: { kind: 'view', file: file.path } } : {};
      }
      if ((result.kind === 'pick' && id?.startsWith('settings:')) || (key === 's' && this.category === 'updates'))
        return await this.updateSettings();
      if (this.category === 'updates') return await this.updates(key ?? this.updateKey(id));
      if (this.category === 'health') {
        if (key === 'f' || id === 'repair:run') return this.repair();
        if (key === 'l' || id === 'health:check') {
          await this.loadDoctor();
          await this.loadSetup();
          return {};
        }
        if (key === 'e') return await this.enable();
      }
      if (this.category === 'engine') return await this.engineAct(result);
      if (id?.startsWith('more:') && result.kind === 'pick') {
        const spec = commandSpec(id.slice(5)) as CommandSpec;
        const argv = await new CommandForm(this.app, this.ctx, spec).run();
        return argv ? { exit: { kind: 'run', argv } } : {};
      }
    } catch (e) {
      return { notice: Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) };
    }
    return {};
  }

  /** The Engine category: look (Enter on the first row, or l), and stop what was found (x, a shared-core operation). */
  private async engineAct(result: ListResult<string>): Promise<Outcome<string>> {
    const id = result.kind === 'pick' || result.kind === 'action' ? result.value : undefined;
    const look = async (): Promise<void> => {
      this.busy('Looking for HCS systems…');
      this.engine = await readQuery(engineLeftovers, this.ctx);
    };
    if ((result.kind === 'action' && result.key === 'l') || id === 'engine:load') {
      await look();
      return {};
    }
    const chosen = this.engine ? engineView(this.model())?.resolve(result) : undefined;
    if (chosen?.kind !== 'action') return {};
    const done = await this.operations.perform(chosen.action, [this.label], (text) => this.busy(text, id));
    await look();
    return { notice: done.notice };
  }

  /** The key an Enter on an Updates row stands for. */
  private updateKey(id: string | undefined): string | undefined {
    if (id === 'updates:latest') return this.latest ? 'u' : 'c';
    if (id === 'updates:auto') return 'a';
    if (id === 'updates:previous') return 'r';
    return undefined;
  }

  private measure(): Outcome<string> {
    this.busy('Measuring what is stored… this can take a minute or more');
    const report = this.dataService.report();
    this.data = { entries: report.entries, disks: report.disks, total: report.totalBytes };
    return { notice: Theme.ok(Theme.glyph.ok + ' Total stored: ' + humanBytes(report.totalBytes) + '.') };
  }

  private async remove(id: string | undefined): Promise<Outcome<string>> {
    const entry = id?.startsWith('entry:') ? this.data?.entries[Number(id.slice(6))] : undefined;
    if (!entry || !this.data) return {};
    const target =
      cleanTargetOf(entry) ?? fail('"' + entry.name + '" is kept on this PC on purpose.', 'It is not deleted here.');
    const plan = this.dataService.plan([target]);
    if (!plan.present.length) return { notice: Theme.muted(target + ' does not exist.') };
    const ok = await this.app.ask(
      'Delete ' + target + '?',
      [
        humanBytes(plan.totalBytes) + ' in ' + entry.path + '.',
        ...plan.present.flatMap((t) => (t.warning ? [t.target + ' ' + t.warning + '.'] : [])),
        'This cannot be undone.',
      ],
      'Delete',
      true,
    );
    if (!ok) return {};
    const outcome = this.dataService.clean(plan);
    if (outcome.failed.length)
      return { notice: Theme.error(Theme.glyph.cross + ' Could not remove everything: ' + outcome.failed.join('; ')) };
    const gone = this.data.entries.filter((e) => e !== entry);
    this.data = { ...this.data, entries: gone, total: _.sumBy(gone, 'bytes') };
    return { notice: Theme.ok(Theme.glyph.ok + ' Freed ' + humanBytes(outcome.freedBytes) + '.') };
  }

  /** Repair shows what it does as it goes and asks before it changes anything, so it runs on the normal screen. */
  private repair(): Outcome<string> {
    return { exit: { kind: 'run', argv: ['repair'] } };
  }

  private async enable(): Promise<Outcome<string>> {
    const ok = await this.app.ask(
      'Turn on Windows Sandbox?',
      ['Windows asks for admin permission, then you restart Windows to finish.'],
      'Turn on',
    );
    if (!ok) return {};
    // The admin prompt and its output need the normal screen.
    this.app.terminal.stop();
    const worked = this.health.enableFeature();
    this.app.terminal.start();
    await this.loadSetup();
    return {
      notice: worked
        ? Theme.ok(Theme.glyph.ok + ' Done. Restart Windows to finish.')
        : Theme.error(
            Theme.glyph.cross + ' Windows Sandbox could not be turned on (or the admin prompt was declined).',
          ),
    };
  }
}
