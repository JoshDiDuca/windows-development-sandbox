// The engine feature's work: what each engine can do and whether this PC can run it (engineReports, which runs a few
// Windows programs, so it is read on purpose and never live). Nothing is run or changed for the check's fixes.
import { fail, safeText } from '../../../core/util/index.js';
import { engineReports, lookForLeftovers, stopLeftovers, type EngineReport } from '../../../host/engines/index.js';
import { implement } from '../../context.js';
import { cancelled, plural } from '../../kernel/index.js';
import {
  checkEngine,
  cleanEngine,
  engineLeftovers,
  engineStatus,
  type EngineReportRow,
  type Leftovers,
} from './engine.def.js';

/** The report as the definitions describe it (the host's arrays are readonly; the output is plain data). */
function reportRow(r: EngineReport): EngineReportRow {
  return {
    id: r.id,
    inUse: r.inUse,
    capabilities: { ...r.capabilities },
    check: { available: r.check.available, reasons: [...r.check.reasons], fixes: [...r.check.fixes] },
  };
}

export const engineStatusRun = implement(engineStatus, async (ctx) => {
  const reports = await engineReports(ctx.loaded.config);
  const using = reports.find((r) => r.inUse);
  return {
    engine: using?.id ?? ctx.loaded.config.sandbox.engine,
    engines: reports.map(reportRow),
  };
});

export const checkEngineRun = implement(checkEngine, async (ctx, input) => {
  const report = (await engineReports(ctx.loaded.config)).find((r) => r.id === input.engine);
  if (!report) return fail('Unknown engine: ' + input.engine, 'Use windows-sandbox or hcs.');
  return reportRow(report);
});

export const engineLeftoversRun = implement(engineLeftovers, (ctx): Leftovers => {
  const look = lookForLeftovers(ctx.loaded.config.storage.root);
  if (!look.available) return { available: false, message: look.reason, systems: [] };
  const systems = look.systems.map((s) => ({
    id: s.id,
    kind: safeText(s.kind),
    state: safeText(s.state),
    since: s.since,
  }));
  return {
    available: true,
    message: systems.length
      ? plural(systems.length, 'HCS system') + ' of ours left running.'
      : 'No HCS system of ours is running.',
    systems,
  };
});

export const cleanEngineRun = implement(cleanEngine, async (ctx, _input, io) => {
  const root = ctx.loaded.config.storage.root;
  const look = lookForLeftovers(root);
  if (!look.available) return { available: false, stopped: 0, failed: 0, message: look.reason + ' Nothing to clean.' };
  if (!look.systems.length)
    return { available: true, stopped: 0, failed: 0, message: 'No HCS system of ours is running. Nothing to clean.' };
  const yes = await io.confirm({
    title: 'Stop ' + plural(look.systems.length, 'HCS system') + '?',
    lines: [
      ...look.systems.map((s) => s.id + '  (' + safeText(s.kind) + ', ' + safeText(s.state) + ')'),
      'A sandbox of yours that is running on purpose is listed too: stopping it ends its sessions.',
      "No file is deleted, and other programs and other Windows users' sandboxes are not touched.",
    ],
    yes: 'Stop them',
    danger: true,
  });
  if (!yes) cancelled();
  io.progress('Stopping HCS systems');
  const results = stopLeftovers(
    root,
    look.systems.map((s) => s.id),
  );
  for (const r of results)
    io.log(
      r.stopped ? 'Stopped ' + r.id : 'Could not stop ' + r.id + ': ' + safeText(r.problem ?? ''),
      r.stopped ? 'ok' : 'danger',
    );
  const stopped = results.filter((r) => r.stopped).length;
  const failed = results.length - stopped;
  if (failed)
    fail(
      plural(failed, 'HCS system') + ' could not be stopped.',
      'Run it again from an administrator terminal: sandbox engine clean',
    );
  return { available: true, stopped, failed, message: 'Stopped ' + plural(stopped, 'HCS system') + '.' };
});
