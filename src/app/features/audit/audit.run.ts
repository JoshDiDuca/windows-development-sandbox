// The audit feature's work: reads the log on this PC and sums it up (totals, per agent, per session). Much of what is
// in the log came from the sandbox, so every text is made plain (no control codes) before it leaves here.
import { plainText } from '../../../core/util/index.js';
import { AuditLog, type AuditEvent } from '../../../host/audit/index.js';
import { implement } from '../../context.js';
import type { InputOf } from '../../kernel/index.js';
import { listAudit, NO_SESSION, type AuditList, type AuditRow, type AuditSession } from './audit.def.js';

type AuditInput = InputOf<typeof listAudit>;

/** Most sessions listed. */
const MAX_SESSIONS = 60;

const plain = (s: string | undefined): string | undefined => (s === undefined ? undefined : plainText(s));

/** A stored event as the feature shows it. */
export function auditRow(e: AuditEvent): AuditRow {
  const opt = <K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> =>
    value ? ({ [key]: plainText(value) } as Record<K, string>) : {};
  return {
    time: e.t,
    kind: e.k,
    what: plain(e.k === 'session' ? (e.ag ?? e.p) : e.p) ?? '',
    ...opt('command', e.c),
    ...opt('parent', e.pp),
    ...opt('action', e.a),
    ...opt('folder', e.w),
    ...opt('project', e.pj),
    ...opt('session', e.s),
    ...opt('agent', e.ag),
    ...(e.s && e.sv ? { linked: e.sv === 't' ? ('only-session' as const) : ('process' as const) } : {}),
    count: e.n ?? 1,
    ...opt('sha', e.h),
    ...opt('author', e.au),
  };
}

/** Does an event pass the filters that are not about its kind? */
function inScope(e: AuditEvent, input: AuditInput): boolean {
  const same = (a: string | undefined, b: string): boolean => a !== undefined && a.toLowerCase() === b.toLowerCase();
  if (input.session !== undefined) {
    if (input.session === NO_SESSION ? e.s !== undefined : !e.s?.startsWith(input.session)) return false;
  }
  if (input.agent !== undefined && !same(e.ag, input.agent)) return false;
  if (input.project !== undefined && !same(e.pj, input.project)) return false;
  return true;
}

interface Tally {
  commands: number;
  files: Set<string>;
  commits: number;
}

const tally = (): Tally => ({ commands: 0, files: new Set(), commits: 0 });

function count(t: Tally, e: AuditEvent): void {
  if (e.k === 'proc') t.commands += e.n ?? 1;
  if (e.k === 'file') t.files.add((e.w ?? '') + '\0' + (e.p ?? ''));
  if (e.k === 'commit') t.commits += 1;
}

const counts = (t: Tally): { commands: number; files: number; commits: number } => ({
  commands: t.commands,
  files: t.files.size,
  commits: t.commits,
});

/** The listing for these filters, from a log (the command line, the menu and the web all show this). */
export function auditListing(
  log: AuditLog,
  settings: { readonly enabled: boolean; readonly days: number; readonly maxMb: number },
  input: AuditInput,
  folder: string,
  now = Date.now(),
): AuditList {
  // The last n × 24 hours (the day files are UTC days: one more is read, then cut to the hour).
  const since = new Date(now - input.days * 86400000).toISOString();
  const scoped = log.read({ days: input.days + 1, grep: input.grep }).filter((e) => e.t >= since && inScope(e, input));
  const total = tally();
  const unlinked = tally();
  const perSession = new Map<string, { info: AuditSession; t: Tally }>();
  for (const e of scoped) {
    count(total, e);
    if (!e.s) {
      count(unlinked, e);
      continue;
    }
    let entry = perSession.get(e.s);
    if (!entry) {
      entry = {
        info: {
          id: plainText(e.s),
          agent: plainText(e.ag ?? (e.k === 'session' ? (e.p ?? '?') : '?')),
          project: plainText(e.pj ?? '?'),
          started: e.t,
          commands: 0,
          files: 0,
          commits: 0,
        },
        t: tally(),
      };
      perSession.set(e.s, entry);
    }
    count(entry.t, e);
    if (e.k === 'session' && e.a === 'end') entry.info = { ...entry.info, ended: e.t };
    if (e.k === 'proc' && (e.c || e.p)) entry.info = { ...entry.info, last: plainText(e.c || e.p || '') };
  }
  const sessions = [...perSession.values()]
    .map(({ info, t }) => ({ ...info, ...counts(t) }))
    .sort((a, b) => b.started.localeCompare(a.started));
  const agents = new Map<string, { sessions: number; commands: number; files: number; commits: number }>();
  for (const s of sessions) {
    const a = agents.get(s.agent) ?? { sessions: 0, commands: 0, files: 0, commits: 0 };
    agents.set(s.agent, {
      sessions: a.sessions + 1,
      commands: a.commands + s.commands,
      files: a.files + s.files,
      commits: a.commits + s.commits,
    });
  }
  const matching = input.kind === 'all' ? scoped : scoped.filter((e) => e.k === input.kind);
  return {
    enabled: settings.enabled,
    keepDays: settings.days,
    maxMb: settings.maxMb,
    bytes: log.bytes(),
    folder,
    filter: {
      days: input.days,
      kind: input.kind,
      ...(input.session !== undefined ? { session: input.session } : {}),
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.project !== undefined ? { project: input.project } : {}),
      ...(input.grep !== undefined ? { grep: input.grep } : {}),
    },
    matched: matching.length,
    events: matching.slice(-input.limit).reverse().map(auditRow),
    totals: { events: scoped.length, ...counts(total), sessions: sessions.length },
    agents: [...agents.entries()].map(([agent, a]) => ({ agent, ...a })).sort((a, b) => b.commands - a.commands),
    sessions: sessions.slice(0, MAX_SESSIONS),
    unlinked: counts(unlinked),
  };
}

export const listAuditRun = implement(listAudit, (ctx, input) => {
  const settings = ctx.loaded.config.audit;
  const folder = AuditLog.dirFor(ctx.storageRoot, ctx.dataPath);
  return auditListing(new AuditLog(folder, settings), settings, input, folder);
});
