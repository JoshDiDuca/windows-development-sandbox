// Section 6: the saved logins of every agent and the service sign-ins, as the accounts view shows them
// (src/app/features/accounts). One category per agent (its save rows and its logins), then one per service (its
// state, its warnings, share / import / sign in / forget). Keys and Enter act on the open category only; what they do
// is the operation's.
import {
  agentPage,
  listAccounts,
  serviceCategory,
  servicePage,
  type AccountsList,
} from '../../../app/features/accounts/index.js';
import { readQuery } from '../../../app/registry.js';
import type { Context } from '../../commands/context.js';
import type { App, ListOptions, ListResult } from '../../tui/index.js';
import { MenuOperations } from '../io-menu.js';
import { menuView, type MenuView } from '../render-view.js';
import { ListPage, type Outcome } from './list-page.js';

export type AccountsModel = AccountsList;

/** The services the menu lists: those whose sign-in is written (the others would offer actions that cannot work). */
function shown(m: AccountsModel): AccountsModel['services'] {
  return m.services.filter((s) => s.ready);
}

/** The menu's rows, keys and Enter labels of one agent's category. */
function viewOf(m: AccountsModel, category: string | undefined): MenuView {
  const agent = m.agents.find((a) => a.name === category);
  if (agent) return menuView(agentPage(agent), { category: agent.name, refresh: false });
  const service = shown(m).find((s) => serviceCategory(s.kind) === category);
  if (service) return menuView(servicePage(service), { category: serviceCategory(service.kind), refresh: false });
  return menuView({ title: 'Accounts', sections: [] }, { refresh: false });
}

/** The list for the accounts tab. Pure. */
export function accountsOptions(m: AccountsModel): ListOptions<string> {
  return {
    path: [],
    intro: 'Logins saved on this PC, per agent, and the service sign-ins sandboxes may get.',
    categories: [
      ...m.agents.map((a) => ({
        id: a.name,
        label: a.name,
        description: a.kept
          ? 'Saved ' + a.name + ' logins.'
          : "This agent's login is not kept between sandboxes: it cannot be pointed at a folder we control.",
      })),
      ...shown(m).map((s) => ({
        id: serviceCategory(s.kind),
        label: s.label,
        description: 'For ' + s.usedFor + '.',
      })),
    ],
    items: [
      ...m.agents.flatMap((a) => menuView(agentPage(a), { category: a.name, refresh: false }).items),
      ...shown(m).flatMap((s) => menuView(servicePage(s), { category: serviceCategory(s.kind), refresh: false }).items),
    ],
    empty: 'No agents.',
    actions: (category) => viewOf(m, category).actions,
    enterLabel: (category, id) => viewOf(m, category).enterLabel(category, id),
  };
}

export class AccountsPage extends ListPage<string> {
  readonly label = 'Accounts';
  private model: AccountsModel = { agent: 'claude', agents: [], services: [] };
  private readonly operations: MenuOperations;

  constructor(
    app: App,
    private readonly ctx: Context,
  ) {
    super(app);
    this.operations = new MenuOperations(app, ctx);
  }

  protected async load(): Promise<void> {
    this.model = await readQuery(listAccounts, this.ctx);
  }

  protected options(): ListOptions<string> {
    return accountsOptions(this.model);
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    const chosen = viewOf(this.model, this.category).resolve(result);
    if (!chosen) return {};
    if (chosen.kind === 'refresh') return { reload: true };
    return this.operations.perform(chosen.action, [this.label], (text) => this.busy(text));
  }
}
