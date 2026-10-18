// Section 1: the agents. "Start" lists the agents you can start here (Enter starts one) after "Repeat last", and ends
// with "Add an agent…" (the agents view's rows and keys: src/app/features/agents); "Options" holds how a start goes
// (attach, window, folder) and the other ways to start; "On this PC" has the not-sandboxed entries while agent commands
// are on.
import fs from 'node:fs';
import path from 'node:path';
import type { Action } from '../../../app/kernel/index.js';
import { agentsPage, listAgents, type AgentsList } from '../../../app/features/agents/index.js';
import type { ConfigFile } from '../../../app/features/settings/index.js';
import { readQuery } from '../../../app/registry.js';
import type { Context } from '../../commands/context.js';
import { commandLine, readHistory } from '../../history.js';
import { AgentCommandsService, type AgentCommandsStatus } from '../../services/index.js';
import { commandSpec, type CommandSpec } from '../../manifest.js';
import {
  Text,
  Theme,
  type App,
  type Category,
  type ListItem,
  type ListOptions,
  type ListResult,
} from '../../tui/index.js';
import { CommandForm } from '../command-form.js';
import { MenuOperations } from '../io-menu.js';
import { menuView, type MenuView } from '../render-view.js';
import type { Draft } from '../settings/draft.js';
import { askPath } from '../settings/ask-path.js';
import { SeveralAgents } from '../several.js';
import { ListPage, type Outcome } from './list-page.js';

export type WindowChoice = 'config' | 'hide' | 'show';

export interface AgentsModel {
  readonly folder: string;
  readonly defaultAgent: string;
  readonly agents: readonly { readonly name: string; readonly ready: boolean }[];
  readonly last: string[] | undefined;
  readonly attach: boolean;
  readonly window: WindowChoice;
  /** Agents that can be run on this PC without the sandbox (see hostAgentsToShow). */
  readonly hostAgents: readonly string[];
  /** The agents you added yourself: only these can be removed (the built-in ones stay). */
  readonly removable?: readonly string[];
}

/** The agents page's data as the agents view takes it. Pure. */
export function agentsList(m: AgentsModel): AgentsList {
  const removable = m.removable ?? [];
  return {
    folder: m.folder,
    defaultAgent: m.defaultAgent,
    agents: m.agents.map((a) => ({
      name: a.name,
      ready: a.ready,
      isDefault: a.name === m.defaultAgent,
      removable: removable.includes(a.name),
    })),
  };
}

/** The Start category: the agents view's rows and keys, as the menu draws them. Pure. */
function startView(m: AgentsModel): MenuView {
  return menuView(agentsPage(agentsList(m)), { category: 'start', refresh: false });
}

/**
 * The "not sandboxed" entries: only while agent commands are on (typing the agent then starts the sandbox, so a way to
 * run the real one is needed), one per agent found installed on this PC.
 */
export function hostAgentsToShow(enabled: boolean, found: readonly { harness: string }[]): string[] {
  return enabled ? found.map((a) => a.harness) : [];
}

const WINDOW_TEXT: Record<WindowChoice, string> = { config: 'as configured', hide: 'hidden', show: 'shown' };

/** The command line a start stands for. Pure. */
export function startArgv(m: AgentsModel, agent: string, cwd: string): string[] {
  return [
    'launch',
    '--harness',
    agent,
    ...(m.attach ? ['--terminal'] : []),
    ...(m.window === 'hide' ? ['--headless'] : m.window === 'show' ? ['--window'] : []),
    ...(path.resolve(m.folder).toLowerCase() === path.resolve(cwd).toLowerCase() ? [] : ['--workspace', m.folder]),
  ];
}

/** Settings has unsaved changes to the agents (their list or the default): the agent operations wait for them. */
export function agentsHaveStagedChanges(file: ConfigFile, draft: Draft): boolean {
  return draft.has(file, ['harnesses']) || draft.has(file, ['defaultHarness']);
}

/** The categories of the agents section; "On this PC" only when there is something in it. Pure. */
export function agentCategories(m: Pick<AgentsModel, 'folder' | 'hostAgents'>): Category[] {
  return [
    {
      id: 'start',
      label: 'Start',
      description: 'Agents you can start in ' + m.folder + '. Add an agent at the end of the list.',
    },
    { id: 'options', label: 'Options', description: 'How a start goes, and the other ways to start.' },
    ...(m.hostAgents.length
      ? [
          {
            id: 'host',
            label: 'On this PC',
            description: 'The real agents on this PC, with no sandbox around them.',
          },
        ]
      : []),
  ];
}

/** A Start row of the view with the menu's own lines: the default's accent and the command a start runs. Pure. */
function startRow(item: ListItem<string>, m: AgentsModel, cwd: string): ListItem<string> {
  const name = item.value.startsWith('agent:') ? item.value.slice(6) : undefined;
  if (name === undefined) return item;
  return {
    ...item,
    hint: (name === m.defaultAgent ? Theme.accent('default  ') : '') + (item.hint ?? ''),
    details: [Theme.muted('Command  ') + commandLine(startArgv(m, name, cwd))],
  };
}

/** The list for the agents section. Pure. */
export function agentsOptions(m: AgentsModel, cwd: string = process.cwd()): ListOptions<string> {
  const view = startView(m);
  return {
    path: [],
    categories: agentCategories(m),
    items: [
      ...(m.last
        ? [
            {
              value: 'repeat',
              label: 'Repeat last',
              category: 'start',
              section: 'Quick start',
              hint: Theme.muted(Text.truncate(commandLine(m.last), 50)),
              description: 'Runs the last command again.',
            },
          ]
        : []),
      ...view.items.map((item) => startRow(item, m, cwd)),
      {
        value: 'opt:attach',
        label: 'Attach this terminal',
        category: 'options',
        section: 'This start',
        hint: m.attach ? Theme.ok('yes') : Theme.muted('no'),
        flip: true,
        description: 'Shows the agent in this terminal (Ctrl+] detaches). Without it the agent runs in the sandbox.',
      },
      {
        value: 'opt:window',
        label: 'Sandbox window',
        category: 'options',
        section: 'This start',
        hint: WINDOW_TEXT[m.window],
        description: 'Hide or show the Windows Sandbox window (sbx-show brings a hidden one back).',
      },
      {
        value: 'opt:folder',
        label: 'Folder',
        category: 'options',
        section: 'This start',
        hint: Text.middle(m.folder, 40),
        description: 'The project folder to work on.',
      },
      {
        value: 'more',
        label: 'More start options…',
        category: 'options',
        section: 'Start differently',
        description: 'Node and Python versions, databases, scripts and the rest of the start form.',
      },
      {
        value: 'several',
        label: 'Start several agents…',
        category: 'options',
        section: 'Start differently',
        description: 'One or more projects, one or more agents each, all in one sandbox.',
      },
      {
        value: 'noagent',
        label: 'Sandbox without an agent…',
        category: 'options',
        section: 'Start differently',
        description: 'Tools and databases only.',
      },
      ...m.hostAgents.map((agent) => ({
        value: 'host:' + agent,
        label: agent + ' (not sandboxed)',
        category: 'host',
        description: 'Runs the real ' + agent + ' on this PC, with no sandbox around it.',
      })),
    ],
    enterLabel: (_category, id) =>
      ENTER[id ?? ''] ?? (id?.startsWith('agent:') ? 'start' : id?.startsWith('host:') ? 'run' : 'open'),
    actions: (category) => (category === 'start' ? view.actions : []),
  };
}

/** What Enter does on the rows that are not an agent. */
const ENTER: Readonly<Record<string, string>> = {
  repeat: 'run again',
  add: 'add',
  'opt:attach': 'switch',
  'opt:window': 'change',
  'opt:folder': 'choose',
};

export class AgentsPage extends ListPage<string> {
  readonly label = 'Agents';
  private attach = false;
  private window: WindowChoice = 'config';
  private folder = process.cwd();
  private model: AgentsModel | undefined;
  private readonly operations: MenuOperations;
  /** What load() looked up: the agents view, programs on PATH, the history file. */
  private facts:
    | {
        readonly agents: AgentsList;
        readonly commands: AgentCommandsStatus;
        readonly last: string[] | undefined;
      }
    | undefined;

  constructor(
    app: App,
    private readonly ctx: Context,
    /** Your own config file: the default agent's name for where the cursor starts. */
    private readonly file: ConfigFile,
    /** Unsaved changes in Settings: while there are some to the agents, the agent operations wait for them. */
    private readonly draft: Draft,
  ) {
    super(app);
    this.operations = new MenuOperations(app, ctx);
  }

  private current(): AgentsModel {
    if (!this.facts) throw new Error('The agents tab was not loaded');
    const { agents, commands, last } = this.facts;
    return {
      folder: this.folder,
      defaultAgent: agents.defaultAgent,
      agents: agents.agents.map((a) => ({ name: a.name, ready: a.ready })),
      last,
      attach: this.attach,
      window: this.window,
      hostAgents: hostAgentsToShow(commands.enabled, commands.found),
      removable: agents.agents.filter((a) => a.removable).map((a) => a.name),
    };
  }

  /** The cursor starts on the default agent. */
  protected override initialFocus(): string {
    return 'agent:' + this.file.userConfig().defaultHarness;
  }

  protected async load(): Promise<void> {
    this.facts = {
      agents: await readQuery(listAgents, this.ctx),
      commands: await new AgentCommandsService(this.ctx).statusAsync(),
      last: readHistory()[0]?.argv,
    };
    this.model = this.current();
  }

  protected options(): ListOptions<string> {
    this.model = this.current();
    return agentsOptions(this.model);
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    const model = this.current();
    const chosen = startView(model).resolve(result);
    if (chosen?.kind === 'action') {
      const { action } = chosen;
      // A start keeps the options of this page (attach, window, folder), which the plain link does not know.
      if (action.kind === 'link' && action.target.kind === 'start-agent')
        return { exit: { kind: 'run', argv: startArgv(model, action.target.agent, process.cwd()) } };
      return this.operate(action);
    }
    if (result.kind !== 'pick') return {};
    const id = result.value;
    if (id.startsWith('host:')) return { exit: { kind: 'run', argv: ['host', id.slice(5)] } };
    switch (id) {
      case 'repeat':
        return model.last ? { exit: { kind: 'run', argv: model.last } } : {};
      case 'opt:attach':
        this.attach = !this.attach;
        return {};
      case 'opt:window':
        this.window = this.window === 'config' ? 'hide' : this.window === 'hide' ? 'show' : 'config';
        return {};
      case 'opt:folder': {
        const picked = await askPath(this.app, {
          path: ['Agents', 'Folder'],
          title: 'Choose the project folder',
          kind: 'dir',
          initial: this.folder,
          validate: (v) => (fs.existsSync(path.resolve(v)) ? true : 'That folder does not exist.'),
        });
        if (picked) this.folder = path.resolve(picked);
        return {};
      }
      case 'more': {
        const argv = await new CommandForm(
          this.app,
          this.ctx,
          commandSpec('launch') as CommandSpec,
          startArgv(model, model.defaultAgent, process.cwd()).slice(1),
        ).run();
        return argv ? { exit: { kind: 'run', argv } } : {};
      }
      case 'several': {
        const argv = await new SeveralAgents(this.app, this.ctx).run();
        return argv ? { exit: { kind: 'run', argv } } : {};
      }
      case 'noagent': {
        const argv = await new CommandForm(this.app, this.ctx, commandSpec('start') as CommandSpec).run();
        return argv ? { exit: { kind: 'run', argv } } : {};
      }
      default:
        return {};
    }
  }

  /** Add, make default and remove run through the menu's dialogs, unless Settings has unsaved changes to the agents. */
  private async operate(action: Action): Promise<Outcome<string>> {
    if (agentsHaveStagedChanges(this.file, this.draft))
      return { notice: Theme.warn('Agents have unsaved changes in Settings: save them (Ctrl+S) or undo them first.') };
    return this.operations.perform(action, [this.label], (text) => this.busy(text));
  }
}
