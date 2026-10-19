// The user config and the smaller subset a project's .sandbox-config.json may change. Types are inferred from these
// schemas, and the JSON Schema files in schemas/ are generated from them at build time.
import _ from 'lodash';
import { z } from 'zod';
import { NameSchema, SchemaRefSchema, StringsSchema, toggle } from './common.js';
import { DatabasesSchema } from './databases.js';
import { HarnessSchema } from './harness.js';
import { AgentCommandsSchema, AttachSchema, ClaudeProfileSchema, SecretsSchema } from './profile.js';
import {
  AuditSchema,
  DownloadsSchema,
  SharingSchema,
  GitSchema,
  GuestWorkspaceSchema,
  MappingSchema,
  NetworkSchema,
  ProvisioningSchema,
  SandboxSchema,
  WorkspaceFilterSchema,
} from './sandbox.js';
import { ToolchainsSchema } from './toolchains.js';
import { AppsSchema, ProjectAppsSchema } from './apps.js';
import { ProjectsSchema } from './projects.js';
import { ResumeSchema } from './resume.js';
import { WebSchema } from './web.js';
import { VpnSchema } from './vpn.js';
import { GithubSchema } from './github.js';

const RESERVED_ENV_PREFIX =
  /^(AGENT_|GIT_|GH_|GITHUB_|NODE_|NPM_CONFIG_(USERCONFIG|GLOBALCONFIG|PREFIX|SCRIPT_SHELL)|SSL_|CLAUDE|ANTHROPIC_|OPENAI_|CODEX_|GEMINI_|GOOGLE_|COPILOT_|AWS_|AZURE_)/i;
const RESERVED_ENV_SUFFIX = /(_PROXY|_BASE_URL|_ENDPOINT|_CA_BUNDLE|_CA_CERTS)$/i;
const RESERVED_ENV_NAMES = new Set(
  [
    'PATH',
    'PATHEXT',
    'BASH_ENV',
    'ENV',
    'COMSPEC',
    'PSMODULEPATH',
    'PYTHONPATH',
    'PYTHONSTARTUP',
    'PERL5OPT',
    'RUBYOPT',
    'JAVA_TOOL_OPTIONS',
    'LD_PRELOAD',
    'SYSTEMROOT',
    'WINDIR',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'TEMP',
    'TMP',
  ].map((n) => n.toUpperCase()),
);

/**
 * An environment variable a repo's .sandbox-config.json may not set: the git guard's and the sandbox's own (setting
 * AGENT_GIT_ACCESS or GIT_CONFIG_COUNT would undo provisioning.git.access), interpreter hooks (NODE_OPTIONS reaches the
 * git guard's node), proxies and API endpoints (ANTHROPIC_BASE_URL would send your API key to the repo's server).
 */
export function reservedEnvName(name: string): boolean {
  return RESERVED_ENV_PREFIX.test(name) || RESERVED_ENV_SUFFIX.test(name) || RESERVED_ENV_NAMES.has(name.toUpperCase());
}

export const ConfigSchema = z
  .strictObject({
    $schema: SchemaRefSchema.optional(),
    defaultHarness: NameSchema.describe('Agent started by `sandbox launch` (sandbox claude always runs claude).'),
    guestWorkspace: GuestWorkspaceSchema,
    readOnly: z.boolean().describe('Map the workspace read-only.'),
    workspaceFilter: WorkspaceFilterSchema,
    audit: AuditSchema,
    mappings: z.array(MappingSchema).describe('Extra folders from this PC.'),
    sandbox: SandboxSchema,
    sharing: SharingSchema,
    storage: z.strictObject({
      root: z
        .string()
        .min(1)
        .describe(
          'Where everything is kept on this PC (tools, databases, logins, launches). The default is a private folder for you under %ProgramData%\\AgentSandbox\\users, which works for installs for one user and for everyone. sandbox storage move <folder> moves it.',
        ),
      persistAgentState: z.boolean().describe('Keep agent logins and history between sandboxes.'),
      dataName: NameSchema.describe('Name of the persistent data set (C:\\AgentData) shared by all workspaces.'),
      markSandboxFiles: z
        .boolean()
        .describe(
          'Programs and scripts (.exe, .ps1, .bat, .cmd, .msi, .lnk ...) that appear or change in your project while a sandbox runs get Windows\' "downloaded from the internet" mark, so SmartScreen and PowerShell ask before they run on this PC.',
        ),
      contained: z
        .enum(['off', 'vhdx'])
        .describe(
          '(beta) Keep the sandbox tools, state and logs inside one disk image file (vhdx) instead of loose folders, so scanning programs on this PC see one file. Not yet tried on a real PC. Turn it on with sandbox storage contained on (it moves your files and asks first); Windows asks for permission to mount the image when a sandbox starts. "off" = loose folders, as always. Yours only: a project file (.sandbox-config.json) cannot set it.',
        ),
      containedMaxGb: z
        .number()
        .int()
        .min(8)
        .max(4096)
        .describe('(beta) Largest size, in GB, the disk image of storage.contained may grow to.'),
      warnDataGb: z
        .number()
        .min(0)
        .describe(
          'Say at launch when the persisted data (tools, databases, logins) is bigger than this many GB; 0 = never. sandbox data shows what takes the space.',
        ),
    }),
    network: NetworkSchema,
    vpn: VpnSchema,
    github: GithubSchema,
    provisioning: ProvisioningSchema,
    downloads: DownloadsSchema,
    toolchains: ToolchainsSchema,
    databases: DatabasesSchema.describe(
      'Databases running inside the sandbox. Data persists in C:\\AgentData\\databases; each one starts at boot.',
    ),
    attach: AttachSchema,
    web: WebSchema,
    agentCommands: AgentCommandsSchema,
    secrets: SecretsSchema,
    personalization: toggle('Copy your desktop look (theme, accent, taskbar, wallpaper, ...) into the sandbox.'),
    apps: AppsSchema,
    claudeProfile: ClaudeProfileSchema,
    harnesses: z.record(NameSchema, HarnessSchema).describe('Agents that can run in the sandbox.'),
    hooks: z.strictObject({ failFast: z.boolean().describe('Stop when a hook script fails.') }),
    projects: ProjectsSchema.describe(
      'Several projects in one sandbox: folders of projects mapped at every start, and adding folders while it runs.',
    ),
    resume: ResumeSchema.describe('Reopening the sessions of the last sandbox when a new one starts.'),
  })
  .refine((c) => c.harnesses[c.defaultHarness] !== undefined, {
    message: 'defaultHarness must be one of the configured harnesses',
    path: ['defaultHarness'],
  });

/**
 * What a project's .sandbox-config.json may change. A repo can ship this file, so it can NOT touch storage, agent
 * executables, host folders for tools or Claude settings, or anything else outside this list.
 */
export const LocalOverridesSchema = z
  .strictObject({
    $schema: SchemaRefSchema,
    harness: NameSchema.describe('Agent for this project.'),
    guestWorkspace: GuestWorkspaceSchema,
    readOnly: z.boolean().describe('Map this project read-only.'),
    // A project may turn the filter on and keep more out, never let ignored files in.
    workspaceFilter: WorkspaceFilterSchema.pick({ enabled: true, exclude: true }).partial(),
    mappings: z
      .array(MappingSchema)
      .describe(
        'Extra folders (relative paths are relative to this file), e.g. a read-only data folder at another place in the sandbox. Folders outside the project are used only as your projects.allowOutsideMappings setting allows (by default you are asked once).',
      ),
    scripts: StringsSchema.describe(
      'Scripts (.ps1 / .mjs / .cmd, relative to this file) run inside the sandbox before the agent.',
    ),
    // This PC's resources are yours to share: CPU, paging file (this PC's disk) and the RAM kept for this PC are not a
    // project's to set.
    sandbox: SandboxSchema.omit({
      cpuLimit: true,
      pageFileMb: true,
      reserveHostMb: true,
      maxMemoryPercent: true,
      maxMemoryMb: true,
      engine: true,
      agentMemoryHeadroomMb: true,
      pressureResponse: true,
    }).partial(),
    // A project may block more (the LAN, hosts); it never opens hosts, ports, DNS or a proxy.
    network: NetworkSchema.pick({ blockPrivateRanges: true, blockHosts: true }).partial(),
    // A project may turn the kill switch on, never off, and never choose a VPN, a server, a file or a login.
    vpn: VpnSchema.pick({ killSwitch: true }).partial(),
    provisioning: ProvisioningSchema.pick({ copyFromHost: true, fallbackToInstall: true, refresh: true })
      .extend({ git: GitSchema.partial(), terminal: toggle('Windows Terminal as the sandbox window.').partial() })
      .partial(),
    downloads: DownloadsSchema.partial(),
    // Every toolchain setting, each one optional (a project usually only switches languages on or pins a version).
    toolchains: z
      .strictObject({
        ..._.mapValues(_.omit(ToolchainsSchema.shape, 'environment'), (shape) => shape.partial()),
        environment: ToolchainsSchema.shape.environment.refine(
          (env) => !Object.keys(env).some(reservedEnvName),
          'names the sandbox sets or that carry logins (AGENT_*, GIT_*, PATH, BASH_ENV, NODE_*, proxies, ANTHROPIC_*, CLAUDE_* ...) cannot be set by a project',
        ),
      })
      .partial(),
    databases: z.strictObject(_.mapValues(DatabasesSchema.shape, (shape) => shape.partial())).partial(),
    attach: AttachSchema.partial(),
    personalization: toggle('Copy your desktop look into the sandbox.').partial(),
    // Catalogue apps only (a vetted list): your own programs (apps.custom) download anything, so a repo cannot add
    // them, nor agent add-ons that are yours only (rtk hooks every agent command, Headroom sits in its API path).
    apps: ProjectAppsSchema.partial(),
    claudeProfile: ClaudeProfileSchema.pick({
      enabled: true,
      overwrite: true,
      copyCredentials: true,
      syncHistory: true,
      syncClaudeMem: true,
    }).partial(),
    hooks: z.strictObject({ failFast: z.boolean() }).partial(),
  })
  .partial();
