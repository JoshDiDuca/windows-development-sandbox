// Projects registered after boot (sandbox claude from another folder on the PC, which the host links into the hub).
// Each is provisioned once, on demand, while every other session keeps running: the toolchain steps it needs that are
// not installed yet (installOnce markers and installed folders make the rest free), its Node/Python versions, its
// databases and hooks. Its sessions get ITS environment, built from the boot's base environment rather than the boot
// project's: nothing machine-wide is switched under the sessions already running (no nvm symlink switch, machine
// variables only added, never replaced). A failure is that project's alone.
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectSpec } from '../../shared/channel/schema.js';
import { isWithin } from '../../shared/paths/projects.js';
import { insideWorkspace } from './state.js';
import { baseEnvFor, readBootEnv } from '../boot/boot-env.js';
import { dryRun, localDir } from '../runtime/paths.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log, warn } from '../runtime/log.js';
import { session } from '../runtime/session.js';
import { errMsg } from '../../core/util/errors.js';
import { writeGuides } from '../boot/guide.js';
import { withProject } from '../runtime/project-context.js';
import { saveProjectStatus } from '../boot/project-status.js';
import { addMachineEnvironment, agentEnv } from '../setup/environment.js';
import { projectHooks, runHooksAsync } from '../setup/hooks.js';
import { setupToolchains } from '../toolchains/index.js';

export interface Provisioned {
  spec: ProjectSpec;
  env: NodeJS.ProcessEnv;
  summary: string[];
}

interface Entry {
  key: string;
  work: Promise<Provisioned>;
  listeners: Set<(message: string) => void>;
  done?: Provisioned;
}

/** `set` lines for a .cmd file. Values are quoted; a value with a line break cannot be set this way and is left out. */
function cmdSet(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  return names
    .filter((n) => env[n] !== undefined && !/[\r\n]/.test(String(env[n])))
    .map((n) => '@set "' + n + '=' + String(env[n]).replace(/%/g, '%%') + '"');
}

/**
 * A terminal for the project inside the sandbox: `sbx-shell <name>` (from any terminal tab) opens cmd in its folder
 * with its environment. Written to the sandbox's own disk.
 */
function writeShell(spec: ProjectSpec, env: NodeJS.ProcessEnv, names: readonly string[]): void {
  const dir = mkdirp(path.join(localDir, 'projects', spec.name));
  fs.writeFileSync(path.join(dir, 'env.cmd'), [...cmdSet(env, [...names, 'PATH']), ''].join('\r\n'));
  fs.writeFileSync(
    path.join(dir, 'shell.cmd'),
    ['@call "' + path.join(dir, 'env.cmd') + '"', '@cd /d "' + spec.workspace + '"', '@title ' + spec.name, ''].join(
      '\r\n',
    ),
  );
  const bin = mkdirp(path.join(localDir, 'bin'));
  fs.writeFileSync(
    path.join(bin, 'sbx-shell.cmd'),
    [
      '@if "%~1"=="" (echo Usage: sbx-shell ^<project^>   ^(a terminal in that project with its tools^) & dir /b "' +
        path.join(localDir, 'projects') +
        '" & exit /b 2)',
      '@if not exist "' +
        path.join(localDir, 'projects') +
        '\\%~1\\shell.cmd" (echo No project %~1 in this sandbox. & exit /b 2)',
      '@cmd /k ""' + path.join(localDir, 'projects') + '\\%~1\\shell.cmd""',
      '',
    ].join('\r\n'),
  );
}

/** The guide every agent reads lists every project in the sandbox (they can all see each other's folders). */
function refreshGuide(projects: readonly Provisioned[]): void {
  // The self-test must never rewrite this machine's real managed CLAUDE.md.
  if (dryRun || (process.env.AGENT_SANDBOX_SELFTEST === '1' && !process.env.AGENT_MANAGED_DIR)) return;
  const boot = readBootEnv();
  if (!boot) return;
  const list = projects.map((p) => ({
    guest: p.spec.workspace,
    host: p.spec.workspaceHost,
    name: p.spec.name,
    tools: p.summary,
  }));
  try {
    writeGuides(boot.summary, boot.lan, list);
  } catch (e) {
    warn('Could not update the sandbox guide: ' + errMsg(e));
  }
}

/** Sets one project up: hooks, the toolchain steps it needs, its environment, sbx-shell and its status. */
async function setUp(spec: ProjectSpec, say: (message: string) => void): Promise<Provisioned> {
  if (!insideWorkspace(spec.workspace) || !exists(spec.workspace)) {
    throw new Error(
      'Project folder ' +
        spec.workspace +
        ' (' +
        spec.workspaceHost +
        ') is not visible inside the sandbox. Stop the sandbox (sandbox stop) and start it from that folder, or add its parent folder to projects.roots.',
    );
  }
  saveProjectStatus(spec.name, spec.workspace, 'provisioning', 'Setting up ' + spec.name, spec.databases, []);
  log('Project ' + spec.name + ': setting up ' + spec.workspace + ' (' + spec.workspaceHost + ')');
  const boot = readBootEnv();
  const base = baseEnvFor(boot);
  const hooks = projectHooks(spec.name, spec.workspace);
  if (spec.hooks) {
    say('Pre-provision hooks');
    await runHooksAsync('pre-provision', base, hooks);
  }
  const tools = await withProject({ workspace: spec.workspace, duringSession: true }, () =>
    setupToolchains(
      spec.toolchains,
      spec.versions,
      {
        gitEnabled: session.provisioning.git.enabled,
        // Git access is machine-wide: the host refuses a project that needs a stricter one, so the sandbox's applies.
        gitAccess: session.provisioning.git.access ?? 'full',
        hostGit: session.hostTools.git,
        refresh: false,
        databases: spec.databases,
      },
      {
        report: (m) => {
          saveProjectStatus(spec.name, spec.workspace, 'provisioning', m, spec.databases, []);
          say(m);
        },
        reuse: boot?.steps,
      },
    ),
  );
  tools.prepend.push(path.join(localDir, 'bin'));
  const env = agentEnv(tools, { workspace: spec.workspace, project: spec.name, base });
  const specFile = path.join(mkdirp(path.join(localDir, 'projects', spec.name)), 'project.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  env.AGENT_PROJECT_FILE = specFile;
  // New terminal tabs see the new tools too, after everything the boot project has (never in place of it).
  addMachineEnvironment(tools.vars, [...tools.prepend, ...tools.append], true);
  try {
    writeShell(spec, env, [
      ...Object.keys(tools.vars),
      'AGENT_WORKSPACE',
      'AGENT_PROJECT',
      'AGENT_SANDBOX_WORKSPACE',
      'AGENT_PROJECT_FILE',
    ]);
  } catch (e) {
    warn('sbx-shell for ' + spec.name + ': ' + errMsg(e));
  }
  if (spec.hooks) {
    say('Pre-agent hooks');
    await runHooksAsync('pre-agent', env, hooks);
  }
  for (const line of tools.summary) log('  [' + spec.name + '] ' + line);
  saveProjectStatus(spec.name, spec.workspace, 'ready', 'Ready', spec.databases, tools.summary);
  return { spec, env, summary: tools.summary };
}

/** Projects registered after boot, each provisioned once on demand (a changed spec provisions again). */
export class ProjectProvisioner {
  /** By project name (lower case). The same spec again is free. */
  private readonly running = new Map<string, Entry>();
  /** The last finished provisioning of each project (kept while a changed spec provisions again). */
  private readonly ready = new Map<string, Provisioned>();

  /**
   * Provisions a project (or joins the run already doing it: two sessions requested at once wait for the same one).
   * `say` gets the progress lines.
   */
  provision(spec: ProjectSpec, say: (message: string) => void): Promise<Provisioned> {
    const id = spec.name.toLowerCase();
    const key = JSON.stringify(spec);
    const known = this.running.get(id);
    if (known && known.key === key) {
      known.listeners.add(say);
      return known.work.finally(() => known.listeners.delete(say));
    }
    const listeners = new Set([say]);
    const broadcast = (message: string): void => {
      for (const l of listeners)
        try {
          l(message);
        } catch {
          /* a listener's write failing never stops provisioning */
        }
    };
    const work = setUp(spec, broadcast);
    const entry: Entry = { key, work, listeners };
    this.running.set(id, entry);
    work.then(
      (done) => {
        entry.done = done;
        this.ready.set(id, done);
        refreshGuide(this.all());
      },
      (e: unknown) => {
        warn('Project ' + spec.name + ' could not be set up: ' + errMsg(e));
        saveProjectStatus(spec.name, spec.workspace, 'failed', errMsg(e), spec.databases, []);
        // The next session for it tries again.
        if (this.running.get(id) === entry) this.running.delete(id);
      },
    );
    return work;
  }

  /** The provisioned project containing this folder, if any (exec in its folders uses its environment). */
  provisionedFor(cwd: string): Provisioned | null {
    return (
      this.all()
        .filter((p) => isWithin(p.spec.workspace, cwd))
        .sort((a, b) => b.spec.workspace.length - a.spec.workspace.length)[0] ?? null
    );
  }

  all(): Provisioned[] {
    return [...this.ready.values()];
  }
}

/** The daemon's one provisioner. */
export const provisioner = new ProjectProvisioner();
