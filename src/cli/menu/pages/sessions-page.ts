// Section 2: the agent sessions of the running sandbox, as the sessions view shows them (src/app/features/sessions).
// Enter shows one in this terminal (the one thing that leaves the menu), r restarts the agents.
import { link } from '../../../app/kernel/index.js';
import { listSessions, sessionsPage, type SessionsList } from '../../../app/features/sessions/index.js';
import { readQuery } from '../../../app/registry.js';
import type { Context } from '../../commands/context.js';
import type { App, ListOptions, ListResult } from '../../tui/index.js';
import { MenuOperations } from '../io-menu.js';
import { menuView, type MenuView } from '../render-view.js';
import { ListPage, type Outcome } from './list-page.js';

/** What the page shows: the sessions query's result (the folder column is never shown here). */
export type SessionsModel = Omit<SessionsList, 'wide'>;

export function sessionsMenu(m: SessionsModel): MenuView {
  // Reopening the last sessions runs the hand-written `resume` on the normal screen: a key of the menu, not a link.
  const resume = link({ kind: 'command', argv: ['resume'] }, 'Reopen last sessions', {
    key: 'o',
    verb: 'reopen last sessions',
    importance: 2,
  });
  const page = sessionsPage({ ...m, wide: false });
  return menuView({ ...page, actions: [...(page.actions ?? []), resume] });
}

/** The list for the sessions tab. Pure. */
export function sessionsOptions(m: SessionsModel): ListOptions<string> {
  const v = sessionsMenu(m);
  return { path: [], items: v.items, actions: v.actions, enterLabel: v.enterLabel };
}

export class SessionsPage extends ListPage<string> {
  readonly label = 'Sessions';
  private model: SessionsModel;
  private readonly operations: MenuOperations;

  constructor(
    app: App,
    private readonly ctx: Context,
  ) {
    super(app);
    this.operations = new MenuOperations(app, ctx);
    this.model = { sandboxRunning: false, sessions: [], defaultAgent: ctx.loaded.config.defaultHarness };
  }

  protected async load(): Promise<void> {
    this.model = await readQuery(listSessions, this.ctx);
  }

  protected options(): ListOptions<string> {
    return sessionsOptions(this.model);
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    const chosen = sessionsMenu(this.model).resolve(result);
    if (!chosen) return {};
    if (chosen.kind === 'refresh') return { reload: true };
    return this.operations.perform(chosen.action, [this.label], (text) => this.busy(text));
  }
}
