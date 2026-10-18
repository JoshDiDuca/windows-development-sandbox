// The agent sessions of the running sandbox: the list (live) and restarting the agents. Pure: schemas, labels and the
// view; sessions.run.ts does the work. A running session links to its terminal (attach in the menu, the terminal page
// in the web UI).
import { z } from 'zod';
import {
  action,
  ago,
  defineOperation,
  defineQuery,
  defineView,
  link,
  type Item,
  type Page,
  type Section,
} from '../../kernel/index.js';

const ViewersSchema = z.object({ viewers: z.number(), remote: z.number() });

/** A session as every surface may see it: never its attach address or token. */
export const SessionRowSchema = z.object({
  id: z.string().describe('The session'),
  launchId: z.string(),
  harness: z.string().describe('The agent'),
  cwd: z.string().describe('Its folder in the sandbox'),
  project: z.string().optional(),
  phase: z.enum(['starting', 'running', 'exited', 'failed']).describe('What it is doing'),
  message: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().describe('When it started'),
  conversation: z.string().optional(),
  exitCode: z.number().optional(),
  projectName: z.string().optional().describe('The project it runs in'),
  here: z.boolean().optional().describe('In the project of the current folder'),
  /** Terminals attached (from this PC and in the sandbox); null: an older session that cannot say. */
  viewers: ViewersSchema.nullable().optional(),
  /** It runs and its terminal can be reached from this PC. */
  canOpen: z.boolean(),
});
export type SessionRow = z.output<typeof SessionRowSchema>;

export const SessionsListSchema = z.object({
  sandboxRunning: z.boolean(),
  /** The agent offered when nothing runs. */
  defaultAgent: z.string(),
  /** The folder column is wanted (sandbox sessions --wide). */
  wide: z.boolean(),
  /** "Running, started by alice (shared with you)" when the sandbox is another user's. */
  owner: z.string().optional(),
  sessions: z.array(SessionRowSchema),
});
export type SessionsList = z.output<typeof SessionsListSchema>;

/** "1 here, 0 in sandbox" for a session's viewers. */
export function viewerText(v: SessionRow['viewers']): string {
  return v === undefined
    ? '-'
    : v === null
      ? 'unknown (older session)'
      : v.remote + ' here, ' + (v.viewers - v.remote) + ' in sandbox';
}

/** This folder's project first, newest first within each group. */
export function orderedSessions(list: readonly SessionRow[]): SessionRow[] {
  const newest = (a: SessionRow, b: SessionRow): number => (a.startedAt < b.startedAt ? 1 : -1);
  return [...list.filter((s) => s.here).sort(newest), ...list.filter((s) => !s.here).sort(newest)];
}

export const listSessions = defineQuery({
  id: 'sessions.list',
  title: 'Sessions',
  summary: 'list agent sessions and who is attached',
  input: z.object({ wide: z.boolean().default(false).describe("also show each session's folder") }),
  output: SessionsListSchema,
  live: { everyMs: 2500 },
  cli: {
    name: 'sessions',
    group: 'Sessions',
    json: true,
    flags: { wide: { flag: '--wide', noMenu: true } },
    // The --json shape `sandbox sessions` has always printed: the session records, without the web's field.
    shapeJson: (o) => o.sessions.map(({ canOpen: _canOpen, ...s }) => s),
  },
});

export const restartSessions = defineOperation({
  id: 'sessions.restart',
  title: 'Restart agents',
  summary: "restart this project's running agents in place; they resume their conversation",
  input: z.object({
    harness: z.string().optional().describe('only this agent'),
    all: z.boolean().default(false).describe("every project's sessions, not only this folder's"),
  }),
  output: z.object({ message: z.string().describe("The sandbox's answer") }),
  text: (o) => o.message,
  cli: {
    name: 'restart',
    group: 'Agents',
    flags: {
      harness: { flag: '--harness', shownAs: '--agent', value: 'name', choices: 'harnesses' },
      all: { flag: '--all' },
    },
  },
});

function sessionItem(s: SessionRow, wide: boolean): Item {
  const state = s.phase + (s.exitCode !== undefined ? ' (' + s.exitCode + ')' : '');
  const running = s.phase === 'running';
  return {
    id: s.id,
    label: s.harness + '  ' + (s.projectName ?? '-'),
    hint: state + '  ' + ago(s.startedAt),
    badges: [{ text: s.phase, tone: running ? 'ok' : s.phase === 'failed' ? 'danger' : 'muted' }],
    group: s.here ? "This folder's project" : 'Other sessions',
    marked: s.here,
    icon: s.harness,
    description: running
      ? "Opens this session's terminal (in a terminal, Ctrl+] detaches; the session keeps running)."
      : undefined,
    details: ['Session   ' + s.id, 'Folder    ' + s.cwd, 'Attached  ' + viewerText(s.viewers)],
    cells: {
      here: s.here ? '*' : '',
      id: s.id,
      agent: s.harness,
      project: s.projectName ?? '-',
      state,
      attached: viewerText(s.viewers),
      ...(wide ? { folder: s.cwd } : {}),
      started: ago(s.startedAt),
    },
    ...(running && s.canOpen ? { primary: link({ kind: 'terminal', session: s.id }, 'Open', { verb: 'attach' }) } : {}),
    ...(running ? {} : { disabled: 'This session has ended.' }),
    ...(running && !s.canOpen ? { disabled: 'Not reachable from this PC.' } : {}),
  };
}

/** The sessions page: one list (a table on the command line), this folder's project first. */
export function sessionsPage(o: SessionsList): Page {
  const sessions = orderedSessions(o.sessions);
  const agent = o.defaultAgent;
  const start = link({ kind: 'start-agent', agent }, 'Start ' + agent, { verb: 'start' });
  // Only ended sessions (from the last sandbox): starting one is the next step.
  const startSection: Section[] =
    sessions.length && !sessions.some((s) => s.phase === 'running' || s.phase === 'starting')
      ? [{ id: 'start', actions: [{ ...start, description: 'Starts ' + agent + ' in this folder.' }] }]
      : [];
  return {
    title: 'Sessions',
    ...(o.owner ? { notice: { text: o.owner, tone: 'accent' } } : {}),
    sections: [
      {
        id: 'sessions',
        cards: true,
        columns: [
          { key: 'here', label: '' },
          { key: 'id', label: 'ID' },
          { key: 'agent', label: 'AGENT' },
          { key: 'project', label: 'PROJECT' },
          { key: 'state', label: 'STATE' },
          { key: 'attached', label: 'ATTACHED' },
          ...(o.wide ? [{ key: 'folder', label: 'FOLDER' }] : []),
          { key: 'started', label: 'STARTED' },
        ],
        items: sessions.map((s) => sessionItem(s, o.wide)),
        notes: [
          ...(sessions.some((s) => s.here) ? [{ text: '* = the project of this folder', tone: 'muted' as const }] : []),
          ...(o.wide
            ? []
            : [{ text: 'Folders: sandbox sessions --wide', tone: 'muted' as const, only: 'cli' as const }]),
        ],
      },
      ...startSection,
    ],
    actions: [
      ...(o.sandboxRunning ? [{ ...start, label: 'New session', key: 'n', verb: 'new session', importance: 1 }] : []),
      ...(sessions.length
        ? [action(restartSessions, { all: false }, { key: 'r', verb: 'restart agents', importance: 1 })]
        : []),
      link({ kind: 'command', argv: ['resume'] }, 'Reopen last sessions', {
        key: 'o',
        verb: 'reopen last sessions',
        importance: 2,
      }),
    ],
    empty: {
      title: o.sandboxRunning ? 'No sessions' : 'No sandbox is running',
      text: o.sandboxRunning
        ? 'No agent is running. Start ' + agent + ' in this folder.'
        : 'Starting ' + agent + ' starts the sandbox too; its session is listed here.',
      action: start,
      cliText: 'No sessions. Start one with: sandbox claude',
    },
  };
}

export const sessionsView = defineView({
  id: 'sessions',
  title: 'Sessions',
  summary: 'The agent sessions of the running sandbox: open one, restart the agents.',
  queries: { sessions: listSessions },
  operations: [restartSessions],
  build: ({ sessions }) => sessionsPage(sessions),
});
