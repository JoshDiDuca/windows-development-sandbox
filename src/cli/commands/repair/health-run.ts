// The look -> ask -> fix decision of doctor and repair, with no surface in it: results go to `events` (the CLI's
// HealthPrinter, or the shared core's io), and the question is asked through `confirmFix`. Used by run.ts (the CLI) and
// by the health feature (the menu and the web).
import { ALL_CHECKS } from './checks/index.js';
import { HealthRun, summarize, type RunHooks } from './engine.js';
import type { Check, CheckResult, RepairEnv, Summary } from './types.js';

/** Where the results of a run go while it runs: the CLI's HealthPrinter, or the shared core's io (ioEvents). */
export interface HealthEvents {
  hooks(): RunHooks;
  plan(fixable: readonly CheckResult[]): void;
  line(text: string): void;
}

/** What happens to the fixes: applied without asking, asked (when allowed), or not at all. */
export interface HealthPlan {
  /** Fix without asking. */
  readonly yes: boolean;
  /** May ask (a terminal, and not --json). */
  readonly ask: boolean;
  /** The question asked after the list of what will change. */
  readonly question: (n: number) => string;
}

/** What both commands find, and what they do about it. */
export interface HealthReport {
  readonly found: CheckResult[];
  readonly final: CheckResult[];
  readonly summary: Summary;
  /** Fixes were applied. */
  readonly changed: boolean;
}

/**
 * Runs the checks, then (when allowed) the fixes. `events` is null for --json. Without a `confirmFix` a question is
 * answered no, so nothing is fixed unless the plan says yes.
 */
export async function runHealth(
  env: RepairEnv,
  events: HealthEvents | null,
  plan: HealthPlan,
  checks: readonly Check[] = ALL_CHECKS,
  confirmFix: (question: string) => Promise<boolean> = () => Promise.resolve(false),
): Promise<HealthReport> {
  const run = new HealthRun(checks, env, events?.hooks());
  const found = await run.look();
  const fixable = found.filter((r) => r.fixable);
  let final = found;
  let changed = false;
  if (fixable.length) {
    let go = plan.yes;
    if (!go && plan.ask) {
      events?.plan(fixable);
      go = await confirmFix(plan.question(fixable.length));
    }
    if (go) {
      if (plan.yes) events?.plan(fixable);
      final = await run.fix(found);
      changed = true;
    } else events?.line('\nNothing was changed.');
  }
  return { found, final, summary: summarize(final), changed };
}
