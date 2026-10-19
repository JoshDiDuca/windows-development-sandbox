// The sandbox machine, folders mapped into it, and what is provisioned (Git, terminal).
import { z } from 'zod';
import { GitAccessSchema, GuestPathSchema, toggle } from './common.js';

export const GuestWorkspaceSchema = z
  .union([z.literal('auto'), z.literal('mirror'), GuestPathSchema])
  .describe(
    'Where the workspace appears inside the sandbox. "auto" = C:\\Workspace\\<folder name>. "mirror" = the same path as on this PC, so absolute paths in configs and build caches match (another drive letter such as F: is a subst drive onto C:\\Mirror\\F); paths the sandbox reserves (C:\\Users\\..., C:\\Program Files\\...) fall back to "auto".',
  );

export const MappingSchema = z.strictObject({
  host: z.string().min(1).describe('Folder on this PC (relative paths are relative to the config file).'),
  guest: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe(
      'Where it appears inside the sandbox, e.g. C:\\Assets, or on another drive letter (D: to Z:) such as F:\\SteamLibrary\\steamapps\\common\\Game (shown as F: at boot). Leave it out to use the same path as on this PC (a folder inside the project stays where it is in the project). A full path only; one the sandbox cannot use (C:\\Windows\\..., C:\\Users\\..., one already in use) stops the launch with the fix.',
    ),
  readOnly: z.boolean().describe('true = the agent can only read it.'),
  optional: z.boolean().optional().describe('true = skip it quietly when the host folder does not exist.'),
});

export const SandboxSchema = z.strictObject({
  engine: z
    .enum(['windows-sandbox', 'hcs'])
    .describe(
      '(alpha) What runs the sandbox. "windows-sandbox" = Windows Sandbox (the default: desktop, Windows Terminal, GPU, clipboard, audio, printers). "hcs" = a headless Hyper-V isolated Server Core container for agents (no desktop, GPU or clipboard); it needs Windows features and an image on this PC (sandbox engine check hcs lists what is missing), and starting it is not enabled yet in this alpha. sandbox engine shows what each engine can do. Yours only: a project file (.sandbox-config.json) cannot set it.',
    ),
  memoryMb: z
    .union([z.literal('auto'), z.number().int().min(2048)])
    .describe(
      'Sandbox RAM in MB (>= 2048), or "auto": free RAM minus reserveHostMb, capped at maxMemoryMb. Never more than this PC can keep in RAM for it (its RAM minus the larger of reserveHostMb and 25 %, 2 GB more with vGPU): a bigger value is lowered.',
    ),
  maxMemoryMb: z.number().int().positive().describe('Upper limit for memoryMb "auto".'),
  maxMemoryPercent: z
    .number()
    .int()
    .min(10)
    .max(100)
    .describe('memoryMb "auto" never takes more than this share of this PC\'s total RAM (percent).'),
  cpuLimit: z
    .union([z.literal('none'), z.number().int().min(5).max(100)])
    .describe(
      'Most of this PC\'s CPU the sandbox may use, in percent (5-100), e.g. 50 keeps half free for you; "none" = no cap (Windows Sandbox would take every processor). Covers everything this tool starts in the sandbox (agents, installs, builds, its terminal).',
    ),
  pageFileMb: z
    .number()
    .int()
    .min(0)
    .max(262144)
    .describe(
      'Size of the sandbox\'s paging file in MB, created at full size when it starts so it never grows while builds run (8 GB of its disk always stays free). Windows Sandbox starts with about 1 GB: parallel builds then fail with "The paging file is too small", and Windows grows the file under load. 0 = leave Windows\' own.',
    ),
  reserveHostMb: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Memory always left for this PC when memoryMb is "auto": the sandbox gets at most (free RAM, and RAM plus paging file still unused) minus this.',
    ),
  agentMemoryHeadroomMb: z
    .union([z.literal('auto'), z.literal('none'), z.number().int().min(0)])
    .describe(
      'The last resort that keeps the sandbox up, in MB below its commit limit (RAM plus paging file): builds are slowed down long before (sandbox.pressureResponse); only if everything the agents start together would take the sandbox to the very edge of its memory, where Windows inside it would start failing, is a build refused memory instead of Windows. "auto" = the larger of 1536 MB and 3 % of the commit limit; "none" = no backstop. Yours only: a project file cannot change it.',
    ),
  pressureResponse: z
    .boolean()
    .describe(
      'When the sandbox (or this PC) runs low on memory, slow builds down in steps, like a PC that gets slower instead of failing: build programs get lower CPU and memory priority, then less CPU, then compilers take turns (the waiting ones briefly suspended and trimmed to the paging file). Nothing is stopped or killed, and the agents themselves are never touched. Yours only: a project file cannot change it.',
    ),
  vGpu: z
    .boolean()
    .describe(
      "Virtual GPU. Off by default: Microsoft notes it widens the sandbox attack surface. The sandbox then uses this PC's graphics card, and with some graphics drivers heavy use can freeze the whole PC: turn it on only when a program in the sandbox needs the GPU (the mesa toolchain gives software OpenGL without it).",
    ),
  networking: z.boolean().describe('Internet access. false is the only hard network isolation Windows Sandbox offers.'),
  clipboard: z
    .boolean()
    .describe(
      "Shared clipboard between this PC and the sandbox. Also lets an agent's copy (in sandbox attach) reach this PC's clipboard.",
    ),
  audioInput: z.boolean().describe('Microphone access.'),
  videoInput: z.boolean().describe('Camera access.'),
  printerRedirection: z.boolean().describe('Printers from this PC.'),
  protectedClient: z.boolean().describe('Run the sandbox window in Protected Client mode (recommended).'),
  headless: z
    .boolean()
    .describe(
      'Hide the sandbox window (sbx-show brings it back). A headless sandbox shuts down when its last session ends.',
    ),
  keepAwake: z
    .boolean()
    .describe(
      'Keep this PC from sleeping while a sandbox runs, so agents left working overnight keep going (the screen may still turn off; closing a laptop lid still sleeps it).',
    ),
});
export const SharingSchema = z.strictObject({
  otherUsers: z
    .boolean()
    .describe(
      'Let other Windows users of this PC use a sandbox you start: list its sessions, attach, run commands and stop it. They use the agent logins inside it, and history goes to your account.',
    ),
});
const PortSchema = z.number().int().min(1).max(65535);
const HostEntrySchema = z
  .string()
  .max(253)
  .regex(
    /^(@developer|(\*\.)?([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+)$/,
    'a host name like example.com, *.example.com, or @developer',
  );

export const NetworkSchema = z.strictObject({
  blockPrivateRanges: z
    .boolean()
    .describe('Block your LAN (10/8, 172.16/12, 192.168/16, SMB) from inside the sandbox.'),
  allowOnly: z
    .array(HostEntrySchema)
    .describe(
      'Only these hosts can be reached once the sandbox is set up (tools still download first). *.example.com covers its subdomains; @developer adds package registries, GitHub, toolchain downloads and the AI providers. Programs go through a proxy in the sandbox (HTTP_PROXY); anything else is blocked by its firewall. Empty = no limit.',
    ),
  blockHosts: z
    .array(
      z
        .string()
        .max(253)
        .regex(/^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/, 'a host name like telemetry.example.com'),
    )
    .describe(
      "Never reachable from the sandbox, e.g. production servers or telemetry (each exact name; the sandbox's hosts file sends them nowhere).",
    ),
  forwardPorts: z
    .array(
      z.strictObject({
        pc: PortSchema.describe('The port on this PC (localhost only).'),
        sandbox: PortSchema.describe('The port inside the sandbox (a server there may listen on localhost only).'),
      }),
    )
    .describe(
      'Reach servers in the sandbox from this PC: http://localhost:<pc> here goes to <sandbox> inside, while it runs. Nothing else on your network can use them.',
    ),
  dns: z
    .array(z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/, 'an IPv4 address like 1.1.1.1'))
    .describe("DNS servers for the sandbox instead of your network's, e.g. 1.1.1.1 and 9.9.9.9."),
  proxy: z
    .string()
    .regex(/^(https?:\/\/[^\s]+)?$/, 'http://host:port')
    .refine(
      (v) => !/^https?:\/\/[^/?#]*@/i.test(v),
      'no user name or password in the address (it would be stored in plain text and visible to the agent): use a proxy that needs no login',
    )
    .describe(
      'An HTTP proxy the sandbox uses to reach the internet (HTTP_PROXY / HTTPS_PROXY for everything in it), e.g. http://proxy.corp:8080. Empty = none.',
    ),
});

export const AuditSchema = z.strictObject({
  enabled: z
    .boolean()
    .describe(
      'Keep an audit log on this PC of what your agents did: programs started (with their command lines, secrets hidden), files changed in the projects, git commits, sessions, and what the repo guard caught, each linked to the agent session that did it where that can be known. The sandbox cannot change it. Read it with sandbox audit or on the Activity page.',
    ),
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .describe(
      'Days the audit log is kept (1 to 30; a larger number keeps 30); older days are deleted when a sandbox starts and once a day.',
    ),
  maxMb: z
    .number()
    .int()
    .min(5)
    .max(5000)
    .describe('Most space the audit log may take, in MB (older days go first). Days before today are compressed.'),
  processes: z
    .boolean()
    .describe(
      'Record every program started in the sandbox with its command line (Windows process auditing; repeated runs are counted, not listed).',
    ),
  files: z.boolean().describe('Record the files changed in the projects while the sandbox runs.'),
  commits: z
    .boolean()
    .describe(
      "Record the git commits made in the projects while the sandbox runs (read from each project's .git folder on this PC).",
    ),
});

export const WorkspaceFilterSchema = z.strictObject({
  enabled: z
    .boolean()
    .describe(
      'Keep what your .gitignore lists (.env files, node_modules, build output ...) out of the sandbox. The sandbox works on a copy of the project without those files, kept in step with it both ways within about a second; what it creates that is ignored (its own node_modules, builds) stays in the sandbox. Git works as usual. Off = the project folder itself is mapped.',
    ),
  exclude: z
    .array(z.string().max(500))
    .describe('Also keep these out, as .gitignore patterns, e.g. secrets/, *.pem, data/private/.'),
  include: z
    .array(z.string().max(500))
    .describe('Let these in although .gitignore lists them, e.g. .env.example, data/fixtures/.'),
});
export const GitSchema = z.strictObject({
  enabled: z.boolean().describe('Provide Git for Windows (and Git Bash, which Claude Code needs).'),
  access: GitAccessSchema,
});
export const ProvisioningSchema = z.strictObject({
  copyFromHost: z.boolean().describe('Copy Node, Git, nvm and the agent from this PC when they are installed here.'),
  fallbackToInstall: z.boolean().describe('Download anything that cannot be copied from this PC.'),
  refresh: z.boolean().describe('Re-copy / re-download everything on the next launch.'),
  git: GitSchema,
  terminal: toggle('Windows Terminal as the sandbox window (downloaded once).'),
  conpty: toggle(
    "Agent sessions use Microsoft's newer pseudo console (conpty.dll, downloaded once) instead of the one built into Windows: no garbled screen after resizing, real scrollback for the mouse wheel. Off = the one built into Windows.",
  ),
});

export const DownloadsSchema = z.strictObject({
  requireChecksum: z
    .boolean()
    .describe(
      "Refuse any toolchain, database or tool download that has no published checksum (SHA-256/SHA-512) to verify it against. false = allow those, as before. Downloads that do have a published checksum are always verified. A project's .sandbox-config.json can only turn this on.",
    ),
});
