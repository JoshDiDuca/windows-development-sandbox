// The pure half of the registry: every operation, query and view by id, and the web UI's navigation. The browser
// bundle imports this file (and through it only *.def.ts files); app/registry.ts adds the run functions on the Node
// side. A new feature adds its definitions here and its implementations there.
import type { AnyDefinition, AnyView, OperationDef, QueryDef } from '../kernel/index.js';
import { addAgent, agentsView, listAgents, makeDefaultAgent, removeAgent, startAgent } from './agents/agents.def.js';
import {
  accountsView,
  defaultAccount,
  listAccounts,
  removeAccount,
  renameAccount,
  saveAccount,
  useAccount,
} from './accounts/accounts.def.js';
import { appsView, listApps, requestApp, setCustomApps, toggleApp } from './apps/apps.def.js';
import { browseFolder } from './files/files.def.js';
import { checkEngine, cleanEngine, engineLeftovers, engineStatus, engineView } from './engine/engine.def.js';
import { checkHealth, enableSandbox, healthView, lastHealth, repairHealth } from './health/health.def.js';
import { cleanData, dataView, pruneStorage, showData } from './data/data.def.js';
import {
  changeDataFolder,
  containedOff,
  containedOn,
  containedStatus,
  moveStorage,
  showStorage,
  storageView,
  useStorage,
} from './storage/storage.def.js';
import { hideWindow, sandboxStatus, sandboxView, showWindow, stopSandbox } from './sandbox/sandbox.def.js';
import {
  addProject,
  allProjects,
  chooseProjects,
  excludeProject,
  includeProject,
  listProjects,
  projectRoots,
  projectsView,
  removeProject,
} from './projects/projects.def.js';
import { listLogs, logsView, tailLog } from './logs/logs.def.js';
import { auditView, listAudit } from './audit/audit.def.js';
import { listSessions, restartSessions, sessionsView } from './sessions/sessions.def.js';
import { vpnLogin, vpnLogout, vpnStatus, vpnView } from './vpn/vpn.def.js';
import { githubLogin, githubLogout, githubStatus, githubView } from './github/github.def.js';
import {
  exportConfig,
  getSetting,
  importConfig,
  listSettings,
  resetSetting,
  setSetting,
  settingsView,
} from './settings/settings.def.js';
import { migrateSettings, runUpdate, updatesStatus, updatesView } from './updates/updates.def.js';
import { openWeb, startWeb, stopWeb, webStatus, webView } from './web/web.def.js';
import {
  accessStatus,
  accessView,
  allowDevice,
  lanOff,
  lanOn,
  revokeAccess,
  revokeAllAccess,
} from './access/access.def.js';

export type { AgentRow, AgentsList } from './agents/agents.def.js';
export type { AccountRow, AccountsList, AgentAccounts } from './accounts/accounts.def.js';
export type { AppRow, AppsList, CustomAppRow } from './apps/apps.def.js';
export type { FolderEntry, FolderListing } from './files/files.def.js';
export type { LogFileRow, LogFiles, LogTail } from './logs/logs.def.js';
export type { AuditList, AuditRow, AuditSession } from './audit/audit.def.js';
export type { ProjectRow, ProjectsList } from './projects/projects.def.js';
export type { SandboxStatus } from './sandbox/sandbox.def.js';
export type { SessionRow, SessionsList } from './sessions/sessions.def.js';
export type { SettingRow, SettingsList } from './settings/settings.def.js';
export type { VpnStatus } from './vpn/vpn.def.js';
export type { GithubStatus } from './github/github.def.js';
export type { AccessStatus } from './access/access.def.js';

export const OPERATIONS = [
  cleanEngine,
  showWindow,
  hideWindow,
  stopSandbox,
  restartSessions,
  startAgent,
  addAgent,
  makeDefaultAgent,
  removeAgent,
  setSetting,
  resetSetting,
  exportConfig,
  importConfig,
  saveAccount,
  useAccount,
  defaultAccount,
  renameAccount,
  removeAccount,
  toggleApp,
  setCustomApps,
  requestApp,
  chooseProjects,
  addProject,
  removeProject,
  includeProject,
  excludeProject,
  allProjects,
  projectRoots,
  checkHealth,
  repairHealth,
  enableSandbox,
  cleanData,
  pruneStorage,
  runUpdate,
  migrateSettings,
  moveStorage,
  useStorage,
  changeDataFolder,
  containedOn,
  containedOff,
  startWeb,
  openWeb,
  stopWeb,
  vpnLogin,
  vpnLogout,
  githubLogin,
  githubLogout,
  allowDevice,
  revokeAccess,
  revokeAllAccess,
  lanOn,
  lanOff,
] as const;
export const QUERIES = [
  sandboxStatus,
  listSessions,
  listAgents,
  listSettings,
  getSetting,
  browseFolder,
  listAccounts,
  listApps,
  listProjects,
  lastHealth,
  showData,
  showStorage,
  containedStatus,
  listLogs,
  tailLog,
  listAudit,
  updatesStatus,
  engineStatus,
  checkEngine,
  engineLeftovers,
  webStatus,
  vpnStatus,
  githubStatus,
  accessStatus,
] as const;
export const VIEWS = [
  sandboxView,
  sessionsView,
  agentsView,
  settingsView,
  accountsView,
  appsView,
  projectsView,
  healthView,
  dataView,
  storageView,
  logsView,
  auditView,
  updatesView,
  engineView,
  webView,
  vpnView,
  githubView,
  accessView,
] as const;

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
  /** The view this entry opens (an entry has a view, or children, or says where the area is). */
  readonly view?: ViewId;
  /** Where the area is today when it has no view yet. */
  readonly elsewhere?: string;
  /** Entries under this one (Sandbox: Status, Projects). */
  readonly children?: readonly NavSection[];
  /** Views shown as more categories inside this entry's page (Settings: VPN, GitHub), not as entries of their own. */
  readonly embeds?: readonly { readonly label: string; readonly view: ViewId }[];
}

/** Every entry of the navigation, children included, in order. */
export function navSections(nav: readonly NavSection[]): NavSection[] {
  return nav.flatMap((n) => [n, ...navSections(n.children ?? [])]);
}

/** Every view the web's navigation opens. */
export function navViews(nav: readonly NavSection[]): ViewId[] {
  return navSections(nav).flatMap((n) => [...(n.view ? [n.view] : []), ...(n.embeds ?? []).map((e) => e.view)]);
}

/** The entry whose page shows this view as one of its categories (VPN: Settings), if any. */
export function embeddingOf(nav: readonly NavSection[], view: string): NavSection | undefined {
  return navSections(nav).find((n) => n.embeds?.some((e) => e.view === view));
}

export const NAV: readonly NavSection[] = [
  { label: 'Agents', view: 'agents' },
  { label: 'Sessions', view: 'sessions' },
  { label: 'Activity', view: 'audit' },
  {
    label: 'Sandbox',
    children: [
      { label: 'Status', view: 'sandbox' },
      { label: 'Projects', view: 'projects' },
    ],
  },
  { label: 'Apps', view: 'apps' },
  {
    label: 'Settings',
    view: 'settings',
    embeds: [
      { label: 'VPN', view: 'vpn' },
      { label: 'GitHub', view: 'github' },
    ],
  },
  { label: 'Accounts', view: 'accounts' },
  { label: 'Remote access', view: 'access' },
  {
    label: 'Maintenance',
    children: [
      { label: 'Updates', view: 'updates' },
      { label: 'Data', view: 'data' },
      { label: 'Storage', view: 'storage' },
      { label: 'Health', view: 'health' },
      { label: 'Logs', view: 'logs' },
      { label: 'Engine', view: 'engine' },
      {
        label: 'More',
        elsewhere: 'The less common commands are in the menu (sandbox > Maintenance).',
      },
    ],
  },
];
