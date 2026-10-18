// The health of this PC and the sandbox: the last check or repair (saved), checking, repairing, and turning Windows
// Sandbox on. Pure: schemas, the line format the surfaces print, and the view. The checks and the saving are in
// health.run.ts (Node side).
import { z } from 'zod';
import {
  action,
  ago,
  defineOperation,
  defineQuery,
  defineView,
  type Item,
  type Page,
  type Section,
  type Tone,
} from '../../kernel/index.js';

const CLI_DOCTOR =
  'sandbox doctor and sandbox repair are hand-written renderers of this run (lines redrawn in place, --json alone, repair before the settings load)';

export const StatusSchema = z.enum(['ok', 'fixed', 'needs-you', 'warn', 'skipped']).describe('What the check found');
export const CheckRowSchema = z.object({
  id: z.string().describe('The check'),
  group: z.string().describe('Its heading (This PC, Install ...)'),
  name: z.string().describe('What was checked'),
  status: StatusSchema,
  detail: z.string().describe('What was found'),
  means: z.string().optional().describe('What it means for you'),
  fix: z.string().optional().describe('What to do yourself'),
  plan: z.string().optional().describe('What repair would change'),
  lines: z.array(z.string()).optional().describe('More lines (a diff, folders)'),
  fixable: z.boolean().describe('Repair can mend it'),
  timedOut: z.boolean().optional().describe('It took too long'),
  applied: z
    .object({ done: z.string(), before: z.string(), after: z.string() })
    .optional()
    .describe('What a fix changed'),
  error: z.string().optional().describe('Why a fix did not work'),
});
export type CheckRow = z.output<typeof CheckRowSchema>;

export const SummarySchema = z
  .object({
    total: z.number().describe('Checks that ran'),
    ok: z.number().describe('Checks that are fine'),
    fixed: z.number().describe('Problems repair fixed'),
    warn: z.number().describe('Warnings'),
    needsYou: z.number().describe('Problems you need to fix'),
    skipped: z.number().describe('Checks that did not run'),
    fixable: z.number().describe('Problems repair can still mend'),
  })
  .describe('How many checks ended how');
export type HealthSummary = z.output<typeof SummarySchema>;

export const SetupRowSchema = z.object({
  name: z.string().describe('What was looked at'),
  status: z.enum(['ok', 'warn', 'action']).describe('OK, a warning, or something to do'),
  detail: z.string().describe('What was found'),
});

export const HealthLastSchema = z.object({
  at: z.string().describe('When it ran (ISO time)'),
  mode: z.enum(['check', 'repair']).describe('A check or a repair'),
  checks: z.array(CheckRowSchema).describe('The results'),
  summary: SummarySchema,
  details: z.array(z.tuple([z.string(), z.string()])).describe('The doctor details: name and value'),
  setup: z
    .object({
      checks: z.array(SetupRowSchema),
      canEnable: z.boolean().describe('Windows Sandbox can be turned on from here'),
      error: z.string().nullable().describe('Why the setup could not be read'),
    })
    .nullable()
    .describe('What sandbox setup found'),
  log: z.string().nullable().describe('The repair log, if one was written'),
});
export type HealthLast = z.output<typeof HealthLastSchema>;

/** "6 ok, 1 fixed, 1 needs you, 1 warning": the parts that are zero are left out (except ok). */
export function summaryText(s: HealthSummary): string {
  const parts = [
    s.ok + ' ok',
    s.fixed && s.fixed + ' fixed',
    s.needsYou && s.needsYou + ' ' + (s.needsYou === 1 ? 'needs' : 'need') + ' you',
    s.warn && s.warn + (s.warn === 1 ? ' warning' : ' warnings'),
    s.skipped && s.skipped + ' skipped',
  ];
  return parts.filter(Boolean).join(', ');
}

const MARK: Readonly<Record<CheckRow['status'], string>> = {
  ok: '[ok]',
  fixed: '[fixed]',
  warn: '[!]',
  'needs-you': '[x]',
  skipped: '[-]',
};

const TONE: Readonly<Record<CheckRow['status'], Tone | undefined>> = {
  ok: undefined,
  fixed: 'accent',
  warn: 'warn',
  'needs-you': 'danger',
  skipped: 'muted',
};

const MAX_LINES = 6;

export interface ResultLine {
  readonly text: string;
  readonly tone?: Tone;
}

/**
 * The lines of one result as the plain printer writes them (HealthPrinter.result with animate off), without the group
 * heading. The tone paints the first line only.
 */
export function resultLines(r: CheckRow): ResultLine[] {
  const first: ResultLine = {
    text: '  ' + MARK[r.status] + ' ' + r.name + ': ' + r.detail + (r.timedOut ? ' (took too long)' : ''),
    ...(TONE[r.status] ? { tone: TONE[r.status] } : {}),
  };
  if (r.status === 'ok') return [first];
  const out: ResultLine[] = [first];
  if (r.means) out.push({ text: '      What it means: ' + r.means });
  if (r.fixable && r.plan) out.push({ text: '      Fix: sandbox repair will ' + r.plan });
  else if (r.fix) out.push({ text: '      Fix: ' + r.fix });
  const lines = r.lines ?? [];
  for (const line of lines.slice(0, MAX_LINES)) out.push({ text: '        ' + line });
  if (lines.length > MAX_LINES) out.push({ text: '        ... and ' + (lines.length - MAX_LINES) + ' more' });
  return out;
}

const BADGE: Readonly<Record<CheckRow['status'], string>> = {
  ok: 'OK',
  fixed: 'FIXED',
  'needs-you': 'NEEDS YOU',
  warn: 'WARNING',
  skipped: 'SKIPPED',
};

function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

const OutcomeSchema = z.object({
  summary: SummarySchema,
  changed: z.boolean().describe('Fixes were applied'),
  log: z.string().nullable().describe('The repair log, if one was written'),
});

export const lastHealth = defineQuery({
  id: 'health.last',
  title: 'Health',
  summary: 'the last check or repair of this PC and the sandbox',
  input: z.object({}),
  output: z.object({ last: HealthLastSchema.nullable().describe('Nothing yet: no check has run') }),
  surfaces: { except: { cli: 'the command line prints results as it checks (sandbox doctor)' } },
});

export const checkHealth = defineOperation({
  id: 'health.check',
  title: 'Check this PC',
  summary: 'check this PC, the install, your settings and the sandbox (changes nothing)',
  input: z.object({ harness: z.string().optional().describe('agent to check') }),
  output: OutcomeSchema,
  text: (o) => 'Summary: ' + summaryText(o.summary),
  surfaces: { except: { cli: CLI_DOCTOR } },
});

export const repairHealth = defineOperation({
  id: 'health.repair',
  title: 'Run the checks and fix what can be fixed',
  summary: 'find and fix problems (install, data folder, settings, stale state, half-installed tools)',
  input: z.object({}),
  output: OutcomeSchema,
  danger: true,
  text: (o) =>
    'Summary: ' +
    summaryText(o.summary) +
    (o.log ? '. Log: ' + o.log : '. No log was written (the storage folder does not exist yet).'),
  surfaces: { except: { cli: CLI_DOCTOR } },
});

export const enableSandbox = defineOperation({
  id: 'health.enableSandbox',
  title: 'Turn on Windows Sandbox',
  summary: 'turn on the Windows Sandbox feature (Windows asks for admin permission; restart to finish)',
  input: z.object({}),
  output: z.object({ message: z.string().describe('What happened') }),
  danger: true,
  text: (o) => o.message,
  surfaces: {
    except: {
      cli: 'sandbox setup asks and turns it on (hand-written: it also offers to restart Windows)',
      web: 'Windows asks for admin permission on this PC; use the menu or sandbox setup',
    },
  },
});

/** A repair row: what it means is the description; what was found and the fix are the detail lines. */
function checkItems(last: HealthLast): Item[] {
  return last.checks.map((r, i) => {
    const found = r.detail + (r.timedOut ? ' (took too long)' : '');
    const rest = resultLines(r)
      .slice(1)
      .map((l) => l.text.trim())
      .filter((l) => !l.startsWith('What it means: '));
    const details = r.means ? [found, ...rest] : rest;
    return {
      id: 'repair:' + i,
      label: r.name,
      hint: BADGE[r.status],
      ...(TONE[r.status] ? { tone: TONE[r.status] } : {}),
      badges: [{ text: BADGE[r.status], ...(TONE[r.status] ? { tone: TONE[r.status] } : {}) }],
      description: r.means ?? found,
      ...(details.length ? { details } : {}),
    };
  });
}

/** A "Set up this PC" row: the real value is the hint; OK or action needed is the tone and the badge. */
const SETUP_BADGE: Readonly<Record<'ok' | 'warn' | 'action', string>> = {
  ok: 'OK',
  warn: 'WARNING',
  action: 'NEEDS YOU',
};

/** The health page: before any check, the two things to do; after one, what it found. Pure. */
export function healthPage(o: { last: HealthLast | null }): Page {
  const last = o.last;
  const check = action(checkHealth, {}, { verb: 'check' });
  const repair = action(repairHealth, {}, { verb: 'check and fix' });
  if (!last) {
    return {
      title: 'Health',
      sections: [
        {
          id: 'doctor',
          title: 'Doctor',
          cards: true,
          items: [
            {
              id: 'health:check',
              label: 'Check this PC',
              description:
                'Looks at this PC: Windows features, the install, the folders and the sandbox. It takes a few seconds, so it only runs when you ask.',
              primary: check,
            },
          ],
        },
        {
          id: 'repair',
          title: 'Repair',
          cards: true,
          items: [
            {
              id: 'repair:run',
              label: 'Run the checks and fix what can be fixed',
              description:
                'Checks the install, data folder, settings and sandbox, lists what it would change, and asks before it fixes anything.',
              primary: repair,
            },
          ],
        },
      ],
    };
  }
  const canEnable = Boolean(last.setup?.canEnable);
  const sections: Section[] = [
    {
      id: 'status',
      summary: (last.mode === 'repair' ? 'Last repair ' : 'Last check ') + ago(last.at),
      ...(last.log ? { notes: [{ text: 'Log: ' + last.log, tone: 'muted' as const }] } : {}),
    },
    {
      id: 'doctor',
      title: 'Doctor',
      items: last.details.map(([name, detail], i) => ({
        id: 'doctor:' + i,
        label: name,
        // The hint is the whole value; only a long one is cut, and then the description keeps all of it.
        hint: cut(detail, 50),
        ...(detail.length > 50 ? { description: detail } : {}),
      })),
    },
    {
      id: 'repair',
      title: 'Repair',
      items: checkItems(last),
    },
  ];
  if (last.setup) {
    const setup = last.setup;
    sections.push({
      id: 'setup',
      title: 'Set up this PC',
      items: setup.error
        ? [{ id: 'setup:error', label: setup.error }]
        : setup.checks.map((c, i) => ({
            id: 'setup:' + i,
            label: c.name,
            hint: c.detail,
            tone: c.status === 'ok' ? 'ok' : c.status === 'warn' ? 'warn' : 'danger',
            badges: [
              {
                text: SETUP_BADGE[c.status],
                tone: c.status === 'ok' ? 'ok' : c.status === 'warn' ? 'warn' : 'danger',
              },
            ],
          })),
      notes: canEnable
        ? [{ text: 'Turn Windows Sandbox on from the menu or with sandbox setup.', tone: 'muted', only: 'web' }]
        : [],
    });
  }
  return {
    title: 'Health',
    sections,
    actions: [
      action(repairHealth, {}, { key: 'f', verb: 'check and fix', importance: 1 }),
      action(checkHealth, {}, { key: 'l', verb: last ? 'check again' : 'check', importance: 2 }),
      ...(canEnable ? [action(enableSandbox, {}, { key: 'e', verb: 'turn on Windows Sandbox', importance: 3 })] : []),
    ],
  };
}

export const healthView = defineView({
  id: 'health',
  title: 'Health',
  summary: 'Checks this PC and your settings, repairs problems, and sets up Windows Sandbox.',
  queries: { last: lastHealth },
  operations: [checkHealth, repairHealth, enableSandbox],
  build: ({ last }) => healthPage(last),
});
