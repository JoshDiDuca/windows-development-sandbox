// The guest's fixed folders, and how much memory the sandbox gets.
import os from 'node:os';
import type { Config } from '../../core/types.js';
import { fail } from '../../core/util/index.js';
import { MIRROR_ROOT } from '../../shared/paths/index.js';

export const GUEST = {
  launch: 'C:\\AgentLaunch',
  data: 'C:\\AgentData',
  hostTools: 'C:\\HostTools',
  mirror: MIRROR_ROOT,
} as const;

type SandboxSettings = Config['sandbox'];

const MB = 1048576;
const MIN_AUTO_MEMORY_MB = 4096;

export type MemoryLimit = 'share' | 'max' | 'commit-limit' | 'resident';

export interface MemoryDecision {
  readonly mb: number;
  /** What set the size. */
  readonly limitedBy: MemoryLimit;
  /** Stable candidate before the total commit limit. */
  readonly withoutCommitMb: number;
  /** Current available commit is used only as a minimum launch safety check. */
  readonly freeMb: number;
  readonly commitAvailableMb: number | null;
  readonly commitLimitMb: number | null;
}

const roundDown = (mb: number): number => Math.floor(mb / 1024) * 1024;

/**
 * GPU-PV (vGPU) needs room of its own on this PC: the GPU's shared memory for the sandbox comes out of this PC's RAM,
 * and a GPU game plus heavy builds with vGPU on has killed the VM when the PC had no RAM left for it.
 */
export const VGPU_RESERVE_MB = 4096;

/**
 * The most memory this PC can keep in RAM for the sandbox (pure): its RAM minus max(reserveHostMb, 25 %), and 4 GB
 * more with vGPU. Windows Sandbox's memory is this PC's memory taken as needed; beyond what the PC can keep resident it
 * is paged to this PC's disk while the sandbox pages to its own, and that is what can freeze the whole PC.
 */
export function residentCapMb(sandbox: SandboxSettings, totalMb: number): number {
  const keep = Math.max(sandbox.reserveHostMb, Math.floor(totalMb / 4)) + (sandbox.vGpu ? VGPU_RESERVE_MB : 0);
  return roundDown(totalMb - keep);
}

/** A fixed memoryMb above what this PC can keep resident is lowered to that (never below 4 GB). */
export function cappedMemoryMb(memoryMb: number, sandbox: SandboxSettings, totalMb: number): number {
  const cap = residentCapMb(sandbox, totalMb);
  return cap >= MIN_AUTO_MEMORY_MB && memoryMb > cap ? cap : memoryMb;
}

/** The launch note when a fixed memoryMb was lowered. */
export function residentNote(asked: number, given: number): string | null {
  if (given >= asked) return null;
  return (
    'sandbox.memoryMb asks for ' +
    asked +
    ' MB; this PC can keep ' +
    given +
    ' MB in RAM for the sandbox (its RAM minus what it needs itself), so the sandbox gets ' +
    given +
    " MB. More would be paged to this PC's disk, which can freeze the whole PC."
  );
}

/**
 * "auto" is stable across launches: total RAM, total commit limit, configured limits and the resident safety cap set
 * the size. Transient free RAM/cache is deliberately ignored; current available commit only gates unsafe launches.
 */
export function decideMemory(
  sandbox: SandboxSettings,
  freeMb: number,
  totalMb: number,
  commitAvailableMb: number | null,
  commitLimitMb: number | null = null,
): MemoryDecision {
  const shareMb = Math.floor((totalMb * sandbox.maxMemoryPercent) / 100);
  const reserveMb = sandbox.reserveHostMb + (sandbox.vGpu ? VGPU_RESERVE_MB : 0);
  const byCommit = commitLimitMb === null ? Infinity : commitLimitMb - reserveMb;
  const candidates: [MemoryLimit, number][] = [
    ['max', sandbox.maxMemoryMb],
    ['share', shareMb],
    ['commit-limit', byCommit],
    ['resident', residentCapMb(sandbox, totalMb)],
  ];
  const lowest = candidates.reduce((a, b) => (b[1] < a[1] ? b : a));
  const withoutCommit = roundDown(Math.min(sandbox.maxMemoryMb, shareMb, residentCapMb(sandbox, totalMb)));
  return {
    mb: roundDown(lowest[1]),
    limitedBy: lowest[0],
    withoutCommitMb: withoutCommit,
    freeMb,
    commitAvailableMb,
    commitLimitMb,
  };
}

/** A plain-words note when the total commit limit makes the stable sandbox size much smaller. */
export function memoryNote(decision: MemoryDecision): string | null {
  if (decision.limitedBy !== 'commit-limit' || decision.withoutCommitMb - decision.mb < 2048) return null;
  return (
    'The sandbox gets ' +
    decision.mb / 1024 +
    ' GB of memory instead of ' +
    decision.withoutCommitMb / 1024 +
    ' GB: this PC has only ' +
    Math.floor((decision.commitLimitMb ?? 0) / 1024) +
    ' GB of total commit capacity (RAM plus paging file) is available; this sets the stable ceiling. ' +
    'Increase the Windows paging file or adjust sandbox.reserveHostMb to raise it.'
  );
}

/** "auto": see decideMemory. free memory is accepted for compatibility but never affects the stable result. */
export function resolveMemoryMb(
  sandbox: SandboxSettings,
  freeMemoryBytes = os.freemem(),
  totalMemoryBytes = os.totalmem(),
  commitAvailableMb: number | null = null,
  commitLimitMb: number | null = null,
): number {
  if (sandbox.memoryMb !== 'auto') return sandbox.memoryMb;
  const decision = decideMemory(
    sandbox,
    Math.floor(freeMemoryBytes / MB),
    Math.floor(totalMemoryBytes / MB),
    commitAvailableMb,
    commitLimitMb,
  );
  const minimumAvailable = sandbox.reserveHostMb + (sandbox.vGpu ? VGPU_RESERVE_MB : 0) + MIN_AUTO_MEMORY_MB;
  if (decision.mb < MIN_AUTO_MEMORY_MB || (commitAvailableMb !== null && commitAvailableMb < minimumAvailable))
    fail(
      commitAvailableMb !== null && commitAvailableMb < minimumAvailable
        ? 'Not enough memory left on this PC for the sandbox (' +
            decision.commitAvailableMb +
            ' MB of RAM plus paging file left, ' +
            sandbox.reserveHostMb +
            ' MB kept for this PC).'
        : 'The stable memory limit for the sandbox is below 4 GB (' + decision.mb + ' MB).',
      'Close some apps, enlarge the Windows paging file, lower sandbox.reserveHostMb, or set sandbox.memoryMb to a fixed value (>= 4096).',
    );
  return decision.mb;
}
