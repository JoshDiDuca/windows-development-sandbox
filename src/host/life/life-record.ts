// Why the last sandbox stopped, when nobody stopped it. The background watcher writes a host-only "life" record (when
// the sandbox started, when it was last seen running, how it ended) and keeps this PC awake while it runs
// (sandbox.keepAwake). When the PC restarts, sleeps or crashes, the watcher stops too and the record has no end: the
// next launch reads Windows' System log from that moment on and says what happened, and what keeps it from happening.
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';
import { hostStateFile } from '../storage/index.js';
import { causeSince, IsoSchema, STOP_KINDS, type StopCause } from './stop-events.js';
import { stopWarning } from './stop-warning.js';
import { saveCrashReport } from './crash-report.js';

const LifeSchema = z.object({
  started: IsoSchema,
  lastSeen: IsoSchema,
  keepAwake: z.boolean(),
  ended: z
    .object({
      at: IsoSchema,
      cause: z
        .object({
          kind: z.enum(STOP_KINDS),
          at: IsoSchema,
          text: z.string().max(400),
        })
        .nullable(),
      report: z.string().max(1000).optional(),
    })
    .optional(),
  reported: z.boolean().optional(),
});
export type Life = z.output<typeof LifeSchema>;

/** <storage>\sync\<data>-life.json: how the running (or last) sandbox lived and ended. */
export class LifeRecord {
  private readonly file: JsonFile<Life>;

  constructor(
    private readonly storageRoot: string,
    private readonly dataPath: string,
  ) {
    this.file = new JsonFile(LifeSchema, hostStateFile(storageRoot, dataPath, '-life.json'));
  }

  read(): Life | null {
    return this.file.read();
  }

  /** At launch: a fresh record (the previous one has been reported by then). */
  start(keepAwake: boolean, now = new Date()): void {
    this.file.write({ started: now.toISOString(), lastSeen: now.toISOString(), keepAwake });
  }

  /** Every minute while the sandbox runs. */
  beat(now = new Date()): void {
    const life = this.read();
    if (life && !life.ended) this.file.write({ ...life, lastSeen: now.toISOString() });
  }

  /**
   * The watcher saw the sandbox close while this PC kept running: closed by you (no cause), or by sleep / low memory.
   */
  end(cause: StopCause | null, now = new Date(), report: string | null = null): void {
    const life = this.read();
    if (life && !life.ended)
      this.file.write({ ...life, ended: { at: now.toISOString(), cause, ...(report ? { report } : {}) } });
  }

  /**
   * At launch: one warning when the last sandbox ended without anyone closing it (the PC restarted, crashed, slept or
   * ran out of memory), then never again for that run. `watcherAlive` = its watcher is still running (then it did not
   * end).
   */
  lastStopWarning(watcherAlive: boolean, find?: (since: string) => StopCause | null): string | null {
    const life = this.read();
    if (!life || life.reported || watcherAlive) return null;
    this.file.write({ ...life, reported: true });
    // The watcher writes the report when it sees the end; when this PC itself went down, it is written now.
    const report = (): string | null =>
      life.ended?.report ?? (find ? null : saveCrashReport(this.storageRoot, this.dataPath, life.lastSeen));
    return stopWarning(life, find ?? ((since) => causeSince(since, this.storageRoot)), report);
  }
}
