// The health feature's work: the checks (through the repair engine), the repair log, the saved results
// (<storage>\health\last.json), and turning Windows Sandbox on. The CLI's doctor and repair call healthWith too; the
// menu and the web run the operations. Talks only through io.
import fs from 'node:fs';
import path from 'node:path';
import { packageVersion } from '../../../core/package-info.js';
import { assertNoLinks, dirExists, errMsg, fail, safeText, type UserError } from '../../../core/util/index.js';
import { assertTestWritable } from '../../../host/test-guard.js';
import { JsonFile } from '../../../shared/io/index.js';
import { requireOnPc, type Context } from '../../../cli/commands/context.js';
import { buildEnv } from '../../../cli/commands/repair/env.js';
import { runHealth, type HealthEvents, type HealthReport } from '../../../cli/commands/repair/health-run.js';
import { logText, writeRepairLog } from '../../../cli/commands/repair/log.js';
import { ALL_CHECKS } from '../../../cli/commands/repair/checks/index.js';
import type { CheckResult } from '../../../cli/commands/repair/types.js';
import { ENABLE_COMMAND } from '../../../cli/commands/setup/facts.js';
import { HealthService } from '../../../cli/services/index.js';
import { implement } from '../../context.js';
import { cancelled, type OperationIO } from '../../kernel/index.js';
import {
  checkHealth,
  CheckRowSchema,
  enableSandbox,
  HealthLastSchema,
  lastHealth,
  repairHealth,
  resultLines,
  type CheckRow,
  type HealthLast,
} from './health.def.js';

/** Where the saved results are: <storage>\health\last.json. */
function lastFile(storageRoot: string): string {
  return path.join(storageRoot, 'health', 'last.json');
}

function readLast(storageRoot: string): HealthLast | null {
  return new JsonFile(HealthLastSchema, lastFile(storageRoot)).read();
}

/**
 * Saves the results. A folder that cannot be written must not fail the check or repair (the result is on screen and in
 * the log), so a failure is not raised.
 */
function saveLast(storageRoot: string, last: HealthLast): void {
  if (!dirExists(storageRoot)) return;
  try {
    const dir = path.join(storageRoot, 'health');
    assertNoLinks(storageRoot, dir);
    assertTestWritable(lastFile(storageRoot));
    fs.mkdirSync(dir, { recursive: true });
    new JsonFile(HealthLastSchema, lastFile(storageRoot)).write(last);
  } catch {
    // Saving is a convenience: the page then shows the last one saved, or nothing.
  }
}

/** A result as saved: the text cleaned (it can quote what the sandbox wrote), the timing left out. */
function savedRow(r: CheckResult): CheckRow {
  const clean = (t: string | undefined): string | undefined => (t === undefined ? undefined : safeText(t));
  return CheckRowSchema.parse({
    id: r.id,
    group: r.group,
    name: safeText(r.name),
    status: r.status,
    detail: safeText(r.detail),
    means: clean(r.means),
    fix: clean(r.fix),
    plan: clean(r.plan),
    lines: r.lines?.map((l) => safeText(l)),
    fixable: r.fixable,
    timedOut: r.timedOut,
    applied: r.applied && {
      done: safeText(r.applied.done),
      before: safeText(r.applied.before),
      after: safeText(r.applied.after),
    },
    error: clean(r.error),
  });
}

/** What `sandbox setup` found, as the page keeps it (null when it could not be read). */
function setupOf(ctx: Context): NonNullable<HealthLast['setup']> {
  const health = new HealthService(ctx);
  try {
    health.assertWindows();
    const report = health.setupReport();
    return {
      checks: report.checks.map((c) => ({ name: safeText(c.name), status: c.status, detail: safeText(c.detail) })),
      canEnable: report.canEnable,
      error: null,
    };
  } catch (e) {
    return { checks: [], canEnable: false, error: safeText(errMsg(e)) };
  }
}

function quote(n: number, what: string): string {
  return n + ' ' + what + (n === 1 ? '' : 's');
}

/** Where a run's results go on the surfaces that have no terminal: the shared core's io. */
export function ioEvents(io: OperationIO): HealthEvents {
  let group: string | null = null;
  const heading = (g: string): void => {
    if (g === group) return;
    group = g;
    io.log(g, 'accent');
  };
  return {
    hooks: () => ({
      lookStart: (check) => io.progress('Checking ' + (check.checking ?? check.name.toLowerCase())),
      lookEnd: (r) => {
        heading(r.group);
        for (const l of resultLines(r)) io.log(l.text, l.tone);
      },
      fixStart: (r) => io.progress('Fixing: ' + (r.plan ?? r.name)),
      fixEnd: (r) => {
        heading(r.group);
        if (r.status === 'fixed') {
          io.log('  [fixed] ' + r.name + ': ' + (r.applied?.done ?? r.detail));
          return;
        }
        io.log('  [x] ' + r.name + ': the fix did not work' + (r.error ? ' (' + r.error + ')' : ''), 'danger');
        if (r.fix) io.log('      Fix: ' + r.fix);
      },
    }),
    plan: (fixable) => {
      io.log('Repair will change:', 'accent');
      fixable.forEach((r, i) => {
        io.log('  ' + (i + 1) + '. ' + r.name + ': ' + (r.plan ?? r.detail));
        for (const line of (r.lines ?? []).slice(0, 6)) io.log('       ' + line);
      });
      io.log('Nothing is deleted except leftovers; your settings, logins and projects are never removed.');
    },
    line: (text) => io.log(text),
  };
}

export interface HealthSurface {
  /** Where results go while they are found (null: nothing is printed, for --json). */
  readonly events: HealthEvents | null;
  /** May ask (the CLI: a terminal and not --json; the menu and web: yes for repair). */
  readonly mayAsk: boolean;
  readonly confirmFix: (question: string) => Promise<boolean>;
}

export interface HealthRequest {
  readonly mode: 'doctor' | 'repair';
  /** Fix without asking (--fix, --yes). */
  readonly yes: boolean;
  /** The agent to check (--agent). */
  readonly harness?: string;
  /** Repair with a broken settings file: the checks run on the defaults and report it. */
  readonly configError?: UserError | null;
  /** What sandbox setup found, saved with the rest (null from the command line). */
  readonly setup?: HealthLast['setup'];
}

export interface HealthOutcome {
  readonly report: HealthReport;
  readonly details: string[][];
  readonly log: string | null;
}

/**
 * The one run of doctor and repair, for every surface: look, ask (when allowed), fix, write the repair log, and save
 * the results. The CLI prints what this returns; the menu and the web show the saved results.
 */
export async function healthWith(ctx: Context, request: HealthRequest, surface: HealthSurface): Promise<HealthOutcome> {
  if (request.mode === 'repair') requireOnPc('repair');
  const env = buildEnv(ctx, request.configError ?? null);
  const question =
    request.mode === 'doctor'
      ? (n: number): string => quote(n, 'problem') + ' can be fixed. Fix ' + (n === 1 ? 'it' : 'them') + ' now?'
      : (n: number): string => 'Fix ' + (n === 1 ? 'this problem' : 'these ' + n + ' problems') + '?';
  const report = await runHealth(
    env,
    surface.events,
    { yes: request.yes, ask: surface.mayAsk, question },
    ALL_CHECKS,
    surface.confirmFix,
  );
  const details = request.configError ? [] : new HealthService(ctx).doctor(request.harness);
  let log: string | null = null;
  if (request.mode === 'repair') {
    const when = new Date();
    log = writeRepairLog(
      ctx.storageRoot,
      logText({
        when,
        version: packageVersion(),
        command: 'sandbox repair' + (request.yes ? ' --yes' : ''),
        found: report.found,
        final: report.final,
        summary: report.summary,
      }),
      when,
    );
  }
  saveLast(ctx.storageRoot, {
    at: new Date().toISOString(),
    mode: request.mode === 'repair' ? 'repair' : 'check',
    checks: report.final.map(savedRow),
    summary: report.summary,
    details: details.map(([name, detail]) => [safeText(name), safeText(detail)] as [string, string]),
    setup: request.setup ?? null,
    log: log === null ? null : safeText(log),
  });
  return { report, details, log };
}

/** Updates the saved results' setup part (after turning the feature on); nothing is saved before the first check. */
function refreshSetup(ctx: Context): void {
  const last = readLast(ctx.storageRoot);
  if (last) saveLast(ctx.storageRoot, { ...last, setup: setupOf(ctx) });
}

export const checkHealthRun = implement(checkHealth, async (ctx, input, io) => {
  io.progress('Checking this PC');
  const { report } = await healthWith(
    ctx,
    { mode: 'doctor', yes: false, harness: input.harness, setup: setupOf(ctx) },
    { events: ioEvents(io), mayAsk: false, confirmFix: () => Promise.resolve(false) },
  );
  return { summary: report.summary, changed: report.changed, log: null };
});

export const repairHealthRun = implement(repairHealth, async (ctx, _input, io) => {
  // A "no" is not cancelled(): the run logs "Nothing was changed." and still writes the log, as the command did.
  const previous = readLast(ctx.storageRoot);
  const { report, log } = await healthWith(
    ctx,
    { mode: 'repair', yes: false, setup: previous?.setup ?? null },
    {
      events: ioEvents(io),
      mayAsk: true,
      confirmFix: (question) => io.confirm({ title: question, yes: 'Fix', danger: true }),
    },
  );
  return { summary: report.summary, changed: report.changed, log };
});

export const enableSandboxRun = implement(enableSandbox, async (ctx, _input, io) => {
  requireOnPc('setup');
  const health = new HealthService(ctx);
  health.assertWindows();
  const yes = await io.confirm({
    title: 'Turn on Windows Sandbox?',
    lines: ['Windows asks for admin permission, then you restart Windows to finish.'],
    yes: 'Turn on',
    danger: true,
  });
  if (!yes) cancelled();
  io.progress('Turning on Windows Sandbox');
  if (!health.enableFeature('ignore'))
    fail(
      'Windows Sandbox could not be turned on (or the admin prompt was declined).',
      'In an admin PowerShell run: ' + ENABLE_COMMAND + ', then restart Windows.',
    );
  refreshSetup(ctx);
  return { message: 'Done. Restart Windows to finish.' };
});

/** The saved results for the menu and the web (the page reads them; nothing is checked). */
export const lastHealthRun = implement(lastHealth, (ctx) => ({ last: readLast(ctx.storageRoot) }));
