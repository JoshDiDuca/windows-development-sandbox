// The run folder (<data>\run on the host, C:\AgentData\run in the sandbox) is the host <-> sandbox channel. No
// network needed: boot status, requests (host -> guest) and responses/status (guest -> host) are small JSON files,
// written atomically and parsed with the channel schemas on read. Anything that does not parse is ignored.
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import {
  GuestRequestSchema,
  GuestResponseSchema,
  IdSchema,
  PressureStatusSchema,
  ProjectStatusSchema,
  SandboxStatusSchema,
  SessionStatusSchema,
  VpnStatusSchema,
} from './schema.js';
import type {
  GuestRequest,
  GuestResponse,
  PressureStatus,
  ProjectStatus,
  SandboxStatus,
  SessionStatus,
  VpnStatus,
} from './schema.js';
import { readValid } from '../io/index.js';

/** Ids become file names, so only a strict alphabet is allowed (no separators, no dots). */
export function safeId(id: string): string {
  return IdSchema.parse(id);
}

export function now(): string {
  return new Date().toISOString();
}

/** Message files in a folder (strict names only), validated; invalid ones are reported separately for deletion. */
const scan = <S extends z.ZodType>(schema: S, dir: string): { valid: z.output<S>[]; invalid: string[] } => {
  if (!fs.existsSync(dir)) return { valid: [], invalid: [] };
  const valid: z.output<S>[] = [];
  const invalid: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.tmp')) continue;
    const message = /^[A-Za-z0-9_-]{1,64}\.json$/.test(name) ? readValid(schema, path.join(dir, name)) : null;
    if (message) valid.push(message);
    else invalid.push(path.join(dir, name));
  }
  return { valid, invalid };
};

/** The run folder of one data folder: where each message lives, and reading them validated. */
export class RunDir {
  readonly root: string;
  readonly sandboxFile: string;
  readonly vpnFile: string;
  /** What the memory governor in the sandbox is doing (pressure.json). */
  readonly pressureFile: string;
  /** What the sandbox's programs may really use (budget.json): processors, memory, build jobs, link slots. */
  readonly budgetFile: string;
  readonly requestsDir: string;
  readonly responsesDir: string;
  readonly sessionsDir: string;
  readonly projectsDir: string;
  /** audit.processes: programs the sandbox started, in small .jsonl files the host takes in and deletes. */
  readonly auditDir: string;
  /**
   * Each running session's process tree, recorded by its ptyhost (guest only: the daemon ends what a ptyhost that was
   * itself ended left running).
   */
  readonly treesDir: string;
  /** One-shot secrets the host hands over (see secrets.ts). Next to run, not in it: shared-use users can change run. */
  readonly secretsDir: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'run');
    this.sandboxFile = path.join(this.root, 'sandbox.json');
    this.vpnFile = path.join(this.root, 'vpn.json');
    this.pressureFile = path.join(this.root, 'pressure.json');
    this.budgetFile = path.join(this.root, 'budget.json');
    this.requestsDir = path.join(this.root, 'requests');
    this.responsesDir = path.join(this.root, 'responses');
    this.sessionsDir = path.join(this.root, 'sessions');
    this.projectsDir = path.join(this.root, 'projects');
    this.auditDir = path.join(this.root, 'audit');
    this.treesDir = path.join(this.root, 'trees');
    this.secretsDir = path.join(dataDir, 'secrets');
  }

  requestFile(id: string): string {
    return path.join(this.requestsDir, safeId(id) + '.json');
  }
  responseFile(id: string): string {
    return path.join(this.responsesDir, safeId(id) + '.json');
  }
  sessionFile(id: string): string {
    return path.join(this.sessionsDir, safeId(id) + '.json');
  }
  treeFile(id: string): string {
    return path.join(this.treesDir, safeId(id) + '.json');
  }
  projectFile(name: string): string {
    return path.join(this.projectsDir, safeId(name) + '.json');
  }

  secretFile(id: string): string {
    return path.join(this.secretsDir, safeId(id) + '.json');
  }

  readSandboxStatus(): SandboxStatus | null {
    return readValid(SandboxStatusSchema, this.sandboxFile);
  }
  readVpnStatus(): VpnStatus | null {
    return readValid(VpnStatusSchema, this.vpnFile);
  }
  readPressure(): PressureStatus | null {
    return readValid(PressureStatusSchema, this.pressureFile);
  }
  readSession(id: string): SessionStatus | null {
    return readValid(SessionStatusSchema, this.sessionFile(id));
  }
  readResponse(id: string): GuestResponse | null {
    return readValid(GuestResponseSchema, this.responseFile(id));
  }
  listSessions(): SessionStatus[] {
    return scan(SessionStatusSchema, this.sessionsDir).valid.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  readProjectStatus(name: string): ProjectStatus | null {
    return readValid(ProjectStatusSchema, this.projectFile(name));
  }
  listProjectStatus(): ProjectStatus[] {
    return scan(ProjectStatusSchema, this.projectsDir).valid.slice(0, 64);
  }
  scanRequests(): { valid: GuestRequest[]; invalid: string[] } {
    return scan(GuestRequestSchema, this.requestsDir);
  }
}
