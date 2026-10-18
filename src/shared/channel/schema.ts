// The host <-> sandbox channel messages, defined once with zod. Both sides parse what they read: the guest only acts on
// these request kinds, and the host treats everything the guest writes as untrusted (shapes checked, sizes capped).
import { z } from 'zod';
import { HarnessSchema, ToolchainsSchema } from '../../core/schema/index.js';

export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid id');
const Text = (max = 4096) => z.string().max(max);
const TimeSchema = Text(64);

export const AttachEndpointSchema = z.strictObject({
  addresses: z.array(Text(64)).max(16),
  port: z.number().int().min(1024).max(65535),
  token: Text(256),
});

/** The boot's progress in a shape the host can show: step n of m, what is being set up now, how many are done. */
export const BootProgressSchema = z.strictObject({
  step: z.number().int().min(1).max(32),
  steps: z.number().int().min(1).max(32),
  title: Text(120),
  /** Being set up now; percent while it downloads (when the size is known). */
  active: z.array(z.strictObject({ name: Text(64), percent: z.number().int().min(0).max(100).optional() })).max(8),
  done: z.number().int().min(0).max(1000),
  total: z.number().int().min(0).max(1000),
});

/** C:\AgentData\run\sandbox.json: boot progress of the sandbox as a whole. */
export const SandboxStatusSchema = z.object({
  launchId: Text(64),
  phase: z.enum(['booting', 'provisioning', 'ready', 'failed']),
  message: Text(),
  updatedAt: TimeSchema,
  workspaceHost: Text(),
  guestWorkspace: Text(),
  headless: z.boolean(),
  /** The sandbox's IPv4 addresses (for network.forwardPorts; the host only uses ones on its Hyper-V network). */
  addresses: z.array(z.string().max(45)).max(8).optional(),
  /** A malformed progress is dropped, never the status (the phase still counts). */
  progress: BootProgressSchema.optional().catch(undefined),
});

const VersionSchema = z.strictObject({ spec: Text(128), source: Text(256) });
const DatabasePlanSchema = z.strictObject({
  database: z.enum(['postgres', 'mysql', 'sqlserver', 'mongodb', 'redis', 'dynamodb']),
  reasons: z.array(Text(1024)).max(32),
  version: Text(64),
  port: z.number().int().min(1024).max(65535),
  adminPort: z.number().int().min(1024).max(65535).optional(),
});

/**
 * A project the host registered after boot (sandbox claude from another folder): everything the guest needs to
 * provision it and run its sessions with its own environment, resolved on the host exactly like a fresh launch (its
 * approved .sandbox-config.json, version files, toolchain detection, database plan). Host -> guest only.
 */
export const ProjectSpecSchema = z.strictObject({
  name: IdSchema,
  /** Inside the sandbox: C:\Projects\<name>. */
  workspace: Text(1024),
  workspaceHost: Text(1024),
  toolchains: ToolchainsSchema,
  versions: z.strictObject({ node: VersionSchema, nodeExtra: z.array(Text(128)).max(16), python: VersionSchema }),
  databases: z.array(DatabasePlanSchema).max(8),
  /** Agents this project may start that the sandbox did not boot with (its .sandbox-config.json "harness"). */
  harnesses: z.record(Text(64), HarnessSchema).refine((h) => Object.keys(h).length <= 8, 'at most 8 agents'),
  /** Its hooks were staged in C:\AgentLaunch\projects\<name>\hooks. */
  hooks: z.boolean(),
});

/** C:\AgentData\run\requests\<id>.json: the ONLY things the host can ask the sandbox to do. */
export const GuestRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('session'),
    id: IdSchema,
    harness: Text(64),
    args: z.array(Text()).max(256),
    cwd: Text(),
    project: ProjectSpecSchema.optional(),
    harnessSpec: HarnessSchema.optional(),
    createdAt: TimeSchema,
  }),
  /** Provision a registered project without starting an agent (sandbox start / exec / db from its folder). */
  z.strictObject({ kind: z.literal('project'), id: IdSchema, project: ProjectSpecSchema, createdAt: TimeSchema }),
  z.strictObject({
    kind: z.literal('exec'),
    id: IdSchema,
    command: z.array(Text()).min(1).max(256),
    cwd: Text(),
    timeoutSeconds: z.number().positive().max(86400),
    createdAt: TimeSchema,
  }),
  /** cwd: only the sessions in this folder or below (one project's); omitted = every session. */
  z.strictObject({
    kind: z.literal('restart'),
    id: IdSchema,
    harness: Text(64).nullable(),
    cwd: Text().optional(),
    createdAt: TimeSchema,
  }),
  z.strictObject({ kind: z.literal('ping'), id: IdSchema, createdAt: TimeSchema }),
  /**
   * The PC's own memory or CPU is running low (the host watchdog): the sandbox slows its heaviest builds down for
   * `seconds` (it never stops them) so Windows does not have to close it. Repeated while the PC stays low.
   */
  z.strictObject({
    kind: z.literal('pressure'),
    id: IdSchema,
    reason: Text(300),
    seconds: z.number().int().min(10).max(300),
    /** "severe": the PC is nearly out of memory; builds go to the governor's last step at once. */
    level: z.enum(['slow', 'severe']).optional(),
    createdAt: TimeSchema,
  }),
]);

/** C:\AgentData\run\pressure.json: what the memory governor in the sandbox is doing (guest-written, capped). */
export const PressureStatusSchema = z.object({
  level: z.enum(['ok', 'throttled', 'suspending']),
  /** The governor's dial, 0 (nothing wrong) to 4 (one compiler at a time). */
  step: z.number().int().min(0).max(4).optional(),
  profile: z.enum(['normal', 'gentle']),
  /** Share of the sandbox's RAM still free and of its commit limit in use (percent). */
  ramFreePercent: z.number().int().min(0).max(100),
  commitPercent: z.number().int().min(0).max(100),
  /** Programs running at lower priority because of it. */
  lowered: z.number().int().min(0).max(1024),
  /** Compilers waiting their turn right now (name, process id, seconds until they may go on). */
  paused: z.array(z.object({ name: Text(64), pid: z.number().int(), seconds: z.number().int().min(0).max(60) })).max(8),
  /** The CPU share the compilers get together (percent; 100 = no cap). */
  cpuPercent: z.number().int().min(0).max(100).optional(),
  /** The PC itself asked for slowing down (its memory or CPU is low). */
  pcLow: z.boolean(),
  lastAction: Text(300),
  updatedAt: TimeSchema,
});
export type PressureStatus = z.output<typeof PressureStatusSchema>;

/** C:\AgentData\run\responses\<id>.json: the guest's reply. */
export const GuestResponseSchema = z.object({
  id: IdSchema,
  ok: z.boolean(),
  message: Text(65536),
  exitCode: z.number().int().optional(),
  stdout: Text(4 * 1024 * 1024).optional(),
  stderr: Text(4 * 1024 * 1024).optional(),
  finishedAt: TimeSchema,
});

/** C:\AgentData\run\sessions\<id>.json: one agent session (its own pseudo console and terminal tab). */
export const SessionStatusSchema = z.object({
  id: IdSchema,
  launchId: Text(64),
  harness: Text(64),
  cwd: Text(),
  /** The project it runs in: its hub name, or the launch folder's for the first project. */
  project: Text(64).optional(),
  phase: z.enum(['starting', 'running', 'exited', 'failed']),
  message: Text(),
  updatedAt: TimeSchema,
  startedAt: TimeSchema,
  /** The agent's own conversation this session is in (Claude: the file name of its .jsonl), once known. */
  conversation: Text(128).optional(),
  exitCode: z.number().int().optional(),
  attach: AttachEndpointSchema.optional(),
});

/**
 * C:\AgentData\run\projects\<name>.json: how far a project's provisioning is (guest-written, so validated and capped).
 */
export const ProjectStatusSchema = z.object({
  name: IdSchema,
  workspace: Text(1024),
  phase: z.enum(['provisioning', 'ready', 'failed']),
  message: Text(),
  updatedAt: TimeSchema,
  databases: z.array(z.object({ database: Text(32), port: z.number().int() })).max(16),
  summary: z.array(Text(512)).max(64),
});

/** The guest writes run/vpn.json: whether the VPN tunnel is up (validated and capped on the host). */
export const VpnStatusSchema = z.object({
  state: z.enum(['off', 'starting', 'up', 'failed']),
  message: Text(2000),
  killSwitch: z.boolean(),
  /** The server's name, e.g. uk2201.nordvpn.com. */
  server: Text(128).optional(),
  /** What the sandbox's traffic looks like from outside, once the tunnel is up. */
  publicIp: Text(64).optional(),
  updatedAt: TimeSchema,
});

export type VpnStatus = z.output<typeof VpnStatusSchema>;
export type ProjectSpec = z.output<typeof ProjectSpecSchema>;
export type ProjectStatus = z.output<typeof ProjectStatusSchema>;
export type AttachEndpoint = z.output<typeof AttachEndpointSchema>;
export type SandboxStatus = z.output<typeof SandboxStatusSchema>;
export type BootProgress = z.output<typeof BootProgressSchema>;
export type GuestRequest = z.output<typeof GuestRequestSchema>;
export type GuestResponse = z.output<typeof GuestResponseSchema>;
export type SessionStatus = z.output<typeof SessionStatusSchema>;
