// The sandbox engines: the engine in use, and for each engine what it can do and whether this PC can run it. `check`
// says what this PC lacks, with the commands that would fix it as text to copy: nothing is run or changed. Pure: the
// schemas, the words the check prints and the page. The checks run in engine.run.ts (Node side).
import { z } from 'zod';
import { defineQuery, defineView, type Fact, type Item, type Page, type Section } from '../../kernel/index.js';

/** The label of each capability, in the order the page and the command line show them. */
export const CAPABILITY_NAMES = {
  desktop: 'desktop window',
  gpu: 'GPU',
  clipboard: 'clipboard',
  audio: 'audio',
  video: 'camera',
  printers: 'printers',
  liveFolderAdd: 'add folders while running',
  attachedDisks: 'attached disks',
  multipleInstances: 'several at once',
  hvsocket: 'Hyper-V sockets',
} as const;

type CapabilityKey = keyof typeof CAPABILITY_NAMES;
const CAPABILITY_KEYS = Object.keys(CAPABILITY_NAMES) as CapabilityKey[];

const FALLBACK_FIX = 'see docs/design/engines.md';

export const EngineIdSchema = z.enum(['windows-sandbox', 'hcs']).describe('The engine');

export const CapabilitiesSchema = z.object({
  desktop: z.boolean().describe(CAPABILITY_NAMES.desktop),
  gpu: z.boolean().describe(CAPABILITY_NAMES.gpu),
  clipboard: z.boolean().describe(CAPABILITY_NAMES.clipboard),
  audio: z.boolean().describe(CAPABILITY_NAMES.audio),
  video: z.boolean().describe(CAPABILITY_NAMES.video),
  printers: z.boolean().describe(CAPABILITY_NAMES.printers),
  liveFolderAdd: z.boolean().describe(CAPABILITY_NAMES.liveFolderAdd),
  attachedDisks: z.boolean().describe(CAPABILITY_NAMES.attachedDisks),
  multipleInstances: z.boolean().describe(CAPABILITY_NAMES.multipleInstances),
  hvsocket: z.boolean().describe(CAPABILITY_NAMES.hvsocket),
});

export const EngineCheckSchema = z
  .object({
    available: z.boolean().describe('This PC can run it'),
    reasons: z.array(z.string()).describe('Why not, in plain words'),
    fixes: z.array(z.string()).describe('The command that fixes each reason (never run for you)'),
  })
  .describe('Whether this PC can run it');

export const EngineReportSchema = z.object({
  id: EngineIdSchema,
  inUse: z.boolean().describe('The setting sandbox.engine names it'),
  capabilities: CapabilitiesSchema.describe('What it can do'),
  check: EngineCheckSchema,
});
export type EngineReportRow = z.output<typeof EngineReportSchema>;

export const EnginesSchema = z.object({
  engine: EngineIdSchema.describe('The engine in use (the setting sandbox.engine)'),
  engines: z.array(EngineReportSchema).describe('Every engine'),
});
export type Engines = z.output<typeof EnginesSchema>;

/** The lines `sandbox engine check` prints (plain: the colours are the command line's own). */
export function checkText(r: EngineReportRow): string {
  if (r.check.available) {
    const lines = [r.id + ' can be used on this PC.'];
    if (r.id === 'hcs') lines.push('HCS is in alpha: starting it is not enabled yet (docs/design/engines.md).');
    return lines.join('\n');
  }
  const lines = [r.id + ' cannot be used on this PC yet:'];
  r.check.reasons.forEach((reason, i) => {
    lines.push('', '  ' + (i + 1) + '. ' + reason, '     To fix: ' + (r.check.fixes[i] ?? FALLBACK_FIX));
  });
  lines.push('', 'Nothing was changed. These commands change Windows, so they are yours to run (or not).');
  return lines.join('\n');
}

export const engineStatus = defineQuery({
  id: 'engine.status',
  title: 'Engine',
  summary: 'the engine in use and what each engine can do on this PC',
  input: z.object({}),
  output: EnginesSchema,
  cli: { name: 'engine', action: 'show', json: true },
});

export const checkEngine = defineQuery({
  id: 'engine.check',
  title: 'Check an engine',
  summary: 'what this PC lacks for an engine, and the commands that would fix it',
  input: z.object({ engine: z.string().default('hcs').describe('the engine to check') }),
  output: EngineReportSchema,
  surfaces: {
    except: {
      menu: 'the Engine category shows every engine and its check with the fixes (engine.status)',
      web: 'the Engine page shows every engine and its check with the fixes (engine.status)',
    },
  },
  text: checkText,
  cli: {
    name: 'engine',
    action: 'check',
    positional: ['engine'],
    json: true,
    exitCode: (r) => (r.check.available ? 0 : 1),
  },
});

function engineSection(r: EngineReportRow): Section {
  const facts: Fact[] = CAPABILITY_KEYS.map((key) => {
    const yes = r.capabilities[key];
    return {
      id: key,
      label: CAPABILITY_NAMES[key],
      value: yes ? 'yes' : 'no',
      ...(yes ? {} : { tone: 'muted' as const }),
    };
  });
  const items: Item[] = [
    ...r.check.reasons.map((reason, i) => ({ id: 'reason:' + i, label: reason, tone: 'warn' as const })),
    ...r.check.fixes.map((fix, i) => ({ id: 'fix:' + i, label: 'Fix: ' + fix })),
  ];
  return {
    id: r.id,
    title: r.id + (r.id === 'hcs' ? '  (alpha)' : '') + (r.inUse ? '  (in use)' : ''),
    summary: r.check.available ? 'can be used on this PC' : 'cannot be used yet',
    facts,
    items,
  };
}

/** The engine page: the engine in use, then a card per engine with its capabilities, reasons and fixes. Pure. */
export function enginePage(o: Engines): Page {
  return {
    title: 'Engine',
    notice: { text: 'Engine in use: ' + o.engine + '  (setting: sandbox.engine)' },
    sections: o.engines.map(engineSection),
  };
}

export const engineView = defineView({
  id: 'engine',
  title: 'Engine',
  summary: 'What runs your sandbox, and what each engine can do on this PC.',
  queries: { engines: engineStatus },
  operations: [],
  build: ({ engines }) => enginePage(engines),
});
