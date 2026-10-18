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

export type MemoryLimit = 'free' | 'share' | 'max' | 'commit' | 'resident';

export interface MemoryDecision {
  readonly mb: number;
  /** What set the size. */
  readonly limitedBy: MemoryLimit;
  /** What it would have been without looking at the commit (the old rule). */
  readonly withoutCommitMb: number;
  /** The inputs of the refusal, when mb is below the minimum. */
  readonly freeMb: number;
  readonly commitAvailableMb: number | null;
}

const roundDown = (mb: number): number => Math.floor(mb / 1024) * 1024;

/** GPU-PV (vGPU) needs room of its own on this PC: memory the graphics driver pins for the sandbox. */
const VGPU_RESERVE_MB = 2048;

/**
 * The most memory this PC can keep in RAM for the sandbox (pure): its RAM minus max(reserveHostMb, 25 %), and 2 GB
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
 * "auto" (pure): free RAM minus the reserve, never more than maxMemoryMb or maxMemoryPercent of the PC's total RAM,
 * and, when the PC's available commit (RAM plus paging file, what the sandbox's memory is charged against) is known,
 * never more than that minus the reserve either.
 */
export function decideMemory(
  sandbox: SandboxSettings,
  freeMb: number,
  totalMb: number,
  commitAvailableMb: number | null,
): MemoryDecision {
  const shareMb = Math.floor((totalMb * sandbox.maxMemoryPercent) / 100);
  const byFree = freeMb - sandbox.reserveHostMb;
  const byCommit = commitAvailableMb === null ? Infinity : commitAvailableMb - sandbox.reserveHostMb;
  const candidates: [MemoryLimit, number][] = [
    ['max', sandbox.maxMemoryMb],
    ['share', shareMb],
    ['free', byFree],
    ['commit', byCommit],
    ['resident', residentCapMb(sandbox, totalMb)],
  ];
  const lowest = candidates.reduce((a, b) => (b[1] < a[1] ? b : a));
  const withoutCommit = roundDown(Math.min(sandbox.maxMemoryMb, shareMb, byFree, residentCapMb(sandbox, totalMb)));
  return { mb: roundDown(lowest[1]), limitedBy: lowest[0], withoutCommitMb: withoutCommit, freeMb, commitAvailableMb };
}

/** A plain-words note when the commit made the sandbox's memory much smaller (2 GB or more) than free RAM allowed. */
export function memoryNote(decision: MemoryDecision): string | null {
  if (decision.limitedBy !== 'commit' || decision.withoutCommitMb - decision.mb < 2048) return null;
  return (
    'The sandbox gets ' +
    decision.mb / 1024 +
    ' GB of memory instead of ' +
    decision.withoutCommitMb / 1024 +
    ' GB: this PC has only ' +
    Math.floor((decision.commitAvailableMb ?? 0) / 1024) +
    ' GB of memory (RAM plus paging file) left to hand out, and if it runs out Windows closes the sandbox. ' +
    'A bigger Windows paging file, or closing other programs, gives it more.'
  );
}

/** "auto": see decideMemory. commitAvailableMb: from HostTools memory-status (omitted = not checked). */
export function resolveMemoryMb(
  sandbox: SandboxSettings,
  freeMemoryBytes = os.freemem(),
  totalMemoryBytes = os.totalmem(),
  commitAvailableMb: number | null = null,
): number {
  if (sandbox.memoryMb !== 'auto') return sandbox.memoryMb;
  const decision = decideMemory(
    sandbox,
    Math.floor(freeMemoryBytes / MB),
    Math.floor(totalMemoryBytes / MB),
    commitAvailableMb,
  );
  if (decision.mb < MIN_AUTO_MEMORY_MB)
    fail(
      decision.limitedBy === 'commit'
        ? 'Not enough memory left on this PC for the sandbox (' +
            decision.commitAvailableMb +
            ' MB of RAM plus paging file left, ' +
            sandbox.reserveHostMb +
            ' MB kept for this PC).'
        : 'Not enough free RAM for the sandbox (' +
            decision.freeMb +
            ' MB free, ' +
            sandbox.reserveHostMb +
            ' MB kept for this PC).',
      'Close some apps, enlarge the Windows paging file, lower sandbox.reserveHostMb, or set sandbox.memoryMb to a fixed value (>= 4096).',
    );
  return decision.mb;
}
