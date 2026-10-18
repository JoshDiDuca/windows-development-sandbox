// What the guest reads at boot: session.json (the whole launch, decided on this side) and env.cmd for logon.cmd.
import fs from 'node:fs';
import path from 'node:path';
import type {
  DatabasePlan,
  GenerateOptions,
  Generated,
  GuestSession,
  HostProbe,
  ProfileResult,
  ResolvedMapping,
} from '../../core/types.js';
import { resolveToolchains } from '../../core/detect/index.js';
import { hubName, PROJECTS_GUEST, substDrives } from '../../shared/paths/index.js';
import { hostClaudeDir } from '../profile/index.js';
import type { BootProjects } from './boot-projects.js';
import { databaseCatalog } from './database-plan.js';
import { effectiveCpuLimit } from '../../shared/memory/index.js';
import { loadProfileOf } from './risk-notes.js';

/** What generateSandbox has decided or staged before it writes session.json. */
export interface SessionParts {
  readonly launchId: string;
  readonly launchPath: string;
  readonly harness: GuestSession['harness'];
  readonly boot: BootProjects;
  readonly mappings: readonly ResolvedMapping[];
  readonly profile: ProfileResult;
  readonly databases: DatabasePlan[];
  readonly toolchains: Generated['toolchains'];
  /** The sandbox's memory (MB), for the agents' memory limit. */
  readonly memoryMb: number;
}

/** What was found on this PC to copy instead of download. */
export function hostToolsOf(probe: HostProbe): GuestSession['hostTools'] {
  return {
    node: Boolean(probe.nodeDir),
    nodeVersion: probe.nodeDir || probe.nvmNode ? probe.hostNodeVersion.replace(/^v/, '') : null,
    harnessExecutable: probe.harnessExe?.file ?? null,
    git: Boolean(probe.gitDir),
    nvm: Boolean(probe.nvmDir),
    volta: Boolean(probe.volta),
    pyenv: Boolean(probe.pyenv),
  };
}

/** session.json. The key order is the file's byte order: keep it. */
export function guestSession(o: GenerateOptions, parts: SessionParts): GuestSession {
  const { config, workspaceHost, harnessName } = o.run;
  const { profile } = parts;
  return {
    launchId: parts.launchId,
    project: path.basename(workspaceHost),
    projectId: hubName(workspaceHost, []),
    workspace: config.guestWorkspace,
    workspaceHost,
    projectsDir: PROJECTS_GUEST,
    // Every folder mapped for other projects (roots and projects mapped at boot): the guest accepts projects in them.
    roots: [...parts.boot.roots, ...parts.boot.projects].map((r) => r.guest),
    ...(o.autoSession === false ? { autoSession: false } : {}),
    harnessName,
    // The environment (it may hold API keys) travels in a one-shot file in <data>\secrets, never in this file.
    harness: parts.harness ? { ...parts.harness, environment: {} } : null,
    harnessArguments: o.harnessArgs,
    persistAgentState: config.storage.persistAgentState,
    networking: config.sandbox.networking,
    headless: config.sandbox.headless,
    network: config.network,
    provisioning: config.provisioning,
    // "auto" is decided here, so the guest and the launch table agree.
    toolchains: resolveToolchains(config.toolchains, parts.toolchains),
    databases: parts.databases,
    databaseCatalog: databaseCatalog(config.databases),
    versions: o.run.versions,
    attach: config.attach,
    hooks: config.hooks,
    downloads: config.downloads,
    ...(o.vpn ? { vpn: o.vpn.session } : {}),
    hostTools: hostToolsOf(o.probe),
    claudeProfile: {
      overwrite: config.claudeProfile.overwrite,
      items: profile.staged,
      credentials: profile.credentials,
      hostConfigDir: profile.hostDir ?? hostClaudeDir(config.claudeProfile),
      syncClaudeMem: config.claudeProfile.syncClaudeMem,
    },
    personalization: fs.existsSync(path.join(parts.launchPath, 'personalize', 'personalize.reg')),
    substDrives: substDrives(parts.mappings.map((m) => m.guest)),
    cpuLimitPercent: effectiveCpuLimit(config.sandbox.cpuLimit, loadProfileOf(config)),
    loadProfile: loadProfileOf(config),
    pageFileMb: config.sandbox.pageFileMb,
    agentBackstop: config.sandbox.agentMemoryHeadroomMb,
    pressureResponse: config.sandbox.pressureResponse,
    apps: config.apps,
    auditProcesses: config.audit.enabled && config.audit.processes,
    agentHomes: Object.assign({}, ...Object.values(config.harnesses).map((h) => h.home?.env ?? {})),
    agentProfileDirs: Object.fromEntries(
      Object.entries(config.harnesses).flatMap(([name, h]) =>
        h.home?.profileDirs?.length ? [[name, h.home.profileDirs]] : [],
      ),
    ),
    agents: Object.fromEntries(Object.entries(config.harnesses).map(([name, h]) => [name, { ...h, environment: {} }])),
  };
}

/**
 * env.cmd, which logon.cmd calls before it opens Windows Terminal: Terminal expands "%AGENT_WORKSPACE%" (the starting
 * folder of new tabs) from its own environment, and the runtime only sets the variable machine-wide after Terminal
 * started. `%` is doubled for cmd; a Windows path holds no quotes.
 */
export function logonEnv(workspace: string): string {
  return '@set "AGENT_WORKSPACE=' + workspace.replace(/[\r\n"]/g, '').replace(/%/g, '%%') + '"\r\n';
}
