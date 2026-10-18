// The sandbox's own logs: the files (newest first), the end of one (live, so it follows), and the last crash report.
// Pure: schemas, labels and the view; logs.run.ts reads them through LogsService. `sandbox logs` stays a hand-written
// command (--follow prints until Ctrl+C), so both queries are CLI-exempt and that command reads them with readQuery.
import { z } from 'zod';
import {
  ago,
  bytesText,
  defineQuery,
  defineView,
  link,
  type Item,
  type Page,
  type Section,
} from '../../kernel/index.js';

/** The name that shows the newest crash report instead of a log (never a log file name: those start with guest-,
 * daemon- or bootstrap-). */
export const CRASH = '@crash';

/** Most lines the page shows of one log (a query gives at most `lines`; a crash report can be longer). */
const MAX_SHOWN = 1000;

const CLI_EXEMPT =
  'sandbox logs is hand-written: --follow prints new lines until Ctrl+C; it reads this same query (readQuery)';

export const LogFileSchema = z.object({
  name: z.string().describe('The log file'),
  path: z.string().describe('Where it is on this PC'),
  bytes: z.number().describe('Its size in bytes'),
  modified: z.number().describe('When it was last written (ms)'),
});
export type LogFileRow = z.output<typeof LogFileSchema>;

export const LogFilesSchema = z.object({
  folder: z.string().describe('The folder the logs are in'),
  files: z.array(LogFileSchema).describe('The log files, newest first'),
  crash: z.boolean().describe('A crash report exists'),
});
export type LogFiles = z.output<typeof LogFilesSchema>;

export const LogTailSchema = z.object({
  name: z.string().describe('The log shown, or @crash for the last crash report (empty: there are no logs)'),
  file: z.string().describe('Its full path (empty: there are no logs)'),
  text: z.string().describe('The text read, made safe for a terminal'),
  next: z.number().describe('Where to read on from next time (bytes)'),
});
export type LogTail = z.output<typeof LogTailSchema>;

export const listLogs = defineQuery({
  id: 'logs.list',
  title: 'Logs',
  summary: "list the sandbox's own logs",
  input: z.object({}),
  output: LogFilesSchema,
  surfaces: { except: { cli: CLI_EXEMPT } },
});

export const tailLog = defineQuery({
  id: 'logs.tail',
  title: 'Log',
  summary: 'the end of one log, followed as it grows',
  input: z.object({
    name: z
      .string()
      .max(200)
      .optional()
      .describe('The log to show (default: the newest), or @crash for the last crash report'),
    from: z.number().int().min(0).default(0).describe('Read on from this byte (0: the end of the log)'),
    lines: z.number().int().min(1).max(1000).default(120).describe('How many lines of the end to show'),
  }),
  output: LogTailSchema,
  live: { everyMs: 1000 },
  surfaces: { except: { cli: CLI_EXEMPT } },
});

/** What the view's address can set: the log shown. */
export interface LogsParams {
  readonly name?: string;
}

/** The badge of the log the page shows (a log is not "this folder": marked would say that). */
const SHOWING = { text: 'showing', tone: 'accent' } as const;

/** The lines of a text as a page shows them (the last MAX_SHOWN, no trailing empty line). */
function shownLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-MAX_SHOWN);
}

/** The page: one row per log (the one shown marked), the crash report last, and the end of the shown log. Pure. */
export function logsPage(files: LogFiles, tail?: LogTail): Page {
  const shown = tail?.file ? tail : undefined;
  const items: Item[] = files.files.map((f) => ({
    id: 'log:' + f.name,
    label: f.name,
    hint: bytesText(f.bytes) + '  ' + ago(f.modified),
    keys: 'Enter shows the end of this log in the terminal.',
    primary: link({ kind: 'view', view: 'logs', params: { name: f.name } }, 'Show', { verb: 'show' }),
    ...(shown?.name === f.name ? { badges: [SHOWING] } : {}),
  }));
  if (files.crash)
    items.push({
      id: 'log:' + CRASH,
      label: 'Last crash report',
      description: 'What Windows logged, this PC and the sandbox memory when the sandbox last ended in a crash.',
      primary: link({ kind: 'view', view: 'logs', params: { name: CRASH } }, 'Show', { verb: 'show' }),
      ...(shown?.name === CRASH ? { badges: [SHOWING] } : {}),
    });
  const tailSection: Section[] = shown
    ? [
        {
          id: 'tail',
          title: shown.name === CRASH ? 'Last crash report' : shown.name,
          summary: shown.file,
          text: shownLines(shown.text),
        },
      ]
    : [];
  return {
    title: 'Logs',
    sections: [{ id: 'files', items }, ...tailSection],
    actions: [
      // The web hides command links (it follows live instead); this one stays because `logs` is a hand-written command.
      link({ kind: 'command', argv: ['logs', '--follow'] }, 'Follow the newest log', {
        key: 'f',
        verb: 'follow in the terminal',
        importance: 2,
      }),
    ],
    empty: { title: 'No logs yet', text: 'Logs appear after the first start.', cliText: 'No sandbox logs yet.' },
  };
}

export const logsView = defineView({
  id: 'logs',
  title: 'Logs',
  summary: "The sandbox's own logs: pick one to see its end as it grows.",
  queries: { files: listLogs, tail: tailLog },
  operations: [],
  params: ['name'],
  inputs: (p: LogsParams) => ({ tail: p.name ? { name: p.name } : {} }),
  build: ({ files, tail }) => logsPage(files, tail),
});
