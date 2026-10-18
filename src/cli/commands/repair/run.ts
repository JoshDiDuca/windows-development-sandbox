// `sandbox doctor` and `sandbox repair`: the command line's renderers of the health feature's run (healthWith): lines
// as each check ends, the summary, the details, the log path. doctor only looks (and offers to fix, or fixes with
// --fix); repair looks, lists what it would change, asks once, then fixes and writes a log. --json prints the results
// instead and never asks.
import { confirm } from '@inquirer/prompts';
import { UserError } from '../../../core/util/index.js';
import { insideSandbox } from '../../../host/sandbox/index.js';
import type { CliOptions } from '../../args.js';
import { printJson, table } from '../../output/index.js';
import { HealthService } from '../../services/index.js';
import { createContext, defaultsContext, requireOnPc, type Context } from '../context.js';
import { healthWith } from '../../../app/features/health/index.js';
import { HealthPrinter } from './printer.js';

const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const stdout = { write: (text: string): void => void process.stdout.write(text) };

const askFix = (question: string): Promise<boolean> => confirm({ message: question, default: true });

function quote(n: number, what: string): string {
  return n + ' ' + what + (n === 1 ? '' : 's');
}

/** `sandbox doctor` */
export async function runDoctor(ctx: Context): Promise<number> {
  if (insideSandbox()) {
    table(new HealthService(ctx).doctor());
    return 0;
  }
  const json = ctx.options.json;
  const printer = json ? null : new HealthPrinter(stdout);
  printer?.title('Checking this PC, the install, your settings and the sandbox...');
  const { report, details } = await healthWith(
    ctx,
    { mode: 'doctor', yes: ctx.options.fix, harness: ctx.options.harness },
    { events: printer, mayAsk: !json && interactive(), confirmFix: askFix },
  );
  if (printJson(ctx, { checks: report.final, summary: report.summary, details })) return 0;
  printer?.summary(report.final, report.summary);
  const left = report.final.filter((r) => r.fixable).length;
  if (left && !report.changed)
    printer?.line('\n' + quote(left, 'problem') + ' can be fixed: run sandbox repair (or sandbox doctor --fix).');
  printer?.line('\n' + 'Details');
  table(details);
  return 0;
}

/** `sandbox repair` for a loaded context. */
export async function runRepair(ctx: Context, configError: UserError | null = null): Promise<number> {
  requireOnPc('repair');
  const json = ctx.options.json;
  const printer = json ? null : new HealthPrinter(stdout);
  printer?.title('Checking this PC, the install, your settings and the sandbox...');
  const yes = ctx.options.yes;
  const ask = !json && interactive();
  const { report, log } = await healthWith(
    ctx,
    { mode: 'repair', yes, configError },
    { events: printer, mayAsk: ask, confirmFix: askFix },
  );
  const stillFixable = report.final.filter((r) => r.fixable).length;
  if (printJson(ctx, { checks: report.final, summary: report.summary, changed: report.changed, log })) {
    return report.summary.needsYou ? 1 : 0;
  }
  printer?.summary(report.final, report.summary);
  if (stillFixable && !ask && !yes)
    printer?.line('\n' + quote(stillFixable, 'problem') + ' can be fixed: run sandbox repair --yes.');
  printer?.line(
    log
      ? '\nLog of what was found and changed: ' + log
      : '\nNo log was written (the storage folder does not exist yet).',
  );
  return report.summary.needsYou ? 1 : 0;
}

/**
 * Entry point that works even when the config file is broken (createContext would throw): falls back to the built-in
 * defaults so the other checks still run, and reports the settings problem as a check of its own.
 */
export function repairCommand(packageRoot: string, entry: string, options: CliOptions): Promise<number> {
  let ctx: Context;
  try {
    ctx = createContext(packageRoot, entry, options);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    return runRepair(defaultsContext(packageRoot, entry, options), e);
  }
  return runRepair(ctx);
}

export { runHealth } from './health-run.js';
