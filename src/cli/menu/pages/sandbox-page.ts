// Section 3: the sandbox as a whole. Status (the sandbox view: its facts, the window, stopping it), Projects (the
// projects view: roots, the projects and the all-projects setting) and Databases (start and stop), each a category on
// the left.
import { listProjects, projectsPage, type ProjectsList } from '../../../app/features/projects/index.js';
import { sandboxPage, sandboxStatus, type SandboxStatus } from '../../../app/features/sandbox/index.js';
import { readQuery } from '../../../app/registry.js';
import { errMsg, safeText } from '../../../core/util/index.js';
import { RunDir } from '../../../shared/channel/index.js';
import type { Context } from '../../commands/context.js';
import { DatabasesService, type DatabaseRow } from '../../services/index.js';
import { Theme, type App, type ListAction, type ListItem, type ListOptions, type ListResult } from '../../tui/index.js';
import { MenuOperations } from '../io-menu.js';
import { menuView, type MenuView } from '../render-view.js';
import { ListPage, type Outcome } from './list-page.js';

export interface SandboxModel {
  readonly report: SandboxStatus;
  readonly projects: ProjectsList;
  /** Null: the sandbox is not running or did not answer. */
  readonly databases: DatabaseRow[] | null;
  /** The agent "Start the sandbox" offers while nothing runs. */
  readonly defaultAgent: string;
}

const CATEGORIES = [
  { id: 'status', label: 'Status', description: 'What the sandbox is doing, its window, and stopping it.' },
  {
    id: 'projects',
    label: 'Projects',
    description: 'Project roots (folders of projects, opened without a restart) and the projects started before.',
  },
  { id: 'databases', label: 'Databases', description: 'Databases the sandbox can run: start and stop them.' },
];

/** The status category: the sandbox view's rows (prefixed, so they never clash with the projects' rows). */
function statusView(m: SandboxModel): MenuView {
  return menuView(sandboxPage(m.report), { category: 'status', prefix: 'status:', refresh: false });
}

/** The projects category: the projects view's rows and keys (no prefix: `@add-root`, `root:`, `project:`). */
function projectsView(m: SandboxModel): MenuView {
  return menuView(projectsPage(m.projects), { category: 'projects', refresh: false });
}

/** The category whose rows and keys are open (the one the cursor is in). */
function viewFor(m: SandboxModel, category: string | undefined): MenuView | undefined {
  if (category === 'projects') return projectsView(m);
  if (category === 'status' || category === undefined) return statusView(m);
  return undefined;
}

/** The list for the sandbox tab. Pure. */
export function sandboxOptions(m: SandboxModel): ListOptions<string> {
  const running = m.report.sandbox.running;
  const status = statusView(m);
  const projects = projectsView(m);
  const statusItems: ListItem<string>[] = [...(running ? [] : startRows(m.defaultAgent, 'status')), ...status.items];
  const noDatabases: ListItem<string>[] = m.databases
    ? []
    : running
      ? [
          {
            value: 'info:db',
            label: 'The sandbox is not ready yet',
            category: 'databases',
            section: 'Databases',
            description: 'Its databases are listed once it is ready. l looks again.',
            disabled: 'Not ready yet: l looks again.',
          },
        ]
      : startRows(m.defaultAgent, 'databases');
  const databases: ListItem<string>[] = (m.databases ?? []).map((d) => ({
    value: 'db:' + d.name,
    label: d.name,
    hint: d.running ? Theme.ok('running') + Theme.muted(' :' + d.port) : Theme.muted('stopped :' + d.port),
    category: 'databases',
    section: 'Databases',
    description: d.title + '. Enter ' + (d.running ? 'stops' : 'starts') + ' it (the first start downloads it).',
  }));
  return {
    path: [],
    items: [...statusItems, ...projects.items, ...databases, ...noDatabases],
    categories: CATEGORIES,
    empty: 'Nothing here yet.',
    actions: (category) =>
      category === 'projects'
        ? [...projects.actions, REFRESH]
        : category === 'databases'
          ? [REFRESH]
          : [...status.actions, REFRESH],
    enterLabel: (category, id) => viewFor(m, category)?.enterLabel(category, id) || enterLabel(id ?? '', m),
  };
}

const REFRESH: ListAction<string> = { key: 'l', label: 'refresh', importance: 3 };

/** The rows that start a sandbox, shown where the sandbox has to run for anything to be there. */
function startRows(agent: string, category: string): ListItem<string>[] {
  return [
    {
      value: 'act:start',
      label: 'Start the sandbox with ' + agent,
      hint: Theme.muted('default agent'),
      category,
      section: 'No sandbox is running',
      description: 'Starts the sandbox and ' + agent + ' in this folder.',
    },
    {
      value: 'act:start-bare',
      label: 'Start the sandbox without an agent',
      category,
      section: 'No sandbox is running',
      description: 'Tools and databases only.',
    },
  ];
}

/** What Enter does on a row of Projects and Databases ("" = the row only shows information). */
function enterLabel(id: string, m: SandboxModel): string {
  if (id.startsWith('act:start')) return 'start';
  if (id.startsWith('db:')) return m.databases?.find((d) => 'db:' + d.name === id)?.running ? 'stop' : 'start';
  return '';
}

export class SandboxPage extends ListPage<string> {
  readonly label = 'Sandbox';
  private model: SandboxModel | undefined;
  private readonly operations: MenuOperations;

  constructor(
    app: App,
    private readonly ctx: Context,
  ) {
    super(app);
    this.operations = new MenuOperations(app, ctx);
  }

  protected async load(): Promise<void> {
    const report = await readQuery(sandboxStatus, this.ctx);
    const guest = report.sandbox.running && report.sandbox.phase === 'ready' ? this.guestWorkspace() : null;
    let databases: DatabaseRow[] | null = null;
    if (guest) {
      try {
        databases = await new DatabasesService(this.ctx).list(guest);
      } catch {
        /* the sandbox did not answer: the list stays empty */
      }
    }
    this.model = {
      report,
      projects: await readQuery(listProjects, this.ctx),
      databases,
      defaultAgent: this.defaultAgent(),
    };
  }

  /** The folder `sbx-db` runs in: the sandbox's own workspace. */
  private guestWorkspace(): string | null {
    return new RunDir(this.ctx.dataPath).readSandboxStatus()?.guestWorkspace ?? null;
  }

  protected options(): ListOptions<string> {
    if (!this.model) throw new Error('The sandbox tab was not loaded');
    return sandboxOptions(this.model);
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    const id = result.kind === 'pick' || result.kind === 'action' ? result.value : undefined;
    const key = result.kind === 'action' ? result.key : undefined;
    try {
      if (key === 'l') return { reload: true };
      // Only the open category's keys and rows: a key of one category must not fire in another.
      const chosen = this.model ? viewFor(this.model, this.category)?.resolve(result) : undefined;
      if (chosen?.kind === 'action')
        return await this.operations.perform(chosen.action, [this.label], (text) => this.busy(text, id));
      if (id === 'act:start' && !key)
        return { exit: { kind: 'run', argv: ['launch', '--harness', this.defaultAgent()] } };
      if (id === 'act:start-bare' && !key) return { exit: { kind: 'run', argv: ['start'] } };
      if (id?.startsWith('db:') && result.kind === 'pick') return await this.toggleDatabase(id.slice(3));
    } catch (e) {
      return { notice: Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) };
    }
    return {};
  }

  private defaultAgent(): string {
    return this.ctx.loaded.config.defaultHarness;
  }

  private noSandbox(): Outcome<string> | null {
    return this.model?.report.sandbox.running ? null : { notice: Theme.warn('No sandbox is running.') };
  }

  private async toggleDatabase(name: string): Promise<Outcome<string>> {
    const none = this.noSandbox();
    if (none) return none;
    const row = this.model?.databases?.find((d) => d.name === name);
    const guest = this.guestWorkspace();
    if (!row || !guest) return {};
    const action = row.running ? 'stop' : 'start';
    this.busy((row.running ? 'Stopping ' : 'Starting ') + name + '… the first start downloads it', 'db:' + name);
    const result = await new DatabasesService(this.ctx).run(action, name, guest);
    const last = safeText((result.stdout ?? '').trim().split(/\r?\n/).pop() ?? result.message);
    return {
      reload: true,
      notice: result.ok ? Theme.ok(Theme.glyph.ok + ' ' + last) : Theme.error(Theme.glyph.cross + ' ' + last),
    };
  }
}
