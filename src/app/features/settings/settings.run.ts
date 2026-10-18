// The settings feature's work: the rows of a scope, and one setting read, changed or reset. Files are changed one
// setting at a time with comments kept, and nothing is written unless the whole file stays valid (settings-file.ts).
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { loadConfig } from '../../../core/config/index.js';
import { redactSecrets } from '../../../core/schema/index.js';
import type { Config } from '../../../core/types.js';
import { fail, safeText, writeJson } from '../../../core/util/index.js';
import { hereDir } from '../../../cli/commands/projects/here.js';
import { implement, type AppContext } from '../../context.js';
import { allowedText, cancelled, valueFromText } from '../../kernel/index.js';
import { CATEGORIES } from './categories.def.js';
import { ConfigFile } from './settings-file.js';
import { diffText, exportSettings, planImport, skippedLine, type ImportPlan } from './settings-share.js';
import { findSetting, masked, settingRows, type SettingsFiles } from './settings-rows.js';
import {
  exportConfig,
  getSetting,
  importConfig,
  listSettings,
  resetSetting,
  setSetting,
  type Scope,
} from './settings.def.js';

/** The file `sandbox config export` writes when none is named. */
export const DEFAULT_EXPORT = 'sandbox-settings.json';

/** A shared file is a few KB; anything bigger is not one. */
const MAX_BYTES = 1024 * 1024;

/** Your own settings file (the one --config names) and the project file of the current folder. */
export function settingsFiles(ctx: AppContext): SettingsFiles {
  return { user: ConfigFile.user(ctx.loaded.configPath), project: ConfigFile.project(hereDir(ctx)) };
}

/** A typed or sent value as the setting reads it: text goes through the command line's rules (true/on, numbers ...). */
function valueFor(node: Parameters<typeof valueFromText>[0], value: unknown): unknown {
  return typeof value === 'string' ? valueFromText(node, value) : value;
}

export const listSettingsRun = implement(listSettings, (ctx, input) => {
  const files = settingsFiles(ctx);
  const file = files[input.scope];
  const rows = settingRows(files, input.scope).filter((r) => input.scope === 'project' || r.id !== 'storage.root');
  return {
    scope: input.scope,
    file: file.file,
    exists: file.exists,
    ...(input.scope === 'user' ? { dataFolder: ctx.storageRoot, exportFile: path.resolve(DEFAULT_EXPORT) } : {}),
    categories: CATEGORIES.filter((c) => rows.some((r) => r.category === c.id)).map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
    })),
    rows,
  };
});

export const getSettingRun = implement(getSetting, (ctx, input) => {
  const file = settingsFiles(ctx).user;
  const { key } = findSetting(file, input.key);
  // Secret values (an agent's API keys) are never shown.
  return { key: input.key, value: _.get(redactSecrets(file.userConfig()), key) as unknown };
});

/** The file of a scope, and the setting a key names in it. */
function target(ctx: AppContext, scope: Scope, name: string): ReturnType<typeof findSetting> & { file: ConfigFile } {
  const file = settingsFiles(ctx)[scope];
  return { ...findSetting(file, name), file };
}

export const setSettingRun = implement(setSetting, (ctx, input) => {
  const { key, node, file } = target(ctx, input.scope, input.key);
  if (node.isSection)
    fail('"' + input.key + '" is a group of settings.', 'Set one of them, e.g. ' + node.leaves(key)[0]?.key.join('.'));
  const value = valueFor(node, input.value);
  const problem = node.check(value);
  if (problem !== true) {
    const typed = typeof input.value === 'string' ? input.value : JSON.stringify(masked(key, input.value));
    fail('"' + typed + '" does not work for ' + input.key + ': ' + problem, allowedText(node));
  }
  const outcome = file.set(key, value);
  if (typeof outcome === 'object')
    fail('Could not change ' + input.key + ': ' + outcome.problems.join('; '), 'Nothing was written.');
  return {
    key: input.key,
    changed: outcome === 'saved',
    message:
      input.key +
      ' is ' +
      JSON.stringify(masked(key, value)) +
      (outcome === 'unchanged' ? ' (it was already)' : '') +
      '.',
  };
});

export const resetSettingRun = implement(resetSetting, (ctx, input) => {
  const { key, file } = target(ctx, input.scope, input.key);
  const outcome = file.set(key, undefined);
  if (typeof outcome === 'object')
    fail('Could not reset ' + input.key + ': ' + outcome.problems.join('; '), 'Nothing was written.');
  return {
    key: input.key,
    changed: outcome === 'saved',
    message: file.isProject
      ? input.key + ' is not set in ' + file.file + ' any more.'
      : input.key + ' is back to its default: ' + JSON.stringify(masked(key, file.defaultOf(key))) + '.',
  };
});

/** Your settings as they are on disk now (the menu may have saved changes since it started). */
function freshConfig(ctx: AppContext): Config {
  return loadConfig(ctx.loaded.configPath ?? undefined).config;
}

/** Reads a shared file and plans the import. Fails with the reason when it cannot be read. */
function readImport(config: Config, file: string): ImportPlan {
  const source = path.resolve(file);
  if (!fs.existsSync(source))
    fail('There is no file ' + source + '.', 'Give the path of a file made by sandbox config export.');
  if (fs.statSync(source).size > MAX_BYTES) fail(source + ' is too big to be a settings file.');
  const plan = planImport(fs.readFileSync(source, 'utf8'), config);
  if (plan.problems.length)
    fail(
      source + ' is not valid settings:\n  ' + plan.problems.map(safeText).join('\n  '),
      'Nothing was changed. Fix the file, or export a new one with: sandbox config export',
    );
  return plan;
}

/** Writes the planned changes to your settings file (comments stay); returns how many settings changed. */
function applyImport(ctx: AppContext, plan: ImportPlan): number {
  const outcome = ConfigFile.user(ctx.loaded.configPath).setMany(plan.changes);
  if (typeof outcome === 'object')
    fail('Could not import: ' + outcome.problems.join('; '), 'Nothing was written. Your settings are unchanged.');
  return plan.changes.length;
}

export const exportConfigRun = implement(exportConfig, async (ctx, input, io) => {
  const target = path.resolve(input.settingsFile ?? DEFAULT_EXPORT);
  if (fs.existsSync(target)) {
    const replace = await io.confirm({
      title: target + ' exists. Replace it?',
      yes: 'Replace',
      noTerminal: { message: target + ' exists already.', fix: 'Pick another name, or delete it first.' },
    });
    if (!replace) cancelled();
  }
  const { data, skipped } = exportSettings(freshConfig(ctx), input.withPaths);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeJson(target, data);
  return {
    file: target,
    leftOut: skipped.map(skippedLine),
    pathsLeftOut: !input.withPaths && skipped.some((s) => s.why === 'path'),
  };
});

export const importConfigRun = implement(importConfig, async (ctx, input, io) => {
  const file =
    input.settingsFile ??
    (await io.path({
      title: 'Which settings file',
      lines: ['A file made by Export settings (or sandbox config export).'],
      pathKind: 'file',
    }));
  if (file === undefined) cancelled();
  const plan = readImport(freshConfig(ctx), file);
  if (plan.skipped.length) {
    io.log('Not imported (never taken from a file):');
    for (const s of plan.skipped) io.log('  ' + safeText(skippedLine(s)));
  }
  const n = plan.changes.length;
  if (!n) return { changed: 0, message: 'Nothing to change: your settings already match the file.' };
  io.log('This would change ' + n + ' setting' + (n === 1 ? '' : 's') + ':');
  for (const line of diffText(plan.lines)) io.log('  ' + safeText(line));
  const yes = await io.confirm({
    title: 'Change your settings like this?',
    yes: 'Change',
    noTerminal: { message: 'Cannot ask here (no terminal).', fix: 'Add --yes to change them without asking.' },
  });
  if (!yes) cancelled('Nothing was changed.');
  const changed = applyImport(ctx, plan);
  return {
    changed,
    message: 'Imported ' + changed + ' setting' + (changed === 1 ? '' : 's') + '. New sandboxes use them.',
  };
});
