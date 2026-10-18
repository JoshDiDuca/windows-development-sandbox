// The data area's work: measuring what is kept, deleting chosen parts of it (DataService: never follows links, refuses
// while a sandbox runs) and the clean-up of old launch folders, logs and leftovers. Talks only through io.
import { humanBytes } from '../../../core/disk.js';
import { fail } from '../../../core/util/index.js';
import { cleanTargetOf, DataService, type DataEntry, type DataReport } from '../../../cli/services/index.js';
import { describePrune, pruneStorage as prune } from '../../../host/storage/index.js';
import { isSandboxRunning } from '../../../host/sandbox/index.js';
import { RunDir } from '../../../shared/channel/index.js';
import { implement } from '../../context.js';
import { cancelled, type OperationIO } from '../../kernel/index.js';
import { cleanData, DATA_AREAS, pruneStorage, showData, type DataShow } from './data.def.js';

const MEASURING = 'Measuring the saved data (big folders take a moment)';
const NOTHING_CHOSEN = 'Nothing chosen, nothing removed.';

/** The page's numbers, in bytes and in words (the definition cannot format them). */
function showOf(report: DataReport): DataShow {
  const total = report.totalBytes;
  const areaTotals: Record<string, string> = {};
  for (const area of DATA_AREAS) {
    const sum = report.entries.filter((e) => e.area === area).reduce((n, e) => n + e.bytes, 0);
    areaTotals[area] = humanBytes(sum);
  }
  return {
    dataPath: report.dataPath,
    storageRoot: report.storageRoot,
    totalBytes: total,
    total: humanBytes(total),
    storageShare: '<- sandbox storage (' + humanBytes(total) + ' of it)',
    areaTotals,
    entries: report.entries.map((e) => ({
      area: e.area,
      name: e.name,
      path: e.path,
      bytes: e.bytes,
      size: humanBytes(e.bytes),
      target: cleanTargetOf(e),
    })),
    disks: report.disks.map((d) => ({
      drive: d.drive,
      totalBytes: d.totalBytes,
      freeBytes: d.freeBytes,
      usedBytes: d.usedBytes,
      holdsStorage: d.holdsStorage,
      used: humanBytes(d.usedBytes),
      usedPercent: Math.round((d.usedBytes / d.totalBytes) * 100),
      free: humanBytes(d.freeBytes),
      total: humanBytes(d.totalBytes),
    })),
  };
}

/** Rows as aligned columns, as the command line's tables print them (the last column is not padded). */
function alignedLines(rows: readonly (readonly string[])[]): string[] {
  const width = (i: number): number => Math.max(0, ...rows.map((r) => (r[i] ?? '').length));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(width(i) + 2))).join(''));
}

/** No target named: what can be cleaned, with sizes, to tick from. Undefined when nothing can be. */
async function pickTargets(service: DataService, io: OperationIO): Promise<string[] | undefined> {
  io.progress(MEASURING);
  const choices = service.entries().flatMap((e: DataEntry) => {
    const target = cleanTargetOf(e);
    return target ? [{ value: target, label: target.padEnd(28) + humanBytes(e.bytes) }] : [];
  });
  if (!choices.length) return undefined;
  return io.checklist({
    title: 'What do you want to delete? (space ticks, enter confirms)',
    choices,
    noTerminal: {
      message: 'Which data should be cleaned?',
      fix: 'Name them: sandbox data clean logs tools/go   (what exists: sandbox data)',
    },
  });
}

export const showDataRun = implement(showData, (ctx) => {
  return showOf(new DataService(ctx).report());
});

export const cleanDataRun = implement(cleanData, async (ctx, input, io) => {
  const service = new DataService(ctx);
  let inputs = input.targets;
  if (!inputs.length) {
    const chosen = await pickTargets(service, io);
    if (!chosen?.length) return { message: NOTHING_CHOSEN, freedBytes: 0 };
    inputs = chosen;
  }
  const plan = service.plan(inputs);
  if (!plan.present.length)
    return {
      message: 'Nothing to remove: ' + plan.targets.map((t) => t.target).join(', ') + ' do(es) not exist.',
      freedBytes: 0,
    };
  for (const line of alignedLines(plan.present.map((t) => ['  ' + t.target, humanBytes(t.bytes), t.path])))
    io.log(line);
  for (const t of plan.present) if (t.warning) io.log('Warning: ' + t.target + ' ' + t.warning + '.', 'warn');
  const names = plan.present.map((t) => t.target).join(', ');
  const confirmed = plan.present.some((t) => t.target === 'all')
    ? await io.confirm({
        title: 'This cannot be undone; the next sandbox starts from scratch and reinstalls everything.',
        typed: 'all',
        danger: true,
        noTerminal: { message: 'Nothing removed.', fix: 'Add --yes to delete without asking.' },
      })
    : await io.confirm({
        title: 'Delete ' + names + ' (' + humanBytes(plan.totalBytes) + ')? This cannot be undone.',
        yes: 'Delete',
        danger: true,
        noTerminal: { message: 'Cannot ask here (no terminal).', fix: 'Add --yes to delete without asking.' },
      });
  if (!confirmed) cancelled('Nothing removed.');
  const outcome = service.clean(plan);
  if (outcome.failed.length)
    fail(
      'Could not remove everything: ' + outcome.failed.join('; '),
      'Close programs using those folders and run the same command again.',
    );
  return {
    message:
      'Removed ' +
      names +
      ' and freed ' +
      humanBytes(outcome.freedBytes) +
      (outcome.touchedData ? '; the next sandbox reinstalls what it needs.' : '.'),
    freedBytes: outcome.freedBytes,
  };
});

export const pruneStorageRun = implement(pruneStorage, async (ctx, input, io) => {
  const running = isSandboxRunning() ? new RunDir(ctx.dataPath).readSandboxStatus()?.launchId : undefined;
  const options = { launchDays: input.days, keep: running ? [running] : [] };
  const found = prune(ctx.storageRoot, { ...options, dryRun: true });
  if (found.launches + found.logs + found.leftovers === 0) return { message: 'Nothing to clean.', removed: false };
  io.log('Can be removed: ' + describePrune(found).replace(' removed', '') + '.');
  const confirmed = await io.confirm({
    title: 'Delete them?',
    yes: 'Delete',
    danger: true,
    noTerminal: { message: 'Cannot ask here (no terminal).', fix: 'Add --yes to delete without asking.' },
  });
  if (!confirmed) cancelled('Nothing removed.');
  const removed = describePrune(prune(ctx.storageRoot, options)).replace(' removed', '');
  return { message: 'Removed ' + removed + '.', removed: true };
});
