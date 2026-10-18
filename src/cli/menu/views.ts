// The shared core's views the menu shows, and in which section (the parity self-test reads this list: an operation or
// query is reachable in the menu when a view here offers it). Settings is drawn by its own page over the same rows,
// because the menu stages changes until Ctrl+S.
import { agentsView } from '../../app/features/agents/index.js';
import { dataView } from '../../app/features/data/index.js';
import { accountsView } from '../../app/features/accounts/index.js';
import { appsView } from '../../app/features/apps/index.js';
import { healthView } from '../../app/features/health/index.js';
import { logsView } from '../../app/features/logs/index.js';
import { projectsView } from '../../app/features/projects/index.js';
import { sandboxView } from '../../app/features/sandbox/index.js';
import { sessionsView } from '../../app/features/sessions/index.js';
import { storageView } from '../../app/features/storage/index.js';
import { settingsView } from '../../app/features/settings/index.js';
import { engineView } from '../../app/features/engine/index.js';
import { updatesView } from '../../app/features/updates/index.js';
import { webView } from '../../app/features/web/index.js';
import { vpnView } from '../../app/features/vpn/index.js';
import { githubView } from '../../app/features/github/index.js';
import type { AnyView } from '../../app/kernel/index.js';
import type { SECTION_LABELS } from './shell.js';

export interface MenuViewPlace {
  readonly view: AnyView;
  readonly section: (typeof SECTION_LABELS)[number];
}

export const MENU_VIEWS: readonly MenuViewPlace[] = [
  { view: agentsView, section: 'Agents' },
  { view: sessionsView, section: 'Sessions' },
  { view: sandboxView, section: 'Sandbox' },
  { view: settingsView, section: 'Settings' },
  { view: accountsView, section: 'Accounts' },
  { view: appsView, section: 'Apps' },
  { view: projectsView, section: 'Sandbox' },
  { view: healthView, section: 'Maintenance' },
  { view: dataView, section: 'Maintenance' },
  { view: storageView, section: 'Maintenance' },
  { view: logsView, section: 'Maintenance' },
  { view: updatesView, section: 'Maintenance' },
  { view: engineView, section: 'Maintenance' },
  { view: webView, section: 'Maintenance' },
  // The Settings page draws the VPN row itself (its login is staged with the settings); the view lists its operations.
  { view: vpnView, section: 'Settings' },
  // The same for the GitHub token row.
  { view: githubView, section: 'Settings' },
];
