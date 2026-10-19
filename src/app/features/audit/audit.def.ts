// The audit log as a page: what the agents ran, changed and committed, per session, from the log on this PC
// (audit.enabled). Pure: schemas, labels and the view; audit.run.ts reads the log. Filters are the query's input: the
// command line has them as flags (sandbox audit --days 7 --session <id>), the web as the view's filters and
// parameters, and each session's card opens the page filtered to it.
import { z } from 'zod';
import {
  action,
  ago,
  bytesText,
  defineQuery,
  defineView,
  link,
  plural,
  type Fact,
  type Item,
  type Page,
  type Section,
} from '../../kernel/index.js';
import { setSetting } from '../settings/settings.def.js';

export const AUDIT_EVENT_KINDS = ['proc', 'file', 'commit', 'session', 'guard', 'note', 'remote'] as const;
export const AUDIT_KIND_FILTERS = ['all', 'proc', 'file', 'commit', 'session', 'guard', 'remote'] as const;
/** The days the page offers (the log keeps at most 30). */
const PERIODS = [1, 3, 7, 14, 30] as const;
/** The session filter that means "not linked to any session". */
export const NO_SESSION = 'none';
/** The longest "what" a table cell shows (the whole text is in the details and in --json). */
const CELL_MAX = 240;

const KIND_LABEL: Readonly<Record<(typeof AUDIT_EVENT_KINDS)[number], string>> = {
  proc: 'command',
  file: 'file',
  commit: 'commit',
  session: 'session',
  guard: 'GUARD',
  note: 'note',
  remote: 'remote',
};

export const AuditRowSchema = z.object({
  time: z.string().describe('When it happened (ISO time)'),
  kind: z
    .enum(AUDIT_EVENT_KINDS)
    .describe(
      'proc: a program started; file: changed in a project; commit; session; guard: the repo guard; note; remote: what another Windows user or a paired device did in the web UI',
    ),
  what: z.string().describe('The program, the file, the commit message, the agent, or what happened'),
  command: z.string().optional().describe("A program's command line (secrets hidden)"),
  parent: z.string().optional().describe('The program that started it'),
  action: z
    .string()
    .optional()
    .describe('file: change or rename; session: start or end; commit: commit, amend, merge, cherry-pick ...'),
  folder: z.string().optional().describe('The project folder on this PC'),
  project: z.string().optional().describe('The project'),
  session: z.string().optional().describe('The agent session it belongs to (missing: not known)'),
  agent: z.string().optional().describe("That session's agent"),
  linked: z
    .enum(['process', 'only-session'])
    .optional()
    .describe(
      'How it was linked: process = by the programs the session started; only-session = the only session running in that project then (likely, not proven)',
    ),
  count: z.number().int().describe('How many times it happened in that minute'),
  sha: z.string().optional().describe("A commit's id"),
  author: z.string().optional().describe("A commit's author; for remote: who did it"),
});
export type AuditRow = z.output<typeof AuditRowSchema>;

const CountsSchema = z.object({
  commands: z.number().int().describe('Programs started'),
  files: z.number().int().describe('Files changed (each file once)'),
  commits: z.number().int().describe('Commits'),
});

export const AuditSessionSchema = CountsSchema.extend({
  id: z.string().describe('The session'),
  agent: z.string().describe('Its agent'),
  project: z.string().describe('Its project'),
  started: z.string().describe('Its first event (ISO time)'),
  ended: z.string().optional().describe('When it ended, if that was recorded'),
  last: z.string().optional().describe('The last command it ran'),
});
export type AuditSession = z.output<typeof AuditSessionSchema>;

export const AuditAgentSchema = CountsSchema.extend({
  agent: z.string().describe('The agent'),
  sessions: z.number().int().describe('Its sessions'),
});

export const AuditListSchema = z.object({
  enabled: z.boolean().describe('The audit log is on (audit.enabled)'),
  keepDays: z.number().int().describe('Days it is kept (audit.days)'),
  maxMb: z.number().int().describe('Most space it may take (audit.maxMb)'),
  bytes: z.number().describe('Space it takes now'),
  folder: z.string().describe('Where it is on this PC'),
  filter: z.object({
    days: z.number().int(),
    kind: z.enum(AUDIT_KIND_FILTERS),
    session: z.string().optional(),
    agent: z.string().optional(),
    project: z.string().optional(),
    grep: z.string().optional(),
  }),
  /** Events that match every filter (the list holds the newest of them). */
  matched: z.number().int(),
  events: z.array(AuditRowSchema).describe('The events, newest first'),
  /** Over the period and filters, every kind. */
  totals: CountsSchema.extend({ events: z.number().int(), sessions: z.number().int() }),
  agents: z.array(AuditAgentSchema),
  sessions: z.array(AuditSessionSchema).describe('The sessions in the period, newest first'),
  /** What no session can be linked to. */
  unlinked: CountsSchema,
});
export type AuditList = z.output<typeof AuditListSchema>;

export const listAudit = defineQuery({
  id: 'audit.list',
  title: 'Activity',
  summary: 'what your agents did: programs started, files changed, commits, sessions, repo guard',
  input: z.object({
    days: z.number().int().min(1).max(30).default(1).describe('the last n days (1: the last 24 hours)'),
    kind: z.enum(AUDIT_KIND_FILTERS).default('all').describe('only proc, file, commit, session or guard events'),
    session: z
      .string()
      .max(64)
      .optional()
      .describe('only the events of this session (its id or the start of it; none: not linked to a session)'),
    agent: z.string().max(64).optional().describe("only this agent's events"),
    project: z.string().max(128).optional().describe("only this project's events"),
    grep: z.string().max(200).optional().describe('only events containing this text'),
    limit: z.number().int().min(1).max(5000).default(300).describe('show at most this many events (the newest)'),
  }),
  output: AuditListSchema,
  live: { everyMs: 15000 },
  cli: {
    name: 'audit',
    group: 'Health',
    json: true,
    flags: {
      days: { flag: '--days', value: 'n' },
      kind: { flag: '--kind', value: 'kind' },
      session: { flag: '--session', value: 'id' },
      agent: { flag: '--agent', value: 'name' },
      project: { flag: '--project', value: 'name' },
      grep: { flag: '--grep', value: 'text' },
      limit: { flag: '--limit', value: 'n', advanced: true },
    },
    // Oldest first, like the log itself.
    shapeJson: (o) => [...o.events].reverse(),
    examples: ['sandbox audit --days 7 --kind commit', 'sandbox audit --session 4f2c --grep "git push"'],
  },
});

/** "14:03:22" today, "Oct 18 14:03" before (local time). */
export function eventTime(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const two = (n: number): string => String(n).padStart(2, '0');
  const today = new Date(now).toDateString() === d.toDateString();
  if (today) return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return month + ' ' + d.getDate() + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
}

/** The first few characters of a session id (enough to tell sessions apart, and to filter by). */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** What an event says, in one line. */
export function eventWhat(e: AuditRow): string {
  switch (e.kind) {
    case 'proc':
      return e.command || e.what;
    case 'file':
      return (e.action === 'rename' ? 'added/removed ' : 'changed ') + e.what;
    case 'commit':
      return (
        (e.sha ? e.sha.slice(0, 7) + ' ' : '') +
        e.what +
        (e.action && e.action !== 'commit' ? ' (' + e.action + ')' : '')
      );
    case 'session':
      return e.what + (e.action === 'end' ? ' ended' : ' started') + (e.project ? ' in ' + e.project : '');
    case 'remote':
      return (e.author ?? 'someone') + ': ' + e.what + (e.action && e.action !== 'ok' ? ' (' + e.action + ')' : '');
    default:
      return e.what;
  }
}

/** Who did it: the agent, with ? when only likely, - when not known. */
function whoText(e: AuditRow): string {
  if (!e.agent) return '-';
  return e.agent + (e.linked === 'only-session' ? '?' : '');
}

function clip(text: string, max = CELL_MAX): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function eventItem(e: AuditRow, index: number): Item {
  const what = eventWhat(e) + (e.count > 1 ? '  ×' + e.count : '');
  const details = [
    ...(e.session ? ['Session   ' + e.session + (e.linked === 'only-session' ? ' (likely)' : '')] : []),
    ...(e.project ? ['Project   ' + e.project] : []),
    ...(e.kind === 'proc' && e.command && e.what !== e.command ? ['Program   ' + e.what] : []),
    ...(e.parent ? ['Started by  ' + e.parent] : []),
    ...(e.author ? ['Author    ' + e.author] : []),
    ...(e.sha ? ['Commit    ' + e.sha] : []),
    ...(e.folder && e.kind !== 'session' ? ['Folder    ' + e.folder] : []),
  ];
  return {
    id: 'event:' + index,
    label: clip(what),
    hint: eventTime(e.time) + '  ' + whoText(e),
    tone: e.kind === 'guard' ? 'warn' : undefined,
    details,
    keywords: [e.session, e.project, e.agent, e.kind, e.author].filter(Boolean).join(' '),
    cells: {
      time: eventTime(e.time),
      agent: whoText(e),
      kind: KIND_LABEL[e.kind],
      what: clip(what),
    },
  };
}

/** The address of the page with these filters (the period and kind kept unless given). */
function filtered(o: AuditList, more: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return { days: String(o.filter.days), kind: o.filter.kind, ...more };
}

/** "12 commands, 3 files, 1 commit". */
function countsText(c: { commands: number; files: number; commits: number }): string {
  return plural(c.commands, 'command') + ', ' + plural(c.files, 'file') + ', ' + plural(c.commits, 'commit');
}

function sessionItem(o: AuditList, s: AuditSession): Item {
  return {
    id: 'session:' + s.id,
    label: s.agent + '  ' + s.project,
    icon: s.agent,
    hint: 'started ' + ago(s.started) + (s.ended ? ', ended ' + ago(s.ended) : ''),
    badges: [
      ...(s.commits ? [{ text: plural(s.commits, 'commit'), tone: 'accent' as const }] : []),
      ...(s.ended ? [{ text: 'ended', tone: 'muted' as const }] : []),
    ],
    details: ['Did       ' + countsText(s), ...(s.last ? ['Last      ' + clip(s.last, 120)] : []), 'Session   ' + s.id],
    keywords: s.id,
    cells: {
      session: shortId(s.id),
      agent: s.agent,
      project: s.project,
      started: eventTime(s.started),
      commands: String(s.commands),
      files: String(s.files),
      commits: String(s.commits),
    },
    primary: link({ kind: 'view', view: 'audit', params: filtered(o, { session: s.id }) }, 'Show', {
      verb: 'show',
      description: 'Only what this session did.',
    }),
  };
}

function unlinkedItem(o: AuditList): Item {
  const u = o.unlinked;
  return {
    id: 'session:' + NO_SESSION,
    label: 'Not linked to a session',
    icon: 'session',
    description:
      'What the sandbox ran itself (setup, services), and changes made while no session or several ran in that project.',
    details: ['Did       ' + countsText(u)],
    cells: {
      session: NO_SESSION,
      agent: '-',
      project: '-',
      started: '',
      commands: String(u.commands),
      files: String(u.files),
      commits: String(u.commits),
    },
    primary: link({ kind: 'view', view: 'audit', params: filtered(o, { session: NO_SESSION }) }, 'Show', {
      verb: 'show',
      description: 'Only what no session can be linked to.',
    }),
  };
}

/** "session 4f2c1a9b (claude · app)", "agent codex", "text "git push"" for the filters in use. */
function filterText(o: AuditList): string {
  const f = o.filter;
  const session = f.session ? o.sessions.find((s) => s.id === f.session) : undefined;
  return [
    f.session === NO_SESSION
      ? 'not linked to a session'
      : f.session
        ? 'session ' + shortId(f.session) + (session ? ' (' + session.agent + ', ' + session.project + ')' : '')
        : '',
    f.agent ? 'agent ' + f.agent : '',
    f.project ? 'project ' + f.project : '',
    f.grep ? 'containing "' + f.grep + '"' : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** The sessions as cards (a table on the command line), or nothing when there are none or one is shown. */
function sessionsSection(o: AuditList, items: readonly Item[], period: string): Section[] {
  if (!items.length) return [];
  return [
    {
      id: 'sessions',
      title: 'Sessions',
      summary: plural(o.sessions.length, 'session') + ' ' + period,
      cards: true,
      columnsOn: 'cli',
      columns: [
        { key: 'session', label: 'SESSION' },
        { key: 'agent', label: 'AGENT' },
        { key: 'project', label: 'PROJECT' },
        { key: 'started', label: 'STARTED' },
        { key: 'commands', label: 'COMMANDS' },
        { key: 'files', label: 'FILES' },
        { key: 'commits', label: 'COMMITS' },
      ],
      items,
      notes: [{ text: 'Only one session: sandbox audit --session <id>', tone: 'muted', only: 'cli' }],
    },
  ];
}

/** The page: the period's totals, per agent, the sessions (each opens its own events), and the events. Pure. */
export function auditPage(o: AuditList): Page {
  const f = o.filter;
  const period = f.days === 1 ? 'in the last 24 hours' : 'in the last ' + f.days + ' days';
  const narrowed = Boolean(f.session || f.agent || f.project || f.grep);
  const showAll = link({ kind: 'view', view: 'audit', params: filtered(o, {}) }, 'Show everything', { verb: 'show' });
  const turnOn = action(
    setSetting,
    { key: 'audit.enabled', value: true },
    { label: 'Turn the audit log on', verb: 'start', key: 'o', importance: 1 },
  );
  const t = o.totals;
  const summary: Fact[] = t.events
    ? [
        { id: 'events', label: 'Events', value: String(t.events) },
        { id: 'commands', label: 'Commands', value: String(t.commands) },
        { id: 'files', label: 'Files changed', value: String(t.files) },
        {
          id: 'commits',
          label: 'Commits',
          value: String(t.commits),
          ...(t.commits ? { tone: 'accent' as const } : {}),
        },
        { id: 'sessions', label: 'Sessions', value: String(t.sessions) },
      ]
    : [];
  const agents: Fact[] =
    f.session || o.agents.length < 1
      ? []
      : o.agents.map((a) => ({
          id: 'agent:' + a.agent,
          label: a.agent,
          value: plural(a.commands, 'command'),
          details: [plural(a.files, 'file') + ', ' + plural(a.commits, 'commit'), plural(a.sessions, 'session')],
        }));
  const logNote = {
    text:
      'The log takes ' +
      bytesText(o.bytes) +
      ' of ' +
      o.maxMb +
      ' MB and keeps ' +
      plural(o.keepDays, 'day') +
      ', on this PC where the sandbox cannot reach it (' +
      o.folder +
      ').',
    tone: 'muted' as const,
  };
  const sessionItems =
    f.session !== undefined
      ? []
      : [
          ...o.sessions.map((s) => sessionItem(o, s)),
          ...(o.unlinked.commands || o.unlinked.files || o.unlinked.commits ? [unlinkedItem(o)] : []),
        ];
  const events = o.events.map(eventItem);
  const likely = o.events.some((e) => e.linked === 'only-session');
  const sections: Section[] = [
    ...(narrowed ? [{ id: 'filter', title: 'Filtered', summary: filterText(o), actions: [showAll] }] : []),
    { id: 'summary', facts: summary },
    ...(agents.length ? [{ id: 'agents', title: 'By agent', facts: agents }] : []),
    ...sessionsSection(o, sessionItems, period),
    {
      id: 'events',
      title: 'Events',
      summary:
        o.matched > events.length
          ? 'the newest ' + events.length + ' of ' + o.matched
          : plural(o.matched, 'event') + ' ' + period,
      columns: [
        { key: 'time', label: 'TIME' },
        { key: 'agent', label: 'AGENT' },
        { key: 'kind', label: 'KIND' },
        { key: 'what', label: 'WHAT' },
      ],
      items: events,
      notes: [
        logNote,
        ...(likely
          ? [
              {
                text: '? = the only session running in that project then (likely, not proven)',
                tone: 'muted' as const,
              },
            ]
          : []),
        ...(o.matched > events.length
          ? [
              {
                text: 'More: sandbox audit --limit <n>, or narrow it down.',
                tone: 'muted' as const,
                only: 'cli' as const,
              },
            ]
          : []),
      ],
    },
  ];
  return {
    title: 'Activity',
    ...(o.enabled ? {} : { notice: { text: 'The audit log is off: nothing new is recorded.', tone: 'warn' as const } }),
    sections,
    actions: o.enabled ? [] : [turnOn],
    empty: {
      title: narrowed ? 'Nothing matches' : o.enabled ? 'Nothing recorded ' + period : 'The audit log is off',
      text: narrowed
        ? 'No events ' + period + ' for ' + filterText(o) + '.'
        : o.enabled
          ? 'What your agents run, change and commit appears here while a sandbox runs.'
          : 'Turn it on to keep a record of what your agents run, change and commit (kept ' +
            plural(o.keepDays, 'day') +
            ' on this PC).',
      action: narrowed ? showAll : o.enabled ? undefined : turnOn,
      cliText: o.enabled
        ? 'Nothing in the audit log ' + period + (narrowed ? ' for ' + filterText(o) : '') + '.'
        : 'The audit log is off. Turn it on in the menu (Settings > Security & privacy > Audit log) or with: sandbox config set audit.enabled true',
    },
  };
}

/** The command line that shows what a view address of this page shows (the menu runs it on the normal screen). */
export function auditArgv(params: Readonly<Record<string, string>> = {}): string[] {
  const flags: [string, string | undefined][] = [
    ['--days', params.days],
    ['--kind', params.kind === 'all' ? undefined : params.kind],
    ['--session', params.session],
    ['--agent', params.agent],
    ['--project', params.project],
    ['--grep', params.grep],
  ];
  return ['audit', ...flags.flatMap(([flag, value]) => (value ? [flag, value] : []))];
}

/** What the view's address can set. */
export interface AuditParams {
  readonly days?: string;
  readonly kind?: string;
  readonly session?: string;
  readonly agent?: string;
  readonly project?: string;
  readonly grep?: string;
}

export const auditView = defineView({
  id: 'audit',
  title: 'Activity',
  summary: 'What your agents ran, changed and committed, from the audit log on this PC.',
  queries: { audit: listAudit },
  operations: [setSetting],
  filters: [
    {
      param: 'kind',
      label: 'Kind',
      choices: [
        { value: 'all', label: 'Everything' },
        { value: 'proc', label: 'Commands' },
        { value: 'file', label: 'Files' },
        { value: 'commit', label: 'Commits' },
        { value: 'session', label: 'Sessions' },
        { value: 'guard', label: 'Repo guard' },
      ],
    },
    {
      param: 'days',
      label: 'Period',
      choices: PERIODS.map((d) => ({ value: String(d), label: d === 1 ? '24 hours' : d + ' days' })),
    },
  ],
  params: ['session', 'agent', 'project', 'grep'],
  inputs: (p: AuditParams) => ({
    audit: {
      days: PERIODS.find((d) => String(d) === p.days) ?? 1,
      kind: AUDIT_KIND_FILTERS.find((k) => k === p.kind) ?? 'all',
      ...(p.session ? { session: p.session } : {}),
      ...(p.agent ? { agent: p.agent } : {}),
      ...(p.project ? { project: p.project } : {}),
      ...(p.grep ? { grep: p.grep } : {}),
    },
  }),
  build: ({ audit }) => auditPage(audit),
});
