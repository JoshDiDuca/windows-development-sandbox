// The shared core's views the menu shows, and in which section (the parity self-test reads this list: an operation or
// query is reachable in the menu when a view here offers it). Settings is drawn by its own page over the same rows,
// because the menu stages changes until Ctrl+S.
import { engineView } from '../../app/features/engine/index.js';
import { sandboxView } from '../../app/features/sandbox/index.js';
import { sessionsView } from '../../app/features/sessions/index.js';
import { settingsView } from '../../app/features/settings/index.js';
import type { AnyView } from '../../app/kernel/index.js';
import type { SECTION_LABELS } from './shell.js';

export interface MenuViewPlace {
  readonly view: AnyView;
  readonly section: (typeof SECTION_LABELS)[number];
}

export const MENU_VIEWS: readonly MenuViewPlace[] = [
  { view: sessionsView, section: 'Sessions' },
  { view: sandboxView, section: 'Sandbox' },
  { view: settingsView, section: 'Settings' },
  { view: engineView, section: 'Maintenance' },
];
