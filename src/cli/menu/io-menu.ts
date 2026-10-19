// Running the shared core's actions inside the menu: an operation's questions become the menu's dialogs (yes/no over
// the screen, a text field, the path picker, a list), its fields the settings editors, its progress the page's notice,
// and what it said so far is shown above its next question. The result is one notice line: what it did, or what went
// wrong and how to fix it. A link leaves the menu for what needs the terminal (attach, a start).
import { operationById } from '../../app/features/defs.js';
import { runDefinition } from '../../app/registry.js';
import {
  Cancelled,
  ioFromAsker,
  SchemaNode,
  toWireError,
  type Action,
  type Answer,
  type AnyDefinition,
  type Asker,
  type OperationAction,
  type OperationIO,
  type Question,
  type Target,
} from '../../app/kernel/index.js';
import { errMsg } from '../../core/util/index.js';
import type { Context } from '../commands/context.js';
import { Theme, type App } from '../tui/index.js';
import { askPath } from './settings/ask-path.js';
import { ValueEditor } from './settings/value-editor.js';
import type { ShellExit } from './shell.js';

/** Where the dialogs say they are (the menu's path line). */
type Where = readonly string[];

async function ask(app: App, where: Where, q: Question, said: readonly string[]): Promise<Answer> {
  const lines = [...said, ...(q.lines ?? []), ...('problem' in q && q.problem ? [Theme.warn(q.problem)] : [])];
  const path = [...where];
  switch (q.kind) {
    case 'confirm': {
      if (!q.typed) return app.ask(q.title, lines, q.yes ?? 'Yes', q.danger ?? false);
      const typed = await app.text({ path, label: 'Type "' + q.typed + '" to confirm', about: [q.title, ...lines] });
      return typed?.trim().toLowerCase() === q.typed;
    }
    case 'choose':
      return app.choose(path, [q.title, ...lines].join(' '), q.choices, q.initial);
    case 'checklist': {
      const picked = await app.list<string>({
        path,
        intro: [q.title, ...lines],
        multi: true,
        items: q.choices.map((ch) => ({ ...ch, checked: q.checked?.includes(ch.value) ?? false })),
      });
      return picked.kind === 'multi' ? picked.values : undefined;
    }
    case 'path':
      return askPath(app, {
        path,
        title: q.title,
        about: lines,
        kind: q.pathKind,
        initial: q.initial,
        literals: q.literals,
      });
    case 'text':
    case 'secret':
      return app.text({
        path,
        label: q.title,
        about: lines,
        initial: q.kind === 'text' ? q.initial : undefined,
        allowEmpty: q.kind === 'text' ? q.allowEmpty : false,
        masked: q.kind === 'secret',
      });
  }
}

/** How a page shows progress while an operation runs (ListPage.busy). */
export type ShowBusy = (text: string) => void;

/** What an action did: leave the menu to run a command, and/or a notice after the page loads again. */
export interface Performed {
  readonly exit?: ShellExit;
  readonly notice?: string;
  readonly reload?: boolean;
}

/** Where a link goes in the menu: what needs the terminal is run on the normal screen. */
function follow(target: Target): Performed {
  switch (target.kind) {
    case 'terminal':
      return { exit: { kind: 'run', argv: ['attach', target.session] } };
    case 'start-agent':
      return { exit: { kind: 'run', argv: ['launch', '--harness', target.agent] } };
    case 'command':
      return { exit: { kind: 'run', argv: [...target.argv] } };
    case 'view':
      return {};
  }
}

/** How a definition is run: in this process (the menu), or on the owner's web UI (sandbox remote). */
export type DefinitionRunner = (id: string, input: unknown, io: OperationIO) => Promise<unknown>;

export class MenuOperations {
  constructor(
    private readonly app: App,
    ctx: Context,
    private readonly runner: DefinitionRunner = (id, input, io) => runDefinition(id, ctx, input, io),
  ) {}

  /** Does what an action of a page says: follows a link, or asks for its fields and runs its operation. */
  async perform(
    action: Action,
    where: Where,
    busy?: ShowBusy,
    onOutput?: (output: unknown) => void,
  ): Promise<Performed> {
    if (action.kind === 'link') return follow(action.target);
    const def = operationById(action.op);
    if (!def) return { notice: Theme.error(Theme.glyph.cross + ' Unknown operation ' + action.op + '.') };
    const answers = await this.fields(action, def, where);
    if (!answers) return {};
    return { reload: true, notice: await this.run(def, { ...action.input, ...answers }, where, busy, onOutput) };
  }

  /** The values of an action's fields, from the editors that fit them (undefined: one was backed out of). */
  private async fields(
    action: OperationAction,
    def: AnyDefinition,
    where: Where,
  ): Promise<Record<string, unknown> | undefined> {
    const answers: Record<string, unknown> = {};
    const editor = new ValueEditor(this.app);
    for (const field of action.fields ?? []) {
      const node = new SchemaNode(def.input).child(field.name);
      if (!node) continue;
      const edited = await editor.edit([...where, field.label], [...field.key], node, action.initial?.[field.name]);
      if (!edited) return undefined;
      answers[field.name] = edited.value;
    }
    return answers;
  }

  /**
   * Runs a definition with this input and returns the notice to show: its text (✓), the problem and its fix (✘), or
   * undefined when a question was declined (nothing changed, nothing to say).
   */
  async run(
    def: AnyDefinition,
    input: unknown,
    where: Where,
    busy: ShowBusy = () => undefined,
    onOutput?: (output: unknown) => void,
  ): Promise<string | undefined> {
    const said: string[] = [];
    const asker: Asker = async (q) => (await ask(this.app, where, q, said.splice(0))) as never;
    const io = ioFromAsker(asker, {
      progress: (text) => busy(Theme.muted(text + '…')),
      log: (text, tone) => said.push(tone === 'warn' || tone === 'danger' ? Theme.warn(text) : text),
    });
    try {
      const output = await this.runner(def.id, input, io);
      onOutput?.(output);
      // The notice is one line: an operation that says several lines (accounts use) runs them together.
      const text = def.text?.(output)?.replace(/\n+/g, ' ');
      return text ? Theme.ok(Theme.glyph.ok + ' ' + text) : undefined;
    } catch (e) {
      if (e instanceof Cancelled) return undefined;
      const problem = toWireError(e);
      if (problem.kind === 'bug') return Theme.error(Theme.glyph.cross + ' ' + errMsg(e));
      return (
        Theme.error(Theme.glyph.cross + ' ' + problem.message) + (problem.fix ? Theme.muted('  ' + problem.fix) : '')
      );
    }
  }
}
