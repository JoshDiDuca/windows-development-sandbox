export {
  type AppCategory,
  APP_CATEGORIES,
  type AppSource,
  type AppEntry,
  APPS,
  appById,
  RTK_VERSION,
} from './catalogue.js';
export { exeMatcher, appsToInstall, appsNeedMesa } from './selection.js';
export { claudeManagedSettings, type ManagedSettings, rtkHookCommand, RTK_GUIDE_LINE } from './agent-addons.js';
