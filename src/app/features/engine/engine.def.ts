// The engine area: HCS compute systems this tool left running (a crashed command can leave a utility VM up: it holds
// memory, not data) and stopping them. Pure: schemas, labels and the view; engine.run.ts does the work. The planned
// engine.status / engine.check definitions of the engine area (docs/design/areas/11-engine.md) join this file, and the
// `engine` view gets their query beside `leftovers`.
import { z } from 'zod';
import {
  action,
  ago,
  defineOperation,
  defineQuery,
  defineView,
  plural,
  type Item,
  type Page,
} from '../../kernel/index.js';

export const LeftoverSystemSchema = z.object({
  id: z.string().describe('The compute system'),
  kind: z.string().describe('Container or VirtualMachine (the utility VM)'),
  state: z.string().describe('What it is doing'),
  since: z.string().nullable().describe('When it was created (ISO time), when HCS says'),
});
export type LeftoverRow = z.output<typeof LeftoverSystemSchema>;

export const LeftoversSchema = z.object({
  available: z.boolean().describe('HCS could be asked'),
  message: z.string().describe('Why nothing is listed, or what was found'),
  systems: z.array(LeftoverSystemSchema).describe('Ours that are running now'),
});
export type Leftovers = z.output<typeof LeftoversSchema>;

export const engineLeftovers = defineQuery({
  id: 'engine.leftovers',
  title: 'HCS systems left running',
  summary: 'list the HCS compute systems this tool left running (a crashed command can leave one up)',
  input: z.object({}),
  output: LeftoversSchema,
  cli: { name: 'engine', action: 'leftovers', json: true },
});

export const cleanEngine = defineOperation({
  id: 'engine.clean',
  title: 'Stop the leftover systems…',
  summary: 'stop the HCS compute systems this tool left running (frees their memory; no data is lost)',
  input: z.object({}),
  output: z.object({
    available: z.boolean().describe('HCS could be asked'),
    stopped: z.number().describe('How many were stopped'),
    failed: z.number().describe('How many could not be stopped'),
    message: z.string().describe('What happened'),
  }),
  danger: true,
  text: (o) => o.message,
  cli: { name: 'engine', action: 'clean' },
});

function systemItem(s: LeftoverRow): Item {
  return {
    id: s.id,
    label: s.id,
    hint: s.state + (s.since ? '  started ' + ago(s.since) : ''),
    tone: 'warn',
    details: [
      'System   ' + s.id,
      'Kind     ' + s.kind,
      'State    ' + s.state,
      ...(s.since ? ['Created  ' + s.since] : []),
    ],
  };
}

/** The leftovers page: one row per system with the way to stop them, or why there is nothing. */
export function engineLeftoversPage(o: Leftovers): Page {
  return {
    title: 'Engine',
    sections: o.systems.length
      ? [
          {
            id: 'leftovers',
            title: 'HCS systems left running',
            summary: plural(o.systems.length, 'system') + ' (memory, not data)',
            items: o.systems.map(systemItem),
            actions: [action(cleanEngine, {}, { key: 'x', verb: 'stop them', importance: 1 })],
          },
        ]
      : [],
    empty: { title: 'Nothing left running', text: o.message },
  };
}

export const engineView = defineView({
  id: 'engine',
  title: 'Engine',
  summary: 'HCS systems this tool left running, and stopping them.',
  queries: { leftovers: engineLeftovers },
  operations: [cleanEngine],
  build: ({ leftovers }) => engineLeftoversPage(leftovers),
});
