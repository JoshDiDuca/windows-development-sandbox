// The sandbox feature's work: its status (from the services, as this user may see it), its window and stopping it.
// Talks only through `io`; another user's sandbox follows the sharing rules (cli/commands/shared-use.ts).
import path from 'node:path';
import { safeText } from '../../../core/util/index.js';
import { SandboxChannel } from '../../../host/channel/index.js';
import { readSandboxFacts } from '../../../host/health/index.js';
import { LifeRecord, readLastEnd } from '../../../host/life/index.js';
import { cleanUpLeftovers, endSandboxPrograms, restartSandboxService } from '../../../host/sandbox/index.js';
import { judgeSandbox } from '../../../host/health/index.js';
import { runningOwner } from '../../../host/sharing/index.js';
import { requireOnPc, requireRunning } from '../../../cli/commands/context.js';
import { hereDir } from '../../../cli/commands/projects/here.js';
import { lookAtSandbox, useSharedSandbox, type SandboxView } from '../../../cli/commands/shared-use.js';
import { SandboxService } from '../../../cli/services/index.js';
import { implement, typedConfirm } from '../../context.js';
import { cancelled } from '../../kernel/index.js';
import {
  cleanUpSandbox,
  hideWindow,
  sandboxStatus,
  showWindow,
  stopSandbox,
  type SandboxStatus,
} from './sandbox.def.js';

/** Another user's sandbox that is not shared: whose it is, and nothing else. */
function limitedStatus(view: SandboxView, folder: string): SandboxStatus {
  const owner = view.owner;
  return {
    shared: { line: view.line ?? '', limited: true, startedBy: owner?.kind === 'other' ? owner.user : null },
    sandbox: {
      running: true,
      phase: 'unknown',
      startedAt: null,
      daemon: '-',
      account: null,
      syncWatcher: false,
    },
    here: { folder, project: null, guest: null },
    roots: [],
    projects: [],
    otherSessions: [],
    repoGuard: { guarded: 0, findings: [] },
  };
}

export const sandboxStatusRun = implement(sandboxStatus, async (asked) => {
  const view = lookAtSandbox(asked);
  if (view.limited) return limitedStatus(view, hereDir(asked));
  const report = await new SandboxService(view.ctx).status();
  const { storageRoot, dataPath } = view.ctx;
  const lastEnd = readLastEnd(() => new LifeRecord(storageRoot, dataPath).read(), dataPath, report.sandbox.running);
  const leftover = report.sandbox.running ? judgeSandbox(await readSandboxFacts(storageRoot, dataPath, false)) : null;
  return {
    ...(lastEnd ? { lastEnd } : {}),
    ...(leftover?.state === 'leftover' ? { leftover: { text: leftover.why } } : {}),
    ...(view.line ? { shared: { line: view.line, limited: false, startedBy: view.ctx.borrowed?.user ?? null } } : {}),
    ...report,
    sandbox: { ...report.sandbox, daemon: safeText(report.sandbox.daemon) },
  };
});

export const showWindowRun = implement(showWindow, async (ctx, _input, io) => {
  requireOnPc('show');
  requireRunning();
  await useSharedSandbox(ctx, { kind: 'owner-only', what: 'show the window', window: true }, typedConfirm(io));
  new SandboxService(ctx).showWindow();
  return { message: 'Sandbox window shown.' };
});

export const hideWindowRun = implement(hideWindow, async (ctx, _input, io) => {
  requireOnPc('hide');
  requireRunning();
  await useSharedSandbox(ctx, { kind: 'owner-only', what: 'hide the window', window: true }, typedConfirm(io));
  io.progress('Hiding the window');
  await new SandboxService(ctx).hideWindow();
  return { message: 'Sandbox window hidden. Bring it back with "Show the window".' };
});

/**
 * A dead sandbox leaves Windows Sandbox programs behind and Windows then refuses to start a new one ("signed out"):
 * ends them after asking, and restarts the Windows Sandbox service when asked to (or when they will not go).
 */
export const cleanUpSandboxRun = implement(cleanUpSandbox, async (ctx, input, io) => {
  requireOnPc('cleanup');
  const { storageRoot, dataPath } = ctx;
  const lines: string[] = [];
  const outcome = await cleanUpLeftovers({
    facts: () => readSandboxFacts(storageRoot, dataPath, true),
    end: endSandboxPrograms,
    restartService: restartSandboxService,
    confirm: (q) =>
      io.confirm({
        ...q,
        danger: true,
        noTerminal: { message: 'Nothing was closed.', fix: 'Add --yes to answer yes.' },
      }),
    say: (line) => {
      lines.push(line);
      io.log(line);
    },
    alsoService: input.service === true,
  });
  if (outcome === 'cleaned' || outcome === 'service-restarted') new SandboxChannel(dataPath, () => false).reset();
  const message = {
    nothing: 'No Windows Sandbox program is left over.',
    alive: lines[lines.length - 1] ?? 'A sandbox is working; nothing was closed.',
    declined: 'Nothing was closed.',
    cleaned: 'The leftover Windows Sandbox programs are closed. A new sandbox can start now.',
    'service-restarted': 'The Windows Sandbox service was restarted. A new sandbox can start now.',
    failed: 'The Windows Sandbox service could not be restarted.',
  }[outcome];
  return { outcome, message };
});

/**
 * Stopping ends every project's sessions: it says which, and the sessions of other projects need a yes (also on the
 * command line, where --yes gives it; a script without it fails rather than end them by accident).
 */
export const stopSandboxRun = implement(stopSandbox, async (asked, _input, io) => {
  requireOnPc('stop');
  if (!new SandboxService(asked).isRunning()) return { stopped: false, message: 'No Windows Sandbox is running.' };
  // Another user's sandbox: only when shared, and only after typing their name (--yes in scripts).
  const ctx =
    runningOwner().kind === 'mine'
      ? asked
      : await useSharedSandbox(
          asked,
          (shared) => ({ kind: 'stop', sessions: new SandboxChannel(shared.dataPath).currentSessions().length }),
          typedConfirm(io),
        );
  const service = new SandboxService(ctx);
  const { sandbox, running, others } = service.stopPlan();
  if (running.length)
    io.log(
      'Stopping ends ' +
        running.length +
        ' session(s): ' +
        running
          .map((s) => safeText(s.harness) + ' in ' + safeText(s.project ?? path.win32.basename(s.cwd)))
          .join(', ') +
        '.',
    );
  const yes = await io.confirm({
    title: others.length ? 'Stop the whole sandbox?' : 'Stop the sandbox?',
    lines: others.length ? [others.length + ' of them belong to other projects.'] : [],
    yes: 'Stop',
    danger: true,
    implied: others.length === 0,
    noTerminal: {
      message: others.length + ' of these sessions belong to other projects, so the sandbox was not stopped.',
      fix: 'Stop it anyway with: sandbox stop --yes',
    },
  });
  if (!yes) cancelled();
  io.progress('Asking the sandbox to shut down');
  await service.shutdown(sandbox);
  return { stopped: true, message: 'Sandbox is shutting down; history and claude-mem sync back when it closes.' };
});
