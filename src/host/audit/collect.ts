// What goes into the audit log, from the background watcher while the sandbox runs:
//  - programs started in the sandbox: the .jsonl files it leaves in run\audit\ (untrusted: links refused, each file
//    and line size-capped, every line checked and forced to kind "proc", times kept to now, command lines scrubbed of
//    secrets, a session it names kept only when this sandbox has that session), taken in and deleted;
//  - files changed in the projects: watched from this PC (the sandbox cannot hide or fake these);
//  - git commits in the projects: read from each project's reflog on this PC (git-commits.ts);
//  - sessions starting and ending, and what the repo guard caught.
// Each event is linked to the agent session that did it where that can be known (attribute.ts), else to none.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assertNoLinks } from '../../core/util/index.js';
import { RunDir } from '../../shared/channel/index.js';
import { JsonFile } from '../../shared/io/index.js';
import { hubName } from '../../shared/paths/index.js';
// The file itself, not the barrel: the barrel leads back to the watcher, which imports this file.
import { ProjectRegistry } from '../projects/registry.js';
import { hostStateFile } from '../storage/index.js';
import { makesCommits, SessionBook, type GitRun, type Link } from './attribute.js';
import { CommitWatcher, type CommitSeen } from './git-commits.js';
import { AuditEventSchema, AuditLog, AuditSessionIdSchema, fold, type AuditEvent } from './log.js';
import { redactCommandLine } from './redact.js';

const MAX_FILES_PER_PASS = 200;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Paths in a project not worth a line each (git's own bookkeeping, dependency folders). */
const QUIET =
  /(^|[\\/])(\.git[\\/](objects|logs|refs|index\.lock|FETCH_HEAD|ORIG_HEAD)|node_modules[\\/]|target[\\/]|\.venv[\\/]|__pycache__[\\/])/i;
/** A commit waits this long before it is written, so the git command that made it (reported later) can claim it. */
const COMMIT_HOLD_MS = 45 * 1000;
/** Git commands are remembered this long for linking commits. */
const GIT_RUNS_KEPT_MS = 10 * 60 * 1000;
/** A time the sandbox reports is believed only this far from now (else it is now). */
const PAST_MS = 2 * 86400000;
const FUTURE_MS = 3600000;
/** Projects watched at most (the running sandbox's registry can grow while it runs). */
const MAX_PROJECTS = 64;

const AuditSettingsSchema = z.object({
  enabled: z.boolean(),
  days: z.number().int().min(1).max(365),
  maxMb: z.number().int().min(5).max(5000),
  processes: z.boolean(),
  files: z.boolean(),
  /** Missing in files written by versions before commits were recorded. */
  commits: z.boolean().default(true),
  projects: z.array(z.string().max(1024)).max(64),
});
export type AuditSettings = z.output<typeof AuditSettingsSchema>;
const settingsFile = (storageRoot: string, dataPath: string): JsonFile<AuditSettings> =>
  new JsonFile(AuditSettingsSchema, hostStateFile(storageRoot, dataPath, '-audit.json'));

/** Host-only: the audit settings of the running sandbox (written at launch, read by the watcher). */
export function saveAuditSettings(storageRoot: string, dataPath: string, settings: AuditSettings): void {
  return settingsFile(storageRoot, dataPath).write(settings);
}
export function readAuditSettings(storageRoot: string, dataPath: string): AuditSettings | null {
  return settingsFile(storageRoot, dataPath).read();
}

/** A project of the running sandbox: its name (as sessions name it) and its folder on this PC. */
export interface AuditProject {
  readonly name: string;
  readonly host: string;
}

/** The sandbox's projects: the registry's (projects that joined while it runs too) and the ones it started with. */
function registryProjects(storageRoot: string, started: readonly string[]): AuditProject[] {
  const out: AuditProject[] = [];
  const add = (name: string, host: string): void => {
    if (!out.some((p) => p.host.toLowerCase() === host.toLowerCase())) out.push({ name, host });
  };
  try {
    for (const p of new ProjectRegistry(storageRoot).read()?.projects ?? []) add(p.name, p.host);
  } catch {
    // No registry (or an unreadable one): the projects it started with.
  }
  for (const host of started) add(hubName(host, []), host);
  return out.slice(0, MAX_PROJECTS);
}

/** A time from the sandbox as an ISO time near now: one too far off (a wrong clock, a made-up line) becomes now. */
function believable(t: string, now: number): string {
  const ms = Date.parse(t);
  return Number.isNaN(ms) || ms < now - PAST_MS || ms > now + FUTURE_MS
    ? new Date(now).toISOString()
    : new Date(ms).toISOString();
}

export class AuditCollector {
  private readonly log: AuditLog;
  private pending: AuditEvent[] = [];
  private sessions = new Map<string, string>();
  private readonly book = new SessionBook();
  private gitRuns: GitRun[] = [];
  private held: { commit: CommitSeen; seenAt: number }[] = [];
  private readonly commitWatcher = new CommitWatcher();
  private readonly watched = new Set<string>();
  private watchers: fs.FSWatcher[] = [];
  private maintainedOn = '';

  constructor(
    private readonly dataPath: string,
    storageRoot: string,
    private readonly settings: AuditSettings,
    private readonly projects: () => readonly AuditProject[] = () => registryProjects(storageRoot, settings.projects),
  ) {
    this.log = new AuditLog(AuditLog.dirFor(storageRoot, dataPath), settings);
  }

  private add(e: Omit<AuditEvent, 't'> & { t?: string }): void {
    this.pending.push({ t: new Date().toISOString(), ...e });
  }

  /** Deletes old days, then starts watching the projects' files and commits. */
  start(): void {
    this.maintainDaily();
    this.add({
      k: 'note',
      p:
        'sandbox started; audit: ' +
        [
          this.settings.processes && 'programs',
          this.settings.files && 'files',
          this.settings.commits && 'commits',
          'sessions',
        ]
          .filter(Boolean)
          .join(', '),
    });
    this.watchProjects();
  }

  /** The projects not watched yet (one that joined the sandbox since): their files and their reflogs from now on. */
  private watchProjects(): void {
    for (const project of this.projects()) {
      const key = project.host.toLowerCase();
      if (this.watched.has(key)) continue;
      this.watched.add(key);
      if (this.settings.commits) this.commitWatcher.prime([project.host]);
      if (this.settings.files) this.watchFiles(project);
    }
  }

  private watchFiles(project: AuditProject): void {
    try {
      this.watchers.push(
        fs.watch(project.host, { recursive: true }, (event, file) => {
          const rel = file ? String(file) : '';
          if (!rel || QUIET.test(rel)) return;
          this.add({
            k: 'file',
            a: event === 'rename' ? 'rename' : 'change',
            p: rel.replace(/\\/g, '/').slice(0, 1024),
            w: project.host,
            pj: project.name,
          });
        }),
      );
    } catch {
      /* a project that is gone */
    }
  }

  private linked(link: Link | undefined): Partial<AuditEvent> {
    const s = this.book.get(link?.s);
    return link && s ? { s: s.id, ag: s.agent, pj: s.project, sv: link.sv } : {};
  }

  /** Programs the sandbox reported: taken in (checked) and deleted. */
  private takeGuestReports(now: number): void {
    if (!this.settings.processes) return;
    const dir = new RunDir(this.dataPath).auditDir;
    assertNoLinks(this.dataPath, dir);
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(dir)
        .filter((n) => /^[\w-]+\.jsonl$/.test(n))
        .sort()
        .slice(0, MAX_FILES_PER_PASS);
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && stat.size <= MAX_FILE_BYTES)
          for (const line of fs.readFileSync(file, 'utf8').split('\n')) this.takeLine(line, now);
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
  }

  /** One line the sandbox wrote: only a program, with only the fields it may set. */
  private takeLine(line: string, now: number): void {
    if (!line.trim() || line.length > 8192) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const e = AuditEventSchema.safeParse(raw);
    if (!e.success) return;
    const { t, p, c, pp } = e.data;
    const claimed = AuditSessionIdSchema.safeParse(e.data.s);
    const session = claimed.success ? this.book.get(claimed.data) : undefined;
    const event: AuditEvent = {
      t: believable(t, now),
      k: 'proc',
      ...(p !== undefined ? { p } : {}),
      ...(c !== undefined ? { c: redactCommandLine(c) } : {}),
      ...(pp !== undefined ? { pp } : {}),
      ...(session ? this.linked({ s: session.id, sv: 'p' }) : {}),
    };
    if (session && makesCommits(p ?? '', c ?? '')) this.gitRuns.push({ t: Date.parse(event.t), session: session.id });
    this.pending.push(event);
  }

  private primaryProject(): string {
    return this.projects()[0]?.name ?? 'project';
  }

  private trackSessions(now: number): void {
    const list = new RunDir(this.dataPath).listSessions();
    this.book.update(list, this.primaryProject(), now);
    const phases = new Map(list.map((s) => [s.id, s.phase]));
    for (const s of list) {
      const before = this.sessions.get(s.id);
      const who = this.linked({ s: s.id, sv: 'p' });
      if (!before && s.phase === 'running')
        this.add({ k: 'session', a: 'start', p: s.harness, w: s.cwd, c: s.id, ...who, sv: undefined });
      if (before === 'running' && (s.phase === 'exited' || s.phase === 'failed'))
        this.add({
          k: 'session',
          a: 'end',
          p: s.harness,
          w: s.cwd,
          c: s.id + (s.exitCode !== undefined ? ' exit ' + s.exitCode : ''),
          ...who,
          sv: undefined,
        });
    }
    this.sessions = phases;
  }

  /** New commits are held a moment; held ones whose time has come are written, linked to a session if one is known. */
  private takeCommits(now: number, final: boolean): void {
    if (!this.settings.commits) return;
    const projects = this.projects();
    for (const commit of this.commitWatcher.commits(projects.map((p) => p.host)))
      this.held.push({ commit, seenAt: now });
    const due = this.held.filter((h) => final || now - h.seenAt >= COMMIT_HOLD_MS);
    this.held = this.held.filter((h) => !due.includes(h));
    for (const { commit, seenAt } of due) {
      const name =
        projects.find((p) => p.host.toLowerCase() === commit.project.toLowerCase())?.name ??
        hubName(commit.project, []);
      // Git's own time, unless the sandbox's clock (or the line) is far off: then when it was seen.
      const t = believable(commit.t, seenAt);
      this.pending.push({
        t,
        k: 'commit',
        a: commit.action,
        p: redactCommandLine(commit.message),
        h: commit.sha,
        au: commit.author,
        w: commit.project,
        pj: name,
        ...this.linked(this.book.linkCommit(name, Date.parse(t), this.gitRuns)),
      });
    }
    this.gitRuns = this.gitRuns.filter((g) => g.t >= now - GIT_RUNS_KEPT_MS);
  }

  /** File changes not linked yet: to the one session running in their project then, if there was exactly one. */
  private linkFiles(): void {
    this.pending = this.pending.map((e) =>
      e.k === 'file' && !e.s && e.pj ? { ...e, ...this.linked(this.book.linkFile(e.pj, Date.parse(e.t))) } : e,
    );
  }

  guard(detail: string): void {
    this.add({ k: 'guard', p: detail.slice(0, 1024) });
  }

  /** Old days go when the watcher starts and again whenever the day changes while it runs. */
  private maintainDaily(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today === this.maintainedOn) return;
    this.maintainedOn = today;
    this.log.maintain(today);
  }

  /** Writes what came in since the last call (repeats folded); call every few seconds. */
  flush(final = false): void {
    const now = Date.now();
    const step = (work: () => void): void => {
      try {
        work();
      } catch {
        /* next pass */
      }
    };
    step(() => this.watchProjects());
    // Sessions first: a program or commit can only be linked to a session the book knows.
    step(() => this.trackSessions(now));
    step(() => this.takeGuestReports(now));
    step(() => this.takeCommits(now, final));
    step(() => this.linkFiles());
    const events = this.pending.sort((a, b) => a.t.localeCompare(b.t));
    this.pending = [];
    this.log.append(fold(events));
    step(() => this.maintainDaily());
  }

  stop(): void {
    this.watchers.forEach((w) => w.close());
    this.add({ k: 'note', p: 'sandbox closed' });
    this.flush(true);
    this.log.maintain();
  }

  maintain(): void {
    this.log.maintain();
  }
}
