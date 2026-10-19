// What was running in the last sandbox, so the next one can open it again: <storage>\sync\<data>-sessions.json (host
// only, never in the data folder the sandbox can write). The launch writes how the sandbox was started, the background
// watcher notes the running sessions every minute, stopping on purpose marks the file. Also the decisions that use it:
// reopen or ask (shouldReopen) and the limit on automatic restarts (autoRestartAllowed). The conversation ids come
// from the sandbox, so they are checked before they are kept.
import path from 'node:path';
import { z } from 'zod';
import type { SessionStatus } from '../../core/types.js';
import { JsonFile } from '../../shared/io/index.js';
import { hostDirFor, isConversationId, projectForGuestDir } from '../../shared/paths/index.js';
import type { Registry } from '../projects/index.js';
import { hostStateFile } from '../storage/index.js';
import type { Life } from './life-record.js';

const MAX_SESSIONS = 50;
const MAX_TEXT = 1024;
/** At most this many automatic restarts in this long. */
export const AUTO_RESTARTS = 3;
export const AUTO_RESTART_WINDOW_MS = 6 * 60 * 60 * 1000;

const Text = z.string().max(MAX_TEXT);
const LedgerSchema = z.object({
  savedAt: z.string().max(40),
  launch: z.object({
    primary: Text,
    harness: Text.nullable(),
    projects: z.array(Text).max(MAX_SESSIONS),
    headless: z.boolean(),
    configPath: Text.nullable(),
  }),
  sessions: z
    .array(
      z.object({
        harness: Text,
        project: Text,
        conversation: z.string().max(128).optional(),
        startedAt: z.string().max(40),
      }),
    )
    .max(MAX_SESSIONS),
  /** The sandbox was stopped on purpose (sandbox stop, a restart that reopens, closed with nothing wrong). */
  closedOnPurpose: z.boolean().optional(),
  /** When the watcher started the sandbox again by itself after a crash (only the last six hours are kept). */
  autoRestarts: z.array(z.string().max(40)).max(20).optional(),
  /** The watcher stopped restarting by itself (too many crashes); the next launch says so. */
  gaveUpAt: z.string().max(40).optional(),
});
export type Ledger = z.output<typeof LedgerSchema>;
export type LedgerSession = Ledger['sessions'][number];
export type LedgerLaunch = Ledger['launch'];

/** What `resume.sessions` can be. */
export type ResumeSetting = 'ask' | 'always' | 'afterCrash' | 'never';

/** Did the last sandbox end without anyone closing it? (A PC that went down leaves a life record that never ended.) */
export function endedUnexpectedly(life: Life | null, closedOnPurpose: boolean, watcherAlive: boolean): boolean {
  if (!life || closedOnPurpose || watcherAlive) return false;
  return life.ended ? life.ended.cause !== null : true;
}

/**
 * What a launch does about the sessions of the last sandbox. Nothing recorded, or "never": no. "always": reopen. "ask":
 * ask. "afterCrash": reopen when the last sandbox ended unexpectedly, else do nothing (and ask nothing).
 */
export function shouldReopen(
  setting: ResumeSetting,
  life: Life | null,
  ledger: Pick<Ledger, 'sessions' | 'closedOnPurpose'> | null,
  watcherAlive = false,
): 'ask' | 'reopen' | 'no' {
  if (!ledger?.sessions.length || setting === 'never') return 'no';
  if (setting === 'always') return 'reopen';
  if (setting === 'ask') return 'ask';
  return endedUnexpectedly(life, ledger.closedOnPurpose === true, watcherAlive) ? 'reopen' : 'no';
}

/** May the watcher start the sandbox again? (Fewer than three automatic restarts in the last six hours.) */
export function autoRestartAllowed(restarts: readonly string[], now: Date): boolean {
  return recent(restarts, now).length < AUTO_RESTARTS;
}

function recent(restarts: readonly string[], now: Date): string[] {
  return restarts.filter((at) => {
    const ms = Date.parse(at);
    return Number.isFinite(ms) && now.getTime() - ms < AUTO_RESTART_WINDOW_MS && ms <= now.getTime();
  });
}

/** "claude in mw2-agent, codex in web (2 sessions)". */
export function describeLast(sessions: readonly LedgerSession[]): string {
  const names = sessions.map((s) => s.harness + ' in ' + (path.win32.basename(s.project) || s.project));
  return names.join(', ') + ' (' + sessions.length + ' session' + (sessions.length === 1 ? '' : 's') + ')';
}

/** <storage>\sync\<data>-sessions.json. */
export class SessionLedger {
  private readonly file: JsonFile<Ledger>;

  constructor(storageRoot: string, dataPath: string) {
    this.file = new JsonFile(LedgerSchema, hostStateFile(storageRoot, dataPath, '-sessions.json'));
  }

  read(): Ledger | null {
    return this.file.read();
  }

  /** At launch: how the sandbox was started. The sessions of the last one stay until this one's are noted. */
  startLaunch(launch: LedgerLaunch, now = new Date()): void {
    const before = this.read();
    this.file.write({
      savedAt: now.toISOString(),
      launch: { ...launch, projects: launch.projects.slice(0, MAX_SESSIONS) },
      sessions: before?.sessions ?? [],
      closedOnPurpose: false,
      ...(before?.autoRestarts ? { autoRestarts: recent(before.autoRestarts, now) } : {}),
      ...(before?.gaveUpAt ? { gaveUpAt: before.gaveUpAt } : {}),
    });
  }

  /**
   * Every minute: the running sessions, each with the folder it is in on this PC (sessions in a folder no project
   * covers are left out), and the projects the sandbox has now. A conversation the sandbox has not told yet stays as
   * it was noted before. Does nothing for a sandbox this tool did not start.
   */
  recordSessions(sessions: readonly SessionStatus[], registry: Registry | null, now = new Date()): void {
    const ledger = this.read();
    // Stopped on purpose: the sessions that end while it shuts down are exactly what the next start should reopen.
    if (!ledger || !registry || ledger.closedOnPurpose) return;
    const mapped = [...registry.projects, ...registry.roots];
    const before = new Map(ledger.sessions.map((s) => [key(s), s]));
    const noted = sessions
      // A shell is not reopened: what it was doing is gone with the sandbox.
      .filter((s) => s.phase === 'running' && s.kind !== 'shell')
      .flatMap((s): LedgerSession[] => {
        const project = projectForGuestDir(mapped, s.cwd);
        if (!project) return [];
        const entry: LedgerSession = {
          harness: s.harness,
          project: hostDirFor(project, s.cwd),
          startedAt: s.startedAt.slice(0, 40),
        };
        const conversation =
          s.conversation && isConversationId(s.conversation) ? s.conversation : before.get(key(entry))?.conversation;
        return [conversation ? { ...entry, conversation } : entry];
      })
      .slice(-MAX_SESSIONS);
    const primary = registry.projects.find((p) => p.primary)?.host ?? ledger.launch.primary;
    const projects = registry.projects.filter((p) => !p.primary && p.mechanism !== 'root').map((p) => p.host);
    this.file.write({
      ...ledger,
      savedAt: now.toISOString(),
      launch: { ...ledger.launch, primary, projects: projects.slice(0, MAX_SESSIONS) },
      sessions: noted,
    });
  }

  /** The sandbox was stopped on purpose, or closed with nothing wrong. */
  markClosedOnPurpose(): void {
    const ledger = this.read();
    if (ledger && !ledger.closedOnPurpose) this.file.write({ ...ledger, closedOnPurpose: true });
  }

  /** The watcher is about to start the sandbox again by itself. */
  recordAutoRestart(now = new Date()): void {
    const ledger = this.read();
    if (ledger)
      this.file.write({
        ...ledger,
        autoRestarts: [...recent(ledger.autoRestarts ?? [], now), now.toISOString()].slice(-20),
        gaveUpAt: undefined,
      });
  }

  /** The watcher stopped trying. */
  giveUp(now = new Date()): void {
    const ledger = this.read();
    if (ledger) this.file.write({ ...ledger, gaveUpAt: now.toISOString() });
  }

  /** The launch says the watcher gave up (once). */
  takeGaveUp(): string | null {
    const ledger = this.read();
    if (!ledger?.gaveUpAt) return null;
    this.file.write({ ...ledger, gaveUpAt: undefined });
    return ledger.gaveUpAt;
  }
}

const key = (s: Pick<LedgerSession, 'harness' | 'project' | 'startedAt'>): string =>
  [s.harness, s.project.toLowerCase(), s.startedAt].join('|');
