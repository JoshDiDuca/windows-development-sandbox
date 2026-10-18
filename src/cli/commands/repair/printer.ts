// How doctor and repair look: headings per group, one line per result as it finishes (a "Checking ..." line while it
// runs on a terminal), "What it means" and "Fix" under what is not ok, and the summary. The engine's only printing.
import { summaryText } from '../../../app/features/health/index.js';
import { c, canAnimate } from '../../output/index.js';
import type { Check, CheckResult, RepairStatus, Summary } from './types.js';
import type { RunHooks } from './engine.js';

export { summaryText };

/** Where text goes (the terminal; a test collects it). */
export interface Out {
  write(text: string): void;
}

const GLYPH: Record<RepairStatus, { tty: string; plain: string; paint: (t: string) => string }> = {
  ok: { tty: '✔', plain: '[ok]', paint: c.green },
  fixed: { tty: '✔', plain: '[fixed]', paint: c.cyan },
  warn: { tty: '!', plain: '[!]', paint: c.yellow },
  'needs-you': { tty: '✘', plain: '[x]', paint: c.red },
  skipped: { tty: '–', plain: '[-]', paint: c.dim },
};

const MAX_LINES = 6;

export class HealthPrinter {
  private group: string | null = null;
  private live = false;

  constructor(
    private readonly out: Out,
    /** Redraw lines in place (a terminal); otherwise each result is one finished line. */
    private readonly animate: boolean = canAnimate(process.env, Boolean(process.stdout.isTTY)),
  ) {}

  private glyph(status: RepairStatus): string {
    const g = GLYPH[status];
    return g.paint(this.animate ? g.tty : g.plain);
  }

  private clearLive(): void {
    if (this.live) this.out.write('\r\x1b[2K');
    this.live = false;
  }

  private heading(group: string): void {
    if (group === this.group) return;
    this.group = group;
    this.out.write('\n' + c.bold(group) + '\n');
  }

  title(text: string): void {
    this.out.write(c.bold(text) + '\n');
  }

  /** Hooks for HealthRun: print as the checks run (and, for repair, as the fixes are applied). */
  hooks(): RunHooks {
    return {
      lookStart: (check: Check) => {
        this.heading(check.group);
        if (!this.animate) return;
        this.live = true;
        this.out.write('  ' + c.dim('… Checking ' + (check.checking ?? check.name.toLowerCase()) + '…'));
      },
      lookEnd: (result: CheckResult) => {
        this.clearLive();
        this.result(result);
      },
      fixStart: (result: CheckResult) => {
        this.heading(result.group);
        if (!this.animate) return;
        this.live = true;
        this.out.write('  ' + c.dim('… Fixing: ' + (result.plan ?? result.name) + '…'));
      },
      fixEnd: (result: CheckResult) => {
        this.clearLive();
        this.fixed(result);
      },
    };
  }

  /** One result: the line, then what it means and what to do when it is not ok. */
  result(r: CheckResult): void {
    this.heading(r.group);
    const note = r.timedOut ? ' (took too long)' : '';
    this.out.write('  ' + this.glyph(r.status) + ' ' + c.bold(r.name) + ': ' + r.detail + note + '\n');
    if (r.status === 'ok') return;
    if (r.means) this.out.write('      What it means: ' + r.means + '\n');
    if (r.fixable && r.plan) this.out.write('      Fix: sandbox repair will ' + r.plan + '\n');
    else if (r.fix) this.out.write('      Fix: ' + r.fix + '\n');
    for (const line of (r.lines ?? []).slice(0, MAX_LINES)) this.out.write('        ' + line + '\n');
    if ((r.lines?.length ?? 0) > MAX_LINES)
      this.out.write('        ... and ' + (r.lines!.length - MAX_LINES) + ' more\n');
  }

  /** What a fix did, on the line it started. */
  private fixed(r: CheckResult): void {
    this.heading(r.group);
    if (r.status === 'fixed') {
      this.out.write('  ' + this.glyph('fixed') + ' ' + c.bold(r.name) + ': ' + (r.applied?.done ?? r.detail) + '\n');
      return;
    }
    const prefix = '  ' + this.glyph('needs-you') + ' ' + c.bold(r.name) + ': ';
    this.out.write(prefix + 'the fix did not work' + (r.error ? ' (' + r.error + ')' : '') + '\n');
    if (r.fix) this.out.write('      Fix: ' + r.fix + '\n');
  }

  /** What repair will change, listed before it asks. */
  plan(fixable: readonly CheckResult[]): void {
    this.out.write('\n' + c.bold('Repair will change:') + '\n');
    fixable.forEach((r, i) => {
      this.out.write('  ' + (i + 1) + '. ' + r.name + ': ' + (r.plan ?? r.detail) + '\n');
      for (const line of (r.lines ?? []).slice(0, MAX_LINES)) this.out.write('       ' + line + '\n');
    });
    this.out.write('Nothing is deleted except leftovers; your settings, logins and projects are never removed.\n');
  }

  summary(results: readonly CheckResult[], s: Summary): void {
    this.clearLive();
    this.out.write('\n' + c.bold('Summary') + ': ' + summaryText(s) + '\n');
    const left = results.filter((r) => r.status === 'needs-you');
    if (left.length) {
      this.out.write('\n' + c.bold('Still needs you:') + '\n');
      for (const r of left) this.out.write('  - ' + r.name + ': ' + (r.fix ?? r.detail) + '\n');
    }
  }

  line(text: string): void {
    this.out.write(text + '\n');
  }
}
