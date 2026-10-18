// The engine feature's work: what each engine can do and whether this PC can run it (engineReports, which runs a few
// Windows programs, so it is read on purpose and never live). Nothing is run or changed for the check's fixes.
import { fail } from '../../../core/util/index.js';
import { engineReports, type EngineReport } from '../../../host/engines/index.js';
import { implement } from '../../context.js';
import { checkEngine, engineStatus, type EngineReportRow } from './engine.def.js';

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
