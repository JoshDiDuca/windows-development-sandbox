import path from 'node:path';
import type { Config } from '../core/types.js';
import { assertNoLinks } from '../core/util/index.js';
import { takeHandoffs } from '../host/accounts/index.js';
import { hostClaudeDir, PluginShare } from '../host/profile/index.js';
import { hostDataFolder, hostDataRoot, storageOf } from '../host/storage/index.js';
import { hostClaudeMemDir, syncClaudeMem, type MemResult } from './claude-mem.js';
import { readSyncState, writeSyncState, type SyncState } from './sync-state.js';
import { syncHistoryIn, syncHistoryOut, type SyncPaths } from './history.js';

const guestClaude = (dataPath: string): string => path.join(hostDataFolder(dataPath, 'state'), 'claude');
const guestMem = (dataPath: string): string => path.join(hostDataFolder(dataPath, 'state'), 'claude-mem');

/** Sync paths for the sandbox side, after checking nothing on the way there is a link planted by the sandbox. */
const toPaths = (state: SyncState, dataPath: string): SyncPaths => {
  assertNoLinks(hostDataRoot(dataPath), guestClaude(dataPath));
  return {
    hostClaudeDir: state.hostClaudeDir,
    guestClaudeDir: guestClaude(dataPath),
    hostWorkspace: state.hostWorkspace,
    guestWorkspace: state.guestWorkspace,
    extra: state.projects ?? [],
  };
};

/**
 * A project registered while the sandbox runs: its history comes in now (the sandbox's copy only gains files), and
 * from now on syncs back to its own folder on this PC.
 */
export function syncProjectIn(dataPath: string, project: { hostWorkspace: string; guestWorkspace: string }): number {
  const state = readSyncState(dataPath);
  if (!state) return 0;
  const projects = [
    ...(state.projects ?? []).filter((p) => p.hostWorkspace.toLowerCase() !== project.hostWorkspace.toLowerCase()),
    project,
  ];
  const next: SyncState = { ...state, projects };
  writeSyncState(dataPath, next);
  // Prompt history is left alone: sessions are appending to the sandbox's copy right now.
  return state.syncHistory
    ? syncHistoryIn(toPaths(next, dataPath), { promptHistory: false, scope: state.historyScope })
    : 0;
}

const memSync = (dataPath: string, state: SyncState, direction: 'in' | 'out'): MemResult => {
  assertNoLinks(hostDataRoot(dataPath), guestMem(dataPath));
  return syncClaudeMem(hostClaudeMemDir(), guestMem(dataPath), state, direction);
};

export interface SyncSummary {
  history: number;
  claudeMem: MemResult | 'disabled';
}

/** Before launch: finish syncing the previous run out, then bring this PC's history (and claude-mem) in. */
export function syncBeforeLaunch(config: Config, dataPath: string, hostWorkspace: string): SyncSummary {
  const profile = config.claudeProfile;
  const summary: SyncSummary = { history: 0, claudeMem: 'disabled' };
  if (!config.storage.persistAgentState) return summary;
  const previous = readSyncState(dataPath);
  if (previous?.syncHistory) syncHistoryOut(toPaths(previous, dataPath));
  const state: SyncState = {
    ...previous,
    hostClaudeDir: hostClaudeDir(profile),
    hostWorkspace,
    guestWorkspace: config.guestWorkspace,
    syncHistory: profile.syncHistory,
    historyScope: profile.historyScope,
    syncClaudeMem: profile.syncClaudeMem,
    syncClaudeMemBack: profile.syncClaudeMemBack,
    sharePlugins: profile.sharePluginsAcrossAccounts,
    projects: [],
  };
  if (profile.syncHistory) summary.history = syncHistoryIn(toPaths(state, dataPath), { scope: profile.historyScope });
  if (profile.syncClaudeMem) {
    if (previous?.syncClaudeMem && previous.syncClaudeMemBack) memSync(dataPath, state, 'out');
    summary.claudeMem = memSync(dataPath, state, 'in');
  }
  writeSyncState(dataPath, state);
  return summary;
}

/** Syncs the sandbox's history (and, when `final`, claude-mem) back to this PC, as configured for the last launch. */
export function syncBack(dataPath: string, final: boolean): SyncSummary {
  // Service sign-ins the sandbox renewed or you made there (accounts.<kind>.share): sealed here, the plain copy gone;
  // the last sync of a sandbox lets go of its leases.
  try {
    takeHandoffs(dataPath, final);
  } catch {
    // Never stops a sync: a sign-in that could not be taken stays in the data folder for the next cycle.
  }
  const state = readSyncState(dataPath);
  const summary: SyncSummary = { history: 0, claudeMem: 'disabled' };
  if (!state) return summary;
  if (state.syncHistory) summary.history = syncHistoryOut(toPaths(state, dataPath));
  if (final && state.sharePlugins) PluginShare.in(storageOf(dataPath)).saveQuietly(dataPath, guestClaude(dataPath));
  if (final && state.syncClaudeMem && state.syncClaudeMemBack) summary.claudeMem = memSync(dataPath, state, 'out');
  writeSyncState(dataPath, state);
  return summary;
}
