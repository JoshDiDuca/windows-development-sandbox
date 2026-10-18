// The logs feature's work: the sandbox's log files and the end of one, through LogsService. The text is made safe for a
// terminal there (the sandbox wrote it); a name from outside is only ever an exact name from the folder listing.
import { fail, safeText } from '../../../core/util/index.js';
import { newestCrashReport } from '../../../host/life/index.js';
import { LogsService } from '../../../cli/services/index.js';
import { implement } from '../../context.js';
import { CRASH, listLogs, tailLog } from './logs.def.js';

/** The last `n` lines of a text, joined back the way they were (a trailing newline stays). */
function lastLines(text: string, n: number): string {
  return text.split('\n').slice(-n).join('\n');
}

export const listLogsRun = implement(listLogs, (ctx) => {
  const service = new LogsService(ctx);
  return {
    folder: service.folder(),
    files: service.files().map((f) => ({ name: f.name, path: f.path, bytes: f.bytes, modified: f.modified })),
    crash: newestCrashReport(ctx.storageRoot) !== null,
  };
});

export const tailLogRun = implement(tailLog, (ctx, input) => {
  if (input.name === CRASH) {
    const report = newestCrashReport(ctx.storageRoot);
    if (!report) return fail('No crash report yet: no sandbox has ended in a crash since this was installed.');
    return { name: CRASH, file: report.file, text: safeText(report.text), next: 0 };
  }
  const service = new LogsService(ctx);
  // No name and no logs yet: an empty answer (the page says so; the command line fails with the words it always had).
  const name = input.name ?? service.files()[0]?.name;
  if (!name) return { name: '', file: '', text: '', next: 0 };
  const file = service.byName(name);
  const chunk = service.read(file, input.from);
  if (!chunk) return { name, file, text: '', next: input.from };
  return {
    name,
    file,
    text: input.from === 0 ? lastLines(chunk.text, input.lines) : chunk.text,
    next: chunk.next,
  };
});
