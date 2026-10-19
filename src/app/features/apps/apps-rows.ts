// The apps as rows: every catalogue entry this scope can change, its group, whether it is downloaded already and
// whether it is on, plus your own programs. Values come from an AppsSource: the files as saved (SAVED), or the menu's
// staged changes laid over them (the menu's draftSource). The menu and the web both build their lists from these rows.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { APPS, type AppEntry } from '../../../shared/apps/index.js';
import { fieldOf } from '../../kernel/index.js';
import { labelOf } from '../settings/categories.def.js';
import type { ConfigFile } from '../settings/settings-file.js';
import { findSetting } from '../settings/settings-rows.js';
import { groupOf, type AppRow, type CustomAppRow } from './apps.def.js';

export const INSTALL = ['apps', 'install'];
export const CUSTOM_KEY = ['apps', 'custom'];

/** One program of your own, as apps.custom stores it. */
export interface CustomProgram {
  readonly name: string;
  readonly github?: string;
  readonly url?: string;
  readonly cli?: boolean;
}

/** Where the values come from: the files, or the files with unsaved changes laid over them. */
export interface AppsSource {
  /** apps.install as this scope will have it (undefined: not set). */
  install(file: ConfigFile): string[] | undefined;
  /** A setting-backed entry's value (VS Code: vscode.enabled ...). */
  setting(file: ConfigFile, key: string[]): unknown;
  /** Your own programs (none for a project). */
  custom(file: ConfigFile): Record<string, CustomProgram>;
}

/** The files as they are on disk. */
export const SAVED: AppsSource = {
  install: (file) =>
    (file.isProject ? file.valueInFile(INSTALL) : file.userConfig().apps.install) as string[] | undefined,
  setting: (file, key) => _.get(file.userConfig(), key) as unknown,
  custom: (file) => (file.isProject ? {} : (file.userConfig().apps.custom as Record<string, CustomProgram>)),
};

/**
 * The catalogue entries a file can change (a project cannot change an app that has a setting of its own, nor an agent
 * add-on that is yours only).
 */
export function entriesOf(file: ConfigFile): AppEntry[] {
  return APPS.filter((a) => !(file.isProject && (a.setting || a.userOnly)));
}

/** Downloaded already (into this data folder), so the next sandbox starts it without a download. */
function installed(entry: AppEntry, dataPath: string): boolean {
  if (entry.id === 'vscode') return fs.existsSync(path.join(dataPath, 'tools', 'vscode', 'Code.exe'));
  if (entry.id === 'windows-terminal')
    return fs.existsSync(path.join(dataPath, 'tools', 'terminal', 'WindowsTerminal.exe'));
  return fs.existsSync(path.join(dataPath, 'tools', 'apps', entry.id, '.agent-sandbox-app'));
}

/** Is the entry on in this source? */
export function appIsOn(entry: AppEntry, file: ConfigFile, source: AppsSource): boolean {
  if (entry.setting) return source.setting(file, entry.setting.split('.')) === true;
  return (source.install(file) ?? []).includes(entry.id);
}

/** A setting-backed entry's own Field and value (VS Code: on, off or "auto"). */
function settingParts(entry: AppEntry, file: ConfigFile, source: AppsSource): Partial<AppRow> {
  if (!entry.setting) return {};
  const found = findSetting(file, entry.setting);
  return {
    setting: entry.setting,
    settingField: fieldOf(found.node, found.key, labelOf(found.key)),
    settingValue: source.setting(file, found.key),
  };
}

/** Every app this scope can change, as a row. */
export function appRows(file: ConfigFile, dataPath: string, source: AppsSource = SAVED): AppRow[] {
  return entriesOf(file).map((entry) => ({
    id: entry.id,
    name: entry.name,
    about: entry.about,
    group: groupOf(entry.category),
    size: entry.size,
    cli: Boolean(entry.cli),
    mesa: entry.needs?.includes('mesa') ?? false,
    fullGitOnly: Boolean(entry.fullGitOnly),
    ...(entry.plugsInto ? { plugsInto: entry.plugsInto } : {}),
    ...(entry.service ? { service: true } : {}),
    ...settingParts(entry, file, source),
    installed: installed(entry, dataPath),
    on: appIsOn(entry, file, source),
  }));
}

/** Your own programs as rows (none for a project). */
export function customRows(file: ConfigFile, source: AppsSource = SAVED): CustomAppRow[] {
  return Object.entries(source.custom(file)).map(([id, a]) => ({
    id,
    name: a.name,
    from: a.github ? 'From the latest ' + a.github + ' release.' : 'From ' + String(a.url),
    cli: Boolean(a.cli),
  }));
}
