// The only place that touches disks: mounting and dismounting go through native\scripts\mount-contained.ps1 and
// dismount-contained.ps1 (run elevated through run-elevated.ps1: one Windows permission prompt each), looking goes
// through check-contained.ps1 (no elevation). Everything above this file works against the `DiskPort` interface, so
// the tests use a fake and the real scripts are only ever started on a PC.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { fail } from '../../../core/util/index.js';
import { readValid } from '../../../shared/io/index.js';
import { SYSTEM } from '../../../shared/system.js';
import { nativeFile, nativeScript } from '../../native.js';
import { refuseInSelfTest } from '../../test-guard.js';
import type { ContainedPaths } from './layout.js';
import type { MountReality } from './state.js';

export interface ScriptOutcome {
  readonly ok: boolean;
  readonly message: string;
  /** mount only: the image did not exist and was made (and formatted) by this run. */
  readonly created: boolean;
  /** mount only: it was mounted before this run. */
  readonly alreadyMounted: boolean;
  readonly notes: readonly string[];
}

export interface MountRequest {
  readonly paths: ContainedPaths;
  readonly maxGb: number;
  /** true only the first time: no image file exists yet. The script refuses to create over a file. */
  readonly create: boolean;
  readonly userSid: string;
}

export interface DismountRequest {
  readonly paths: ContainedPaths;
  readonly userSid: string;
}

export interface DiskPort {
  mount(request: MountRequest): Promise<ScriptOutcome>;
  /**
   * A mount that should be there already, checked without a permission prompt: the outcome of a mount (which, for a
   * mount of this image, changes nothing), or null when this port cannot check without a prompt.
   */
  confirmMounted?(request: MountRequest): Promise<ScriptOutcome | null>;
  dismount(request: DismountRequest): Promise<ScriptOutcome>;
  reality(paths: ContainedPaths): Promise<MountReality>;
}

const OutcomeSchema = z.object({
  ok: z.boolean(),
  message: z.string().max(4000),
  created: z.boolean().optional(),
  alreadyMounted: z.boolean().optional(),
  notes: z
    .union([z.array(z.string().max(2000)).max(100), z.string().max(2000)])
    .optional()
    .transform((v) => (v === undefined ? [] : typeof v === 'string' ? [v] : v)),
});

const RealitySchema = z.object({
  imageExists: z.boolean(),
  imageBytes: z.number().nonnegative(),
  mountExists: z.boolean(),
  mountIsMountPoint: z.boolean(),
  attached: z.boolean().nullable(),
});

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export type Runner = (file: string, args: readonly string[], timeoutMs: number) => Promise<RunResult>;

const MOUNT_TIMEOUT_MS = 10 * 60_000;
const LOOK_TIMEOUT_MS = 30_000;

export const spawnRunner: Runner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(file, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: stderr + e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });

export class ScriptDiskPort implements DiskPort {
  constructor(private readonly run: Runner = spawnRunner) {}

  mount(request: MountRequest): Promise<ScriptOutcome> {
    const { paths } = request;
    return this.elevated('mount-contained.ps1', {
      set: paths.set,
      storageRoot: paths.storageRoot,
      image: paths.image,
      mount: paths.mount,
      userSid: request.userSid,
      maxGb: request.maxGb,
      create: request.create,
    });
  }

  dismount(request: DismountRequest): Promise<ScriptOutcome> {
    const { paths } = request;
    return this.elevated('dismount-contained.ps1', {
      set: paths.set,
      storageRoot: paths.storageRoot,
      image: paths.image,
      mount: paths.mount,
      userSid: request.userSid,
    });
  }

  async reality(paths: ContainedPaths): Promise<MountReality> {
    const out = await this.run(
      SYSTEM.powershell(),
      nativeScript('check-contained.ps1', ['-Image', paths.image, '-Mount', paths.mount]),
      LOOK_TIMEOUT_MS,
    );
    const parsed = RealitySchema.safeParse(safeJson(out.stdout.trim()));
    if (out.status !== 0 || !parsed.success)
      fail(
        'Could not look at the contained storage: ' + (out.stderr.trim() || out.stdout.trim() || 'no answer') + '.',
        'Run sandbox doctor.',
      );
    return parsed.data;
  }

  /** One run of an elevated script: the request goes in a file in a private temp folder, the answer comes back so. */
  private async elevated(script: string, request: Record<string, string | number | boolean>): Promise<ScriptOutcome> {
    // A test hands in a fake runner; only the real one reaches a disk.
    if (this.run === spawnRunner) refuseInSelfTest('mount or dismount a disk image');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sandbox-contained-'));
    try {
      const file = path.join(dir, 'request.json');
      const text = JSON.stringify(request, null, 2);
      fs.writeFileSync(file, text, 'utf8');
      const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const out = await this.run(
        SYSTEM.powershell(),
        nativeScript('run-elevated.ps1', ['-Script', nativeFile('scripts', script), '-Json', file, '-Sha256', sha]),
        MOUNT_TIMEOUT_MS,
      );
      const answer = readValid(OutcomeSchema, path.join(dir, 'result.json'));
      if (!answer)
        return fail(
          out.status === 1
            ? 'Windows did not give permission (the prompt was declined or closed).'
            : 'The disk image tool gave no answer' + (out.stderr.trim() ? ': ' + out.stderr.trim() : '.'),
          'Run the command again and choose Yes in the Windows prompt.',
        );
      return {
        ok: answer.ok,
        message: answer.message,
        created: answer.created ?? false,
        alreadyMounted: answer.alreadyMounted ?? false,
        notes: answer.notes,
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
