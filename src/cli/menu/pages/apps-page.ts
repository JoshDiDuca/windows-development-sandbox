// Section 4: the apps catalogue. Groups on the left, space ticks, and the ticks are staged until Ctrl+S saves them. Two
// scopes like Settings: apps for every project, or for this project only. The rows come from the apps feature
// (features/apps/apps-rows.ts); the menu only lays its staged ticks over them. The web and the feature write at once
// (apps.toggle), so the staging stays here: "r" runs the feature's request operation, "c" stages your own programs.
import _ from 'lodash';
import { errMsg } from '../../../core/util/index.js';
import {
  APP_GROUPS,
  appIsOn,
  appRows,
  type AppRow,
  type AppsSource,
  customRows,
  CUSTOM_KEY,
  type CustomAppRow,
  entriesOf,
  INSTALL,
  ISSUES_URL,
  requestApp,
  REQUEST_APP,
  SAVED,
} from '../../../app/features/apps/index.js';
import type { ConfigFile } from '../../../app/features/settings/index.js';
import { action } from '../../../app/kernel/index.js';
import { Theme, type App, type Category, type ListItem, type ListOptions, type ListResult } from '../../tui/index.js';
import type { Context } from '../../commands/context.js';
import type { Draft } from '../settings/draft.js';
import { ValueEditor } from '../settings/value-editor.js';
import { MenuOperations } from '../io-menu.js';
import { SCOPES, scopeStatus, type Scope } from './scopes.js';
import { ListPage, type Outcome } from './list-page.js';
import type { ShellExit } from '../shell.js';
import type { Step } from '../../tui/index.js';

/** The apps as the menu shows them: the saved files with this page's staged ticks laid over them. */
export function draftSource(draft: Draft): AppsSource {
  return {
    install: (file) =>
      draft.has(file, INSTALL) ? (draft.value(file, INSTALL) as string[] | undefined) : SAVED.install(file),
    setting: (file, key) => (draft.has(file, key) ? draft.value(file, key) : SAVED.setting(file, key)),
    custom: (file) =>
      draft.has(file, CUSTOM_KEY)
        ? (draft.value(file, CUSTOM_KEY) as ReturnType<AppsSource['custom']>)
        : SAVED.custom(file),
  };
}

/** The menu's groups: the feature's groups, and in your own scope "Your own programs". */
export function appsCategories(file: ConfigFile): Category[] {
  return [
    ...APP_GROUPS.map(({ id, label, description }) => ({ id, label, description })),
    ...(file.isProject
      ? []
      : [
          {
            id: 'custom',
            label: 'Your own programs',
            description: 'Programs you added yourself (c to add or change them).',
          },
        ]),
  ];
}

function appItem(row: AppRow): ListItem<string> {
  const notes = [
    Theme.muted('Download  ') +
      '~' +
      row.size +
      ' once, kept in C:\\AgentData\\tools\\' +
      (row.setting ? '' : 'apps\\') +
      row.id,
    Theme.muted('Starts    ') + (row.cli ? 'from a terminal (on PATH)' : 'from the desktop or Start > Sandbox apps'),
    ...(row.mesa ? [Theme.muted('Graphics  ') + 'OpenGL on the CPU (Mesa) is added for it'] : []),
    ...(row.fullGitOnly
      ? [Theme.warn('Needs full git access (Settings > Projects & setup > Git): it pushes with its own git.')]
      : []),
    ...(row.setting ? [Theme.muted('Setting   ') + row.setting] : []),
  ];
  return {
    value: row.id,
    label: row.name,
    category: row.group,
    description: row.about,
    details: notes,
    keywords: row.id,
    hint: (row.installed ? Theme.ok('installed ') : '') + Theme.muted(row.size),
    checked: row.on,
  };
}

function customItem(row: CustomAppRow): ListItem<string> {
  return {
    value: '@custom:' + row.id,
    label: row.name,
    category: 'custom',
    description: row.from,
    hint: Theme.muted(row.cli ? 'command line' : 'desktop'),
    checked: true,
    disabled: 'Your own programs are always installed; c to change or remove them.',
  };
}

/** The menu's rows for a scope, with the staged ticks. */
export function appsItems(file: ConfigFile, dataPath: string, draft: Draft): ListItem<string>[] {
  const source = draftSource(draft);
  return [
    ...appRows(file, dataPath, source).map(appItem),
    ...(file.isProject
      ? []
      : [
          {
            value: REQUEST_APP,
            label: 'Request an app…',
            category: 'custom',
            description:
              'Not in the list? Press r: your browser opens a prefilled request on GitHub (' + ISSUES_URL + ').',
            hint: Theme.muted('press r'),
            disabled: 'Press r to open the request form on GitHub.',
          },
        ]),
    ...customRows(file, source).map(customItem),
  ];
}

/** The list for the apps tab. Pure. */
export function appsOptions(file: ConfigFile, dataPath: string, draft: Draft, scope: Scope): ListOptions<string> {
  return {
    path: [],
    status: scopeStatus(file),
    intro: 'Tick the apps every sandbox should have (space). Each downloads once and is kept. Ctrl+S saves.',
    tabs: { items: SCOPES.map((s) => s.tab), active: SCOPES.findIndex((s) => s.scope === scope) },
    multi: true,
    enterTicks: true,
    categories: appsCategories(file),
    items: appsItems(file, dataPath, draft),
    actions: [
      ...(file.isProject ? [] : [{ key: 'c', label: 'your own programs' }]),
      { key: 'r', label: 'request an app' },
    ],
  };
}

/** Stages the ticks of the list: only what differs from the saved file is kept in the draft. */
export function stageTicks(file: ConfigFile, draft: Draft, ticked: readonly string[]): void {
  const entries = entriesOf(file);
  for (const entry of entries.filter((a) => a.setting)) {
    const key = entry.setting!.split('.');
    const on = ticked.includes(entry.id);
    if (on === appIsOn(entry, file, SAVED)) draft.unstage(file, key);
    else draft.stage(file, key, on);
  }
  const wanted = entries.filter((a) => !a.setting && ticked.includes(a.id)).map((a) => a.id);
  const savedInstall = SAVED.install(file) ?? [];
  if (_.isEqual([...wanted].sort(), [...savedInstall].sort())) draft.unstage(file, INSTALL);
  else draft.stage(file, INSTALL, wanted.length || file.isProject ? wanted : undefined);
}

export class AppsPage extends ListPage<string> {
  readonly label = 'Apps';
  override readonly stages = true;
  private scope: Scope = 'user';
  private readonly operations: MenuOperations;

  constructor(
    app: App,
    private readonly ctx: Context,
    private readonly files: Record<Scope, ConfigFile>,
    private readonly draft: Draft,
  ) {
    super(app);
    this.operations = new MenuOperations(app, ctx);
  }

  private get file(): ConfigFile {
    return this.files[this.scope];
  }

  protected load(): Promise<void> {
    return Promise.resolve();
  }

  protected options(): ListOptions<string> {
    return appsOptions(this.file, this.ctx.dataPath, this.draft, this.scope);
  }

  /** Every tick is staged as it happens, so leaving or saving always sees it. */
  protected override afterKey(): Step<ShellExit> {
    stageTicks(this.file, this.draft, this.ticked());
    return;
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    stageTicks(this.file, this.draft, this.ticked());
    if (result.kind === 'tab') {
      this.scope = SCOPES[result.index].scope;
      return {};
    }
    if (result.kind === 'action' && result.key === 'r')
      return this.operations.perform(action(requestApp, {}), [this.label]);
    if (result.kind !== 'action' || result.key !== 'c') return {};
    const node = this.file.schema.child('apps')?.child('custom');
    if (!node) return {};
    try {
      const edited = await new ValueEditor(this.app).edit(
        ['Apps', 'Your own programs'],
        CUSTOM_KEY,
        node,
        draftSource(this.draft).custom(this.file),
      );
      if (edited) this.draft.stage(this.file, CUSTOM_KEY, edited.value);
    } catch (e) {
      return { notice: Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) };
    }
    return {};
  }
}
