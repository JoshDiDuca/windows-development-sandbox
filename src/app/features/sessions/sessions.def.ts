// The sessions of the running sandbox, agents and plain shells: the list (live), restarting the agents, opening a shell
// and closing a session. Pure: schemas, labels and the view; sessions.run.ts does the work. A running session links to
// its terminal (attach in the menu and on the command line, the terminal page in the web UI).
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
  harness: z.string().describe('The agent, or the shell (pwsh, powershell, cmd)'),
  /** A plain shell rather than an agent (absent: an agent). */
  kind: z.enum(['agent', 'shell']).optional(),
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
  summary: 'list sessions (agents and shells) and who is attached',
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
  access: 'control',
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

/** Agent and project names as the web UI has always accepted them. */
const NameText = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const SessionId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** The shells a shell session can run; auto: PowerShell 7 when the sandbox has it, else Windows PowerShell. */
export const SHELL_CHOICES = ['auto', 'pwsh', 'powershell', 'cmd'] as const;

/** The session the operation opened, as a link to its terminal. */
function openedSession(o: { readonly session: string }): { readonly kind: 'terminal'; readonly session: string } {
  return { kind: 'terminal', session: o.session };
}

export const startShell = defineOperation({
  id: 'sessions.shell',
  title: 'New shell',
  summary: 'open PowerShell or cmd in a project of the running sandbox, as a session you can attach to',
  input: z.object({
    project: NameText.optional().describe("The project of the running sandbox (default: this folder's, else asked)"),
    shell: z
      .enum(SHELL_CHOICES)
      .default('auto')
      .describe('The shell: pwsh, powershell or cmd (default: pwsh if present)'),
  }),
  output: z.object({
    session: z.string().describe('The new session'),
    shell: z.string().describe('The shell it runs'),
    message: z.string().describe('What happened'),
  }),
  // A shell runs anything as you: someone you let in remotely may type into one you opened, never open one.
  access: 'owner',
  text: (o) => o.message,
  opens: openedSession,
  cli: {
    name: 'shell',
    group: 'Sessions',
    positional: ['project'],
    flags: { shell: { flag: '--shell', value: 'name', choices: ['pwsh', 'powershell', 'cmd'] } },
    json: true,
    examples: [
      "sandbox shell                      PowerShell in this folder's project, in this terminal (Ctrl+] detaches)",
      'sandbox shell api --shell cmd      cmd in the project api',
    ],
  },
});

export const closeSession = defineOperation({
  id: 'sessions.close',
  title: 'Close',
  summary: 'end a running session (an agent or a shell) and every program it started',
  input: z.object({ session: SessionId.describe('The session to close') }),
  output: z.object({ message: z.string().describe("The sandbox's answer") }),
  access: 'control',
  danger: true,
  text: (o) => o.message,
  cli: { name: 'close', group: 'Sessions', positional: ['session'], examples: ['sandbox close 4f2c9a'] },
});

function sessionItem(s: SessionRow, wide: boolean): Item {
  const state = s.phase + (s.exitCode !== undefined ? ' (' + s.exitCode + ')' : '');
  const running = s.phase === 'running';
  return {
    id: s.id,
    label: (s.kind === 'shell' ? s.harness + ' (shell)' : s.harness) + '  ' + (s.projectName ?? '-'),
    hint: state + '  ' + ago(s.startedAt),
    badges: [{ text: s.phase, tone: running ? 'ok' : s.phase === 'failed' ? 'danger' : 'muted' }],
    group: s.here ? "This folder's project" : 'Other sessions',
    marked: s.here,
    icon: s.harness,
    description: running
      ? "Opens this session's terminal (in a terminal, Ctrl+] detaches; the session keeps running). x closes it."
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
    ...(running
      ? { actions: [action(closeSession, { session: s.id }, { key: 'x', verb: 'close', importance: 1 })] }
      : {}),
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
      ...(o.sandboxRunning
        ? [
            action(
              startShell,
              { shell: 'auto' },
              {
                key: 's',
                verb: 'new shell',
                importance: 1,
                description: 'Opens PowerShell in a project of the sandbox, as a session like the agents.',
              },
            ),
          ]
        : []),
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
  summary: 'The sessions of the running sandbox: open one, restart the agents, open a shell, close one.',
  queries: { sessions: listSessions },
  operations: [restartSessions, startShell, closeSession],
  build: ({ sessions }) => sessionsPage(sessions),
});
