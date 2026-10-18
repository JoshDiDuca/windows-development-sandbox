// The host watchdog: while a sandbox runs, the background sync samples this PC's memory and CPU and, when the PC itself
// runs low (before Windows has to close the sandbox or the PC locks up), asks the sandbox to slow its builds down.
// The decision is pure (watchdogStep); watcher.ts samples, carries it out and logs it. Never blocks.
import type os from 'node:os';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { HOST_THRESHOLDS, type HostThresholds, type LoadProfile } from '../../shared/memory/index.js';
import { hostMemoryLine, type HostMemory } from './host-memory.js';

export interface WatchdogState {
  readonly low: boolean;
  /** Nearly out of memory: the request asks for the governor's last step. */
  readonly severe: boolean;
  readonly calm: number;
  /** Seconds the CPU has been above the limit. */
  readonly cpuHighSeconds: number;
  /** Seconds the disk queue has been above the limit. */
  readonly diskHighSeconds: number;
  /** Time (ms) the last request went out. */
  readonly lastSentAt: number;
}

export const WATCHDOG_START: WatchdogState = {
  low: false,
  severe: false,
  calm: 0,
  cpuHighSeconds: 0,
  diskHighSeconds: 0,
  lastSentAt: 0,
};

/** The request is repeated this often while the PC stays low, and each one lasts a bit longer than that. */
export const RESEND_MS = 30000;
export const REQUEST_SECONDS = 90;

export interface WatchdogInput {
  /** Null when memory could not be read this time (only the CPU counts then). */
  readonly memory: HostMemory | null;
  /** Total CPU use since the last sample (percent), null when unknown. */
  readonly cpuPercent: number | null;
  readonly intervalSeconds: number;
  readonly nowMs: number;
  readonly reserveHostMb: number;
  readonly profile: LoadProfile;
}

export interface WatchdogStep {
  readonly state: WatchdogState;
  /** Send a request to the sandbox now. */
  readonly send: boolean;
  /** Why the PC is low (plain words), empty when it is not. */
  readonly reason: string;
  /** Nearly out of memory: builds go to the governor's last step. */
  readonly severe: boolean;
  /** The state changed (the log says so). */
  readonly changed: boolean;
}

/**
 * Why this PC counts as low, for these numbers ("" when it does not). Low = available RAM under max(4 GB, 12 % of RAM)
 * or available commit under 15 % of the commit limit or half the reserve (the gentle profile: 6 GB, 15 %, 20 %).
 * `scale` widens the limits (1.25 = the level it must climb back above).
 */
export function lowReason(memory: HostMemory, reserveHostMb: number, t: HostThresholds, scale: number): string {
  const availableLimit = Math.max(t.availableMinMb, (memory.totalMb * t.availablePercent) / 100) * scale;
  if (memory.availableMb < availableLimit) return 'only ' + memory.availableMb + " MB of this PC's RAM is free";
  const commitLimit = Math.max((memory.commitLimitMb * t.commitAvailablePercent) / 100, reserveHostMb / 2) * scale;
  if (memory.commitAvailableMb < commitLimit)
    return 'only ' + memory.commitAvailableMb + ' MB of memory (RAM plus paging file) is left on this PC';
  return '';
}

/**
 * Nearly out of memory on this PC: under 1.5 GB of RAM free, or commit within max(2 GB, 4 %) of its limit. Then the
 * sandbox's builds go to the governor's last step at once (one compiler at a time, 15 % CPU) until it passes.
 */
export function severeHost(memory: HostMemory): boolean {
  return (
    memory.availableMb < SEVERE_AVAILABLE_MB ||
    memory.commitAvailableMb < Math.max(SEVERE_COMMIT_MB, (memory.commitLimitMb * SEVERE_COMMIT_PERCENT) / 100)
  );
}

const SEVERE_AVAILABLE_MB = 1536;
const SEVERE_COMMIT_MB = 2048;
const SEVERE_COMMIT_PERCENT = 4;

/** One watchdog step. Hysteresis: low starts at the limits and ends above 1.25 times them for calmSamples samples. */
export function watchdogStep(prev: WatchdogState, input: WatchdogInput): WatchdogStep {
  const t = HOST_THRESHOLDS[input.profile];
  let reason = '';
  if (input.memory) reason = lowReason(input.memory, input.reserveHostMb, t, 1);
  const cpuHigh =
    input.cpuPercent !== null && input.cpuPercent >= t.cpuPercent ? prev.cpuHighSeconds + input.intervalSeconds : 0;
  if (!reason && cpuHigh >= t.cpuSeconds)
    reason = "this PC's CPU has been above " + t.cpuPercent + '% for ' + cpuHigh + ' seconds';
  const diskQueue = input.memory?.diskQueue;
  const diskHigh =
    diskQueue !== undefined && diskQueue >= t.diskQueue ? prev.diskHighSeconds + input.intervalSeconds : 0;
  if (!reason && diskHigh >= t.diskSeconds)
    reason = "this PC's disks have had a queue of " + diskQueue + ' for ' + diskHigh + ' seconds';
  const calmNow = input.memory ? lowReason(input.memory, input.reserveHostMb, t, 1.25) === '' : true;
  let low = prev.low;
  let calm = prev.calm;
  if (reason) {
    low = true;
    calm = 0;
  } else if (prev.low) {
    calm = calmNow && cpuHigh === 0 && diskHigh === 0 ? prev.calm + 1 : 0;
    if (calm >= t.calmSamples) {
      low = false;
      calm = 0;
    }
  }
  const severe = low && input.memory !== null && severeHost(input.memory);
  // Getting severe is sent at once; otherwise the request is repeated every RESEND_MS while the PC stays low.
  const send = low && (input.nowMs - prev.lastSentAt >= RESEND_MS || (severe && !prev.severe));
  return {
    state: {
      low,
      severe,
      calm,
      cpuHighSeconds: cpuHigh,
      diskHighSeconds: diskHigh,
      lastSentAt: send ? input.nowMs : prev.lastSentAt,
    },
    send,
    reason: reason || (low ? 'this PC is still low' : ''),
    severe,
    changed: low !== prev.low,
  };
}

/** Total CPU use between two os.cpus() readings (percent). */
export function cpuPercentBetween(a: readonly os.CpuInfo[], b: readonly os.CpuInfo[]): number | null {
  let busy = 0;
  let total = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i].times;
    const y = b[i].times;
    const idle = y.idle - x.idle;
    const all = y.user - x.user + (y.nice - x.nice) + (y.sys - x.sys) + (y.irq - x.irq) + idle;
    busy += all - idle;
    total += all;
  }
  return total > 0 ? Math.round((busy / total) * 100) : null;
}

const MAX_LOG_BYTES = 512 * 1024;

/** One line in <storage>\logs\host-memory-<data>.log, which the crash report reads; the file is kept small. */
export function appendHostMemory(file: string, memory: HostMemory, cpuPercent: number | null): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + '.old');
    } catch {
      // No log yet.
    }
    fs.appendFileSync(file, hostMemoryLine(memory) + (cpuPercent === null ? '' : ' | CPU ' + cpuPercent + '%') + '\n');
  } catch {
    // The log is a courtesy: never a reason to fail.
  }
}

/** What the launch decided for the watchdog (host-only, in <storage>\run): the load profile and the PC's reserve. */
export interface LoadSettings {
  readonly profile: LoadProfile;
  readonly reserveHostMb: number;
}
const LoadSettingsSchema = z.object({
  profile: z.enum(['normal', 'gentle']),
  reserveHostMb: z.number().int().nonnegative(),
});

function loadFile(storageRoot: string, dataPath: string): string {
  return path.join(storageRoot, 'run', 'load-' + path.basename(dataPath) + '.json');
}

export function writeLoadSettings(storageRoot: string, dataPath: string, settings: LoadSettings): void {
  const file = loadFile(storageRoot, dataPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings));
}

/** The settings of the running launch; the defaults (normal profile, 8 GB reserve) when none were written. */
export function readLoadSettings(storageRoot: string, dataPath: string): LoadSettings {
  try {
    return LoadSettingsSchema.parse(JSON.parse(fs.readFileSync(loadFile(storageRoot, dataPath), 'utf8')));
  } catch {
    // Not written (an older launch) or damaged: the defaults.
    return { profile: 'normal', reserveHostMb: 8192 };
  }
}
