// `sandbox remote`: the menu drawn over another Windows user's program (docs/design/remote-access.md). Every view the
// web UI has is drawn by the menu's own renderer (menuView) from the shared core's pure definitions; its queries and
// operations run on the owner's web UI over the RPC socket, which checks the role this user was given and writes each
// action to the owner's audit log. Nothing here runs on this user's own settings or data.
import { NAV, navViews, viewById } from '../../app/features/defs.js';
import {
  NO_QUESTIONS,
  allows,
  viewInputs,
  type Access,
  type AnyView,
  type Caller,
  type Page,
} from '../../app/kernel/index.js';
import { errMsg, safeText } from '../../core/util/index.js';
import type { Context } from '../commands/context.js';
import type { RemoteClient } from '../services/remote-client.js';
import { Theme, type App } from '../tui/index.js';
import { MenuOperations } from './io-menu.js';
import { menuView } from './render-view.js';

/** The views of the owner's program this role may open (remote access itself is the owner's). */
export function remoteViews(role: Caller): AnyView[] {
  return navViews(NAV)
    .map((id) => viewById(id))
    .filter((v): v is AnyView => v !== undefined)
    .filter((v) => Object.values(v.queries).every((q) => allows(role, (q.access as Access | undefined) ?? 'view')));
}

export class RemoteMenu {
  private readonly operations: MenuOperations;

  constructor(
    private readonly app: App,
    ctx: Context,
    private readonly client: RemoteClient,
    private readonly owner: string,
    private readonly caller: Caller,
  ) {
    this.operations = new MenuOperations(app, ctx, (id, input, io) => client.run(id, input, io));
  }

  private title(): string {
    return safeText(this.owner) + "'s sandbox";
  }

  /** The list of areas, until Esc. */
  async start(): Promise<void> {
    const views = remoteViews(this.caller);
    const role = this.caller.kind === 'owner' ? 'owner' : this.caller.role;
    let at: string | undefined;
    for (;;) {
      const picked = await this.app.list<string>({
        path: [this.title()],
        intro: [
          'You are using ' + safeText(this.owner) + "'s program with the role " + role + '.',
          'What you do runs as ' + safeText(this.owner) + ' and is written to their audit log.',
        ],
        items: views.map((v) => ({ value: v.id, label: v.title, description: v.summary })),
        startAt: at,
        escapeLabel: 'quit',
        enterLabel: 'open',
      });
      if (picked.kind !== 'pick') return;
      at = picked.value;
      const view = views.find((v) => v.id === picked.value);
      if (view) await this.showView(view);
    }
  }

  private async page(view: AnyView): Promise<Page> {
    const inputs = viewInputs(view, {} as never);
    const data: Record<string, unknown> = {};
    for (const [name, query] of Object.entries(view.queries))
      data[name] = await this.client.run(query.id, inputs[name], NO_QUESTIONS);
    return view.build(data as never, {} as never);
  }

  private async showView(view: AnyView): Promise<void> {
    let notice: string | undefined;
    for (;;) {
      let page: Page;
      try {
        page = await this.page(view);
      } catch (e) {
        await this.app.message({ path: [this.title(), view.title], lines: [safeText(errMsg(e))], tone: 'error' });
        return;
      }
      const mv = menuView(page);
      const result = await this.app.list<string>({
        path: [this.title(), view.title],
        intro: page.notice ? [safeText(page.notice.text)] : undefined,
        items: mv.items,
        actions: mv.actions,
        enterLabel: mv.enterLabel,
        notice,
        empty: page.empty?.text,
      });
      if (result.kind === 'back') return;
      const chosen = mv.resolve(result);
      notice = undefined;
      if (!chosen || chosen.kind === 'refresh') continue;
      const action = chosen.action;
      if (action.kind === 'link') {
        notice =
          action.target.kind === 'terminal'
            ? Theme.muted('Attach to it from your own terminal: sandbox attach ' + safeText(action.target.session))
            : Theme.muted('That opens on ' + safeText(this.owner) + "'s side only.");
        continue;
      }
      const done = await this.operations.perform(action, [this.title(), view.title], (text) => {
        notice = text;
        this.app.redraw();
      });
      notice = done.notice;
    }
  }
}
