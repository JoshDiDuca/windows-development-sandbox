// The apps feature's work: the rows of a scope, an app switched on or off, your own programs saved, and the request
// page opened in this PC's browser. Writes go through ConfigFile like the settings do (comments kept, nothing written
// unless the file stays valid).
import { APPS } from '../../../shared/apps/index.js';
import { errMsg, fail } from '../../../core/util/index.js';
import { openIssuePage } from '../../../host/web/index.js';
import { implement } from '../../context.js';
import { allowedText, fieldOf, valueFromText } from '../../kernel/index.js';
import { settingsFiles } from '../settings/settings.run.js';
import { appRows, customRows, CUSTOM_KEY, INSTALL, SAVED } from './apps-rows.js';
import { listApps, requestApp, requestAppUrl, setCustomApps, toggleApp } from './apps.def.js';

export const listAppsRun = implement(listApps, (ctx, input) => {
  const file = settingsFiles(ctx)[input.scope];
  const own = input.scope === 'user';
  const node = own ? file.schema.child('apps')?.child('custom') : undefined;
  return {
    scope: input.scope,
    file: file.file,
    exists: file.exists,
    apps: appRows(file, ctx.dataPath),
    custom: own ? customRows(file) : [],
    ...(own ? { customValue: SAVED.custom(file) } : {}),
    ...(node ? { customField: fieldOf(node, CUSTOM_KEY, 'Your own programs') } : {}),
  };
});

export const toggleAppRun = implement(toggleApp, (ctx, input) => {
  const file = settingsFiles(ctx)[input.scope];
  const entry = APPS.find((a) => a.id === input.id);
  if (!entry || (file.isProject && (entry.setting || entry.userOnly)))
    fail('"' + input.id + '" is not an app this scope can change.', 'Pick one of the apps the Apps page lists.');
  const name = entry.name;
  // A setting-backed app (VS Code, Windows Terminal) is its setting; a catalogue app is one id in apps.install.
  const key = entry.setting ? entry.setting.split('.') : INSTALL;
  let value: unknown = input.on;
  if (!entry.setting) {
    const current = SAVED.install(file) ?? [];
    const next = input.on
      ? current.includes(entry.id)
        ? current
        : [...current, entry.id]
      : current.filter((id) => id !== entry.id);
    // Your own file keeps no empty list (back to the default); a project file always says what it chooses.
    value = next.length || file.isProject ? next : undefined;
  }
  const outcome = file.set(key, value);
  if (typeof outcome === 'object')
    fail('Could not change ' + key.join('.') + ': ' + outcome.problems.join('; '), 'Nothing was written.');
  const said = input.on ? name + ' is installed in every sandbox.' : name + ' is no longer installed.';
  return { message: said + (outcome === 'unchanged' ? ' (it was already)' : '') };
});

export const setCustomAppsRun = implement(setCustomApps, (ctx, input) => {
  if (input.scope === 'project')
    fail('Your own programs are set in your own settings only.', 'Switch to All projects.');
  const file = settingsFiles(ctx).user;
  const node = file.schema.child('apps')?.child('custom');
  if (!node) fail('Your own programs are not a setting of this version.', 'Update sandbox, then try again.');
  const value = typeof input.value === 'string' ? valueFromText(node, input.value) : input.value;
  const problem = node.check(value);
  if (problem !== true) fail('That does not work for apps.custom: ' + problem, allowedText(node));
  const outcome = file.set(CUSTOM_KEY, value);
  if (typeof outcome === 'object')
    fail('Could not change apps.custom: ' + outcome.problems.join('; '), 'Nothing was written.');
  return { message: 'Your own programs are saved.' };
});

export const requestAppRun = implement(requestApp, () => {
  const url = requestAppUrl();
  try {
    openIssuePage(url);
  } catch (e) {
    fail(errMsg(e), 'Open it yourself: ' + url);
  }
  return { url };
});
