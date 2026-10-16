// Section 7: keeping things in shape. Updates (the program and your saved settings), Data & storage (the data folder,
// what is stored, clean-up), Health (doctor, repair and this PC's setup together), the logs, the web UI's server, and
// the less common commands. Each is a category on the left and loads when you open it.
import { dataPage, showData, type DataShow } from '../../../app/features/data/index.js';
import type { Action } from '../../../app/kernel/index.js';
import { readQuery } from '../../../app/registry.js';
import { errMsg } from '../../../core/util/index.js';
import { healthPage, lastHealth, type HealthLast } from '../../../app/features/health/index.js';
import { CRASH, listLogs, logsPage, type LogFiles } from '../../../app/features/logs/index.js';
import { updatesPage, updatesStatus, type UpdatesStatus } from '../../../app/features/updates/updates.def.js';
import { webPage, webStatus, type WebStatus } from '../../../app/features/web/index.js';
import type { Context } from '../../commands/context.js';
import { commandSpec, type CommandSpec } from '../../manifest.js';
import {
  Text,
  Theme,
  type App,
  type ListAction,
  type ListItem,
  type ListOptions,
  type ListResult,
} from '../../tui/index.js';
import { CommandForm } from '../command-form.js';
import { DataFolderFlow, dataFolderRow } from '../data-folder.js';
import { MenuOperations } from '../io-menu.js';
import { menuView, type MenuView } from '../render-view.js';
import { ListPage, type Outcome } from './list-page.js';

export interface MaintenanceModel {
  /** The data folder row (where the sandbox keeps its data). */
  readonly dataFolder: { label: string; hint: string; description: string };
  /** Null until measured (measuring a big data folder takes a while). */
  readonly data: DataShow | null;
  /** The sandbox's logs (the logs view's query): the category's rows and its key. */
  readonly logs: LogFiles;
  /** The Health category: the last check or repair saved (null: none yet). */
  readonly health: { readonly last: HealthLast | null };
  /** The program's updates and saved settings (the status), and a newer version a check found (latest). */
  readonly updates: { readonly status: UpdatesStatus; readonly latest: string | null };
  /** The web UI's server (the web feature's status): running or not, and its address. */
  readonly web: WebStatus;
  /** The commands listed under "More commands". */
  readonly more: readonly { name: string; summary: string }[];
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
    id: 'web',
    label: 'Web UI',
    description: 'The web UI server on this PC: start it, open it in your browser, stop it.',
  },
  { id: 'more', label: 'More commands', description: 'Less common commands.' },
];

const MORE_COMMANDS = ['sync', 'audit', 'config', 'generate', 'exec', 'agent-commands'];

const NO_LOGS: LogFiles = { folder: '', files: [], crash: false };

/** Until the status is read: the server counts as not running. */
const NO_WEB: WebStatus = { running: false, port: null, address: null };

/** Plain names for the commands under More commands. */
const MORE_LABELS: Readonly<Record<string, string>> = {
  sync: 'Copy history back now',
  audit: 'What happened in the sandbox',
  config: 'Your settings file',
  generate: 'Preview a start',
  exec: 'Run a command in the sandbox',
  'agent-commands': 'Agent commands (Beta)',
};

/** The Data & storage category's rows and keys once measured: the data view (src/app/features/data) as menu rows. */
function dataMenuView(data: DataShow | null): MenuView | undefined {
  return data ? menuView(dataPage(data), { category: 'data', prefix: 'data:', refresh: false }) : undefined;
}

function dataItems(m: MaintenanceModel): ListItem<string>[] {
  const folder: ListItem<string> = { value: 'data:folder', category: 'data', section: 'Data folder', ...m.dataFolder };
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
    ];
  return [folder, ...(dataMenuView(m.data)?.items ?? [])];
}

/** The Updates view (src/app/features/updates) as the menu's rows, keys and Enter labels, for the Updates category. */
function updatesMenu(m: MaintenanceModel): MenuView {
  return menuView(updatesPage(m.updates.status, m.updates.latest), { category: 'updates', refresh: false });
}

/** A value the page shows before the first read (the status is read when the page loads). */
const NO_UPDATES: UpdatesStatus = {
  managed: false,
  version: '',
  scope: null,
  autoUpdate: false,
  autoOffText: null,
  previous: null,
  failed: null,
  npmCommand: '',
  error: null,
  settings: { pending: [], error: null },
};

/**
 * The logs view's rows and keys for the Logs category (its own empty row is left out: the category shows the page's
 * "Nothing here yet.").
 */
function logsMenu(files: LogFiles): MenuView {
  return menuView({ ...logsPage(files), empty: undefined }, { category: 'logs', refresh: false });
}

/** The Web UI view (src/app/features/web) as the menu's rows, keys and Enter labels, for the Web UI category. */
function webMenu(m: MaintenanceModel): MenuView {
  return menuView(webPage(m.web), { category: 'web', prefix: 'web:', refresh: false });
}

/** The list for the maintenance tab. Pure. */
export function maintenanceOptions(m: MaintenanceModel): ListOptions<string> {
  // The logs rows have no section heading of their own: the category is their heading.
  const logs: ListItem<string>[] = logsMenu(m.logs).items.map(({ section: _section, ...row }) => row);
  // The checks take seconds (programs are run), so they only run when you ask: the page shows the saved results.
  const health = healthMenu(m);
  const updates = updatesMenu(m);
  const web = webMenu(m);
  const more: ListItem<string>[] = m.more.map((c) => ({
    value: 'more:' + c.name,
    label: MORE_LABELS[c.name] ?? Text.humanize(c.name),
    category: 'more',
    description: c.summary.replace(/^./, (x) => x.toUpperCase()) + '.',
  }));
  return {
    path: [],
    categories: CATEGORIES,
    items: [...updates.items, ...dataItems(m), ...health.items, ...logs, ...web.items, ...more],
    empty: 'Nothing here yet.',
    actions: maintenanceActions(m),
    enterLabel: (category, id) =>
      category === 'health'
        ? health.enterLabel(category, id)
        : category === 'updates'
          ? updates.enterLabel(category, id)
          : category === 'web'
            ? web.enterLabel(category, id)
            : (category === 'data' ? dataMenuView(m.data)?.enterLabel(category, id) : undefined) ||
              enterLabel(id ?? ''),
  };
}

/** The Health category: the health view's rows and keys, drawn only while that category is open. */
function healthMenu(m: MaintenanceModel): MenuView {
  return menuView(healthPage({ last: m.health.last }), { category: 'health', refresh: false });
}

/** What Enter does on a row ("" = the row only shows information). */
function enterLabel(id: string): string {
  if (id === 'data:folder') return 'change';
  if (id === 'data:measure') return 'measure';
  if (id.startsWith('log:')) return 'show';
  if (id.startsWith('more:')) return 'open';
  return '';
}

function maintenanceActions(m: MaintenanceModel): (category: string | undefined) => ListAction<string>[] {
  return (category) => {
    switch (category) {
      case 'data':
        return [{ key: 'm', label: 'measure again' }, ...(dataMenuView(m.data)?.actions ?? [])];
      case 'logs':
        return logsMenu(m.logs).actions;
      case 'health':
        return healthMenu(m).actions;
      case 'updates':
        return updatesMenu(m).actions;
      case 'web':
        return webMenu(m).actions;
      default:
        return [];
    }
  };
}

export class MaintenancePage extends ListPage<string> {
  readonly label = 'Maintenance';
  private data: DataShow | null = null;
  private logs: LogFiles = NO_LOGS;
  private last: HealthLast | null = null;
  private updates: UpdatesStatus = NO_UPDATES;
  private web: WebStatus = NO_WEB;
  private readonly operations: MenuOperations;
  /** The newer version the last check found (null: none, or not looked yet). */
  private latest: string | null = null;

  constructor(
    app: App,
    private readonly ctx: Context,
  ) {
    super(app);
    this.operations = new MenuOperations(app, ctx);
  }

  private model(): MaintenanceModel {
    return {
      dataFolder: dataFolderRow(this.ctx),
      data: this.data,
      logs: this.logs,
      health: { last: this.last },
      updates: { status: this.updates, latest: this.latest },
      web: this.web,
      more: MORE_COMMANDS.flatMap((name) => {
        const spec = commandSpec(name);
        return spec ? [{ name, summary: spec.summary }] : [];
      }),
    };
  }

  protected async load(): Promise<void> {
    try {
      this.logs = await readQuery(listLogs, this.ctx);
    } catch {
      this.logs = NO_LOGS;
    }
    this.last = (await readQuery(lastHealth, this.ctx)).last;
    this.updates = await readQuery(updatesStatus, this.ctx);
    try {
      this.web = await readQuery(webStatus, this.ctx);
    } catch {
      // Not on this PC (a sandbox cannot start the web UI): the category shows it as not running.
      this.web = NO_WEB;
    }
  }

  protected options(): ListOptions<string> {
    return maintenanceOptions(this.model());
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    const id = result.kind === 'pick' || result.kind === 'action' ? result.value : undefined;
    const key = result.kind === 'action' ? result.key : undefined;
    try {
      // The open category's rows and keys only (a key of one category must not fire in another).
      if (this.category === 'data') {
        const chosen = dataMenuView(this.data)?.resolve(result);
        if (chosen?.kind === 'action') return await this.dataAction(chosen.action);
      }
      if (key === 'm' || id === 'data:measure') return await this.measure();
      if (id === 'data:folder' && result.kind === 'pick') {
        const exit = await new DataFolderFlow(this.app, this.ctx).run();
        return exit ? { exit } : { reload: true };
      }
      // Only the open category's rows and keys: `f` and Enter mean something else in Health.
      if (this.category === 'logs') {
        const chosen = logsMenu(this.logs).resolve(result);
        if (chosen?.kind === 'action') return this.showLog(chosen.action);
      }
      if (this.category === 'updates') {
        const chosen = updatesMenu(this.model()).resolve(result);
        if (chosen?.kind === 'action') return await this.runUpdates(chosen.action);
        return {};
      }
      // Only the open category's rows and keys: a key of one category must not fire in another.
      if (this.category === 'health') {
        const chosen = healthMenu(this.model()).resolve(result);
        if (chosen?.kind === 'action')
          return await this.operations.perform(chosen.action, [this.label], (text) => this.busy(text));
        return {};
      }
      // The Web UI's keys (s, o, x) only in its category; the operation reports and the page reloads its facts.
      if (this.category === 'web') {
        const chosen = webMenu(this.model()).resolve(result);
        if (chosen?.kind === 'action')
          return await this.operations.perform(chosen.action, [this.label], (text) => this.busy(text));
        return {};
      }
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

  /**
   * A Logs row or key: the crash report or the end of a log, on the normal screen (the menu's own view shows a log
   * there). Only names from the listing are looked up, never a path of their own.
   */
  private showLog(action: Action): Outcome<string> {
    if (action.kind !== 'link') return {};
    const target = action.target;
    if (target.kind === 'command') return { exit: { kind: 'run', argv: [...target.argv] } };
    if (target.kind !== 'view') return {};
    const name = target.params?.name;
    if (name === CRASH) return { exit: { kind: 'run', argv: ['logs', '--crash'] } };
    const file = this.logs.files.find((f) => f.name === name);
    return file ? { exit: { kind: 'view', file: file.path } } : {};
  }

  /**
   * An Updates row or key: runs its operation as the command line does (the operation asks what it must). A check and
   * an install tell the page the newer version they found (or that none is left), the rest leave it alone.
   */
  private runUpdates(action: Action): Promise<Outcome<string>> {
    const input = action.kind === 'operation' ? action.input : {};
    const checks = input.check === true;
    const installs = !checks && input.rollback === undefined && input.auto === undefined;
    const remember =
      checks || installs
        ? (output: unknown): void => {
            this.latest = (output as { latest: string | null }).latest;
          }
        : undefined;
    return this.operations.perform(action, [this.label], (text) => this.busy(text), remember);
  }

  private async measure(): Promise<Outcome<string>> {
    this.busy('Measuring what is stored… this can take a minute or more');
    this.data = await readQuery(showData, this.ctx);
    return { notice: Theme.ok(Theme.glyph.ok + ' Total stored: ' + this.data.total + '.') };
  }

  /**
   * Delete one stored folder, or clean up: the operation asks and reports as on the command line. After it ran, the
   * sizes shown are out of date, so the list goes back to "Measure what is stored" (a declined question keeps it).
   */
  private async dataAction(action: Action): Promise<Outcome<string>> {
    const outcome = await this.operations.perform(action, [this.label], (text) => this.busy(text));
    if (outcome.reload) this.data = null;
    return outcome;
  }
}
