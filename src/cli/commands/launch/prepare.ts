import path from 'node:path';
import fs from 'node:fs';
import { AccountStore } from '../../../host/profile/index.js';
import { SandboxChannel } from '../../../host/channel/index.js';
import { describePrune, hostDataFolder, pruneStorage } from '../../../host/storage/index.js';
import { RepoGuardStore, readDataSize, saveMarkedProjects } from '../../../host/guard/index.js';
import { ensureConpty, ensureTerminal } from '../../../host/tools/index.js';
import { planView, viewSkipped, saveActiveViews, WorkspaceView } from '../../../host/workspace-view/index.js';
import { saveForwards } from '../../../host/network/index.js';
import { saveAuditSettings } from '../../../host/audit/index.js';
import { humanBytes } from '../../../core/disk.js';
import { syncBeforeLaunch, watcherRunning } from '../../../sync/index.js';
import type { Config, ResolvedRun } from '../../../core/types.js';
import { errMsg } from '../../../core/util/index.js';
import { c, working } from '../../output/index.js';
import { type Context } from '../context.js';
import { firstStartNotice, pendingDownloads } from './first-start.js';
import { LifeRecord, UPDATE_RESTART_WARNING, updateRestartPending } from '../../../host/life/index.js';

/** Nothing has been installed into this data set yet: the first start downloads every toolchain once. */
export function firstBoot(dataPath: string): boolean {
  return !fs.existsSync(path.join(hostDataFolder(dataPath, 'tools'), 'resolved-versions.json'));
}
/** The first-start heads-up (also when this project needs tools not downloaded yet), or null. */
export function firstBootNotice(
  dataPath: string,
  generated: { toolchains: Record<string, { on: boolean }>; databases: { database: string }[] },
): string | null {
  const wanted = [
    'node',
    ...Object.entries(generated.toolchains)
      .filter(([, d]) => d.on)
      .map(([name]) => name),
    ...generated.databases.map((d) => d.database),
  ];
  return firstStartNotice(
    firstBoot(dataPath),
    pendingDownloads(wanted, (dir) => fs.existsSync(path.join(hostDataFolder(dataPath, 'tools'), dir))),
  );
}

function syncSummary(config: Config, dataPath: string, workspaceHost: string): string {
  try {
    const s = syncBeforeLaunch(config, dataPath, workspaceHost);
    return s.history + ' file(s) of history in, claude-mem ' + s.claudeMem;
  } catch (e) {
    return 'FAILED: ' + errMsg(e);
  }
}

/**
 * workspaceFilter: brings the project's filtered view in step before the sandbox maps it, and tells the background
 * watcher to keep it in step while the sandbox runs. Returns the line for the launch table.
 */
async function prepareWorkspaceView(ctx: Context, run: ResolvedRun): Promise<string> {
  const plan = planView(run.config, ctx.storageRoot, run.workspaceHost);
  saveActiveViews(ctx.storageRoot, ctx.dataPath, plan ? [plan.options] : []);
  saveForwards(ctx.storageRoot, ctx.dataPath, run.config.sandbox.networking ? run.config.network.forwardPorts : []);
  saveAuditSettings(ctx.storageRoot, ctx.dataPath, { ...run.config.audit, projects: [run.workspaceHost] });
  saveMarkedProjects(ctx.storageRoot, ctx.dataPath, run.config.storage.markSandboxFiles ? [run.workspaceHost] : []);
  const size = readDataSize(ctx.storageRoot, ctx.dataPath);
  const limit = run.config.storage.warnDataGb;
  if (limit > 0 && size && size.bytes > limit * 1024 ** 3)
    console.warn(
      c.yellow(
        'The persisted data takes ' +
          humanBytes(size.bytes) +
          ' (more than storage.warnDataGb, ' +
          limit +
          ' GB). See what: sandbox data; free space: sandbox data clean <what>.',
      ),
    );
  if (!plan)
    return (
      viewSkipped(run.config, run.workspaceHost) ??
      'off (git-ignored files are visible in the sandbox; workspaceFilter.enabled keeps them out)'
    );
  const stats = await working('Preparing the workspace without its git-ignored files', () =>
    new WorkspaceView(plan.options).prepare(),
  );
  return (
    'on: git-ignored files stay on this PC' +
    (stats.toView || stats.toHost
      ? ' (' +
        stats.toView +
        ' copied in, ' +
        stats.toHost +
        ' out' +
        (stats.conflicts ? ', ' + stats.conflicts + ' conflicts kept next to the file' : '') +
        ')'
      : '') +
    '; ' +
    plan.options.view
  );
}

/** What prepare did, for the launch summary. */
export interface Prepared {
  readonly account: string | null;
  readonly terminal: string;
  readonly history: string;
  readonly pruned: string;
  readonly filter: string;
}

/** Everything a real launch does before the sandbox starts (skipped by `generate`, which only writes files). */
export async function prepare(ctx: Context, run: ResolvedRun): Promise<Prepared> {
  const { options, dataPath, storageRoot } = ctx;
  const { config } = run;
  const accounts = new AccountStore(storageRoot, config.claudeProfile.sharePluginsAcrossAccounts);
  const account = options.account ?? accounts.defaultName();
  if (account && run.harnessName === 'claude' && account !== accounts.activeFor(dataPath))
    accounts.activate(dataPath, account);
  else if (run.harnessName === 'claude') accounts.syncPlugins(dataPath);
  const terminal = config.provisioning.terminal.enabled
    ? await ensureTerminal(dataPath, config.provisioning.refresh, { pwsh: config.toolchains.pwsh.enabled !== false })
    : { exe: null, message: 'disabled' };
  const conpty = config.provisioning.conpty.enabled ? await ensureConpty(dataPath, config.provisioning.refresh) : 'off';
  const history = syncSummary(config, dataPath, run.workspaceHost);
  const guarded = new RepoGuardStore(dataPath).check();
  if (guarded.length)
    console.warn(
      c.yellow(
        'SECURITY: neutralised ' +
          guarded.length +
          ' change(s) the last sandbox made that could run code on this PC (see sandbox status).',
      ),
    );
  const stopped = new LifeRecord(storageRoot, dataPath).lastStopWarning(watcherRunning(dataPath));
  if (stopped) console.warn(c.yellow(stopped));
  if (updateRestartPending()) console.warn(c.yellow(UPDATE_RESTART_WARNING));
  new SandboxChannel(dataPath).reset();
  const filter = await prepareWorkspaceView(ctx, run);
  return {
    account,
    terminal: terminal.message + '; pseudo console: ' + conpty,
    history,
    pruned: describePrune(pruneStorage(storageRoot)),
    filter,
  };
}
