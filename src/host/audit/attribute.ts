// Which agent session an event belongs to, on the PC side. Programs come linked from the sandbox (by the process tree,
// guest/audit/parse.ts); the host only keeps a link to a session it knows. Files and commits are seen from this PC,
// where the writer cannot be told: they are linked only when exactly one session was running in that project at the
// time ("likely", marked as such), or, for a commit, when that project's sessions ran exactly one git command that
// makes commits around then. Anything else stays "no session": nothing is guessed. Pure, so the self-test checks it.
import path from 'node:path';

/** A session as the audit remembers it (its run record goes with the sandbox). */
export interface KnownSession {
  readonly id: string;
  readonly agent: string;
  /** The project it runs in (hub name). */
  readonly project: string;
  /** When it started and ended (ms). */
  readonly from: number;
  readonly to?: number;
}

/** A git command a session ran that can make a commit (from the programs the sandbox reported). */
export interface GitRun {
  readonly t: number;
  readonly session: string;
}

/** A link to a session: its id and how it was made (p: process tree / git command; t: only session running). */
export interface Link {
  readonly s: string;
  readonly sv: 'p' | 't';
}

/** How long before and after a commit a git command counts as the one that made it. */
const GIT_BEFORE_MS = 3 * 60 * 1000;
const GIT_AFTER_MS = 30 * 1000;
/** Sessions remembered at most. */
const MAX_SESSIONS = 512;

/** git commit, merge, cherry-pick, revert, rebase, am, pull: the commands that can add a commit. */
export function makesCommits(program: string, commandLine: string): boolean {
  return (
    /^git(\.exe)?$/i.test(path.win32.basename(program)) &&
    /\s(commit|merge|cherry-pick|revert|rebase|am|pull)(\s|$)/i.test(commandLine)
  );
}

/** The sessions of this sandbox seen so far, with when each ran. */
export class SessionBook {
  private readonly sessions = new Map<string, KnownSession>();

  /** Takes the sessions as they are now: new ones are added, ended ones get their end time. */
  update(
    list: readonly {
      readonly id: string;
      readonly harness: string;
      readonly project?: string;
      readonly phase: string;
      readonly startedAt: string;
      readonly updatedAt: string;
    }[],
    fallbackProject: string,
    now = Date.now(),
  ): void {
    for (const s of list) {
      const known = this.sessions.get(s.id);
      const ended = s.phase === 'exited' || s.phase === 'failed';
      if (known) {
        if (ended && known.to === undefined)
          this.sessions.set(s.id, { ...known, to: Math.min(now, Date.parse(s.updatedAt) || now) });
        continue;
      }
      if (this.sessions.size >= MAX_SESSIONS) continue;
      const from = Date.parse(s.startedAt) || now;
      this.sessions.set(s.id, {
        id: s.id,
        agent: s.harness,
        project: s.project ?? fallbackProject,
        from,
        ...(ended ? { to: Math.max(from, Date.parse(s.updatedAt) || now) } : {}),
      });
    }
    // A session whose record is gone is not running any more: it ended by now at the latest.
    const listed = new Set(list.map((s) => s.id));
    for (const [id, s] of this.sessions)
      if (!listed.has(id) && s.to === undefined) this.sessions.set(id, { ...s, to: now });
  }

  get(id: string | undefined): KnownSession | undefined {
    return id === undefined ? undefined : this.sessions.get(id);
  }

  /** The one session running in this project at time t, or undefined when none or several were. */
  onlyRunning(project: string, t: number): KnownSession | undefined {
    const running = [...this.sessions.values()].filter(
      (s) => s.project.toLowerCase() === project.toLowerCase() && s.from <= t && (s.to === undefined || t <= s.to),
    );
    return running.length === 1 ? running[0] : undefined;
  }

  /** A file change in a project at time t: linked only when one session ran there then. */
  linkFile(project: string, t: number): Link | undefined {
    const only = this.onlyRunning(project, t);
    return only ? { s: only.id, sv: 't' } : undefined;
  }

  /**
   * A commit in a project at time t: the session whose git command made it when that project's sessions ran git
   * commands that make commits around then and all were the same session's; else, when `likely` is allowed (programs
   * are not recorded, so no git command could be seen), the one session running there.
   */
  linkCommit(project: string, t: number, gitRuns: readonly GitRun[], likely = true): Link | undefined {
    const near = new Set(
      gitRuns
        .filter((g) => g.t >= t - GIT_BEFORE_MS && g.t <= t + GIT_AFTER_MS)
        .map((g) => g.session)
        .filter((id) => this.get(id)?.project.toLowerCase() === project.toLowerCase()),
    );
    if (near.size === 1) return { s: [...near][0], sv: 'p' };
    if (near.size > 1) return undefined;
    return likely ? this.linkFile(project, t) : undefined;
  }
}
