// Every setting of a file as rows: which settings there are (from the schema, nothing listed by hand), where they are
// shown (category and heading), their Field, and their values in this file, in your settings and in the project's,
// with secrets as ***. The settings query sends these rows; the menu lays its unsaved changes over them (`source`).
import _ from 'lodash';
import { NEVER_LOOSER } from '../../../core/local-config/index.js';
import { redactSecrets } from '../../../core/schema/index.js';
import type { Config } from '../../../core/types.js';
import { fail } from '../../../core/util/index.js';
import { closest } from '../../../cli/validate.js';
import { fieldOf, type SchemaNode } from '../../kernel/index.js';
import { categoryOf, labelOf, nameOf } from './categories.def.js';
import type { Scope, SettingRow } from './settings.def.js';
import type { ConfigFile } from './settings-file.js';

/** One editable setting with the category and heading it is shown under. */
export interface Setting {
  readonly key: string[];
  readonly node: SchemaNode;
  readonly category: string;
  readonly section?: string;
}

/** Every editable setting of a file, each in its category (settings covered by another section are left out). */
export function settingsOf(file: ConfigFile): Setting[] {
  return file.schema.children().flatMap(([top, node]) => {
    const category = categoryOf(top);
    if (!category) return [];
    const several = category.keys.filter((k) => file.schema.child(k)).length > 1;
    if (!node.isSection)
      return [
        {
          key: [top],
          node,
          category: category.id,
          section: several && category.id !== 'general' ? nameOf(top) : undefined,
        },
      ];
    return node.leaves([top]).map(({ key, node: leaf }) => {
      const heading = [
        several ? nameOf(top) : undefined,
        key.length > 2 ? key.slice(1, -1).map(nameOf).join(' › ') : undefined,
      ]
        .filter(Boolean)
        .join(' › ');
      return { key, node: leaf, category: category.id, section: heading || undefined };
    });
  });
}

/** Your own settings and this folder's project file. */
export type SettingsFiles = Readonly<Record<Scope, ConfigFile>>;

/** Where values come from: the files as saved, or with the menu's unsaved changes laid over them. */
export interface SettingsSource {
  /** What the file says (undefined: not set there). */
  written(file: ConfigFile, key: string[]): unknown;
  /** What is in effect: your file merged with the defaults, or only what a project file says. */
  effective(file: ConfigFile, key: string[], config: Config): unknown;
}

/** The files as they are on disk. */
export const SAVED: SettingsSource = {
  written: (file, key) => file.valueInFile(key),
  effective: (file, key, config) => (file.isProject ? file.valueInFile(key) : _.get(config, key)),
};

/** A value with every secret in it replaced by *** (as the whole settings object would be redacted). */
export function masked(key: readonly string[], value: unknown): unknown {
  if (value === undefined) return undefined;
  return _.get(redactSecrets(_.set({}, key, structuredClone(value))), key);
}

/** The keys a project file's schema can set, worked out once per schema (a list asks for it on every row). */
const projectKeysOf = new WeakMap<SchemaNode, ReadonlySet<string>>();

/** The keys a project file can set. */
function projectKeys(files: SettingsFiles): ReadonlySet<string> {
  const schema = files.project.schema;
  let keys = projectKeysOf.get(schema);
  if (!keys) {
    keys = new Set(schema.leaves().map((l) => l.key.join('.')));
    projectKeysOf.set(schema, keys);
  }
  return keys;
}

/** One setting's row in a scope (`config` and `inProject` can be passed when making many rows). */
export function settingRow(
  s: Setting,
  files: SettingsFiles,
  scope: Scope,
  source: SettingsSource = SAVED,
  config: Config = files.user.userConfig(),
  inProject: ReadonlySet<string> = projectKeys(files),
): SettingRow {
  const file = files[scope];
  const id = s.key.join('.');
  return {
    id,
    key: s.key,
    label: labelOf(s.key),
    category: s.category,
    ...(s.section ? { section: s.section } : {}),
    field: fieldOf(s.node, s.key, labelOf(s.key)),
    value: masked(s.key, source.effective(file, s.key, config)),
    set: source.written(file, s.key) !== undefined,
    yours: masked(s.key, source.effective(files.user, s.key, config)),
    yoursSet: source.written(files.user, s.key) !== undefined,
    inProject: inProject.has(id) ? masked(s.key, source.written(files.project, s.key)) : undefined,
    ...(file.isProject ? {} : { default: masked(s.key, file.defaultOf(s.key)) }),
    locked: NEVER_LOOSER.includes(id),
  };
}

/** Every setting's row in a scope (one read of your settings for all of them). */
export function settingRows(files: SettingsFiles, scope: Scope, source: SettingsSource = SAVED): SettingRow[] {
  const config = files.user.userConfig();
  const inProject = projectKeys(files);
  return settingsOf(files[scope]).map((s) => settingRow(s, files, scope, source, config, inProject));
}

/** The setting a key names in a file's schema; an unknown key says what is close. */
export function findSetting(file: ConfigFile, key: string): { key: string[]; node: SchemaNode } {
  const keyPath = key.split('.');
  let node: SchemaNode | undefined = file.schema;
  for (const part of keyPath) node = node?.child(part);
  if (node) return { key: keyPath, node };
  const hint = closest(
    key,
    file.schema.leaves().map((l) => l.key.join('.')),
  );
  return fail(
    'There is no setting "' +
      key +
      '"' +
      (file.isProject ? ' a project can set' : '') +
      '.' +
      (hint ? ' Did you mean ' + hint + '?' : ''),
    'Settings are named like sandbox.memoryMb. See them all with: sandbox config show',
  );
}
