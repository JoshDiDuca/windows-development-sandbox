// The data area: what the sandbox keeps between runs (toolchains, databases, agent state, logs, what this PC keeps for
// it), deleting chosen parts of it, and the clean-up of old launch folders. Pure: the page builder is here, the work is
// in data.run.ts. Sizes come as bytes and as words (the run formats them: this file cannot import core/disk).
import { z } from 'zod';
import {
  action,
  defineOperation,
  defineQuery,
  defineView,
  fieldOf,
  SchemaNode,
  type Item,
  type Page,
  type Section,
} from '../../kernel/index.js';

export const DATA_AREAS = ['tools', 'databases', 'state', 'logs', 'data', 'host'] as const;
export type DataAreaName = (typeof DATA_AREAS)[number];

/** The heading of each area's section (the CLI's group labels). */
export const AREA_LABEL: Readonly<Record<DataAreaName, string>> = {
  tools: 'Toolchains',
  databases: 'Databases',
  state: 'Agent state',
  logs: 'Logs',
  data: 'Other',
  host: 'On this PC',
};

const DataEntrySchema = z.object({
  area: z.enum(DATA_AREAS).describe('Which kind of data it is'),
  name: z.string().describe('The folder as listed (tools: its name; others: area/name)'),
  path: z.string().describe('Its full path on this PC'),
  bytes: z.number().describe('Its size in bytes (links count 0)'),
  size: z.string().describe('Its size in words, e.g. 1.5 KB'),
  target: z.string().nullable().describe('What sandbox data clean calls it; null when it is kept on purpose'),
});

const DiskSchema = z.object({
  drive: z.string().describe('The drive, e.g. C:\\'),
  totalBytes: z.number().describe('Its size in bytes'),
  freeBytes: z.number().describe('Free bytes'),
  usedBytes: z.number().describe('Used bytes'),
  holdsStorage: z.boolean().describe('The sandbox keeps its files on this drive'),
  used: z.string().describe('Used, in words'),
  usedPercent: z.number().describe('Used, in percent of the size (rounded)'),
  free: z.string().describe('Free, in words'),
  total: z.string().describe('Size, in words'),
});

export const DataShowSchema = z.object({
  dataPath: z.string().describe('The data folder (C:\\AgentData inside the sandbox)'),
  storageRoot: z.string().describe('The storage folder that holds it'),
  totalBytes: z.number().describe('Everything listed, in bytes'),
  total: z.string().describe('Everything listed, in words'),
  storageShare: z.string().describe('"<- sandbox storage (<total> of it)": the note on the storage drive'),
  areaTotals: z.record(z.string(), z.string()).describe("Each area's total in words"),
  entries: z.array(DataEntrySchema).describe('What is stored, by area, biggest first'),
  disks: z.array(DiskSchema).describe("This PC's drives"),
});
export type DataShow = z.output<typeof DataShowSchema>;
export type DataEntryRow = z.output<typeof DataEntrySchema>;
export type DataDisk = z.output<typeof DiskSchema>;

export const showData = defineQuery({
  id: 'data.show',
  title: 'Stored data',
  summary: 'show what is kept between sandboxes (tools, databases, logins, logs), or delete some of it',
  input: z.object({}),
  output: DataShowSchema,
  cli: {
    name: 'data',
    action: 'show',
    json: true,
    // The --json shape `sandbox data` has always printed.
    shapeJson: (o) => ({
      dataPath: o.dataPath,
      storageRoot: o.storageRoot,
      totalBytes: o.totalBytes,
      entries: o.entries.map(({ area, name, path, bytes }) => ({ area, name, path, bytes })),
      disks: o.disks.map(({ drive, totalBytes, freeBytes, usedBytes, holdsStorage }) => ({
        drive,
        totalBytes,
        freeBytes,
        usedBytes,
        holdsStorage,
      })),
    }),
  },
});

const MessageSchema = z.object({ message: z.string().describe('What happened') });

export const cleanData = defineOperation({
  id: 'data.clean',
  title: 'Delete stored data…',
  summary: 'delete chosen parts of what is kept between sandboxes',
  input: z.object({
    targets: z.array(z.string()).default([]).describe('what to clean, e.g. tools/go databases logs'),
  }),
  output: MessageSchema.extend({
    freedBytes: z.number().describe('Bytes freed (0 when nothing was removed)'),
  }),
  danger: true,
  text: (o) => o.message,
  next: (o) => (o.freedBytes > 0 ? 'sandbox data   (see what is left)' : undefined),
  cli: { name: 'data', action: 'clean', positional: ['targets'] },
});

const PruneInputSchema = z.object({
  days: z.number().int().min(1).default(7).describe('launch folders older than this many days'),
});

export const pruneStorage = defineOperation({
  id: 'data.prune',
  title: 'Clean up…',
  summary: 'delete old launch folders, logs and leftovers',
  input: PruneInputSchema,
  output: MessageSchema.extend({ removed: z.boolean().describe('Something was deleted') }),
  text: (o) => o.message,
  next: (o) => (o.removed ? 'sandbox data   (see what else is saved, and clean it)' : undefined),
  cli: {
    name: 'clean',
    group: 'Data',
    flags: { days: { flag: '--days', value: 'n' } },
    yes: 'do not ask before deleting',
  },
});

const DAYS_FIELD = fieldOf(new SchemaNode(PruneInputSchema).child('days')!, ['days']);

/** The data page: disks, then one section per area, the total, and clean-up. */
export function dataPage(o: DataShow): Page {
  const disks: Section = {
    id: 'disks',
    title: 'Disks',
    columns: [
      { key: 'drive', label: 'DRIVE' },
      { key: 'used', label: 'USED' },
      { key: 'free', label: 'FREE' },
      { key: 'size', label: 'SIZE' },
      { key: 'note', label: '' },
    ],
    // The web shows each drive as a row (a table with the storage note does not fit a phone); the CLI keeps the table.
    columnsOn: 'cli',
    items: o.disks.map((d): Item => ({
      id: 'disk:' + d.drive,
      label: d.drive,
      hint: d.used + ' used · ' + d.free + ' free of ' + d.total, // the menu's wording
      ...(d.holdsStorage ? { description: 'The sandbox keeps its files on this drive.' } : {}),
      cells: {
        drive: d.drive,
        used: d.used + ' (' + d.usedPercent + '%)',
        free: d.free,
        size: d.total,
        note: d.holdsStorage ? o.storageShare : '',
      },
    })),
    notes: [{ text: 'Persistent data for the sandbox: ' + o.dataPath + ' (C:\\AgentData inside)' }],
  };
  const areas: Section[] = DATA_AREAS.flatMap((area) => {
    const rows = o.entries.filter((e) => e.area === area);
    if (!rows.length) return [];
    return [
      {
        id: 'area:' + area,
        title: AREA_LABEL[area],
        summary: o.areaTotals[area] ?? '',
        columns: [
          { key: 'name', label: '' },
          { key: 'size', label: '' },
          { key: 'path', label: '' },
        ],
        columnsOn: 'cli' as const,
        items: rows.map((e): Item => ({
          id: 'entry:' + e.name,
          label: e.name,
          hint: e.size,
          ...(e.target
            ? { keys: 'x deletes it.' }
            : { description: 'Kept on this PC on purpose; it is not deleted here.' }),
          details: ['Folder  ' + e.path],
          cells: { name: '  ' + e.name, size: e.size, path: e.path },
          actions: e.target
            ? [action(cleanData, { targets: [e.target] }, { label: 'Delete', key: 'x', verb: 'delete' })]
            : [],
        })),
      },
    ];
  });
  const total: Section = {
    id: 'total',
    facts: [{ id: 'total', label: 'Total', value: o.total }],
    notes: [
      ...(o.entries.length
        ? []
        : [{ text: 'Nothing stored yet. Toolchains, databases and agent logins appear here after the first start.' }]),
      {
        text: 'Free space with: sandbox data clean <target...>  (e.g. tools/go, databases/postgres-18, logs, launches)',
        tone: 'muted' as const,
        only: 'cli' as const,
      },
    ],
  };
  const clean: Section = {
    id: 'clean',
    title: 'Clean up',
    actions: [
      action(
        pruneStorage,
        {},
        {
          label: 'Clean up…',
          verb: 'choose what',
          description: 'Delete caches, old sandboxes and other leftovers (the clean command, with its options).',
          fields: [DAYS_FIELD],
        },
      ),
    ],
  };
  return { title: 'Data', sections: [disks, ...areas, total, clean] };
}

export const dataView = defineView({
  id: 'data',
  title: 'Data',
  summary: 'What the sandbox keeps between runs, and deleting parts of it.',
  queries: { data: showData },
  operations: [cleanData, pruneStorage],
  build: ({ data }) => dataPage(data),
});
