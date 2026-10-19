// The audit log (audit.enabled): one file per day of JSON lines in host-only storage (<storage>\audit\<data set>),
// which the sandbox cannot reach. Days before today are gzipped; days past audit.days and, past audit.maxMb, the
// oldest days are deleted. Lines are short (field names are one or two letters) and capped in length; reading back is
// bounded too (a day's file, the events read).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { z } from 'zod';

export const AUDIT_KINDS = ['proc', 'file', 'commit', 'session', 'guard', 'note'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** A session id as the sandbox's run folder names them. */
export const AuditSessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * One event. k: proc (a program started), file (changed in a project), commit (a git commit in a project), session,
 * guard (repo guard), note.
 */
export const AuditEventSchema = z.object({
  /** ISO time. */
  t: z.string().max(40),
  k: z.enum(AUDIT_KINDS),
  /** proc: program; file: path in the project; commit: its message (first line); session: agent; guard/note: what. */
  p: z.string().max(1024).optional(),
  /** proc: its command line (capped, secrets hidden). */
  c: z.string().max(2048).optional(),
  /** proc: the program that started it. */
  pp: z.string().max(1024).optional(),
  /** file: change | rename; session: start | end; commit: commit | amend | merge | cherry-pick | revert | rebase. */
  a: z.string().max(32).optional(),
  /** project folder on this PC (file, commit, session). */
  w: z.string().max(1024).optional(),
  /** how many times it happened in this line's minute (repeats are counted, not repeated). */
  n: z.number().int().min(1).max(1e9).optional(),
  /** The agent session it belongs to, when known. */
  s: AuditSessionIdSchema.optional(),
  /** That session's agent and project (kept here: the session's own record goes with the sandbox). */
  ag: z.string().max(64).optional(),
  pj: z.string().max(128).optional(),
  /**
   * How it was linked to the session: p = by the programs the session started (as the sandbox reported them); t = it
   * was the only session running in that project at the time (likely, not proven).
   */
  sv: z.enum(['p', 't']).optional(),
  /** commit: its id. */
  h: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  /** commit: who git says made it ("Name <email>"). */
  au: z.string().max(256).optional(),
});
export type AuditEvent = z.output<typeof AuditEventSchema>;

/** Each text field's limit (the schema's): text is cut to it before writing, so a line is never refused on reading. */
const FIELD_MAX = { p: 1024, c: 2048, pp: 1024, a: 32, w: 1024, ag: 64, pj: 128, au: 256 } as const;

/** An event with every text field cut to its limit. */
export function clipEvent(e: AuditEvent): AuditEvent {
  const out: Record<string, unknown> = { ...e };
  for (const [key, max] of Object.entries(FIELD_MAX)) {
    const v = out[key];
    if (typeof v === 'string' && v.length > max) out[key] = v.slice(0, max - 1) + '…';
  }
  return out as AuditEvent;
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;
const DAY_MS = 86400000;
/** A day's file is never unpacked past this (a damaged or planted file cannot take all memory). */
const MAX_DAY_BYTES = 128 * 1024 * 1024;
/** Most events one read returns (the newest ones). */
const MAX_READ_EVENTS = 400000;

/** The audit log keeps at most this many days, whatever audit.days says (older settings allowed up to 365). */
export const MAX_AUDIT_DAYS = 30;

/** The first day (YYYY-MM-DD, UTC like the day files) of a window of `days` days ending today. */
export function firstDay(days: number, now = Date.now()): string {
  const kept = Math.min(MAX_AUDIT_DAYS, Math.max(1, days));
  return new Date(now - (kept - 1) * DAY_MS).toISOString().slice(0, 10);
}

export class AuditLog {
  constructor(
    readonly dir: string,
    private readonly limits: { days: number; maxMb: number },
  ) {}

  /** <storage>\audit\<data set name>. */
  static dirFor(storageRoot: string, dataPath: string): string {
    return path.join(storageRoot, 'audit', path.basename(dataPath));
  }

  private dayFile(day: string, gz = false): string {
    return path.join(this.dir, day + '.jsonl' + (gz ? '.gz' : ''));
  }

  private dayFiles(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((n) => DAY_FILE.test(n))
      .sort();
  }

  /**
   * Writes events (each cut to its fields' limits and checked, so every line written can be read back). Past
   * audit.maxMb nothing more is written but one note saying so, until old days are deleted.
   */
  append(events: readonly AuditEvent[]): void {
    if (!events.length) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const limit = this.limits.maxMb * 1024 * 1024;
    let size = this.bytes();
    if (size >= limit) {
      this.noteFull(events[events.length - 1].t);
      return;
    }
    const byDay = new Map<string, string[]>();
    for (const e of events) {
      const day = e.t.slice(0, 10);
      const checked = AuditEventSchema.safeParse(clipEvent(e));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !checked.success) continue;
      const line = JSON.stringify(checked.data);
      size += line.length + 1;
      if (size > limit) {
        this.noteFull(e.t);
        break;
      }
      byDay.set(day, [...(byDay.get(day) ?? []), line]);
    }
    for (const [day, lines] of byDay) fs.appendFileSync(this.dayFile(day), lines.join('\n') + '\n');
    if (size <= limit) this.fullNoted = false;
  }

  private fullNoted = false;

  /** One line saying the log is full (once until it has room again). */
  private noteFull(t: string): void {
    if (this.fullNoted) return;
    this.fullNoted = true;
    const note: AuditEvent = { t, k: 'note', p: 'the audit log reached audit.maxMb: nothing more is recorded for now' };
    fs.appendFileSync(this.dayFile(t.slice(0, 10)), JSON.stringify(note) + '\n');
  }

  /** Compresses finished days, then deletes days past the limits. Cheap when there is nothing to do. */
  maintain(today = new Date().toISOString().slice(0, 10)): void {
    if (!fs.existsSync(this.dir)) return;
    for (const name of fs.readdirSync(this.dir)) {
      const m = DAY_FILE.exec(name);
      if (!m || m[2] || m[1] >= today) continue;
      const file = path.join(this.dir, name);
      // Lines that arrived for a day already compressed (late reports) are added as another gzip member: the day's
      // compressed file is never written over.
      fs.appendFileSync(file + '.gz', zlib.gzipSync(fs.readFileSync(file)));
      fs.rmSync(file);
    }
    const oldest = firstDay(this.limits.days, Date.parse(today));
    for (const name of this.dayFiles().filter((n) => DAY_FILE.exec(n)![1] < oldest))
      fs.rmSync(path.join(this.dir, name), { force: true });
    let left = this.dayFiles();
    const size = (): number => left.reduce((sum, n) => sum + fs.statSync(path.join(this.dir, n)).size, 0);
    while (left.length > 1 && size() > this.limits.maxMb * 1024 * 1024) {
      fs.rmSync(path.join(this.dir, left[0]), { force: true });
      left = left.slice(1);
    }
  }

  /** The text of one day's file, or '' when it cannot be read within the limits. */
  private dayText(name: string): string {
    try {
      const file = path.join(this.dir, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_DAY_BYTES) return '';
      const raw = fs.readFileSync(file);
      return name.endsWith('.gz')
        ? zlib.gunzipSync(raw, { maxOutputLength: MAX_DAY_BYTES }).toString('utf8')
        : raw.toString('utf8');
    } catch {
      // Damaged or too big once unpacked: that day is left out rather than failing the whole read.
      return '';
    }
  }

  /**
   * Events of the last `days` days (never older than audit.days), oldest first, optionally of some kinds and
   * containing a text. At most MAX_READ_EVENTS (the newest).
   */
  read(o: { days?: number; kinds?: readonly AuditKind[]; grep?: string } = {}): AuditEvent[] {
    const since = firstDay(Math.min(o.days ?? 1, this.limits.days));
    const needle = o.grep?.toLowerCase();
    const days: AuditEvent[][] = [];
    let count = 0;
    // Newest day first, so the cap keeps the newest events.
    for (const name of this.dayFiles()
      .filter((n) => DAY_FILE.exec(n)![1] >= since)
      .reverse()) {
      if (count >= MAX_READ_EVENTS) break;
      const events: AuditEvent[] = [];
      for (const line of this.dayText(name).split('\n')) {
        if (!line.trim() || line.length > 16384) continue;
        if (needle && !line.toLowerCase().includes(needle)) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const e = AuditEventSchema.safeParse(parsed);
        if (!e.success) continue;
        if (o.kinds?.length && !o.kinds.includes(e.data.k)) continue;
        events.push(e.data);
      }
      const room = MAX_READ_EVENTS - count;
      const kept = events.length > room ? events.slice(events.length - room) : events;
      count += kept.length;
      days.push(kept);
    }
    return days.reverse().flat();
  }

  /** Total size on disk. */
  bytes(): number {
    return this.dayFiles().reduce((sum, n) => sum + fs.statSync(path.join(this.dir, n)).size, 0);
  }
}

/**
 * Folds repeats: the same event (kind, program/path, command line, action, project, session) within one minute becomes
 * one line with n = how many times; after `cap` distinct lines a minute, the rest of that minute is one "note" line.
 * Commits are never folded or dropped.
 */
export function fold(events: readonly AuditEvent[], cap = 300): AuditEvent[] {
  const out: AuditEvent[] = [];
  const index = new Map<string, AuditEvent>();
  const perMinute = new Map<string, number>();
  const dropped = new Map<string, number>();
  for (const e of events) {
    if (e.k === 'commit') {
      out.push({ ...e });
      continue;
    }
    const minute = e.t.slice(0, 16);
    const key = [minute, e.k, e.p, e.c, e.a, e.w, e.s].join('\0');
    const seen = index.get(key);
    if (seen) {
      seen.n = (seen.n ?? 1) + (e.n ?? 1);
      continue;
    }
    const count = (perMinute.get(minute) ?? 0) + 1;
    perMinute.set(minute, count);
    if (count > cap) {
      dropped.set(minute, (dropped.get(minute) ?? 0) + (e.n ?? 1));
      continue;
    }
    const copy = { ...e };
    index.set(key, copy);
    out.push(copy);
  }
  for (const [minute, n] of dropped)
    out.push({ t: minute + ':59.999Z', k: 'note', p: n + ' more events in this minute were not listed (audit cap)' });
  return out;
}
