// `sandbox logs`: the end of the newest log, the last crash report (--crash), and with --follow the new text until
// Ctrl+C. It reads through the logs feature's queries (readQuery) and only prints and loops: --follow cannot be a
// one-shot operation (see logs.def.ts).
import { CRASH, listLogs, tailLog } from '../../../app/features/logs/index.js';
import { readQuery } from '../../../app/registry.js';
import { fail, sleep } from '../../../core/util/index.js';
import { type Context } from '../context.js';

export async function logs(ctx: Context): Promise<number> {
  const crash = Boolean(ctx.options.crash);
  if (crash && !(await readQuery(listLogs, ctx)).crash) {
    console.log('No crash report yet: no sandbox has ended in a crash since this was installed.');
    return 0;
  }
  let tail = await readQuery(tailLog, ctx, { name: crash ? CRASH : undefined });
  if (!tail.file) {
    const listed = await readQuery(listLogs, ctx);
    fail('No sandbox logs yet in ' + listed.folder + '.', 'Logs appear after the first start (sandbox claude).');
  }
  console.log('== ' + tail.file + ' ==');
  if (crash) {
    console.log(tail.text);
    return 0;
  }
  process.stdout.write(tail.text);
  if (!ctx.options.follow) return 0;
  console.error('(following; Ctrl+C to stop)');
  for (;;) {
    await sleep(1000);
    const more = await readQuery(tailLog, ctx, { name: tail.name, from: tail.next });
    process.stdout.write(more.text);
    tail = { ...tail, next: more.next };
  }
}
