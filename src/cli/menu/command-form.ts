// One command as a form: its arguments and options listed with their current values, each changed in place with the
// input that fits it (a switch flips, a choice is picked, a number is typed within its limits, a folder or file is
// picked in the path picker, a list is edited item by item), and the exact command line it will run shown live (the
// same line you could type yourself). Built from manifest.ts, so a new command or option appears here on its own.
import { z } from 'zod';
import { humanBytes } from '../../core/disk.js';
import { plainText } from '../../core/util/index.js';
import { SandboxChannel } from '../../host/channel/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import { moveProblem } from '../../host/storage/index.js';
import { splitArgs } from '../args.js';
import type { Context } from '../commands/context.js';
import { AccountsService, cleanTargetOf, DataService, ProjectsService } from '../services/index.js';
import { commandLine } from '../history.js';
import { askedWhen, type CommandSpec, type OptionSpec } from '../manifest.js';
import { Text, Theme, type App, type ListItem } from '../tui/index.js';
import {
  actionOf,
  argLabel,
  argPathKind,
  type Field,
  optionLabel,
  optionPathKind,
  optionProblem,
  plainDescription,
  plainSummary,
} from './command-fields.js';
import { StringListEditor } from './settings/collections/string-list-editor.js';
import type { PathKind } from '../../app/kernel/index.js';
import { askPath } from './settings/ask-path.js';
import { SchemaNode } from '../../app/kernel/index.js';
import { ValueEditor } from './settings/value-editor.js';

const MORE = '@more';
const OTHER = '@other';

export class CommandForm {
  /** Advanced options stay folded away until asked for. */
  private showAdvanced = false;

  /** Answers by field id (arg:<name>, opt:<flag>, json, extra). */
  private readonly values = new Map<string, string[] | boolean>();

  constructor(
    private readonly app: App,
    private readonly ctx: Context,
    private readonly spec: CommandSpec,
    preset: string[] = [],
  ) {
    for (let i = 0; i < preset.length; i++) {
      const option = spec.options.find((o) => o.flag === preset[i]);
      if (option?.type === 'boolean') this.values.set('opt:' + option.flag, true);
      else if (option)
        this.values.set('opt:' + option.flag, [
          ...((this.values.get('opt:' + option.flag) as string[]) ?? []),
          preset[++i],
        ]);
    }
  }

  /** The actions the command's first argument offers (account: save, use, rename ...). */
  private actions(): readonly string[] {
    const choices = this.spec.args[0]?.choices;
    return Array.isArray(choices) ? choices : [];
  }

  /** Values a choices list names, filled in from config and the running sandbox. */
  private choices(choices: OptionSpec['choices']): string[] {
    if (Array.isArray(choices)) return choices;
    if (choices === 'harnesses') return Object.keys(this.ctx.loaded.config.harnesses);
    if (choices === 'accounts') return new AccountsService(this.ctx).list().map((a) => a.name);
    if (choices === 'sessions')
      return isSandboxRunning()
        ? new SandboxChannel(this.ctx.dataPath).runningSessions().map((s) => plainText(s.id))
        : [];
    return [];
  }

  private first(): string {
    return (this.values.get('arg:' + this.spec.args[0]?.name) as string[] | undefined)?.[0] ?? '';
  }

  private valueOf(name: string): string {
    return (this.values.get('arg:' + name) as string[] | undefined)?.[0] ?? '';
  }

  /** Options the form may ask for at all (advanced ones included). */
  private askable(): OptionSpec[] {
    const first = this.first();
    return this.spec.options.filter((o) => {
      if (o.noMenu || !askedWhen(o.when, first)) return false;
      if (typeof o.choices === 'string' && !this.choices(o.choices).length) return false;
      // "(check) the folder": asked only for that action.
      const action = actionOf(o.description, this.actions());
      return !action || action === first;
    });
  }

  private hiddenCount(): number {
    return this.showAdvanced ? 0 : this.askable().filter((o) => o.advanced && !this.values.has('opt:' + o.flag)).length;
  }

  private fields(): Field[] {
    const first = this.first();
    return [
      ...this.spec.args
        .map((spec, index): Field => ({ kind: 'arg', spec, index }))
        .filter((f) => f.kind === 'arg' && (f.index === 0 || askedWhen(f.spec.when, first))),
      ...this.askable()
        .filter((o) => this.showAdvanced || !o.advanced || this.values.has('opt:' + o.flag))
        .map((spec): Field => ({ kind: 'option', spec })),
      ...(this.spec.json && !(this.spec.name === 'data' && first === 'clean') ? [{ kind: 'json' } as Field] : []),
      ...(this.spec.passthrough ? [{ kind: 'extra' } as Field] : []),
    ];
  }

  private id(f: Field): string {
    return f.kind === 'arg' ? 'arg:' + f.spec.name : f.kind === 'option' ? 'opt:' + f.spec.flag : f.kind;
  }

  /** The command line the form stands for now. */
  argv(): string[] {
    const fields = this.fields();
    const list = (f: Field): string[] => (this.values.get(this.id(f)) as string[] | undefined) ?? [];
    const argv = [this.spec.name, ...fields.filter((f) => f.kind === 'arg').flatMap(list)];
    for (const f of fields) {
      if (f.kind !== 'option') continue;
      const v = this.values.get(this.id(f));
      if (v === true) argv.push(f.spec.flag);
      else if (Array.isArray(v)) for (const x of v) argv.push(f.spec.flag, x);
    }
    if (this.values.get('json') === true) argv.push('--json');
    const extra = list({ kind: 'extra' });
    if (extra.length) argv.push(...(this.spec.passthrough === 'agent' ? ['--', ...extra] : extra));
    return argv;
  }

  /** The name of a required argument that has no value yet. */
  private missing(): string | undefined {
    const field = this.fields().find(
      (f) => f.kind === 'arg' && f.spec.required && !(this.values.get(this.id(f)) as string[] | undefined)?.length,
    );
    return field?.kind === 'arg' ? argLabel(field.spec) : undefined;
  }

  private item(f: Field): ListItem<string> {
    const v = this.values.get(this.id(f));
    const shown =
      v === true
        ? Theme.ok('On')
        : v === false || v === undefined
          ? Theme.muted(
              (f.kind === 'option' && f.spec.type === 'boolean') || f.kind === 'json'
                ? 'Off'
                : f.kind === 'option' && f.spec.default !== undefined
                  ? 'default ' + f.spec.default
                  : f.kind === 'arg' && f.spec.required
                    ? 'required'
                    : 'not set',
            )
          : Array.isArray(v) && v.length
            ? v.join(' ')
            : Theme.muted('not set');
    const actions = this.actions();
    if (f.kind === 'arg')
      return {
        value: this.id(f),
        label: argLabel(f.spec),
        hint: shown,
        description: plainDescription(f.spec.description, actions),
        section: 'What',
        keywords: f.spec.name,
      };
    if (f.kind === 'json')
      return {
        value: 'json',
        label: 'Machine-readable output',
        hint: shown,
        description: 'Print JSON instead of a table.',
        section: 'Output',
        flip: true,
      };
    if (f.kind === 'extra')
      return {
        value: 'extra',
        label: this.spec.passthrough === 'agent' ? 'Extra arguments for the agent' : 'Arguments for the command',
        hint: shown,
        description:
          this.spec.passthrough === 'agent'
            ? 'Passed on to the agent, e.g. --continue.'
            : 'The rest of the command line.',
        section: 'Output',
      };
    return {
      value: this.id(f),
      label: optionLabel(f.spec),
      hint: shown,
      description: plainDescription(f.spec.description, actions),
      section: f.spec.advanced ? 'Advanced' : 'Options',
      keywords: f.spec.flag,
      flip: f.spec.type === 'boolean',
    };
  }

  /** Shows the form until you run the command (its argv) or go back (null). */
  async run(): Promise<string[] | null> {
    let focus: string | undefined;
    let notice: string | undefined;
    const path = [Text.humanize(this.spec.name)];
    for (;;) {
      const fields = this.fields();
      const hidden = this.hiddenCount();
      const line = commandLine(this.argv());
      const picked = await this.app.list<string>({
        path,
        intro: plainSummary(this.spec.summary),
        status: Theme.muted('$ ') + Theme.accent(line),
        items: [
          ...fields.map((f) => this.item(f)),
          ...(hidden
            ? [{ value: MORE, label: Theme.muted('More options…'), hint: Theme.muted(hidden + ' more') }]
            : []),
        ],
        startAt: focus,
        actions: [
          { key: 'r', label: 'start', ctrl: true },
          { key: 'r', label: 'clear', applies: (id) => this.values.has(id) },
        ],
        enterLabel: (_category, id) => (id === MORE ? 'show' : this.isSwitch(id) ? 'flip' : 'change'),
        notice,
      });
      notice = undefined;
      if (picked.kind === 'back') return null;
      if (picked.kind === 'action' && picked.key === 'ctrl+r') {
        const missing = this.missing();
        if (!missing) return this.argv();
        notice = Theme.warn(missing + ' is required.');
        continue;
      }
      if (picked.kind === 'pick' && picked.value === MORE) {
        this.showAdvanced = true;
        focus = undefined;
        continue;
      }
      if (picked.kind !== 'pick' && picked.kind !== 'action') continue;
      const field = fields.find((f) => this.id(f) === picked.value);
      if (!field) continue;
      focus = picked.value;
      if (picked.kind === 'action') {
        this.values.delete(this.id(field));
        continue;
      }
      notice = await this.edit(field, path);
      // Enter on the last field starts it (a switch only flips).
      const isSwitch = field.kind === 'json' || (field.kind === 'option' && field.spec.type === 'boolean');
      if (field === fields[fields.length - 1] && !isSwitch && !hidden && !this.missing()) return this.argv();
    }
  }

  private isSwitch(id: string | undefined): boolean {
    const f = this.fields().find((x) => this.id(x) === id);
    return f?.kind === 'json' || (f?.kind === 'option' && f.spec.type === 'boolean');
  }

  /** Sets (or, with no value, clears) a field's answer. */
  private set(id: string, value: string[]): void {
    if (value.length) this.values.set(id, value);
    else this.values.delete(id);
  }

  /** The kind of path a field takes (a folder or a file), if it is one. */
  private pathKind(f: Field): PathKind | undefined {
    if (f.kind === 'option') return optionPathKind(f.spec);
    return f.kind === 'arg' ? argPathKind(f.spec, this.spec.name, this.first()) : undefined;
  }

  /** A name that does not exist yet (the new login's name): typed, not picked. */
  private freeText(f: Field): boolean {
    return f.kind === 'arg' && this.spec.name === 'account' && f.spec.name === 'name' && this.first() === 'save';
  }

  /** The values to pick from for a field with a fixed or looked-up set of answers. */
  private options(f: Field): string[] {
    if (f.kind === 'extra' || f.kind === 'json' || this.freeText(f)) return [];
    const fixed = this.choices(f.spec.choices);
    if (fixed.length || f.kind !== 'arg' || this.spec.name !== 'projects') return fixed;
    const first = this.first();
    if (f.spec.name === 'value' && first === 'all') return ['on', 'off'];
    if (f.spec.name === 'value' && first === 'roots') return ['list', 'add', 'remove'];
    if (f.spec.name === 'folder' && this.valueOf('value') === 'remove')
      return new ProjectsService(this.ctx).list().roots;
    return [];
  }

  /** Changes one field with the input that fits it. Returns a notice to show (when there is something to say). */
  private async edit(f: Field, path: string[]): Promise<string | undefined> {
    const id = this.id(f);
    const current = this.values.get(id);
    if (f.kind === 'json' || (f.kind === 'option' && f.spec.type === 'boolean')) {
      this.values.set(id, current !== true);
      return undefined;
    }
    const label = f.kind === 'extra' ? 'Arguments' : f.kind === 'arg' ? argLabel(f.spec) : optionLabel(f.spec);
    const about = f.kind === 'extra' ? [] : [plainDescription(f.spec.description, this.actions())];
    const here = [...path, label];
    if (f.kind === 'arg' && this.spec.name === 'data' && f.spec.name === 'targets') {
      const picked = await this.dataTargets(path);
      if (picked) this.values.set(id, picked);
      return undefined;
    }
    const many = (f.kind === 'option' && f.spec.type === 'list') || (f.kind === 'arg' && f.spec.variadic);
    const list = this.options(f);
    if (list.length && many) {
      const picked = await this.app.list<string>({
        path: here,
        intro: about,
        multi: true,
        items: list.map((v) => ({ value: v, label: v, checked: Array.isArray(current) && current.includes(v) })),
      });
      if (picked.kind === 'multi') this.set(id, picked.values);
      return undefined;
    }
    if (f.kind === 'arg' && this.spec.name === 'projects' && f.spec.name === 'value' && this.projectAction()) {
      await this.projectFolder(id, here, about);
      return undefined;
    }
    if (list.length) {
      const optional = !(f.kind === 'arg' && f.spec.required);
      const picked = await this.app.choose<string>(
        here,
        about.join(' '),
        [
          ...list.map((v) => ({ value: v, label: v })),
          ...(optional ? [{ value: '', label: Theme.muted('(not set)') }] : []),
        ],
        Array.isArray(current) ? current[0] : undefined,
      );
      if (picked !== undefined) this.set(id, picked === '' ? [] : [picked]);
      return undefined;
    }
    if (f.kind !== 'extra' && typeof f.spec.choices === 'string' && !this.freeText(f))
      return this.nothingToChoose(f.spec.choices);
    const kind = this.pathKind(f);
    if (kind && f.kind !== 'extra') {
      if (many) return this.pathList(id, here, about, kind);
      const picked = await askPath(this.app, {
        path: here,
        title: kind === 'file' ? 'Choose the file' : 'Choose the folder',
        about,
        kind,
        initial: Array.isArray(current) ? current[0] : '',
        validate: (v) => this.pathProblem(f, v),
      });
      if (picked !== undefined) this.set(id, [picked]);
      return undefined;
    }
    if (f.kind === 'option' && f.spec.type === 'list') return this.pathList(id, here, about, undefined);
    const number = f.kind === 'option' && f.spec.type === 'number' ? f.spec : undefined;
    const typed = await this.app.text({
      path: here,
      label,
      about,
      allowEmpty: true,
      accept: number ? /[0-9]/ : undefined,
      hint: number
        ? 'A whole number greater than 0' + (number.default !== undefined ? '. Default: ' + number.default : '') + '.'
        : undefined,
      initial: Array.isArray(current)
        ? many || f.kind === 'extra'
          ? current.map((x) => (/\s/.test(x) ? '"' + x + '"' : x)).join(' ')
          : current[0]
        : '',
      validate: (v) => (f.kind === 'option' ? (optionProblem(f.spec, v) ?? true) : true),
    });
    if (typed === undefined) return undefined;
    this.set(id, many || f.kind === 'extra' ? splitArgs(typed) : typed.trim() ? [typed.trim()] : []);
    return undefined;
  }

  /** Is the problem with a picked path (true = fine)? Moving or switching the data folder has its own rules. */
  private pathProblem(f: Field, picked: string): true | string {
    if (this.spec.name === 'storage' && f.kind === 'arg') {
      const problem = moveProblem(this.ctx.storageRoot, picked, true);
      return problem ? problem.message : true;
    }
    return f.kind === 'option' ? (optionProblem(f.spec, picked) ?? true) : true;
  }

  /** Several folders or files (--script ...): a list to add to, change and remove from. */
  private async pathList(id: string, path: string[], about: string[], kind: PathKind | undefined): Promise<undefined> {
    const node = new SchemaNode(z.array(z.string()).describe(about.join(' ')));
    const edited = await new StringListEditor(
      this.app,
      path,
      node,
      new ValueEditor(this.app),
      [],
      kind,
      'Esc keeps it for the command',
    ).run(Array.isArray(this.values.get(id)) ? [...(this.values.get(id) as string[])] : []);
    if (edited) this.set(id, edited.value as string[]);
    return undefined;
  }

  /** projects remove / include / exclude pick from the known projects (or any folder); add takes a folder. */
  private projectAction(): boolean {
    return ['remove', 'include', 'exclude'].includes(this.first());
  }

  private async projectFolder(id: string, path: string[], about: string[]): Promise<void> {
    const known = new ProjectsService(this.ctx).list().projects.map((p) => p.folder);
    const current = this.values.get(id);
    const picked = await this.app.choose<string>(
      path,
      about.join(' '),
      [...known.map((v) => ({ value: v, label: v })), { value: OTHER, label: 'Another folder…' }],
      Array.isArray(current) ? current[0] : undefined,
    );
    if (picked === undefined) return;
    if (picked !== OTHER) {
      this.set(id, [picked]);
      return;
    }
    const folder = await askPath(this.app, { path, title: 'Choose the folder', about, kind: 'dir' });
    if (folder !== undefined) this.set(id, [folder]);
  }

  /** Nothing to pick from (no saved logins, no running session): say what to do, in the form, without an error. */
  private nothingToChoose(what: string): string {
    return Theme.warn(
      what === 'accounts'
        ? 'No saved logins yet: sign in inside the sandbox, then save it in Accounts.'
        : what === 'sessions'
          ? 'No session is running: start an agent first.'
          : 'There is nothing to choose from yet.',
    );
  }

  /** `data clean` targets, ticked from a list with their sizes (never "all": that is typed on purpose). */
  private async dataTargets(path: string[]): Promise<string[] | undefined> {
    const rows = new DataService(this.ctx).entries().flatMap((e) => {
      const target = cleanTargetOf(e);
      return target ? [{ target, bytes: e.bytes }] : [];
    });
    if (!rows.length) {
      await this.app.message({ path, title: 'Nothing is saved yet', lines: ['There is nothing to delete.'] });
      return undefined;
    }
    const picked = await this.app.list<string>({
      path: [...path, 'Delete what'],
      intro: 'Tick what to delete (space), then Enter. You confirm once more before anything is deleted.',
      multi: true,
      items: rows.map((r) => ({ value: r.target, label: r.target, hint: humanBytes(r.bytes) })),
    });
    return picked.kind === 'multi' && picked.values.length ? picked.values : undefined;
  }
}
