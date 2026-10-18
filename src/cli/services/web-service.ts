// What the web UI's server may do with the running sandbox: the same sessions, projects and rules as the CLI (another
// user's sandbox is shown and used only as far as the sharing rules allow). Returns data, never prints.
import path from 'node:path';
import type { SessionStatus } from '../../core/types.js';
import { safeText } from '../../core/util/index.js';
import { hostEndpoint } from '../../host/channel/index.js';
import { insideSandbox, isSandboxRunning } from '../../host/sandbox/index.js';
import { ownerRule } from '../../host/sharing/index.js';
import type { WebBackend } from '../../host/web/index.js';
import type { Endpoint } from '../../shared/pty/index.js';
import { RunDir } from '../../shared/channel/index.js';
import type { WebInfo, WebProject, WebSession } from '../../shared/web/index.js';
import type { Context } from '../commands/context.js';
import { lookAtSandbox, type SandboxView } from '../commands/shared-use.js';
import { registryOf } from '../commands/projects/here.js';
import { SessionsService, type ListedSession } from './sessions-service.js';

/** The owner is asked (a process listing) at most this often: the browser polls. */
const VIEW_TTL_MS = 3000;
const MAX_SESSIONS = 50;

/** A session as the browser may see it: no attach address or token, text made safe. */
export function webSession(s: SessionStatus | ListedSession, viewers: number | null | undefined): WebSession {
  return {
    id: s.id,
    harness: safeText(s.harness),
    project: safeText(('projectName' in s ? s.projectName : undefined) ?? s.project ?? path.win32.basename(s.cwd)),
    cwd: safeText(s.cwd),
    phase: s.phase,
    message: safeText(s.message).slice(0, 300),
    startedAt: s.startedAt,
    viewers: viewers ?? null,
    canOpen: s.phase === 'running' && hostEndpoint(s) !== null,
  };
}

/** The projects of the running sandbox as the browser may see them (its guest folders made safe). */
export function runningProjects(view: SandboxView): WebProject[] {
  const known = registryOf(view.ctx).read()?.projects ?? [];
  if (known.length) return known.map((p) => ({ name: p.name, guest: safeText(p.guest) }));
  // A sandbox from before projects existed has only its launch folder.
  const status = new RunDir(view.ctx.dataPath).readSandboxStatus();
  return status ? [{ name: 'workspace', guest: safeText(status.guestWorkspace) }] : [];
}

export class WebService implements WebBackend {
  private cached: { at: number; view: SandboxView | null } | null = null;

  constructor(private readonly ctx: Context) {}

  /** The running sandbox as this user sees it, or null when none runs. */
  private view(): SandboxView | null {
    const now = Date.now();
    if (this.cached && now - this.cached.at < VIEW_TTL_MS) return this.cached.view;
    const view = !insideSandbox() && isSandboxRunning() ? lookAtSandbox(this.ctx) : null;
    this.cached = { at: now, view };
    return view;
  }

  /** The sandbox is this user's, or another user's and shared with them. */
  private mayUse(view: SandboxView): boolean {
    return !view.owner || ownerRule(view.owner, { kind: 'use' }).kind === 'allow';
  }

  info(): Promise<WebInfo> {
    const config = this.ctx.loaded.config;
    const view = this.view();
    return Promise.resolve({
      sandbox: view ? 'running' : 'stopped',
      owner: view?.line ?? null,
      canUse: view !== null && this.mayUse(view),
      harnesses: Object.keys(config.harnesses),
      defaultHarness: config.defaultHarness,
      projects: view && this.mayUse(view) ? runningProjects(view) : [],
    });
  }

  async sessions(): Promise<WebSession[]> {
    const view = this.view();
    if (!view || !this.mayUse(view)) return [];
    const launchId = new RunDir(view.ctx.dataPath).readSandboxStatus()?.launchId;
    const listed = await new SessionsService(view.ctx).list();
    return listed
      .filter((s) => s.launchId === launchId && (s.phase === 'running' || s.phase === 'starting'))
      .reverse()
      .slice(0, MAX_SESSIONS)
      .map((s) => webSession(s, s.viewers === undefined ? undefined : (s.viewers?.viewers ?? null)));
  }

  endpoint(sessionId: string): Endpoint | null {
    const view = this.view();
    if (!view || !this.mayUse(view)) return null;
    const run = new RunDir(view.ctx.dataPath);
    const session = run.readSession(sessionId);
    if (!session || session.phase !== 'running' || session.launchId !== run.readSandboxStatus()?.launchId) return null;
    return hostEndpoint(session);
  }
}
