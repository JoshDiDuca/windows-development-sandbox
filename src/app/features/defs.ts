// The pure half of the registry: every operation, query and view by id, and the web UI's navigation. The browser
// bundle imports this file (and through it only *.def.ts files); app/registry.ts adds the run functions on the Node
// side. A new feature adds its definitions here and its implementations there.
import type { AnyDefinition, AnyView, OperationDef, QueryDef } from '../kernel/index.js';
import { browseFolder } from './files/files.def.js';
import { hideWindow, sandboxStatus, sandboxView, showWindow, stopSandbox } from './sandbox/sandbox.def.js';
import { listSessions, restartSessions, sessionsView } from './sessions/sessions.def.js';
import { getSetting, listSettings, resetSetting, setSetting, settingsView } from './settings/settings.def.js';
import { vpnLogin, vpnLogout, vpnStatus, vpnView } from './vpn/vpn.def.js';

export type { FolderEntry, FolderListing } from './files/files.def.js';
export type { SandboxStatus } from './sandbox/sandbox.def.js';
export type { SessionRow, SessionsList } from './sessions/sessions.def.js';
export type { SettingRow, SettingsList } from './settings/settings.def.js';
export type { VpnStatus } from './vpn/vpn.def.js';

export const OPERATIONS = [
  showWindow,
  hideWindow,
  stopSandbox,
  restartSessions,
  setSetting,
  resetSetting,
  vpnLogin,
  vpnLogout,
] as const;
export const QUERIES = [sandboxStatus, listSessions, listSettings, getSetting, browseFolder, vpnStatus] as const;
export const VIEWS = [sandboxView, sessionsView, settingsView, vpnView] as const;

export type Operation = (typeof OPERATIONS)[number];
export type Query = (typeof QUERIES)[number];
export type View = (typeof VIEWS)[number];
export type OperationId = Operation['id'];
export type QueryId = Query['id'];
export type ViewId = View['id'];
export type OperationById<Id extends OperationId> = Extract<Operation, { id: Id }>;
export type QueryById<Id extends QueryId> = Extract<Query, { id: Id }>;
export type ViewById<Id extends ViewId> = Extract<View, { id: Id }>;

export const DEFINITIONS: readonly AnyDefinition[] = [...OPERATIONS, ...QUERIES];

export function definitionById(id: string): AnyDefinition | undefined {
  return DEFINITIONS.find((d) => d.id === id);
}

export function operationById(id: string): OperationDef | undefined {
  return OPERATIONS.find((d) => d.id === id);
}

export function queryById(id: string): QueryDef | undefined {
  return QUERIES.find((d) => d.id === id);
}

export function viewById(id: string): AnyView | undefined {
  return VIEWS.find((v) => v.id === id);
}

/** One section of the web UI's navigation: the menu's sections in its order; `view` once the area is a feature. */
export interface NavSection {
  readonly label: string;
  readonly view?: ViewId;
  /** Where the area is today when it has no view yet. */
  readonly elsewhere?: string;
}

export const NAV: readonly NavSection[] = [
  { label: 'Agents', elsewhere: 'Start agents from the menu (sandbox) or with sandbox <agent>.' },
  { label: 'Sessions', view: 'sessions' },
  { label: 'Sandbox', view: 'sandbox' },
  { label: 'Apps', elsewhere: 'Choose apps in the menu (sandbox > Apps).' },
  { label: 'Settings', view: 'settings' },
  // TODO: move under Settings (children) once NavSection.children exists (area 2, 02-projects.md).
  { label: 'VPN', view: 'vpn' },
  { label: 'Accounts', elsewhere: 'Manage logins in the menu (sandbox > Accounts) or with sandbox account.' },
  { label: 'Maintenance', elsewhere: 'Doctor, repair, data and updates are in the menu (sandbox > Maintenance).' },
];
