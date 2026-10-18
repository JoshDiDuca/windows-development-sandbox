// Section 6: the saved logins of every agent, as the accounts view shows them (src/app/features/accounts). One category
// per agent: its save rows and its logins. Keys and Enter act on the open agent only; what they do is the operation's.
import { agentPage, listAccounts, type AccountsList } from '../../../app/features/accounts/index.js';
import { readQuery } from '../../../app/registry.js';
import type { Context } from '../../commands/context.js';
import type { App, ListOptions, ListResult } from '../../tui/index.js';
import { MenuOperations } from '../io-menu.js';
import { menuView, type MenuView } from '../render-view.js';
import { ListPage, type Outcome } from './list-page.js';

export type AccountsModel = AccountsList;

/** The menu's rows, keys and Enter labels of one agent's category. */
function viewOf(m: AccountsModel, category: string | undefined): MenuView {
  const agent = m.agents.find((a) => a.name === category);
  return agent
    ? menuView(agentPage(agent), { category: agent.name, refresh: false })
    : menuView({ title: 'Accounts', sections: [] }, { refresh: false });
}

/** The list for the accounts tab. Pure. */
export function accountsOptions(m: AccountsModel): ListOptions<string> {
  return {
    path: [],
    intro: 'Logins saved on this PC, per agent. Use puts one into the sandbox; new launches start with the default.',
    categories: m.agents.map((a) => ({
      id: a.name,
      label: a.name,
      description: a.kept
        ? 'Saved ' + a.name + ' logins.'
        : "This agent's login is not kept between sandboxes: it cannot be pointed at a folder we control.",
    })),
    items: m.agents.flatMap((a) => menuView(agentPage(a), { category: a.name, refresh: false }).items),
    empty: 'No agents.',
    actions: (category) => viewOf(m, category).actions,
    enterLabel: (category, id) => viewOf(m, category).enterLabel(category, id),
  };
}

export class AccountsPage extends ListPage<string> {
  readonly label = 'Accounts';
  private model: AccountsModel = { agent: 'claude', agents: [] };
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
