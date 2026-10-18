// The running sandbox as a whole: what it is doing (a live query), its window, and stopping it. Pure: schemas, labels
// and the view; sandbox.run.ts does the work.
import { z } from 'zod';
import {
  action,
  ago,
  defineOperation,
  defineQuery,
  defineView,
  plural,
  type Fact,
  type Item,
  type Page,
  type Section,
} from '../../kernel/index.js';

const ProjectSchema = z.object({
  name: z.string().describe('The project'),
  host: z.string().describe('Its folder on this PC'),
  guest: z.string().describe('Its folder in the sandbox'),
  mechanism: z.string().describe('How it got into the sandbox (launch, root, boot or share)'),
  here: z.boolean().describe('The project of the current folder'),
  setup: z.object({ phase: z.string(), message: z.string() }).describe('How far its setup is'),
  databases: z.array(z.object({ database: z.string(), port: z.number(), state: z.string() })),
  sessions: z.array(z.object({ id: z.string(), harness: z.string(), viewers: z.string(), started: z.string() })),
  repoGuard: z.array(z.string()).describe('Repo guard findings in its folder'),
});

const StateSchema = z.object({
  running: z.boolean().describe('A Windows Sandbox is running'),
  phase: z.string().describe('What it is doing (ready, provisioning ...)'),
  message: z.string().optional().describe('Its last message'),
  headless: z.boolean().optional().describe('Its window is hidden'),
  startedAt: z.number().nullable().describe('When it started (ms), if known'),
  daemon: z.string().describe("The sandbox helper's answer"),
  account: z.string().nullable().describe('The Claude login it uses'),
  syncWatcher: z.boolean().describe('The background history sync runs'),
});

export const SandboxStatusSchema = z.object({
  /** Present when the running sandbox is another user's. */
  shared: z
    .object({
      line: z.string().describe('"Running, started by alice (shared with you)"'),
      limited: z.boolean().describe('Not shared with you: nothing more is shown'),
      startedBy: z.string().nullable().describe('Whose it is'),
    })
    .optional(),
  sandbox: StateSchema,
  here: z.object({ folder: z.string(), project: z.string().nullable(), guest: z.string().nullable() }),
  roots: z.array(z.object({ host: z.string(), guest: z.string() })),
  projects: z.array(ProjectSchema),
  otherSessions: z.array(z.object({ id: z.string(), harness: z.string(), cwd: z.string() })),
  repoGuard: z.object({ guarded: z.number(), findings: z.array(z.string()) }),
});
export type SandboxStatus = z.output<typeof SandboxStatusSchema>;

const MessageSchema = z.object({ message: z.string().describe('What happened') });

/** "pong (2 session(s) running)" from the helper in the sandbox, in plain words. */
export function helperText(answer: string): string {
  const sessions = /^pong \((\d+) session/.exec(answer);
  if (!sessions) return answer;
  return 'responding, ' + plural(Number(sessions[1]), 'session') + ' running';
}

/** How long it has been up ("3 h"), or null. */
function uptime(s: SandboxStatus['sandbox']): string | null {
  return s.running && s.startedAt ? ago(s.startedAt).replace(' ago', '') : null;
}

export const sandboxStatus = defineQuery({
  id: 'sandbox.status',
  title: 'Sandbox status',
  summary: 'show what the sandbox is doing',
  input: z.object({}),
  output: SandboxStatusSchema,
  live: { everyMs: 2500 },
  cli: {
    name: 'status',
    group: 'Sessions',
    json: true,
    // The --json shape `sandbox status` has always printed.
    shapeJson: (o) => {
      if (o.shared?.limited) return { sandbox: { running: true, shared: false, startedBy: o.shared.startedBy } };
      const s = o.sandbox;
      const borrowed = o.shared?.startedBy ? { startedBy: o.shared.startedBy, shared: true } : {};
      return {
        sandbox: {
          ...borrowed,
          running: s.running,
          phase: s.phase,
          message: s.message,
          headless: s.headless,
          uptime: uptime(s),
          daemon: s.daemon,
          account: s.account,
          syncWatcher: s.syncWatcher,
        },
        here: o.here,
        roots: o.roots,
        projects: o.projects,
        otherSessions: o.otherSessions,
        repoGuard: o.repoGuard,
      };
    },
  },
});

export const showWindow = defineOperation({
  id: 'sandbox.showWindow',
  title: 'Show the window',
  summary: 'show the sandbox window',
  input: z.object({}),
  output: MessageSchema,
  text: (o) => o.message,
  cli: { name: 'show', group: 'Sessions' },
});

export const hideWindow = defineOperation({
  id: 'sandbox.hideWindow',
  title: 'Hide the window',
  summary: 'hide the sandbox window (it keeps running)',
  input: z.object({}),
  output: MessageSchema,
  text: (o) => o.message,
  cli: { name: 'hide', group: 'Sessions' },
});

export const stopSandbox = defineOperation({
  id: 'sandbox.stop',
  title: 'Stop the sandbox…',
  summary: "shut the sandbox down (every project's sessions end)",
  input: z.object({}),
  output: z.object({ stopped: z.boolean().describe('It was asked to shut down'), message: z.string() }),
  danger: true,
  text: (o) => o.message,
  cli: { name: 'stop', group: 'Agents', yes: "do not ask when other projects' sessions would end" },
});

const MECHANISM_TEXT: Readonly<Record<string, string>> = {
  launch: 'started from here',
  root: 'in a project root',
  boot: 'mapped at start',
};

function projectItem(p: SandboxStatus['projects'][number]): Item {
  return {
    id: 'project:' + p.name,
    label: p.name,
    icon: 'project',
    hint: p.host + '  ->  ' + p.guest + '  (' + (MECHANISM_TEXT[p.mechanism] ?? 'wsb share') + ')',
    marked: p.here,
    details: [
      'Setup: ' + p.setup.phase + (p.setup.phase === 'ready' ? '' : ' - ' + p.setup.message),
      ...(p.databases.length
        ? ['Databases: ' + p.databases.map((d) => d.database + ' :' + d.port + ' ' + d.state).join(', ')]
        : []),
      ...p.sessions.map((s) => 'Session: ' + s.harness + ' ' + s.id + ', ' + s.viewers + ', started ' + ago(s.started)),
      ...p.repoGuard.map((f) => 'Guard: ' + f),
    ],
  };
}

function facts(o: SandboxStatus): Fact[] {
  const s = o.sandbox;
  const sessions = o.projects.reduce((n, p) => n + p.sessions.length, 0) + o.otherSessions.length;
  const fact = (id: string, label: string, value: string, extra: Partial<Fact> = {}): Fact => ({
    id,
    label,
    value,
    ...extra,
  });
  return [
    ...(o.shared?.startedBy ? [fact('owner', 'Started by', o.shared.startedBy)] : []),
    // One line for what it is doing: "Ready", "Installing Rust ...", or "not running".
    fact('state', 'State', s.running ? s.message || s.phase : 'not running', {
      tone: !s.running ? 'muted' : s.phase === 'ready' ? 'ok' : 'warn',
    }),
    ...(s.running
      ? [
          fact('window', 'Window', s.headless ? 'hidden (sandbox show opens it)' : 'shown'),
          fact('uptime', 'Uptime', uptime(s) ?? '-'),
          fact('helper', 'Helper', s.daemon === '-' ? '-' : helperText(s.daemon)),
          fact('sessions', 'Sessions', String(sessions)),
        ]
      : []),
    fact('account', 'Account', s.account ?? 'none selected (sandbox account use)'),
    fact('sync', 'Background sync', s.syncWatcher ? 'on' : 'off'),
  ];
}

function projectsSection(o: SandboxStatus): Section {
  const roots: Item[] = o.roots.map((r) => ({
    id: 'root:' + r.host,
    label: 'root',
    icon: 'folder',
    hint: r.host + '  ->  ' + r.guest + '  (every project in it opens without a restart)',
  }));
  const here = o.projects.some((p) => p.here);
  return {
    id: 'projects',
    title: 'Projects',
    items: [...o.projects.map(projectItem), ...roots],
    notes: [
      here
        ? { text: '* = the project of this folder', tone: 'muted' }
        : { text: o.here.folder + ' is not in this sandbox (start it here: sandbox claude)', tone: 'muted' },
    ],
  };
}

function guardSection(o: SandboxStatus): Section {
  const findings = o.repoGuard.findings;
  return {
    id: 'guard',
    title: 'Repo guard',
    summary:
      o.repoGuard.guarded +
      ' folder(s) guarded; ' +
      (findings.length ? findings.length + ' change(s) neutralised:' : 'nothing from the sandbox needed neutralising'),
    items: findings.slice(-10).map((f, i) => ({ id: 'guard:' + i, label: f, tone: 'warn' as const })),
  };
}

/** The status page: the facts, the window and stop actions, the projects, and the repo guard. */
export function sandboxPage(o: SandboxStatus): Page {
  const notice = o.shared
    ? {
        text: o.shared.line + (o.shared.limited ? '' : '. Its window is on their desktop; use its agents here.'),
        tone: 'accent' as const,
      }
    : undefined;
  if (o.shared?.limited) return { title: 'Sandbox', notice, sections: [] };
  const running = o.sandbox.running;
  const status: Section = {
    id: 'status',
    title: 'Status',
    facts: facts(o),
    // Only the window action that changes something: show a hidden window, hide a shown one.
    actions: running
      ? [
          o.sandbox.headless
            ? action(showWindow, {}, { key: 'w', verb: 'show', importance: 3 })
            : action(hideWindow, {}, { key: 'h', verb: 'hide', importance: 3 }),
          action(stopSandbox, {}, { key: 'x', verb: 'stop', importance: 1 }),
        ]
      : [],
  };
  const others: Section = {
    id: 'other-sessions',
    title: 'Other sessions',
    items: o.otherSessions.map((s) => ({
      id: 'session:' + s.id,
      label: 'session ' + s.id,
      hint: s.harness + '  ' + s.cwd,
    })),
  };
  return {
    title: 'Sandbox',
    notice,
    sections: [
      status,
      ...(running ? [projectsSection(o)] : []),
      ...(others.items?.length ? [others] : []),
      guardSection(o),
    ],
  };
}

export const sandboxView = defineView({
  id: 'sandbox',
  title: 'Sandbox',
  summary: 'What the sandbox is doing, its window, and stopping it.',
  queries: { status: sandboxStatus },
  operations: [showWindow, hideWindow, stopSandbox],
  build: ({ status }) => sandboxPage(status),
});
