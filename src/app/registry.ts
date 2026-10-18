// Every feature's implementation, by id (Node side; features/defs.ts is the pure half the browser uses). Surfaces run
// definitions only through here, so input and output are checked the same way everywhere.
import type { AppContext } from './context.js';
import {
  invoke,
  NO_QUESTIONS,
  onSurface,
  type AnyDefinition,
  type Implementation,
  type OperationIO,
  type OutputOf,
  type QueryDef,
  type RpcHost,
} from './kernel/index.js';
import {
  addAgentRun,
  listAgentsRun,
  makeDefaultAgentRun,
  removeAgentRun,
  startAgentRun,
} from './features/agents/index.js';
import {
  defaultAccountRun,
  listAccountsRun,
  removeAccountRun,
  renameAccountRun,
  saveAccountRun,
  useAccountRun,
} from './features/accounts/index.js';
import { listAppsRun, requestAppRun, setCustomAppsRun, toggleAppRun } from './features/apps/index.js';
import { browseFolderRun } from './features/files/index.js';
import { cleanDataRun, pruneStorageRun, showDataRun } from './features/data/index.js';
import {
  changeDataFolderRun,
  containedOffRun,
  containedOnRun,
  containedStatusRun,
  moveStorageRun,
  showStorageRun,
  useStorageRun,
} from './features/storage/index.js';
import {
  addProjectRun,
  allProjectsRun,
  chooseProjectsRun,
  excludeProjectRun,
  includeProjectRun,
  listProjectsRun,
  projectRootsRun,
  removeProjectRun,
} from './features/projects/index.js';
import { checkHealthRun, enableSandboxRun, lastHealthRun, repairHealthRun } from './features/health/index.js';
import { hideWindowRun, sandboxStatusRun, showWindowRun, stopSandboxRun } from './features/sandbox/index.js';
import { listLogsRun, tailLogRun } from './features/logs/index.js';
import { listSessionsRun, restartSessionsRun } from './features/sessions/index.js';
import {
  exportConfigRun,
  getSettingRun,
  importConfigRun,
  listSettingsRun,
  resetSettingRun,
  setSettingRun,
} from './features/settings/index.js';
import { migrateSettingsRun, runUpdateRun, updatesStatusRun } from './features/updates/index.js';
import { checkEngineRun, cleanEngineRun, engineLeftoversRun, engineStatusRun } from './features/engine/index.js';
import { openWebRun, startWebRun, stopWebRun, webStatusRun } from './features/web/index.js';
import { vpnLoginRun, vpnLogoutRun, vpnStatusRun } from './features/vpn/index.js';
import { githubLoginRun, githubLogoutRun, githubStatusRun } from './features/github/index.js';

export const IMPLEMENTATIONS: readonly Implementation<AnyDefinition, AppContext>[] = [
  sandboxStatusRun,
  showWindowRun,
  hideWindowRun,
  stopSandboxRun,
  listSessionsRun,
  restartSessionsRun,
  startAgentRun,
  addAgentRun,
  makeDefaultAgentRun,
  removeAgentRun,
  listAgentsRun,
  listSettingsRun,
  getSettingRun,
  setSettingRun,
  resetSettingRun,
  exportConfigRun,
  importConfigRun,
  browseFolderRun,
  listAccountsRun,
  saveAccountRun,
  useAccountRun,
  defaultAccountRun,
  renameAccountRun,
  removeAccountRun,
  listAppsRun,
  toggleAppRun,
  setCustomAppsRun,
  requestAppRun,
  listProjectsRun,
  chooseProjectsRun,
  addProjectRun,
  removeProjectRun,
  includeProjectRun,
  excludeProjectRun,
  allProjectsRun,
  projectRootsRun,
  lastHealthRun,
  checkHealthRun,
  repairHealthRun,
  enableSandboxRun,
  showDataRun,
  cleanDataRun,
  pruneStorageRun,
  showStorageRun,
  moveStorageRun,
  useStorageRun,
  changeDataFolderRun,
  containedStatusRun,
  containedOnRun,
  containedOffRun,
  listLogsRun,
  tailLogRun,
  runUpdateRun,
  migrateSettingsRun,
  updatesStatusRun,
  engineStatusRun,
  checkEngineRun,
  engineLeftoversRun,
  cleanEngineRun,
  startWebRun,
  openWebRun,
  stopWebRun,
  vpnStatusRun,
  vpnLoginRun,
  vpnLogoutRun,
  githubStatusRun,
  githubLoginRun,
  githubLogoutRun,
  webStatusRun,
];

export function implementationOf(id: string): Implementation<AnyDefinition, AppContext> | undefined {
  return IMPLEMENTATIONS.find((i) => i.def.id === id);
}

/** Runs a definition by id: input checked before, output checked after. */
export function runDefinition(id: string, ctx: AppContext, input: unknown, io: OperationIO): Promise<unknown> {
  const impl = implementationOf(id);
  if (!impl) throw new Error('No implementation for ' + id);
  return invoke(impl, ctx, input, io);
}

/** Reads a query in-process (the menu): typed output, and no questions. */
export async function readQuery<D extends QueryDef>(
  def: D,
  ctx: AppContext,
  input: unknown = {},
): Promise<OutputOf<D>> {
  return (await runDefinition(def.id, ctx, input, NO_QUESTIONS)) as OutputOf<D>;
}

/** What the web server may run: the registered definitions whose surfaces include the web. */
export function createRpcHost(ctx: AppContext): RpcHost {
  const allowed = (id: string): Implementation<AnyDefinition, AppContext> | undefined => {
    const impl = implementationOf(id);
    return impl && onSurface(impl.def, 'web') ? impl : undefined;
  };
  return {
    kind: (id) => allowed(id)?.def.kind,
    liveMs: (id) => {
      const def = allowed(id)?.def;
      return def?.kind === 'query' ? def.live?.everyMs : undefined;
    },
    run: (id, input, io) => {
      const impl = allowed(id);
      if (!impl) throw new Error('Not allowed on the web: ' + id);
      return invoke(impl, ctx, input, io);
    },
  };
}
