// Section 5: every setting, for all projects or just this project (two scopes), grouped into categories on the left and
// searchable, with each value, its default and its description. The rows (which settings, their values, secrets as
// ***) are the settings feature's; this page lays the unsaved changes over them: changes are staged in the Draft
// (marked *) and written with Ctrl+S; Enter edits, r resets to the default, z undoes an unsaved change.
import _ from 'lodash';
import {
  CATEGORIES,
  labelOf,
  nameOf,
  settingRow,
  settingsOf,
  type ConfigFile,
  type Setting,
  type SettingRow,
  type SettingsSource,
} from '../../../app/features/settings/index.js';
import { vpnLogin, vpnLoginRowOf, vpnLogout, vpnStatus, type VpnStatus } from '../../../app/features/vpn/index.js';
import { action, valueText } from '../../../app/kernel/index.js';
import { readQuery } from '../../../app/registry.js';
import type { Config } from '../../../core/types.js';
import type { Context } from '../../commands/context.js';
import { errMsg } from '../../../core/util/index.js';
import {
  Text,
  Theme,
  type App,
  type Category,
  type ListAction,
  type ListItem,
  type ListOptions,
  type ListResult,
} from '../../tui/index.js';
import { dataFolderRow, DataFolderFlow } from '../data-folder.js';
import { MenuOperations } from '../io-menu.js';
import { EXPORT_SETTINGS, IMPORT_SETTINGS, ShareSettingsFlow, shareSettingsRows } from '../share-settings.js';
import type { Draft } from '../settings/draft.js';
import { ValueEditor } from '../settings/value-editor.js';
import { SCOPES, scopeStatus, type Scope } from './scopes.js';
import { ListPage, type Outcome } from './list-page.js';

export { settingsOf, type Setting };

/** The files with the menu's unsaved changes laid over them. */
function draftSource(draft: Draft): SettingsSource {
  const written = (file: ConfigFile, key: string[]): unknown =>
    draft.has(file, key) ? draft.value(file, key) : file.valueInFile(key);
  return {
    written,
    effective: (file, key, config) =>
      file.isProject
        ? written(file, key)
        : draft.has(file, key)
          ? (draft.value(file, key) ?? file.defaultOf(key))
          : _.get(config, key),
  };
}

/** A value of a row in one short line, painted like every value in the menu. */
function shown(row: SettingRow, value: unknown, max = 60): string {
  const v = valueText(value, row.field, max);
  return v.tone === 'ok' ? Theme.ok(v.text) : v.tone === 'muted' ? Theme.muted(v.text) : v.text;
}

function item(row: SettingRow, file: ConfigFile, draft: Draft): ListItem<string> {
  const unsaved = draft.has(file, row.key);
  const paint = file.isProject ? Theme.project : Theme.changed;
  const value =
    file.isProject && !row.set ? Theme.muted('all projects: ') + shown(row, row.yours, 40) : shown(row, row.value);
  const details = [
    Theme.muted('Setting       ') + row.id,
    Theme.muted('All projects  ') +
      shown(row, row.yours, 40) +
      Theme.muted(row.yoursSet ? '  (your file)' : '  (built-in default)'),
    Theme.muted('This project  ') +
      (row.inProject === undefined ? Theme.muted('not set') : Theme.project(Text.strip(shown(row, row.inProject, 40)))),
    ...(!file.isProject ? [Theme.muted('Default       ') + shown(row, row.default, 40)] : []),
    ...(unsaved ? [Theme.warn('Unsaved: Ctrl+S saves, z undoes this change.')] : []),
    ...(file.isProject && row.locked
      ? [Theme.warn(Theme.glyph.lock + ' A project can only make this stricter than your own setting.')]
      : []),
  ];
  return {
    value: row.id,
    label: row.label,
    hint: unsaved
      ? paint(Text.strip(value)) + ' ' + Theme.warn('*')
      : row.set
        ? paint(Text.strip(value)) + ' ' + paint(Theme.glyph.changed)
        : value,
    description: row.field.help,
    details,
    section: row.section,
    category: row.category,
    keywords: row.id,
    flip: row.field.kind === 'boolean',
  };
}

/** What a setting is now for editing: the staged value, else the file's (a project), else what is in effect. */
function current(file: ConfigFile, draft: Draft, key: string[], config: Config): unknown {
  const source = draftSource(draft);
  return file.isProject ? (source.written(file, key) ?? _.get(config, key)) : source.effective(file, key, config);
}

/** The row in General that opens the data folder flow (your own settings only). */
export const DATA_FOLDER = '@data-folder';

/** The row in Network that sets the VPN login (its operations are the VPN feature's). */
export const VPN_LOGIN = '@vpn-login';

const VPN_PATH = ['Settings', 'Network', 'VPN login'];

/** The list for the settings section. Pure (reads the files it is given). `extra` are rows that are not settings. */
export function settingsOptions(
  files: Record<Scope, ConfigFile>,
  scope: Scope,
  draft: Draft,
  extra: readonly ListItem<string>[] = [],
  extraActions: readonly ListAction<string>[] = [],
): ListOptions<string> {
  const file = files[scope];
  const config = files.user.userConfig();
  // The Data folder row stands in for the storage folder setting (changing it moves the data, which is asked about).
  const hideRoot = !file.isProject && extra.some((e) => e.value === DATA_FOLDER);
  const settings = settingsOf(file).filter((s) => !(hideRoot && s.key.join('.') === 'storage.root'));
  const rows = settings.map((s) => settingRow(s, files, scope, draftSource(draft), config));
  const set = new Set(rows.filter((r) => r.set).map((r) => r.id));
  const unsaved = new Set(rows.filter((r) => draft.has(file, r.key)).map((r) => r.id));
  const categories: Category[] = CATEGORIES.filter((c) => settings.some((s) => s.category === c.id)).map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description,
  }));
  return {
    path: [],
    status: scopeStatus(file),
    tabs: { items: SCOPES.map((x) => x.tab), active: SCOPES.findIndex((x) => x.scope === scope) },
    items: [...rows.map((r) => item(r, file, draft)), ...(file.isProject ? [] : extra)],
    categories,
    actions: [
      { key: 'r', label: file.isProject ? 'remove' : 'reset to default', applies: (id) => set.has(id) },
      { key: 'z', label: 'undo', applies: (id) => unsaved.has(id) },
      ...extraActions,
    ],
    enterLabel: (_category, id) =>
      id === DATA_FOLDER || id === VPN_LOGIN
        ? 'change'
        : id === EXPORT_SETTINGS || id === IMPORT_SETTINGS
          ? 'open'
          : 'edit',
  };
}

export class SettingsPage extends ListPage<string> {
  readonly label = 'Settings';
  override readonly stages = true;
  private scope: Scope = 'user';
  private readonly editor: ValueEditor;
  private readonly operations: MenuOperations;
  private vpn: VpnStatus = {
    enabled: false,
    provider: 'nordvpn',
    protocol: 'udp',
    country: '',
    killSwitch: true,
    login: 'none',
    loginSavedAt: null,
    running: null,
  };

  constructor(
    app: App,
    private readonly files: Record<Scope, ConfigFile>,
    private readonly draft: Draft,
    private readonly ctx: Context,
  ) {
    super(app);
    this.operations = new MenuOperations(app, ctx);
    this.editor = new ValueEditor(app, {
      suggestions: (key) =>
        ['defaultHarness', 'harness'].includes(key.join('.'))
          ? Object.keys(this.files.user.userConfig().harnesses)
          : undefined,
    });
  }

  private get file(): ConfigFile {
    return this.files[this.scope];
  }

  /** The VPN status without asking the sandbox (no request from the menu): the login row needs only its state. */
  protected async load(): Promise<void> {
    this.vpn = await readQuery(vpnStatus, this.ctx, { tunnel: false });
  }

  protected options(): ListOptions<string> {
    const row = dataFolderRow(this.ctx);
    const loginSaved = this.vpn.login !== 'none';
    return settingsOptions(
      this.files,
      this.scope,
      this.draft,
      [
        { value: DATA_FOLDER, category: 'general', ...row },
        { value: VPN_LOGIN, category: 'network', ...vpnLoginRowOf(this.vpn) },
        ...shareSettingsRows().map((r) => ({ ...r, category: 'general' })),
      ],
      loginSaved ? [{ key: 'x', label: 'delete VPN login', applies: (id) => id === VPN_LOGIN }] : [],
    );
  }

  /** Stages a value; your own file never keeps a line that only repeats the default. */
  private stage(key: string[], value: unknown): void {
    const file = this.file;
    if (
      !file.isProject &&
      value !== undefined &&
      _.isEqual(value, file.defaultOf(key)) &&
      file.valueInFile(key) === undefined
    )
      this.draft.unstage(file, key);
    else this.draft.stage(file, key, value);
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    if (result.kind === 'tab') {
      this.scope = SCOPES[result.index].scope;
      return {};
    }
    if (result.kind !== 'pick' && result.kind !== 'action') return {};
    if (result.value === undefined) return {};
    if (result.value === DATA_FOLDER) {
      if (result.kind !== 'pick') return {};
      const exit = await new DataFolderFlow(this.app, this.ctx).run();
      return exit ? { exit } : { reload: true };
    }
    if (result.value === EXPORT_SETTINGS || result.value === IMPORT_SETTINGS) {
      if (result.kind !== 'pick') return {};
      const flow = new ShareSettingsFlow(this.app, this.ctx);
      const notice = await (result.value === EXPORT_SETTINGS ? flow.export() : flow.import());
      return { reload: true, notice };
    }
    if (result.value === VPN_LOGIN) {
      if (result.kind === 'action' && result.key === 'x')
        return this.operations.perform(action(vpnLogout, {}), VPN_PATH, (t) => this.busy(t));
      if (result.kind !== 'pick') return {};
      return this.operations.perform(action(vpnLogin, {}), VPN_PATH, (t) => this.busy(t));
    }
    const setting = settingsOf(this.file).find((s) => s.key.join('.') === result.value);
    if (!setting) return {};
    if (result.kind === 'action') {
      if (result.key === 'z') {
        this.draft.unstage(this.file, setting.key);
        return {};
      }
      this.stage(setting.key, undefined);
      return {};
    }
    try {
      const now = current(this.file, this.draft, setting.key, this.file.userConfig());
      const path = ['Settings', ...setting.key.slice(0, -1).map(nameOf), labelOf(setting.key)];
      const edited = await this.editor.edit(path, setting.key, setting.node, now);
      if (edited) this.stage(setting.key, edited.value);
    } catch (e) {
      return { notice: Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) };
    }
    return {};
  }
}
